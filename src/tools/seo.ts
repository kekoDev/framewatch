import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SEO_WAIT_MS,
  DEFAULT_VIEWPORT,
  MAX_SEO_HEADINGS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  PERF_INIT_SCRIPT,
  extractSeo,
  fetchRobots,
  probeImage,
  readPerformance,
  type ImageProbe,
  type PageSeo,
  type PerfMetrics,
  type RobotsFetch,
} from "../engine/seo.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import {
  SEO_AREAS,
  judgeSeo,
  metaValues,
  type SeoArea,
  type SeoFinding,
  type SeoLevel,
  type SeoReport,
  type SeoResponseInfo,
} from "../utils/seo-rules.js";
import { resolveStorageState, storageStateField, withAuthNote } from "../utils/storage-state.js";

export const SEO_TOOL_NAME = "framewatch_seo";

export const seoInputShape = {
  url: z.string().url().describe("URL to audit, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_SEO_WAIT_MS)
    .describe("Wait time (ms) after page load before reading the page, so a client-rendered app can finish"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before reading the page"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  check_robots: z
    .boolean()
    .default(true)
    .describe("Fetch /robots.txt and work out whether this page's own path is crawlable"),
  robots_user_agent: z
    .string()
    .min(1)
    .default("Googlebot")
    .describe("Which crawler to answer the robots.txt question for. A named group beats the `*` group, as it does for the real thing."),
  check_og_image: z
    .boolean()
    .default(true)
    .describe("Fetch the og:image and measure it — a share image that 404s or is too small is invisible from the page itself"),
  include_performance: z
    .boolean()
    .default(false)
    .describe(
      "Also measure this load: LCP, CLS, TTFB, page weight and DOM size. Lab numbers from one headless load, " +
        "useful for finding the slow element, not a prediction of field data.",
    ),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  storage_state: storageStateField,
};

export const seoInputSchema = z.object(seoInputShape);
export type SeoInput = z.input<typeof seoInputSchema>;
type ParsedSeoInput = z.output<typeof seoInputSchema>;

/** Everything one audit gathered, before anything judges it. */
interface Gathered {
  page: PageSeo;
  response?: SeoResponseInfo;
  robots?: RobotsFetch;
  og_image?: ImageProbe;
  performance?: PerfMetrics;
}

/**
 * Audit what a search engine — and a link preview — would make of a page.
 *
 * Everything is read from the *rendered* document rather than the HTML source.
 * A single-page app ships an empty `<div id="app">` and fills in the title,
 * the description and the structured data afterwards, so reading the source
 * would report every client-rendered page as having no SEO at all, which is
 * both wrong and the opposite of useful.
 *
 * Three things are checked that are not on the page and cannot be seen from
 * it: the response headers (an `X-Robots-Tag: noindex` is invisible in the
 * DOM), robots.txt (a page can be perfect and simply not crawlable), and the
 * share image itself, which is fetched and measured — an `og:image` pointing
 * at a 404 looks exactly like a working one until somebody shares the link.
 */
export async function auditSeo(rawInput: SeoInput): Promise<CallToolResult> {
  const parsed = seoInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`SEO audit failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  let contextOptions = {};
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    if (auth) contextOptions = { storageState: auth.state };
  } catch (error) {
    return errorResult(`SEO audit of ${input.url} failed: ${firstLine(error)}`);
  }

  let gathered: Gathered;
  try {
    gathered = await withPage({ viewport, contextOptions }, (page, context) => gather(input, page, context));
  } catch (error) {
    return errorResult(describeSeoFailure(input, error));
  }

  const report = judgeSeo({
    requested_url: input.url,
    page: gathered.page,
    robots_user_agent: input.robots_user_agent,
    ...(gathered.response ? { response: gathered.response } : {}),
    ...(gathered.robots ? { robots: gathered.robots } : {}),
    ...(gathered.og_image ? { og_image: gathered.og_image } : {}),
    ...(gathered.performance ? { performance: gathered.performance } : {}),
  });

  return withAuthNote(await render(gathered, report), auth);
}

/** Open the page and collect everything the audit needs from it. */
async function gather(input: ParsedSeoInput, page: Page, context: BrowserContext): Promise<Gathered> {
  // The observers have to exist before the navigation: LCP, CLS and long
  // tasks are only observable as they happen.
  if (input.include_performance) await page.addInitScript(PERF_INIT_SCRIPT);

  const response = await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  if (input.wait_for) {
    await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
  }
  if (input.wait_ms > 0) {
    await page.waitForTimeout(input.wait_ms);
  }

  const seo = await extractSeo(page);
  const gathered: Gathered = { page: seo };

  if (response) {
    gathered.response = { status: response.status(), headers: response.headers() };
  }
  if (input.include_performance) {
    const metrics = await readPerformance(page);
    if (metrics) gathered.performance = metrics;
  }
  if (input.check_robots) {
    gathered.robots = await fetchRobots(context, seo.url);
  }
  if (input.check_og_image) {
    const target = resolveUrl(metaValues(seo, "og:image")[0], seo.url);
    if (target) gathered.og_image = await probeImage(context, target);
  }

  return gathered;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

const AREA_TITLES: Readonly<Record<SeoArea, string>> = {
  indexing: "Indexing",
  content: "Title & description",
  headings: "Headings",
  social: "Social (Open Graph)",
  images: "Images",
  structured_data: "Structured data",
  performance: "Performance (lab)",
};

const MARKS: Readonly<Record<SeoLevel, string>> = {
  problem: "✗",
  warning: "!",
  pass: "✓",
  info: "·",
};

async function render(gathered: Gathered, report: SeoReport): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: formatSeoReport(gathered.page, report) }];

  // The share image is worth looking at, not only measuring: whether the logo
  // is cropped or the text unreadable at card size is not a thing any header
  // can answer.
  const probe = gathered.og_image;
  if (probe?.data) {
    try {
      const resized = await resizeForOutput(probe.data);
      content.push({ type: "image", data: toBase64(resized), mimeType: "image/png" });
      content.push({
        type: "text",
        text: `og:image — ${probe.url} (${probe.width}x${probe.height}${probe.content_type ? `, ${probe.content_type}` : ""}), as it will appear when the page is shared.`,
      });
    } catch {
      // Measured already; failing to re-encode it is not worth failing the audit for.
    }
  }

  return { content };
}

/**
 * The report as text: a verdict line, the problems up front, then every check
 * in the order it was run.
 *
 * Passing checks are printed rather than counted. A report of four lines with
 * nothing else in it is otherwise indistinguishable from an audit that only
 * looked at four things.
 */
export function formatSeoReport(page: PageSeo, report: SeoReport): string {
  const lines: string[] = [];

  lines.push(
    `SEO audit of ${page.url} — ${count(report.problems, "problem")}, ${count(report.warnings, "warning")}, ` +
      `${report.passes} ${report.passes === 1 ? "check" : "checks"} passed.`,
  );

  const problems = report.findings.filter((finding) => finding.level === "problem");
  if (problems.length > 0) {
    lines.push(`Problems: ${problems.map((finding) => `${finding.label} (${headline(finding)})`).join("; ")}`);
  } else {
    lines.push("Nothing here would keep this page out of an index or break its share card.");
  }

  for (const area of SEO_AREAS) {
    const findings = report.findings.filter((finding) => finding.area === area);
    if (findings.length === 0) continue;
    lines.push("");
    lines.push(AREA_TITLES[area]);
    for (const finding of findings) {
      lines.push(`  ${MARKS[finding.level]} ${finding.label} — ${finding.detail}`);
      if (finding.fix) lines.push(`      → ${finding.fix}`);
    }
    if (area === "headings" && page.headings.length > 0) {
      lines.push("  Outline:");
      for (const heading of page.headings) {
        const indent = "  ".repeat(Math.max(0, heading.level - 1));
        const text = heading.empty ? "(empty)" : heading.text;
        lines.push(`    ${indent}h${heading.level} ${text}${heading.hidden ? " (hidden)" : ""}`);
      }
      if (page.heading_total > page.headings.length) {
        lines.push(`    … and ${page.heading_total - page.headings.length} more headings (the first ${MAX_SEO_HEADINGS} are listed)`);
      }
    }
  }

  return lines.join("\n");
}

/** The short form of a finding, for the problems line at the top. */
function headline(finding: SeoFinding): string {
  const [first] = finding.detail.split(" — ");
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Resolve a possibly relative URL against the page. Returns undefined for anything unusable. */
function resolveUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const resolved = new URL(href, base);
    // A data: URI is already the image; there is nothing to fetch and nothing
    // a network could fail to load.
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : undefined;
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
 * One actionable line for an audit that could not run. Mirrors
 * `describeFailure` in screenshot.ts: match on the failing Playwright call,
 * never on substrings of a user-supplied selector.
 */
export function describeSeoFailure(
  input: { url: string; wait_for?: string; wait_for_timeout_ms: number },
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0];
  const prefix = `SEO audit of ${input.url} failed:`;

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

export function registerSeoTool(server: McpServer): void {
  server.registerTool(
    SEO_TOOL_NAME,
    {
      title: "SEO",
      description:
        "Audit what a search engine and a link preview would make of a page: title and meta description (with " +
        "lengths), canonical, robots directives and robots.txt, Open Graph and Twitter card tags, the heading " +
        "outline, images with no alt text, and JSON-LD structured data checked against what Google's rich " +
        "results require. Everything is read from the rendered DOM, so a client-rendered app is measured " +
        "properly rather than reported as empty. The og:image is fetched and measured — a share image that " +
        "404s or is too small is invisible from the page itself — and comes back as an image to look at. " +
        "Set `include_performance: true` to add LCP, CLS, TTFB, page weight and DOM size from the same load.",
      inputSchema: seoInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => auditSeo(args),
  );
}
