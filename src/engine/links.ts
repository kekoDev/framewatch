import type { BrowserContext, Page } from "playwright";
import { MAX_LINK_REDIRECTS, MAX_LINK_SCAN, MAX_LINK_TEXT_LENGTH } from "../constants.js";

/**
 * Link engine.
 *
 * Three jobs, and nothing that judges: collect every address the rendered page
 * refers to, remember what the browser itself made of the ones it loaded, and
 * check the rest over HTTP. What any of that *means* is `utils/link-rules.ts`,
 * which is pure and therefore testable without a socket.
 *
 * Two decisions shape everything here.
 *
 * The page is read after it has rendered, not from its HTML source, for the
 * same reason the SEO engine does: a component framework ships an empty
 * `<div id="app">` and writes every link into it afterwards, so reading the
 * source would report a client-rendered site as having no links at all.
 *
 * And the checks go out through the browser context rather than through
 * `fetch`, so they carry the same cookies, headers and proxy settings the page
 * itself was loaded with. A link behind a login is then checked as the
 * signed-in visitor sees it instead of coming back 401 for everyone.
 */

/* ── What the page points at ──────────────────────────────────────────── */

/** A link a person clicks, or a resource the page pulls in on its own. */
export type LinkRole = "link" | "resource";

/** One address the rendered page refers to, exactly as it was written. */
export interface RawLink {
  /** The href/src as authored — relative, empty, `javascript:` and all. */
  href: string;
  role: LinkRole;
  tag: string;
  /** Which attribute carried it, so a `srcset` candidate is not mistaken for a `src`. */
  attribute: string;
  /** How the element is named in the report — `a "Pricing"`, `img#hero`. */
  description: string;
  /** A CSS selector for the element, recomputed each visit rather than remembered. */
  selector: string;
  /** Which match of `selector` this is, for the common case where it is not unique. */
  match_index: number;
  rel?: string;
}

/** Every element that carries an address, and the attribute it carries it in. */
const SOURCES: ReadonlyArray<{ selector: string; attribute: string; role: LinkRole; list?: boolean }> = [
  { selector: "a[href]", attribute: "href", role: "link" },
  { selector: "area[href]", attribute: "href", role: "link" },
  { selector: "img[src]", attribute: "src", role: "resource" },
  { selector: "img[srcset]", attribute: "srcset", role: "resource", list: true },
  { selector: "source[src]", attribute: "src", role: "resource" },
  { selector: "source[srcset]", attribute: "srcset", role: "resource", list: true },
  { selector: "script[src]", attribute: "src", role: "resource" },
  { selector: "link[href]", attribute: "href", role: "resource" },
  { selector: "iframe[src]", attribute: "src", role: "resource" },
  { selector: "embed[src]", attribute: "src", role: "resource" },
  { selector: "object[data]", attribute: "data", role: "resource" },
  { selector: "video[src]", attribute: "src", role: "resource" },
  { selector: "video[poster]", attribute: "poster", role: "resource" },
  { selector: "audio[src]", attribute: "src", role: "resource" },
  { selector: "track[src]", attribute: "src", role: "resource" },
];

export interface CollectLinksOptions {
  /** Only look inside this. Defaults to the whole document. */
  selector?: string;
  /** Also collect the things the page loads for itself — images, scripts, stylesheets. */
  include_resources?: boolean;
}

/**
 * Read every address out of the rendered document, in document order.
 *
 * Anchors come first because they are what the tool is about; a page's own
 * resources are collected after them so that a `max_links` cap spends itself
 * on links before it spends itself on sprite sheets.
 */
export async function collectLinks(page: Page, options: CollectLinksOptions = {}): Promise<RawLink[]> {
  return page.evaluate(collectInPage, {
    root: options.selector ?? "",
    include_resources: options.include_resources !== false,
    sources: SOURCES.map((source) => ({ ...source, list: source.list === true })),
    max_scan: MAX_LINK_SCAN,
    max_text: MAX_LINK_TEXT_LENGTH,
  });
}

interface CollectArgs {
  root: string;
  include_resources: boolean;
  sources: { selector: string; attribute: string; role: LinkRole; list: boolean }[];
  max_scan: number;
  max_text: number;
}

/**
 * Runs inside the page. Written against `globalThis` because this package
 * compiles with the Node lib only, and defensively throughout because a
 * document can be mid-teardown when this lands in it.
 */
function collectInPage(args: CollectArgs): RawLink[] {
  const g = globalThis as any;
  const doc = g.document;
  const found: RawLink[] = [];
  if (!doc) return found;

  const flatten = (value: unknown): string =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const elide = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

  const escape = (value: string): string => {
    try {
      if (g.CSS && typeof g.CSS.escape === "function") return g.CSS.escape(value);
    } catch {
      // Fall through to the conservative test below.
    }
    return /^[A-Za-z][\w-]*$/.test(value) ? value : "";
  };

  /** A unique-enough CSS selector; `match_index` settles the rest. Mirrors engine/clicks.ts. */
  const selectorFor = (node: any): string => {
    const parts: string[] = [];
    let current = node;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth++) {
      const tag = String(current.tagName || "").toLowerCase();
      if (tag === "body" || tag === "html") {
        parts.unshift(tag);
        break;
      }
      const id = current.id ? escape(String(current.id)) : "";
      if (id !== "") {
        parts.unshift(`#${id}`);
        break;
      }
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        let position = 0;
        let total = 0;
        for (let i = 0; i < parent.children.length; i++) {
          const sibling = parent.children[i];
          if (sibling.tagName !== current.tagName) continue;
          total++;
          if (sibling === current) position = total;
        }
        if (total > 1 && position > 0) part += `:nth-of-type(${position})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };

  /** What the element says it is — its text, its alt, or the rel that explains it. */
  const describe = (node: any, tag: string): string => {
    let label = "";
    try {
      label =
        flatten(node.innerText) ||
        flatten(node.textContent) ||
        flatten(node.getAttribute("alt")) ||
        flatten(node.getAttribute("aria-label")) ||
        flatten(node.getAttribute("title"));
    } catch {
      label = "";
    }
    if (label) return `${tag} "${elide(label, args.max_text)}"`;
    const rel = flatten(node.getAttribute?.("rel"));
    return rel ? `${tag} rel="${elide(rel, args.max_text)}"` : tag;
  };

  /**
   * A `srcset` is a comma-separated list of candidates, each an address
   * followed by an optional descriptor. Every candidate is a real request the
   * browser may make, so every one of them is a link.
   */
  const candidates = (value: string, list: boolean): string[] => {
    if (!list) return [value];
    return value
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter((part) => part !== "");
  };

  let root: any = doc;
  if (args.root) {
    try {
      root = doc.querySelector(args.root) ?? null;
    } catch {
      root = null;
    }
    if (!root) return found;
  }

  const nodes: { node: any; raw: RawLink }[] = [];
  for (const source of args.sources) {
    if (!args.include_resources && source.role === "resource") continue;
    let matches: any[] = [];
    try {
      matches = Array.prototype.slice.call(root.querySelectorAll(source.selector));
    } catch {
      continue;
    }
    for (const node of matches) {
      if (nodes.length >= args.max_scan) break;
      const tag = String(node.tagName || "").toLowerCase();
      const value = String(node.getAttribute(source.attribute) ?? "");
      const rel = flatten(node.getAttribute?.("rel"));
      for (const href of candidates(value, source.list)) {
        nodes.push({
          node,
          raw: {
            href,
            role: source.role,
            tag,
            attribute: source.attribute,
            description: describe(node, tag),
            selector: "",
            match_index: 0,
            ...(rel ? { rel } : {}),
          },
        });
      }
    }
  }

  // Selectors last: each one costs a querySelectorAll to index, and only the
  // elements that survived the scan need one.
  for (const entry of nodes) {
    const selector = selectorFor(entry.node);
    entry.raw.selector = selector;
    try {
      const matches = doc.querySelectorAll(selector);
      for (let i = 0; i < matches.length; i++) {
        if (matches[i] === entry.node) entry.raw.match_index = i;
      }
    } catch {
      entry.raw.selector = "";
    }
    found.push(entry.raw);
  }

  return found;
}

/**
 * Which of these fragments actually point at something.
 *
 * A `#pricing` that matches no element is a broken link that no amount of HTTP
 * checking will ever find — the request succeeds, the page loads, and the
 * visitor simply does not go where the link said. It is only answerable with
 * the document in hand, which is the one thing a link checker without a
 * browser does not have.
 *
 * Both spellings count: an `id`, and the `<a name>` that predates it and still
 * works in every browser.
 */
export async function findFragmentTargets(page: Page, fragments: readonly string[]): Promise<string[]> {
  if (fragments.length === 0) return [];
  try {
    return await page.evaluate((wanted: string[]): string[] => {
      const g = globalThis as any;
      const doc = g.document;
      const present: string[] = [];
      for (const fragment of wanted) {
        let found = false;
        try {
          found = doc.getElementById(fragment) !== null;
          if (!found) {
            const named = doc.getElementsByName ? doc.getElementsByName(fragment) : null;
            found = named !== null && named.length > 0;
          }
        } catch {
          found = false;
        }
        if (found) present.push(fragment);
      }
      return present;
    }, [...fragments]);
  } catch {
    // A page that died before this ran simply has no answer; every fragment
    // then goes unreported rather than being reported as missing.
    return [...fragments];
  }
}

/* ── What the browser already knows ───────────────────────────────────── */

/** What Chromium made of one address it fetched for itself. */
export interface ObservedLoad {
  status?: number;
  /** Chromium's own error text, e.g. `net::ERR_NAME_NOT_RESOLVED`. */
  failure?: string;
  /** Every URL in the redirect chain, first to last. */
  chain: string[];
}

export interface LoadWatch {
  get(url: string): ObservedLoad | undefined;
  detach(): void;
}

/**
 * Record what the browser makes of every request it issues.
 *
 * The page has already fetched its own stylesheets, scripts and images by the
 * time anything is checked, and Chromium's answer is better than a second
 * request would be: it is what actually happened, in the right order, with the
 * right headers, and it costs nothing. Re-requesting them all would double the
 * load on the site under test and could easily disagree with the browser —
 * which is the one verdict that matters.
 *
 * Intermediate redirects are skipped and recorded from the far end instead, so
 * a resource that 301s to a working URL is not reported as a bare 301. An
 * aborted request is recorded as nothing at all: `net::ERR_ABORTED` is what a
 * cancelled preload and a navigation away both look like, and neither is a
 * broken link.
 */
export function watchLoads(page: Page): LoadWatch {
  const seen = new Map<string, ObservedLoad>();

  const chainOf = (request: any): string[] => {
    const chain: string[] = [];
    let current = request;
    for (let hop = 0; current && hop <= MAX_LINK_REDIRECTS; hop++) {
      chain.unshift(String(current.url()));
      current = typeof current.redirectedFrom === "function" ? current.redirectedFrom() : null;
    }
    return chain;
  };

  const onResponse = (response: any): void => {
    try {
      const status = response.status();
      // An intermediate hop: the response at the end of the chain records the
      // verdict for every URL that led to it.
      if (status >= 300 && status < 400) return;
      const chain = chainOf(response.request());
      seen.set(chain[0], { status, chain });
    } catch {
      // A response that cannot be read tells us nothing; the URL is checked
      // over HTTP like any other.
    }
  };

  const onFailed = (request: any): void => {
    try {
      const failure = request.failure()?.errorText ?? "the request failed";
      if (/ERR_ABORTED/i.test(failure)) return;
      const chain = chainOf(request);
      seen.set(chain[0], { failure, chain });
    } catch {
      /* as above */
    }
  };

  page.on("response", onResponse);
  page.on("requestfailed", onFailed);

  return {
    get: (url) => seen.get(url),
    detach: () => {
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
    },
  };
}

/* ── Checking a URL ───────────────────────────────────────────────────── */

/** The outcome of one check, as the checker saw it — no judgement attached. */
export interface CheckOutcome {
  /**
   * Every URL requested, starting with the one that was asked for. One entry
   * means no redirect was followed; a repeat means the chain came back round.
   */
  chain: string[];
  /** The final status, when one arrived. */
  status?: number;
  /** The transport error, when the request never completed. */
  error?: string;
  /** Which verb produced the final answer. */
  method: "HEAD" | "GET";
  /** The chain was still going when `max_redirects` ran out. */
  hops_exceeded?: boolean;
  content_type?: string;
  /** This verdict came from the browser's own load rather than from a fresh request. */
  observed?: boolean;
}

export interface CheckOptions {
  timeout_ms: number;
  max_redirects?: number;
}

/**
 * Ask a server about one URL, following its redirects by hand.
 *
 * Redirects are followed one hop at a time (`maxRedirects: 0`) rather than
 * letting Playwright chase them, because the chain *is* part of the finding: a
 * link that reaches its destination through four hops works and is still worth
 * fixing, and a link that redirects into a 404 is a different bug from a plain
 * 404.
 *
 * HEAD is an optimisation, never the test. A great many servers — CDNs, WAFs,
 * a fair number of frameworks — answer 405 or 404 to a HEAD and serve the very
 * same URL to a GET, so anything that comes back an error is asked for again
 * properly before it is called broken. That costs a second request only on
 * links that were about to be reported, which is the right place to spend it.
 */
export async function checkUrl(context: BrowserContext, url: string, options: CheckOptions): Promise<CheckOutcome> {
  const maxRedirects = options.max_redirects ?? MAX_LINK_REDIRECTS;
  const chain = [url];
  let current = url;
  let method: "HEAD" | "GET" = "HEAD";

  for (let hop = 0; ; hop++) {
    let status: number;
    let headers: Record<string, string>;

    try {
      const head = await context.request.head(current, {
        timeout: options.timeout_ms,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      status = head.status();
      headers = head.headers();
      void head.dispose().catch(() => {});
    } catch (error) {
      return { chain, error: firstLine(error), method };
    }

    if (status >= 400) {
      try {
        const get = await context.request.get(current, {
          timeout: options.timeout_ms,
          maxRedirects: 0,
          failOnStatusCode: false,
        });
        status = get.status();
        headers = get.headers();
        method = "GET";
        void get.dispose().catch(() => {});
      } catch (error) {
        return { chain, error: firstLine(error), method: "GET" };
      }
    }

    const location = status >= 300 && status < 400 ? headers["location"] : undefined;
    if (location === undefined || location === "") {
      return {
        chain,
        status,
        method,
        ...(headers["content-type"] ? { content_type: headers["content-type"] } : {}),
      };
    }

    if (hop >= maxRedirects) return { chain, status, method, hops_exceeded: true };

    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      // A Location header that is not a URL is a redirect to nowhere, which is
      // exactly what a missing one is.
      return { chain, status, method };
    }

    chain.push(next);
    // Back somewhere we have already been: the rules module reads the repeat
    // out of the chain, so the loop is reported rather than merely stopped.
    if (chain.indexOf(next) !== chain.length - 1) return { chain, status, method };
    current = next;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
