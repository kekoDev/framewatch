import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Frame, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  A11Y_FRAME_WAIT_MS,
  A11Y_RUN_TIMEOUT_MS,
  DEFAULT_A11Y_WAIT_MS,
  DEFAULT_VIEWPORT,
  MAX_A11Y_HTML_LENGTH,
  MAX_A11Y_NODES_PER_VIOLATION,
  MAX_A11Y_VIOLATIONS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import { resolveStorageState, storageStateField, withAuthNote } from "../utils/storage-state.js";

export const ACCESSIBILITY_TOOL_NAME = "framewatch_accessibility";

/** WCAG conformance levels, and the axe-core tags each one runs. */
const STANDARDS = {
  wcag2a: ["wcag2a"],
  wcag2aa: ["wcag2a", "wcag2aa"],
  wcag21aa: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
} as const;

export type A11yStandard = keyof typeof STANDARDS;

/** Worst first — this is the order violations are reported in. */
const IMPACT_ORDER = ["critical", "serious", "moderate", "minor"] as const;

export const accessibilityInputShape = {
  url: z.string().url().describe("URL to audit, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  standard: z
    .enum(["wcag2a", "wcag2aa", "wcag21aa"])
    .default("wcag2aa")
    .describe("Conformance level to test against. wcag2aa is the usual legal baseline; wcag21aa adds WCAG 2.1."),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_A11Y_WAIT_MS)
    .describe("Wait time (ms) after page load before auditing, so the app can finish rendering"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before auditing"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  max_violations: z
    .number()
    .int()
    .min(1)
    .max(MAX_A11Y_VIOLATIONS)
    .default(MAX_A11Y_VIOLATIONS)
    .describe("Maximum violation types to report (they are reported worst-impact first)"),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(MAX_A11Y_NODES_PER_VIOLATION)
    .describe("Maximum offending elements listed under each violation"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720). Some rules — reflow, target size — depend on it."),
  storage_state: storageStateField,
};

export const accessibilityInputSchema = z.object(accessibilityInputShape);
export type AccessibilityInput = z.input<typeof accessibilityInputSchema>;

/** The trimmed shape the in-page script sends back — never raw axe results. */
interface AxeNode {
  target: string;
  html: string;
  summary: string;
}

interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  description: string;
  help_url: string;
  tags: string[];
  node_count: number;
  nodes: AxeNode[];
}

interface AxeReport {
  violations: AxeViolation[];
  /** Rules that passed, that found nothing to test, and that need a human. */
  passes: number;
  inapplicable: number;
  incomplete: number;
  /** Total violation types found, before `max_violations` trimmed the list. */
  total_violations: number;
  /** Offending elements across every violation, including those not listed. */
  total_nodes: number;
  url: string;
  axe_version: string;
}

/**
 * Run an axe-core accessibility audit and report what it found.
 *
 * axe is injected into the page rather than reimplemented: it is the engine
 * behind most commercial accessibility tooling, so a violation reported here
 * is one an auditor would also raise. It is injected as a script through
 * `evaluate`, into a context created with CSP bypassed, so a page with a
 * strict Content-Security-Policy can still be audited.
 *
 * Only violations come back. Passing rules are counted, not listed — a list of
 * two hundred rules that did not fire is noise, but the count is what tells
 * you the audit actually ran.
 */
export async function auditAccessibility(rawInput: AccessibilityInput): Promise<CallToolResult> {
  const parsed = accessibilityInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Accessibility audit failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  let source: string;
  try {
    source = axeSource();
  } catch (error) {
    return errorResult(
      "Accessibility audit failed: the axe-core library could not be loaded from this installation " +
        `(${error instanceof Error ? error.message : String(error)}). Reinstall dependencies and try again.`,
    );
  }

  try {
    // `bypassCSP` so the audit can be injected into an app that forbids
    // inline script and eval. The page's own CSP has no bearing on what axe
    // measures, and without this a strictly configured app could not be
    // audited at all.
    const auth = await resolveStorageState(input.storage_state);
    const contextOptions = {
      bypassCSP: true,
      ...(auth ? { storageState: auth.state } : {}),
    };
    const report = await withPage({ viewport, contextOptions }, async (page) => {
      await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      if (input.wait_for) {
        await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
      }
      if (input.wait_ms > 0) {
        await page.waitForTimeout(input.wait_ms);
      }
      await injectAxe(page, source);
      // axe walks the whole DOM; on a big enough app that takes a while, and
      // `page.evaluate` has no timeout of its own — a page that wedges
      // mid-audit would otherwise hang the tool call forever.
      return withTimeout(
        runAxe(page, {
          tags: [...STANDARDS[input.standard]],
          max_violations: input.max_violations,
          max_elements: input.max_elements,
          max_html: MAX_A11Y_HTML_LENGTH,
          frame_wait_ms: A11Y_FRAME_WAIT_MS,
        }),
        A11Y_RUN_TIMEOUT_MS,
        `axe-core did not finish within ${A11Y_RUN_TIMEOUT_MS}ms`,
      );
    });

    return withAuthNote({ content: [{ type: "text", text: formatReport(report, input.standard) }] }, auth);
  } catch (error) {
    return errorResult(describeAuditFailure(input, error));
  }
}

/** Options handed to the in-page runner. Must stay JSON-serialisable. */
interface RunOptions {
  tags: string[];
  max_violations: number;
  max_elements: number;
  max_html: number;
  frame_wait_ms: number;
}

/**
 * Put axe in the main frame and in every child frame.
 *
 * axe audits iframes by talking to a copy of itself inside each one, so a page
 * that embeds anything (a preview pane, an embedded checkout) needs it
 * everywhere. Child frames are best-effort: one that refuses injection — it
 * may be mid-navigation, or gone by the time we reach it — must not stop the
 * audit of the page around it.
 */
async function injectAxe(page: Page, source: string): Promise<void> {
  await evaluateSource(page.mainFrame(), source);
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    await evaluateSource(frame, source).catch(() => {});
  }
}

/**
 * Evaluate the axe bundle as a script in `frame`.
 *
 * The source goes in as a *string*, which Playwright evaluates as a script in
 * the frame — no script tag to be blocked, and the audit context is created
 * with CSP bypassed so injection works on strictly configured apps too.
 *
 * `allowedOrigins` is widened because axe defaults to same-origin frame
 * messaging only, and a cross-origin iframe would otherwise never answer.
 */
async function evaluateSource(frame: Frame, source: string): Promise<void> {
  await frame.evaluate(source as unknown as () => void);
  await frame.evaluate(() => {
    const axe = (globalThis as any).axe;
    if (axe?.configure) axe.configure({ allowedOrigins: ["<unsafe_all_origins>"] });
  });
}

/**
 * Run axe in the page and bring back only what gets printed.
 *
 * The trimming happens in the page on purpose: a full axe result carries every
 * passing rule with every element it checked, which on a real app is megabytes
 * of JSON to serialise across the protocol and then throw away.
 */
async function runAxe(page: Page, options: RunOptions): Promise<AxeReport> {
  return page.evaluate(async (opts: RunOptions): Promise<AxeReport> => {
    const g = globalThis as any;
    const axe = g.axe;
    if (!axe?.run) throw new Error("axe-core did not load in the page");

    const results = await axe.run(g.document, {
      runOnly: { type: "tag", values: opts.tags },
      // Only violations are reported, so this is the only result type whose
      // element details need collecting.
      resultTypes: ["violations"],
      frameWaitTime: opts.frame_wait_ms,
    });

    const order = ["critical", "serious", "moderate", "minor"];
    const rank = (impact: string): number => {
      const at = order.indexOf(impact);
      return at === -1 ? order.length : at;
    };

    const all = (results.violations ?? []).slice().sort((a: any, b: any) => {
      const byImpact = rank(String(a.impact)) - rank(String(b.impact));
      if (byImpact !== 0) return byImpact;
      // Then by blast radius: the rule breaking twenty elements first.
      return (b.nodes?.length ?? 0) - (a.nodes?.length ?? 0);
    });

    const elide = (text: string): string => {
      const flat = String(text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return flat.length > opts.max_html ? `${flat.slice(0, opts.max_html)}…` : flat;
    };

    return {
      violations: all.slice(0, opts.max_violations).map((violation: any) => ({
        id: String(violation.id ?? "unknown"),
        impact: String(violation.impact ?? "unknown"),
        help: String(violation.help ?? ""),
        description: String(violation.description ?? ""),
        help_url: String(violation.helpUrl ?? ""),
        tags: (violation.tags ?? []).map((tag: unknown) => String(tag)),
        node_count: violation.nodes?.length ?? 0,
        nodes: (violation.nodes ?? []).slice(0, opts.max_elements).map((node: any) => ({
          target: (node.target ?? []).map((part: unknown) => String(part)).join(" "),
          html: elide(node.html),
          // The first line is the rule that failed for this element; the rest
          // repeats the violation's own help text.
          summary: elide(String(node.failureSummary ?? "").split("\n").slice(1).join(" ")),
        })),
      })),
      passes: results.passes?.length ?? 0,
      inapplicable: results.inapplicable?.length ?? 0,
      incomplete: results.incomplete?.length ?? 0,
      total_violations: all.length,
      total_nodes: all.reduce((sum: number, violation: any) => sum + (violation.nodes?.length ?? 0), 0),
      url: String(results.url ?? ""),
      axe_version: String(results.testEngine?.version ?? ""),
    };
  }, options);
}

/**
 * Render the report as text.
 *
 * Each violation gets its impact, the rule that failed, what to do about it,
 * the elements at fault and the URL of Deque's write-up — everything needed to
 * fix it without a second lookup.
 */
export function formatReport(report: AxeReport, standard: A11yStandard): string {
  const scope = `${standard.toUpperCase()} (axe-core ${report.axe_version || "?"})`;
  const lines: string[] = [];

  if (report.total_violations === 0) {
    lines.push(`No ${scope} violations on ${report.url}.`);
    lines.push(auditFooter(report));
    return lines.join("\n");
  }

  lines.push(
    `${report.total_violations} ${scope} violation ${report.total_violations === 1 ? "type" : "types"} on ${report.url}, ` +
      `affecting ${report.total_nodes} ${report.total_nodes === 1 ? "element" : "elements"} — ${countByImpact(report)}.`,
  );
  lines.push(auditFooter(report));
  lines.push("");

  report.violations.forEach((violation, index) => {
    lines.push(
      `${index + 1}. [${violation.impact}] ${violation.help} (${violation.id}) — ` +
        `${violation.node_count} ${violation.node_count === 1 ? "element" : "elements"}`,
    );
    lines.push(`   ${violation.description}`);
    for (const node of violation.nodes) {
      lines.push(`   • ${node.target || "?"}`);
      if (node.html) lines.push(`     ${node.html}`);
      if (node.summary) lines.push(`     ${node.summary}`);
    }
    if (violation.node_count > violation.nodes.length) {
      lines.push(`   … and ${violation.node_count - violation.nodes.length} more elements`);
    }
    if (violation.help_url) lines.push(`   ${violation.help_url}`);
  });

  if (report.total_violations > report.violations.length) {
    lines.push("");
    lines.push(
      `… and ${report.total_violations - report.violations.length} more violation types not shown ` +
        "(raise `max_violations` to see them).",
    );
  }

  return lines.join("\n");
}

/**
 * The counts that say how much of the page was actually judged. `incomplete`
 * is the important one: those are the checks axe could not decide on its own
 * (typically colour contrast over an image) and they are the rules a human
 * still has to look at.
 */
function auditFooter(report: AxeReport): string {
  return `${report.passes} rules passed, ${report.incomplete} need a human to check, ${report.inapplicable} did not apply.`;
}

function countByImpact(report: AxeReport): string {
  const counts = new Map<string, number>();
  for (const violation of report.violations) {
    counts.set(violation.impact, (counts.get(violation.impact) ?? 0) + 1);
  }
  const known = IMPACT_ORDER.filter((impact) => counts.has(impact)).map((impact) => `${counts.get(impact)} ${impact}`);
  const other = [...counts.keys()]
    .filter((impact) => !IMPACT_ORDER.includes(impact as (typeof IMPACT_ORDER)[number]))
    .map((impact) => `${counts.get(impact)} ${impact}`);
  return [...known, ...other].join(", ");
}

/**
 * The axe-core bundle as source text, read once and cached.
 *
 * The minified build is preferred purely for injection size; the readable one
 * is an equivalent fallback for installations that ship only it.
 */
let cachedSource: string | null = null;

export function axeSource(): string {
  if (cachedSource !== null) return cachedSource;
  const require = createRequire(import.meta.url);
  const candidates = ["axe-core/axe.min.js", "axe-core/axe.js", "axe-core"];
  const problems: string[] = [];
  for (const candidate of candidates) {
    try {
      cachedSource = readFileSync(require.resolve(candidate), "utf8");
      return cachedSource;
    } catch (error) {
      problems.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(problems.join("; "));
}

/** Reject with `message` if `work` has not settled within `ms`. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expire = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([work, expire]);
  } finally {
    clearTimeout(timer);
    // The losing side has to be settled too: the audit outlives a timeout and
    // would otherwise reject unobserved once the context is torn down.
    void work.catch(() => {});
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a failed audit. Mirrors `describeFailure` in
 * screenshot.ts: match on the failing Playwright call, never on substrings of
 * a user-supplied selector.
 */
export function describeAuditFailure(
  input: { url: string; wait_for?: string; wait_for_timeout_ms: number },
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const prefix = `Accessibility audit of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  if (/^page\.goto:/.test(message)) {
    return `${prefix} the page could not be opened — ${firstLine}`;
  }
  return `${prefix} ${firstLine}`;
}

export function registerAccessibilityTool(server: McpServer): void {
  server.registerTool(
    ACCESSIBILITY_TOOL_NAME,
    {
      title: "Accessibility",
      description:
        "Run an axe-core accessibility audit on a page and report the violations: impact level, the rule that " +
        "failed, the elements at fault and a link to how to fix each one. Choose the conformance level with " +
        "`standard` (wcag2a, wcag2aa, wcag21aa). Rules that passed are counted rather than listed, and the " +
        "'needs review' count tells you what axe could not decide on its own.",
      inputSchema: accessibilityInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => auditAccessibility(args),
  );
}

/** Exported for tests: the axe tag list each standard maps to. */
export const A11Y_STANDARD_TAGS: Readonly<Record<A11yStandard, readonly string[]>> = STANDARDS;
