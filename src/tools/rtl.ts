import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_RTL_ELEMENTS,
  DEFAULT_RTL_WAIT_MS,
  DEFAULT_VIEWPORT,
  HIGHLIGHT_RTL_PROBLEM_COLOUR,
  HIGHLIGHT_RTL_WARNING_COLOUR,
  MAX_HIGHLIGHTS,
  MAX_RTL_ELEMENTS,
  MAX_RTL_ISSUES_PER_ELEMENT,
  MAX_RTL_LISTED,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  DEFAULT_RTL_TRIGGER,
  applyRtlTrigger,
  injectArabic,
  measureElements,
  pairMeasurements,
  readDirection,
  type RtlTrigger,
} from "../engine/rtl.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { highlightElements, type Highlight } from "../utils/highlight.js";
import { buildFindings, describeIssueKind, type ElementFinding, type RtlIssueKind } from "../utils/rtl-rules.js";
import { resolveStorageState, storageStateField, withAuthNote, type StorageState } from "../utils/storage-state.js";
import type { ElementMeasurement } from "../utils/rtl-rules.js";

export const RTL_TOOL_NAME = "framewatch_rtl";

/**
 * The four ways an app is put into RTL.
 *
 * A discriminated union rather than a free-form object, so an agent that picks
 * the wrong shape is told which field is missing instead of having its trigger
 * silently ignored — which would measure the page twice in LTR and report a
 * clean bill of health on a broken page.
 */
const triggerSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("attribute"),
      attr: z.string().min(1).default("dir").describe("Attribute to set, e.g. `dir`"),
      value: z.string().min(1).default("rtl").describe("Value to set it to"),
      target: z.string().min(1).default("html").describe("CSS selector for the element to set it on"),
    }),
    z.object({
      type: z.literal("class"),
      class: z.string().min(1).describe("Class to add, e.g. `rtl` — for apps that switch on a class"),
      target: z.string().min(1).default("html"),
    }),
    z.object({
      type: z.literal("locale"),
      locale: z
        .string()
        .min(2)
        .default("ar")
        .describe("BCP-47 locale for the browser context, e.g. `ar`. `dir=rtl` is set as well — a locale alone does not flip a layout"),
    }),
    z.object({
      type: z.literal("url"),
      rtl_url: z.string().url().describe("A separate URL that serves the RTL version, e.g. https://example.com/ar/"),
    }),
  ])
  .describe("How to put the page into RTL. Defaults to setting `dir=rtl` on <html>");

export const rtlInputShape = {
  url: z
    .string()
    .url()
    .describe("URL to test, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  rtl_trigger: triggerSchema.optional(),
  inject_arabic: z
    .boolean()
    .default(true)
    .describe(
      "Replace visible text with Arabic of about the same length, in BOTH passes, so the comparison changes " +
        "direction and nothing else. Turn it off to test a page that is already translated.",
    ),
  selector: z.string().optional().describe("Only measure inside this container"),
  exclude: z.string().optional().describe("Never measure this, or anything inside it"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_RTL_WAIT_MS)
    .describe("Wait time (ms) after each page load before the page is measured — paid twice, once per direction"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) after each load"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(MAX_RTL_ELEMENTS)
    .default(DEFAULT_RTL_ELEMENTS)
    .describe("Elements measured in each direction"),
  full_page: z.boolean().default(false).describe("Screenshot the whole page rather than just the viewport"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional(),
  storage_state: storageStateField,
};

export const rtlInputSchema = z.object(rtlInputShape);
export type RtlInput = z.input<typeof rtlInputSchema>;
type ParsedRtlInput = z.output<typeof rtlInputSchema>;

/** One direction's pass: what was measured, and the picture of it. */
interface Pass {
  measurements: ElementMeasurement[];
  png?: Buffer;
  direction: { html: string; body: string };
  injection: { replaced: number; error?: string };
  url: string;
}

/**
 * What the RTL pass needs from the LTR one to finish its own work.
 *
 * The overlay has to be drawn on the live RTL page, and what to draw is only
 * known once both passes have been compared — so the RTL pass is handed the
 * LTR measurements and does the pairing, the judging and the highlighting
 * before its context closes. Doing it the other way round would mean
 * reopening and re-rendering the page just to draw boxes on it, and a second
 * render of a page is not guaranteed to lay out identically to the one that
 * was measured.
 */
interface Judged {
  findings: ElementFinding[];
  pairs: number;
  unpaired: number;
}

/**
 * Test a page in LTR and RTL and report what failed to mirror.
 *
 * The page is loaded twice — once as it ships, once flipped — and every
 * element is measured in both. A finding is something that *did not change*
 * when the LTR measurement proves it should have: a box that sits at the same
 * x in both directions, text still hugging the left edge, physical padding
 * that never swapped. Plus the one thing that should not change and did:
 * content that fits in LTR and hangs off the edge in RTL, where it is silently
 * cropped and therefore invisible in a screenshot.
 *
 * Nothing is judged from the RTL rendering alone, which is what separates this
 * from a linter. `text-align: left` is correct on a code block and a number
 * column; `padding-left` is correct on anything that should not mirror. Only
 * the comparison can tell a deliberate physical value from a forgotten one,
 * and a report that cannot tell them apart is one nobody reads twice.
 */
export async function testRtl(rawInput: RtlInput): Promise<CallToolResult> {
  const parsed = rtlInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`RTL test failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const trigger: RtlTrigger = (input.rtl_trigger as RtlTrigger | undefined) ?? DEFAULT_RTL_TRIGGER;

  let storageState: StorageState | undefined;
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    storageState = auth?.state;
  } catch (error) {
    return errorResult(`RTL test of ${input.url} failed: ${describeRtlFailure(input, error)}`);
  }

  try {
    // The two passes run one after the other rather than at once, so both get
    // an unloaded machine and the same `wait_ms` means the same thing for
    // each. A difference in the result has to come from the direction, not
    // from which pass was competing for the CPU — and every finding here is a
    // difference between the two.
    const ltr = await runPass(input, trigger, storageState, false);
    // The RTL pass carries the LTR measurements in, so it can judge and draw
    // the overlay on the page it actually measured — see `Judged`.
    const { pass: rtl, judged } = await runRtlPass(input, trigger, storageState, ltr.measurements);
    return withAuthNote(await render(input, trigger, ltr, rtl, judged), auth);
  } catch (error) {
    return errorResult(`RTL test of ${input.url} failed: ${describeRtlFailure(input, error)}`);
  }
}

/**
 * The LTR pass: load the page as it ships, measure it, photograph it.
 *
 * No overlay is ever drawn here — the findings are reported against the RTL
 * rendering, and the LTR shot is the reference the reader compares it to.
 */
async function runPass(
  input: ParsedRtlInput,
  trigger: RtlTrigger,
  storageState: StorageState | undefined,
  isRtl: boolean,
): Promise<Pass> {
  return withPass(input, trigger, storageState, isRtl, async (page, pass) => {
    const png = await safeScreenshot(page, input.full_page);
    return { ...pass, ...(png ? { png } : {}) };
  });
}

/**
 * The RTL pass: everything `runPass` does, and then the judging.
 *
 * The pairing and the verdicts happen while this page is still open so the
 * overlay can be drawn on the very rendering that was measured, and the boxes
 * therefore land where the measurements said they would.
 */
async function runRtlPass(
  input: ParsedRtlInput,
  trigger: RtlTrigger,
  storageState: StorageState | undefined,
  ltrMeasurements: readonly ElementMeasurement[],
): Promise<{ pass: Pass; judged: Judged }> {
  let judged: Judged = { findings: [], pairs: 0, unpaired: 0 };

  const pass = await withPass(input, trigger, storageState, true, async (page, measured) => {
    const { pairs, unpaired } = pairMeasurements(ltrMeasurements, measured.measurements);
    const findings = buildFindings(pairs);
    judged = { findings, pairs: pairs.length, unpaired };

    // Drawn only now: the overlay is a DOM mutation, and everything that
    // needed measuring has been measured.
    if (findings.length > 0) {
      await highlightElements(page, highlightsFor(findings));
    }
    const png = await safeScreenshot(page, input.full_page);
    return { ...measured, ...(png ? { png } : {}) };
  });

  return { pass, judged };
}

/** Load the page, optionally flip it, inject Arabic, measure — then hand the open page to `then`. */
async function withPass(
  input: ParsedRtlInput,
  trigger: RtlTrigger,
  storageState: StorageState | undefined,
  isRtl: boolean,
  then: (page: Page, pass: Pass) => Promise<Pass>,
): Promise<Pass> {
  const options = {
    viewport: input.viewport ?? { ...DEFAULT_VIEWPORT },
    contextOptions: {
      ...(storageState ? { storageState } : {}),
      // A locale is a context option: it has to be set before the page loads,
      // because the app reads it on boot to decide what to render.
      ...(isRtl && trigger.type === "locale" ? { locale: trigger.locale } : {}),
    },
  };

  // The `url` trigger is a different page, not a different rendering of this
  // one — so it is navigated to rather than applied.
  const target = isRtl && trigger.type === "url" ? trigger.rtl_url : input.url;

  return withPage(options, async (page) => {
    await page.goto(target, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });

    if (isRtl && trigger.type !== "url") {
      // Applied before `wait_for` and the settle: an app that lays itself out
      // on boot has to see the direction it is meant to render in, and one
      // that watches for the attribute gets the whole settle to react.
      await applyRtlTrigger(page, trigger);
    }

    if (input.wait_for) {
      await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
    }
    if (input.wait_ms > 0) {
      await page.waitForTimeout(input.wait_ms);
    }

    // Injected in BOTH passes — see engine/rtl.ts. If only the RTL pass got
    // Arabic, every box would change width for reasons of text metrics rather
    // than direction, and the mirroring comparison would be measuring the font.
    const injection = input.inject_arabic
      ? await injectArabic(page, input.exclude)
      : { replaced: 0 as number, error: undefined as string | undefined };
    if (injection.replaced > 0) {
      // Give the page a frame to reflow around the new text before measuring.
      await page.waitForTimeout(RELAYOUT_MS);
    }

    const measurements = await measureElements(page, {
      ...(input.selector ? { selector: input.selector } : {}),
      ...(input.exclude ? { exclude: input.exclude } : {}),
      max_elements: input.max_elements,
    });
    const direction = await readDirection(page);

    return then(page, { measurements, direction, injection, url: page.url() });
  });
}

/** Settle time after the text is swapped, so the page reflows before it is measured. */
const RELAYOUT_MS = 120;

/**
 * Build the report.
 *
 * Order is deliberate: the verdict line, then the one thing that invalidates
 * everything else (RTL never took effect), then the findings worst-first, then
 * both screenshots — LTR as it ships, RTL with every finding boxed and
 * numbered to match the list.
 */
async function render(
  input: ParsedRtlInput,
  trigger: RtlTrigger,
  ltr: Pass,
  rtl: Pass,
  judged: Judged,
): Promise<CallToolResult> {
  const { findings, unpaired } = judged;
  const problems = findings.filter((f) => f.severity === "problem");
  const warnings = findings.filter((f) => f.severity === "warning");

  const lines: string[] = [];
  const applied = isRtlApplied(rtl);

  lines.push(
    `Tested ${input.url} in both directions — compared ${judged.pairs} element${judged.pairs === 1 ? "" : "s"}, ` +
      `${problems.length} problem${problems.length === 1 ? "" : "s"}, ` +
      `${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
  );
  lines.push(`RTL applied by ${describeTrigger(trigger)}.`);

  if (!applied) {
    // The failure that matters most, because it is silent: a trigger that did
    // not take renders LTR twice, finds every element identical, and looks
    // exactly like a page with no RTL bugs at all.
    lines.push(
      "",
      "✗ RTL was never applied — the document still computes `direction: " +
        `${rtl.direction.html || "unknown"}\` after the trigger ran. Everything below compares the page with ` +
        "itself, so it proves nothing. Check that `rtl_trigger` matches how this app switches direction " +
        "(an app that switches on a class needs `{ type: \"class\", class: \"…\" }`, one with a separate " +
        'Arabic build needs `{ type: "url", rtl_url: "…" }`).',
    );
  }

  if (input.inject_arabic) {
    const failure = rtl.injection.error ?? ltr.injection.error;
    lines.push(
      failure !== undefined
        ? `! Arabic injection could not run (${failure}) — the page was tested with its own text instead, ` +
          "so nothing here has been checked against real right-to-left content."
        : rtl.injection.replaced > 0
          ? `Text replaced with Arabic in both passes (${rtl.injection.replaced} strings in RTL, ` +
            `${ltr.injection.replaced} in LTR), matched to the original lengths so any overflow found is the ` +
            "layout rather than the substitution."
          : "No text was replaced — `inject_arabic` was on but the page had no replaceable text.",
    );
  }

  if (unpaired > 0) {
    lines.push(
      `${unpaired} element${unpaired === 1 ? " was" : "s were"} measured in only one direction and could not be ` +
        "compared — the page renders a different tree in RTL, which is worth a look on its own.",
    );
  }

  if (findings.length === 0 && applied) {
    lines.push(
      "",
      "Nothing failed to mirror. Every element that was off-centre in LTR moved to its mirror position, text " +
        "alignment followed the direction, and nothing new overflows the viewport.",
    );
  }

  if (problems.length > 0) {
    lines.push("", `Problems — ${problems.length} (these are visible to an Arabic reader):`);
    lines.push(...renderFindings(problems));
  }
  if (warnings.length > 0) {
    lines.push("", `Warnings — ${warnings.length} (worth checking, may be deliberate):`);
    lines.push(...renderFindings(warnings));
  }

  const byKind = countByKind(findings);
  if (byKind.length > 0) {
    lines.push("", `By kind: ${byKind.map(([kind, n]) => `${describeIssueKind(kind)} ${n}`).join(", ")}.`);
  }

  const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];

  if (ltr.png) {
    content.push({ type: "image", data: toBase64(await resizeForOutput(ltr.png)), mimeType: "image/png" });
    content.push({ type: "text", text: `LTR — ${ltr.url} as it ships.` });
  }
  if (rtl.png) {
    content.push({ type: "image", data: toBase64(await resizeForOutput(rtl.png)), mimeType: "image/png" });
    content.push({
      type: "text",
      text:
        `RTL — ${rtl.url}` +
        (findings.length === 0
          ? "."
          : `, with the first ${Math.min(findings.length, MAX_HIGHLIGHTS)} finding${
              Math.min(findings.length, MAX_HIGHLIGHTS) === 1 ? "" : "s"
            } boxed and numbered to match the list above — ` +
            `red is a problem, orange a warning.`),
    });
  }

  return { content };
}

/** Each finding as a numbered block: what it is, then one line per issue. */
function renderFindings(findings: readonly ElementFinding[]): string[] {
  const lines: string[] = [];
  for (const finding of findings.slice(0, MAX_RTL_LISTED)) {
    lines.push(`  ${finding.index}. ${finding.description}  ${finding.selector}`);
    for (const issue of finding.issues.slice(0, MAX_RTL_ISSUES_PER_ELEMENT)) {
      lines.push(`       ${issue.severity === "problem" ? "✗" : "!"} ${issue.message}`);
      lines.push(`         ${issue.evidence}`);
    }
    const hidden = finding.issues.length - MAX_RTL_ISSUES_PER_ELEMENT;
    if (hidden > 0) lines.push(`       … and ${hidden} more issue${hidden === 1 ? "" : "s"} on this element`);
  }
  const rest = findings.length - MAX_RTL_LISTED;
  if (rest > 0) lines.push(`  … and ${rest} more`);
  return lines;
}

/** A tally per kind, so a page with one bug repeated 40 times reads as one bug. */
function countByKind(findings: readonly ElementFinding[]): Array<[RtlIssueKind, number]> {
  const counts = new Map<RtlIssueKind, number>();
  for (const finding of findings) {
    for (const issue of finding.issues) {
      counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Did the flip take effect?
 *
 * `html` is what the trigger sets and `body` is what the page actually renders
 * in; either one computing to `rtl` is enough, because an app may set the
 * direction on a wrapper rather than the root.
 */
function isRtlApplied(rtl: Pass): boolean {
  return rtl.direction.html === "rtl" || rtl.direction.body === "rtl";
}

function describeTrigger(trigger: RtlTrigger): string {
  switch (trigger.type) {
    case "attribute":
      return `setting \`${trigger.attr}="${trigger.value}"\` on \`${trigger.target}\``;
    case "class":
      return `adding the class \`${trigger.class}\` to \`${trigger.target}\``;
    case "locale":
      return `loading the page with locale \`${trigger.locale}\` and \`dir=rtl\``;
    case "url":
      return `loading ${trigger.rtl_url}`;
  }
}

/** A screenshot is worth having but never worth failing the audit for. */
async function safeScreenshot(page: Page, fullPage: boolean): Promise<Buffer | undefined> {
  try {
    return await page.screenshot({ type: "png", fullPage });
  } catch {
    return undefined;
  }
}

/**
 * Draw the findings onto the RTL page before it is photographed.
 *
 * Numbered to match the list, and coloured by severity. Drawn after everything
 * has been measured, because the overlay is itself a DOM mutation.
 */
export function highlightsFor(findings: readonly ElementFinding[]): Highlight[] {
  return findings.slice(0, MAX_HIGHLIGHTS).map((finding) => ({
    selector: finding.selector,
    match_index: finding.match_index,
    label: String(finding.index),
    colour: finding.severity === "problem" ? HIGHLIGHT_RTL_PROBLEM_COLOUR : HIGHLIGHT_RTL_WARNING_COLOUR,
    wash:
      finding.severity === "problem" ? "rgba(229, 25, 75, 0.16)" : "rgba(240, 140, 0, 0.16)",
  }));
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a failed run. Mirrors `describeFailure` in
 * screenshot.ts: match on the failing Playwright call, never on substrings of
 * a user-supplied selector.
 */
export function describeRtlFailure(
  input: { url: string; wait_for?: string; wait_for_timeout_ms: number },
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return "Playwright's Chromium browser is not installed. Run `npx playwright install chromium` and try again.";
  }
  if (/^page\.goto:/.test(message)) {
    return `could not open the page — ${firstLine}`;
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms`;
  }
  return firstLine;
}

export function registerRtlTool(server: McpServer): void {
  server.registerTool(
    RTL_TOOL_NAME,
    {
      title: "RTL",
      description:
        "Test a page in LTR and RTL and report what failed to mirror. The page is loaded twice — once as it " +
        "ships, once flipped — every element is measured in both, and a finding is something that did NOT " +
        "change when the LTR measurement proves it should have: a box at the same x in both directions, text " +
        "still hugging the left edge, physical padding that never swapped, a directional icon that did not " +
        "flip. Plus the one thing that should not change and did — content that fits in LTR and hangs off the " +
        "edge in RTL, where it is cropped and invisible in a screenshot. Optionally replaces visible text with " +
        "length-matched Arabic in both passes, so the comparison changes direction and nothing else. Returns " +
        "both screenshots, the RTL one with every finding boxed and numbered.",
      inputSchema: rtlInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => testRtl(args),
  );
}
