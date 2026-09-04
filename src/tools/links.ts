import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_LINKS_WAIT_MS,
  DEFAULT_LINK_CONCURRENCY,
  DEFAULT_LINK_PAGES,
  DEFAULT_LINK_TIMEOUT_MS,
  DEFAULT_MAX_LINKS,
  DEFAULT_VIEWPORT,
  HIGHLIGHT_BROKEN_COLOUR,
  HIGHLIGHT_DEAD_COLOUR,
  MAX_HIGHLIGHTS,
  MAX_LINKS_CAP,
  MAX_LINKS_LISTED,
  MAX_LINK_CONCURRENCY,
  MAX_LINK_DEPTH,
  MAX_LINK_PAGES,
  MAX_LINK_SELECTOR_LENGTH,
  MAX_LINK_SOURCES_LISTED,
  MAX_LINK_TIMEOUT_MS,
  MAX_LINK_URL_LENGTH,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  MIN_LINK_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  checkUrl,
  collectLinks,
  findFragmentTargets,
  watchLoads,
  type CheckOutcome,
  type LinkRole,
  type RawLink,
} from "../engine/links.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { highlightElements, type Highlight } from "../utils/highlight.js";
import {
  classifyHref,
  dedupeKey,
  isAlwaysValidFragment,
  isInternal,
  judgeCheck,
  type LinkCategory,
  type LinkVerdict,
} from "../utils/link-rules.js";
import { resolveStorageState, storageStateField, withAuthNote } from "../utils/storage-state.js";

export const LINKS_TOOL_NAME = "framewatch_links";

export const linksInputShape = {
  url: z
    .string()
    .url()
    .describe("URL to check, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  depth: z
    .number()
    .int()
    .min(0)
    .max(MAX_LINK_DEPTH)
    .default(0)
    .describe(
      "How far to follow the site. 0 checks the links on this page only; 1 also opens each internal page this " +
        "one links to and checks its links, and so on. Each level costs a real browser navigation per page.",
    ),
  check_external: z
    .boolean()
    .default(true)
    .describe(
      "Also check links to other origins. This sends a request to somebody else's server — turn it off on a " +
        "page full of third-party links, or when working offline.",
    ),
  include_resources: z
    .boolean()
    .default(true)
    .describe(
      "Also check what the page loads for itself: images, scripts, stylesheets, iframes, media. Most of these " +
        "cost nothing to check — the browser already fetched them and its answer is reused.",
    ),
  check_fragments: z
    .boolean()
    .default(true)
    .describe(
      "Check that a link into this same page (`#pricing`) actually points at an element. Nothing over HTTP can " +
        "catch this: the page loads fine and the visitor simply does not arrive where the link said.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_LINK_TIMEOUT_MS)
    .max(MAX_LINK_TIMEOUT_MS)
    .default(DEFAULT_LINK_TIMEOUT_MS)
    .describe("How long one link has to answer before it is reported as timed out"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINK_CONCURRENCY)
    .default(DEFAULT_LINK_CONCURRENCY)
    .describe("How many links to check at once. Lower it if a host starts answering 429."),
  max_links: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINKS_CAP)
    .default(DEFAULT_MAX_LINKS)
    .describe("Distinct addresses to check. Links come before resources, so the cap is spent on links first."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_LINK_PAGES)
    .default(DEFAULT_LINK_PAGES)
    .describe("Pages to open when `depth` is above 0, including the one you named"),
  selector: z
    .string()
    .optional()
    .describe("Only collect links inside this container, e.g. 'main' or 'footer'"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_LINKS_WAIT_MS)
    .describe("Wait time (ms) after each page load before its links are read, so a client-rendered app can finish"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) after each load"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  full_page: z
    .boolean()
    .default(false)
    .describe("Photograph the whole document instead of the viewport, so broken links below the fold are visible too"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  storage_state: storageStateField,
};

export const linksInputSchema = z.object(linksInputShape);
export type LinksInput = z.input<typeof linksInputSchema>;
type ParsedLinksInput = z.output<typeof linksInputSchema>;

/* ── What one run collects ────────────────────────────────────────────── */

/** Where one address was written down. */
interface Occurrence {
  page_url: string;
  description: string;
  selector: string;
  match_index: number;
  role: LinkRole;
  tag: string;
}

/** One distinct address, and every place it appears. */
interface Target {
  key: string;
  /** The address as it will be printed and requested. */
  url: string;
  occurrences: Occurrence[];
  external: boolean;
  role: LinkRole;
  outcome?: CheckOutcome;
  verdict?: LinkVerdict;
}

/** An address that was never requested, and why not. */
interface Skipped {
  key: string;
  display: string;
  reason: string;
  occurrences: Occurrence[];
  /** Worth leading with: an empty href or a malformed URL is a bug, not a decision. */
  suspect: boolean;
}

/** A `#fragment` on this page that points at no element. */
interface DeadFragment {
  fragment: string;
  page_url: string;
  occurrences: Occurrence[];
}

/** Everything one run produced. */
interface Crawl {
  targets: Target[];
  skipped: Skipped[];
  dead_fragments: DeadFragment[];
  /** Fragments that were checked and did resolve — counted, not listed. */
  fragments_ok: number;
  /** Href occurrences collected, before they were grouped by address. */
  found: number;
  pages: string[];
  /** Pages that could not be opened during a crawl, after the first one. */
  unreachable_pages: { url: string; error: string }[];
  /** Distinct addresses past `max_links`. */
  over_cap: number;
  png?: Buffer;
  unhighlighted: number;
}

/**
 * Check every link on a page — and, on request, every link on the pages it
 * leads to — and report the ones that do not work.
 *
 * The page is read after it has rendered rather than from its HTML source, so
 * a client-rendered app is checked properly instead of being reported as
 * having no links. The checks go out through the browser context, carrying the
 * same cookies as the page, so a link behind a login is checked as the
 * signed-in visitor sees it.
 *
 * Three things separate this from a HEAD loop. A HEAD that fails is retried as
 * a GET before anything is called broken, because a great many servers refuse
 * the method and serve the URL perfectly well. A status that means "I will not
 * answer that" (401, 403, 429) is reported apart from one that means "there is
 * nothing here", because a report that cries wolf gets ignored. And a
 * same-page `#fragment` is checked against the document, which is the one
 * broken link no HTTP check can ever find.
 */
export async function checkLinks(rawInput: LinksInput): Promise<CallToolResult> {
  const parsed = linksInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Link check failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  let contextOptions = {};
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    if (auth) contextOptions = { storageState: auth.state };
  } catch (error) {
    return errorResult(`Link check of ${input.url} failed: ${firstLine(error)}`);
  }

  let crawl: Crawl;
  try {
    crawl = await withPage({ viewport, contextOptions }, (page, context) => runCrawl(input, page, context));
  } catch (error) {
    return errorResult(describeLinksFailure(input, error));
  }

  return withAuthNote(await render(input, crawl), auth);
}

/* ── The crawl ────────────────────────────────────────────────────────── */

async function runCrawl(input: ParsedLinksInput, page: Page, context: BrowserContext): Promise<Crawl> {
  const watch = watchLoads(page);
  const targets = new Map<string, Target>();
  const skipped = new Map<string, Skipped>();
  const deadFragments = new Map<string, DeadFragment>();
  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: input.url, depth: 0 }];
  const pages: string[] = [];
  const unreachablePages: { url: string; error: string }[] = [];
  let found = 0;
  let fragmentsOk = 0;
  let overCap = 0;

  const note = (map: Map<string, Skipped>, key: string, display: string, reason: string, suspect: boolean, where: Occurrence): void => {
    const existing = map.get(key);
    if (existing) existing.occurrences.push(where);
    else map.set(key, { key, display, reason, occurrences: [where], suspect });
  };

  try {
    while (queue.length > 0 && pages.length < input.max_pages) {
      const { url, depth } = queue.shift()!;
      const pageKey = dedupeKey(url);
      if (visited.has(pageKey)) continue;
      visited.add(pageKey);

      try {
        await load(input, page, url);
      } catch (error) {
        // The page the caller named is the whole run; anything found later is
        // one page of many and is reported rather than thrown.
        if (pages.length === 0) throw error;
        unreachablePages.push({ url, error: firstLine(error) });
        continue;
      }

      const pageUrl = safely(() => page.url()) ?? url;
      pages.push(pageUrl);

      const raw = await collectLinks(page, {
        ...(input.selector !== undefined ? { selector: input.selector } : {}),
        include_resources: input.include_resources,
      });
      found += raw.length;

      const wantedFragments = new Map<string, Occurrence[]>();
      const fresh: Target[] = [];

      for (const link of raw) {
        const where = occurrenceOf(link, pageUrl);
        const classified = classifyHref(link.href, pageUrl);

        switch (classified.kind) {
          case "http": {
            const external = !isInternal(classified.resolved!, pageUrl);
            if (external && !input.check_external) {
              note(skipped, `external:${dedupeKey(classified.resolved!)}`, classified.resolved!, "another origin, and `check_external` is off", false, where);
              continue;
            }
            const key = dedupeKey(classified.resolved!);
            const existing = targets.get(key);
            if (existing) {
              existing.occurrences.push(where);
              // A link matters more than a resource: if the same address is
              // both, it is reported as the link.
              if (where.role === "link") existing.role = "link";
              continue;
            }
            if (targets.size >= input.max_links) {
              overCap++;
              continue;
            }
            const target: Target = { key, url: key, occurrences: [where], external, role: where.role };
            targets.set(key, target);
            fresh.push(target);
            continue;
          }
          case "same_page": {
            const fragment = classified.fragment ?? "";
            if (!input.check_fragments) {
              note(skipped, `fragment:${pageUrl}#${fragment}`, `#${fragment}`, "a link into this page, and `check_fragments` is off", false, where);
              continue;
            }
            const list = wantedFragments.get(fragment) ?? [];
            list.push(where);
            wantedFragments.set(fragment, list);
            continue;
          }
          case "empty":
          case "malformed":
          case "javascript":
            note(skipped, `${classified.kind}:${link.href}`, link.href || "(an empty href)", classified.reason ?? classified.kind, classified.kind !== "javascript", where);
            continue;
          default: {
            const display = link.href;
            note(skipped, `${classified.kind}:${display}`, display, classified.reason ?? `a ${classified.kind}: link, which no checker can follow`, classified.reason !== undefined, where);
            continue;
          }
        }
      }

      if (wantedFragments.size > 0) {
        // `#` and `#top` are the top of the document in every browser and need
        // no element; everything else has to be found in the DOM.
        const wanted = [...wantedFragments.keys()].filter((fragment) => !isAlwaysValidFragment(fragment));
        const present = new Set([
          ...(await findFragmentTargets(page, wanted)),
          ...[...wantedFragments.keys()].filter(isAlwaysValidFragment),
        ]);
        for (const [fragment, occurrences] of wantedFragments) {
          if (present.has(fragment)) {
            // Counted per distinct fragment, not per link: three anchors to
            // #pricing are one thing that either resolves or does not.
            fragmentsOk++;
            continue;
          }
          const key = `${pageUrl}#${fragment}`;
          const existing = deadFragments.get(key);
          if (existing) existing.occurrences.push(...occurrences);
          else deadFragments.set(key, { fragment, page_url: pageUrl, occurrences });
        }
      }

      // Checked here rather than at the end, because what comes back decides
      // what is worth opening next: a 404 is not a page to crawl, and neither
      // is a PDF.
      await runPool(fresh, input.concurrency, async (target) => {
        const observed = target.role === "resource" ? watch.get(target.url) : undefined;
        const outcome: CheckOutcome = observed
          ? {
              chain: observed.chain.length > 0 ? observed.chain : [target.url],
              ...(observed.status !== undefined ? { status: observed.status } : {}),
              ...(observed.failure !== undefined ? { error: observed.failure } : {}),
              method: "GET",
              observed: true,
            }
          : await checkUrl(context, target.url, { timeout_ms: input.timeout_ms });
        target.outcome = outcome;
        target.verdict = judgeCheck(outcome);
      });

      if (depth < input.depth) {
        for (const target of fresh) {
          if (target.external || target.role !== "link") continue;
          if (target.verdict === undefined || (target.verdict.category !== "ok" && target.verdict.category !== "redirect")) continue;
          // Only a document is worth opening. An internal link to a PDF or a
          // zip answers perfectly well and has no links on it.
          if (!/html/i.test(target.outcome?.content_type ?? "")) continue;
          const next = target.verdict.final_url ?? target.url;
          if (visited.has(dedupeKey(next))) continue;
          queue.push({ url: next, depth: depth + 1 });
        }
      }
    }

    const crawl: Crawl = {
      targets: [...targets.values()],
      skipped: [...skipped.values()],
      dead_fragments: [...deadFragments.values()],
      fragments_ok: fragmentsOk,
      found,
      pages,
      unreachable_pages: unreachablePages,
      over_cap: overCap,
      unhighlighted: 0,
    };

    const marked = await drawFindings(input, page, crawl, pages[0]);
    if (marked.png) crawl.png = marked.png;
    crawl.unhighlighted = marked.unhighlighted;

    return crawl;
  } finally {
    watch.detach();
  }
}

/** Open a page the way every other tool does, so `wait_for` means the same thing everywhere. */
async function load(input: ParsedLinksInput, page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  if (input.wait_for) {
    await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
  }
  if (input.wait_ms > 0) {
    await page.waitForTimeout(input.wait_ms);
  }
}

/**
 * Put the entry page back on screen and box everything on it that failed.
 *
 * A selector says nothing about where the problem is; a picture of the page
 * with the broken links outlined says it immediately. Only the entry page is
 * marked up — a crawl of ten pages would otherwise return ten screenshots —
 * and nothing is photographed at all when there is nothing to mark.
 */
async function drawFindings(
  input: ParsedLinksInput,
  page: Page,
  crawl: Crawl,
  entryUrl: string,
): Promise<{ png?: Buffer; unhighlighted: number }> {
  const failing = crawl.targets.filter((target) => FAILED.has(target.verdict?.category ?? "ok"));
  const boxes: { selector: string; match_index: number; broken: boolean }[] = [];
  for (const target of failing) {
    for (const where of target.occurrences) {
      if (!boxable(where, entryUrl)) continue;
      boxes.push({ selector: where.selector, match_index: where.match_index, broken: true });
    }
  }
  for (const fragment of crawl.dead_fragments) {
    if (fragment.page_url !== entryUrl) continue;
    for (const where of fragment.occurrences) {
      if (!boxable(where, entryUrl)) continue;
      boxes.push({ selector: where.selector, match_index: where.match_index, broken: false });
    }
  }
  if (boxes.length === 0) return { unhighlighted: 0 };

  try {
    if (safely(() => page.url()) !== entryUrl) await load(input, page, entryUrl);
  } catch {
    // The entry page will not open a second time; the report stands without a
    // picture of it.
    return { unhighlighted: boxes.length };
  }

  const highlights: Highlight[] = boxes.slice(0, MAX_HIGHLIGHTS).map((box, index) => ({
    selector: box.selector,
    match_index: box.match_index,
    label: String(index + 1),
    colour: box.broken ? HIGHLIGHT_DEAD_COLOUR : HIGHLIGHT_BROKEN_COLOUR,
    wash: box.broken ? "rgba(229, 25, 75, 0.16)" : "rgba(240, 140, 0, 0.16)",
  }));
  const drawn = await highlightElements(page, highlights);
  const png = await safeScreenshot(page, input.full_page);
  return { ...(png ? { png } : {}), unhighlighted: boxes.length - drawn.drawn.length };
}

/**
 * Elements that never have a box to draw over.
 *
 * A broken stylesheet is a real finding and lives in `<head>`, where it has no
 * geometry at all. Asking for a box over one is not a near miss to be counted
 * and explained — it is a question with no answer, so it is never asked.
 */
const UNRENDERED = new Set(["script", "link", "meta", "source", "track", "base"]);

/** Can this occurrence be pointed at in a screenshot of the entry page? */
function boxable(where: Occurrence, entryUrl: string): boolean {
  return where.page_url === entryUrl && where.selector !== "" && !UNRENDERED.has(where.tag);
}

/** Categories that mean the link does not work for a visitor. */
const FAILED: ReadonlySet<LinkCategory> = new Set<LinkCategory>(["broken", "timeout", "error"]);

function occurrenceOf(link: RawLink, pageUrl: string): Occurrence {
  return {
    page_url: pageUrl,
    description: link.description,
    selector: link.selector,
    match_index: link.match_index,
    role: link.role,
    tag: link.tag,
  };
}

/** Run `worker` over `items`, `limit` at a time. Every one of these is a real request. */
async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/* ── Rendering ────────────────────────────────────────────────────────── */

async function render(input: ParsedLinksInput, crawl: Crawl): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: formatCrawl(input, crawl) }];

  if (crawl.png) {
    try {
      content.push({ type: "image", data: toBase64(await resizeForOutput(crawl.png)), mimeType: "image/png" });
      content.push({
        type: "text",
        text:
          `${crawl.pages[0]}, with every link that failed boxed in red and every dead fragment in orange, ` +
          "numbered in the order they appear above." +
          (crawl.unhighlighted > 0
            ? ` ${crawl.unhighlighted} could not be boxed — those elements are hidden, or the page had re-rendered by the time the overlay was drawn.`
            : ""),
      });
    } catch {
      // Measured already; failing to re-encode the frame is not worth failing
      // the check for.
    }
  }

  return { content };
}

function formatCrawl(input: ParsedLinksInput, crawl: Crawl): string {
  const of = (category: LinkCategory): Target[] => crawl.targets.filter((t) => t.verdict?.category === category);
  const broken = of("broken");
  const timedOut = of("timeout");
  const unreachable = of("error");
  const redirected = of("redirect");
  const blocked = of("blocked");
  const working = of("ok");
  const notChecked = crawl.skipped.length + crawl.over_cap;

  const lines: string[] = [];
  const counts = [
    `${broken.length} broken`,
    ...(timedOut.length > 0 ? [`${timedOut.length} timed out`] : []),
    ...(unreachable.length > 0 ? [`${unreachable.length} unreachable`] : []),
    ...(crawl.dead_fragments.length > 0 ? [`${count(crawl.dead_fragments.length, "dead fragment")}`] : []),
    ...(redirected.length > 0 ? [`${redirected.length} redirected`] : []),
    ...(blocked.length > 0 ? [`${blocked.length} blocked`] : []),
    `${working.length} working`,
    ...(notChecked > 0 ? [`${notChecked} not checked`] : []),
  ];

  lines.push(
    `Link check of ${input.url} — ${count(crawl.found, "link")} found on ` +
      `${count(crawl.pages.length, "page")} (${unique(crawl)} unique), ${counts.join(", ")}.`,
  );

  if (crawl.found === 0) {
    lines.push("Nothing on this page points anywhere — no link, image, script or stylesheet.");
    return lines.join("\n");
  }

  const failures = broken.length + timedOut.length + unreachable.length + crawl.dead_fragments.length;
  if (failures === 0) {
    lines.push("Every link that could be checked answered.");
  }
  if (crawl.fragments_ok > 0) {
    lines.push(
      `${count(crawl.fragments_ok, "same-page fragment")} resolved against the document rather than over HTTP.`,
    );
  }
  for (const page of crawl.unreachable_pages) {
    lines.push(`The crawl could not open ${elide(page.url, MAX_LINK_URL_LENGTH)} — ${page.error}`);
  }

  section(lines, `Broken (${broken.length})`, broken, crawl);
  section(lines, `Timed out (${timedOut.length})`, timedOut, crawl);
  section(lines, `Could not be reached (${unreachable.length})`, unreachable, crawl);

  if (crawl.dead_fragments.length > 0) {
    lines.push("");
    lines.push(`Fragments that point at nothing (${crawl.dead_fragments.length}):`);
    for (const fragment of crawl.dead_fragments.slice(0, MAX_LINKS_LISTED)) {
      lines.push(`  #${fragment.fragment} — no element on the page has that id, and no <a name> either`);
      for (const line of sourceLines(fragment.occurrences, crawl)) lines.push(line);
    }
    if (crawl.dead_fragments.length > MAX_LINKS_LISTED) {
      lines.push(`  … and ${crawl.dead_fragments.length - MAX_LINKS_LISTED} more`);
    }
  }

  section(lines, `Redirected (${redirected.length})`, redirected, crawl);
  section(
    lines,
    `Blocked — the server refused the check, not necessarily the link (${blocked.length})`,
    blocked,
    crawl,
  );

  if (crawl.skipped.length > 0 || crawl.over_cap > 0) {
    lines.push("");
    lines.push(`Not checked (${notChecked}):`);
    const ordered = [...crawl.skipped].sort((a, b) => Number(b.suspect) - Number(a.suspect));
    for (const entry of ordered.slice(0, MAX_LINKS_LISTED)) {
      lines.push(`  ${elide(entry.display, MAX_LINK_URL_LENGTH)} — ${entry.reason}`);
      for (const line of sourceLines(entry.occurrences, crawl)) lines.push(line);
    }
    if (ordered.length > MAX_LINKS_LISTED) {
      lines.push(`  … and ${ordered.length - MAX_LINKS_LISTED} more`);
    }
    if (crawl.over_cap > 0) {
      lines.push(
        `  ${count(crawl.over_cap, "address")} past \`max_links\` (${input.max_links}) — raise it, or narrow ` +
          "the run with `selector`.",
      );
    }
  }

  if (working.length > 0) {
    lines.push("");
    lines.push(`Working (${working.length}):`);
    for (const target of working.slice(0, MAX_LINKS_LISTED)) {
      lines.push(`  ${elide(target.url, MAX_LINK_URL_LENGTH)} — ${detailOf(target)}`);
    }
    if (working.length > MAX_LINKS_LISTED) {
      lines.push(`  … and ${working.length - MAX_LINKS_LISTED} more that answered`);
    }
  }

  return lines.join("\n");
}

/**
 * Distinct addresses this run reached a verdict on.
 *
 * Everything that was judged, however it was judged: requested, refused,
 * skipped for a reason, or looked up in the document. Leaving the fragments
 * out would make the number quietly disagree with the sections beneath it.
 */
function unique(crawl: Crawl): number {
  return crawl.targets.length + crawl.skipped.length + crawl.dead_fragments.length + crawl.fragments_ok;
}

/** One section of the report: the address, where it was written, and what to do. */
function section(lines: string[], heading: string, targets: Target[], crawl: Crawl): void {
  if (targets.length === 0) return;
  lines.push("");
  lines.push(`${heading}:`);
  for (const target of targets.slice(0, MAX_LINKS_LISTED)) {
    lines.push(`  ${elide(target.url, MAX_LINK_URL_LENGTH)} — ${detailOf(target)}`);
    for (const line of sourceLines(target.occurrences, crawl)) lines.push(line);
    const fix = target.verdict?.fix;
    if (fix) lines.push(`    → ${fix}`);
  }
  if (targets.length > MAX_LINKS_LISTED) {
    lines.push(`  … and ${targets.length - MAX_LINKS_LISTED} more`);
  }
}

/**
 * What happened, plus a note when the answer came from the browser rather than
 * from a request of this tool's own — the two are not quite the same claim,
 * and the difference matters when they disagree with a curl.
 */
function detailOf(target: Target): string {
  const detail = target.verdict?.detail ?? "no verdict";
  return target.outcome?.observed === true ? `${detail} (seen when the page loaded it)` : detail;
}

/** `from a "Pricing" (#nav-pricing)`, naming the page too once there is more than one. */
function sourceLines(occurrences: Occurrence[], crawl: Crawl): string[] {
  const lines: string[] = [];
  const multipage = crawl.pages.length > 1;
  for (const where of occurrences.slice(0, MAX_LINK_SOURCES_LISTED)) {
    const selector = where.selector === "" ? "" : ` (${elide(where.selector, MAX_LINK_SELECTOR_LENGTH)})`;
    const page = multipage ? ` on ${elide(where.page_url, MAX_LINK_URL_LENGTH)}` : "";
    lines.push(`    from ${where.description}${selector}${page}`);
  }
  if (occurrences.length > MAX_LINK_SOURCES_LISTED) {
    lines.push(`    … and ${occurrences.length - MAX_LINK_SOURCES_LISTED} more places`);
  }
  return lines;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** A screenshot is always worth having and never worth failing the check over. */
async function safeScreenshot(page: Page, fullPage: boolean): Promise<Buffer | undefined> {
  try {
    if (page.isClosed()) return undefined;
    return await page.screenshot({ type: "png", fullPage });
  } catch {
    return undefined;
  }
}

function elide(value: string, max: number): string {
  const flat = String(value).replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a check that could not run. Mirrors `describeFailure`
 * in screenshot.ts: match on the failing Playwright call, never on substrings
 * of a user-supplied selector.
 */
export function describeLinksFailure(
  input: { url: string; wait_for?: string; wait_for_timeout_ms: number },
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = firstLine(message);
  const prefix = `Link check of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${line})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  if (/^page\.goto:/.test(message)) {
    return `${prefix} the page could not be opened — ${line}`;
  }
  return `${prefix} ${line}`;
}

export function registerLinksTool(server: McpServer): void {
  server.registerTool(
    LINKS_TOOL_NAME,
    {
      title: "Links",
      description:
        "Check every link on a page and report the ones that do not work: 404s, server errors, redirect " +
        "chains, redirects that end on an error page, hosts that never answer, and `#fragment` links that " +
        "point at no element on the page. Links are read from the rendered DOM, so a client-rendered app is " +
        "checked properly. What the page loads for itself — images, scripts, stylesheets, iframes — is checked " +
        "too, reusing the browser's own result rather than requesting it again. A HEAD that fails is retried " +
        "as a GET before anything is called broken, and a 401/403/429 is reported as a refused check rather " +
        "than a broken link. Set `depth` above 0 to follow the site's own internal links a level at a time. " +
        "Returns the findings grouped by what went wrong, plus a screenshot of the page with the failing " +
        "links boxed. NOTE: with `check_external` on this sends requests to third-party servers.",
      inputSchema: linksInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => checkLinks(args),
  );
}
