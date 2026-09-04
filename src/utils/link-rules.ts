import { STATUS_CODES } from "node:http";
import { MAX_LINK_REDIRECTS } from "../constants.js";
import type { CheckOutcome } from "../engine/links.js";

/**
 * What counts as a broken link.
 *
 * Everything here is pure: it takes an href and a base, or the outcome of one
 * HTTP check, and returns a verdict. Nothing in this file opens a browser or a
 * socket, which is the point — "is this href even a request?", "did that chain
 * of redirects end somewhere real?" and "is a 403 a broken link?" are all
 * judgements with edge cases, and judgements need unit tests that run in
 * milliseconds.
 *
 * The bias throughout is against false alarms. A report that calls a working
 * link broken is worse than one that says nothing: it sends somebody to look
 * at a page that is fine, and the next real finding gets ignored. So a status
 * that means "I would not answer that" is separated from one that means "there
 * is nothing here", and anything unrecognised is quoted rather than judged.
 */

/* ── Classifying an href ──────────────────────────────────────────────── */

/**
 * What kind of thing an href is.
 *
 * Only `http` is a request. `same_page` is answered by the DOM, the scheme
 * kinds are handed to something that is not a browser, and `malformed` never
 * leaves the page at all.
 */
export type HrefKind =
  | "http"
  | "same_page"
  | "empty"
  | "mailto"
  | "tel"
  | "javascript"
  | "data"
  | "scheme"
  | "malformed";

export interface ClassifiedHref {
  kind: HrefKind;
  /** The absolute URL, for `http` and `same_page`. */
  resolved?: string;
  /** The `#…` part, decoded and without its hash, when there is one. */
  fragment?: string;
  /** The scheme, for `scheme` — `ftp`, `chrome-extension`, whatever the page used. */
  scheme?: string;
  /** Why this one cannot be checked, or is suspect. */
  reason?: string;
}

/**
 * Work out what an href points at, resolved against the page it was found on.
 *
 * Order matters. An empty href and a bare `#` both resolve to the current
 * document, so they are recognised from the raw text before the URL parser
 * gets a chance to turn them into the page's own address and hide what the
 * author actually wrote — and `<a href="#">` is the single most common dead
 * link there is.
 */
export function classifyHref(rawHref: string, base: string): ClassifiedHref {
  const href = String(rawHref ?? "").trim();

  // Per RFC 3986 an empty reference is the current document. Browsers reload
  // the page; it is almost never what the author meant.
  if (href === "") {
    return { kind: "empty", reason: "an empty href reloads the current page" };
  }

  // A fragment-only reference never leaves the document, whatever the base is.
  if (href.startsWith("#")) {
    return { kind: "same_page", fragment: decodeFragment(href.slice(1)) };
  }

  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return { kind: "malformed", reason: `"${href}" is not a URL a browser can resolve` };
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  switch (scheme) {
    case "http":
    case "https":
      break;
    case "mailto":
      return {
        kind: "mailto",
        ...(url.pathname.trim() === "" ? { reason: "a mailto: with no address after it" } : {}),
      };
    case "tel":
      return {
        kind: "tel",
        ...(url.pathname.trim() === "" ? { reason: "a tel: with no number after it" } : {}),
      };
    case "javascript":
      return { kind: "javascript", reason: "runs a script instead of going anywhere" };
    case "data":
      return { kind: "data" };
    default:
      return { kind: "scheme", scheme, reason: `${scheme}: is handed to the operating system, not fetched` };
  }

  const fragment = url.hash ? decodeFragment(url.hash.slice(1)) : undefined;
  const kind: HrefKind = dedupeKey(url.href) === dedupeKey(base) ? "same_page" : "http";
  return {
    kind,
    resolved: url.href,
    ...(fragment !== undefined ? { fragment } : {}),
  };
}

/** `%C3%A9` in an href is `é` in an id — browsers match the decoded form. */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * The identity of a request.
 *
 * The fragment is dropped: it never reaches the server, so `/help#returns` and
 * `/help#shipping` are one request and must not be checked twice. Everything
 * else is kept, including the trailing slash — `/a` and `/a/` are different
 * URLs and routinely redirect differently, so collapsing them would hide a
 * redirect the tool exists to report.
 */
export function dedupeKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url;
  }
}

/** Same scheme, host and port — the only definition a crawl can safely act on. */
export function isInternal(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * The two fragments every browser resolves without an element to scroll to:
 * an empty one (the top of the document, which is what `href="#"` means) and
 * `#top`, which HTML defines as the same thing.
 */
export function isAlwaysValidFragment(fragment: string): boolean {
  return fragment === "" || fragment.toLowerCase() === "top";
}

/* ── Judging the answer ───────────────────────────────────────────────── */

/** Where a checked link ended up. */
export type LinkCategory = "ok" | "redirect" | "broken" | "blocked" | "timeout" | "error";

export interface LinkVerdict {
  category: LinkCategory;
  /** What happened, in one phrase: "404 Not Found", "redirected to … (2 hops)". */
  detail: string;
  /** What to do about it. Only where there is something to do. */
  fix?: string;
  /** Redirects followed. */
  hops: number;
  /** Where the chain actually ended, when that is not where it started. */
  final_url?: string;
}

/**
 * Statuses that mean "I will not answer that", not "there is nothing here".
 *
 * A link behind a login answers 401, a WAF answers 403 to anything without a
 * browser's fingerprint, a rate limiter answers 429, and LinkedIn answers 999
 * to automated checks. Every one of those links works perfectly for a person
 * with a browser, and reporting them as broken is how a link report gets
 * ignored. 405 is here for the same reason from the other direction: the
 * server refused the *method*, so the check failed, not the link.
 */
const REFUSED: Readonly<Record<number, string>> = {
  401: "the server wants credentials before it will answer — the link is likely fine for a signed-in visitor",
  403: "the server refused the check (bot protection usually answers this) — the link may well work in a browser",
  405: "the server refused the request method",
  429: "the check was rate-limited, not the link broken",
  999: "a non-standard status some sites return to automated checks — not a broken link",
};

/**
 * Decide what one check means.
 *
 * The order is the order the failures shadow each other: a loop makes the
 * final status meaningless, a chain that ran out of hops never got one, a
 * transport error means there is no status at all, and only then is the status
 * itself worth reading.
 */
export function judgeCheck(outcome: CheckOutcome): LinkVerdict {
  const chain = outcome.chain.length > 0 ? outcome.chain : [""];
  const hops = chain.length - 1;
  const final = chain[chain.length - 1];
  const landed = hops > 0 ? { final_url: final } : {};

  const repeat = firstRepeat(chain);
  if (repeat !== undefined) {
    return {
      category: "error",
      detail: `the redirects loop — ${repeat} is visited twice`,
      fix: "Follow the chain by hand: a redirect loop is a page nobody can reach.",
      hops,
      ...landed,
    };
  }

  if (outcome.hops_exceeded) {
    return {
      category: "error",
      detail: `still redirecting after ${MAX_LINK_REDIRECTS} redirects, last at ${final}`,
      fix: "A chain this long is a configuration bug — most crawlers give up after five.",
      hops,
      ...landed,
    };
  }

  if (outcome.error !== undefined) {
    const failure = classifyFailure(outcome.error);
    return { ...failure, hops, ...landed };
  }

  const status = outcome.status;
  if (status === undefined) {
    return { category: "error", detail: "the check produced no answer at all", hops, ...landed };
  }

  const named = label(status);

  // A 3xx that is still a 3xx after the chain was followed had nowhere to go.
  if (status >= 300 && status < 400) {
    return {
      category: "broken",
      detail: `${named} — a redirect with no Location header to follow`,
      fix: "Give the redirect a Location, or serve the page directly.",
      hops,
      ...landed,
    };
  }

  if (status >= 400) {
    const refused = REFUSED[status];
    if (refused !== undefined) {
      const method = status === 405 ? ` (${outcome.method} was refused too)` : "";
      return {
        category: "blocked",
        detail: `${named} — ${refused}${method}`,
        ...(status === 429
          ? { fix: "Lower `concurrency` or raise `timeout_ms` and check this one again." }
          : {}),
        hops,
        ...landed,
      };
    }
    return {
      category: "broken",
      detail:
        hops > 0
          ? `${named} — after ${plural(hops, "redirect")}, ending at ${final}`
          : named,
      fix:
        status === 404
          ? "Point the link somewhere that exists, or restore the page."
          : "This link answers an error to every visitor.",
      hops,
      ...landed,
    };
  }

  if (hops === 0) {
    return { category: "ok", detail: named, hops };
  }

  const upgraded = isUpgrade(chain);
  return {
    category: "redirect",
    detail: `redirected to ${final} (${plural(hops, "hop")}), which answered ${named}`,
    ...(hops > 1
      ? { fix: "Link straight to the final address — every hop in the chain is another round trip." }
      : upgraded
        ? { fix: "Write the link as https:// — the http:// form costs an extra round trip on every visit." }
        : {}),
    hops,
    final_url: final,
  };
}

/** Did this chain exist only to swap http for https? */
function isUpgrade(chain: string[]): boolean {
  try {
    return new URL(chain[0]).protocol === "http:" && new URL(chain[chain.length - 1]).protocol === "https:";
  } catch {
    return false;
  }
}

/** The first URL that appears twice, which is a loop however long the chain is. */
function firstRepeat(chain: string[]): string | undefined {
  const seen = new Set<string>();
  for (const url of chain) {
    if (seen.has(url)) return url;
    seen.add(url);
  }
  return undefined;
}

/**
 * Turn a transport failure into something a reader can act on.
 *
 * These are the five that a link check actually hits. Anything else is quoted
 * verbatim rather than guessed at — an error nobody predicted is still useful,
 * and a wrong paraphrase of it is not.
 */
export function classifyFailure(message: string): { category: LinkCategory; detail: string; fix?: string } {
  const line = String(message).split("\n")[0];

  if (/Timeout\s+\d+\s*ms\s+exceeded|timed?\s?out|ETIMEDOUT/i.test(line)) {
    return {
      category: "timeout",
      detail: "no answer within the timeout",
      fix: "Raise `timeout_ms` if the host is simply slow; a link nobody's browser will wait for is broken in practice.",
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|NAME_NOT_RESOLVED|ERR_NAME/i.test(line)) {
    return {
      category: "error",
      detail: "the host name does not resolve",
      fix: "Check the domain for a typo, and that it has not expired.",
    };
  }
  if (/ECONNREFUSED|CONNECTION_REFUSED/i.test(line)) {
    return { category: "error", detail: "nothing is listening on that address — the connection was refused" };
  }
  if (/ECONNRESET|socket hang up|EPIPE/i.test(line)) {
    return { category: "error", detail: "the connection was closed before an answer arrived (socket hang up)" };
  }
  if (/certificate|CERT_|ERR_CERT|SSL|TLS|self-signed/i.test(line)) {
    return {
      category: "error",
      detail: "the TLS certificate was rejected",
      fix: "A browser shows an interstitial for this — to a visitor it is a broken link.",
    };
  }
  return { category: "error", detail: line };
}

/** The registered name of a status code, or "" for the ones nobody standardised. */
export function statusText(status: number): string {
  return STATUS_CODES[status] ?? "";
}

/** `404 Not Found`, or just `999` where inventing a name would be worse than having none. */
function label(status: number): string {
  const name = statusText(status);
  return name === "" ? String(status) : `${status} ${name}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
