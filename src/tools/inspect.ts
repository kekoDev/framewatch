import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SNAPSHOT_WAIT_MS,
  HIGHLIGHT_INSPECT_COLOUR,
  MAX_INSPECT_TARGETS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withSessionLock } from "../engine/browser.js";
import { hmrFor } from "../engine/hmr.js";
import { inventoryPage, measureElements, type InspectResult } from "../engine/inspect.js";
import { describeScale } from "../utils/format.js";
import { clearHighlights, highlightElements, type Highlight } from "../utils/highlight.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { storageStateField, withAuthNote } from "../utils/storage-state.js";
import { formatInspection, formatInventory } from "../utils/style-rules.js";
import { describeVue, formatComponentLine } from "../utils/vue-rules.js";
import { describeSessionFailure, openSessionPage } from "./snapshot.js";

export const INSPECT_TOOL_NAME = "framewatch_inspect";

export const inspectInputShape = {
  url: z
    .string()
    .url()
    .optional()
    .describe("Open this URL first. Omit to measure the page left open by framewatch_interact / framewatch_snapshot."),
  targets: z
    .array(z.string().min(1))
    .max(MAX_INSPECT_TARGETS)
    .optional()
    .describe(
      "What to measure: snapshot refs (`e8`) and/or CSS selectors, in order. Omit for a design inventory of the whole page instead.",
    ),
  selector: z.string().optional().describe("For the inventory: only count elements inside this container"),
  include_screenshot: z.boolean().default(true).describe("With `targets`: return a screenshot with each target boxed and numbered"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_SNAPSHOT_WAIT_MS)
    .describe("Settle time (ms) after opening `url`, so a client-rendered app has drawn"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before measuring"),
  wait_for_timeout_ms: z.number().int().min(1).default(SELECTOR_TIMEOUT_MS).describe("Max time (ms) to wait for `wait_for`"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT),
    })
    .optional()
    .describe("Resize the page to this first (defaults to leaving it as it is)"),
  storage_state: storageStateField,
};

export const inspectInputSchema = z.object(inspectInputShape);
export type InspectInput = z.input<typeof inspectInputSchema>;

/**
 * Measure how elements are built — box, type, colours with contrast, spacing,
 * alignment — or, with no targets, what the whole page is built from. Runs on
 * the interact session's page so a ref from the last snapshot resolves.
 */
export function inspectElements(rawInput: InspectInput): Promise<CallToolResult> {
  return withSessionLock(() => runInspect(rawInput));
}

async function runInspect(rawInput: InspectInput): Promise<CallToolResult> {
  const parsed = inspectInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Inspect failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  try {
    const opened = await openSessionPage(input, "Inspect");
    if ("error" in opened) return errorResult(opened.error);
    const { page, vue, auth, login_visible } = opened;
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const vueLine = vue ? ` — ${describeVue(vue)}` : "";

    if (!input.targets || input.targets.length === 0) {
      const inventory = await inventoryPage(page, input.selector);
      const lines = formatInventory(inventory);
      lines.push(`Page: ${page.url()} — ${describeScale(viewport).replace(/, images.*$/, "")}${vueLine}${input.selector ? ` — scope ${input.selector}` : ""}`);
      hmrFor(page).markSeen();
      return withAuthNote({ content: [{ type: "text", text: lines.join("\n") }] }, auth, login_visible);
    }

    // Component data is only worth asking for on a Vue page; elsewhere the
    // question costs an evaluate per target and always answers "none".
    const results = await measureElements(page, input.targets, { components: vue !== null });
    const measured = results.filter((r) => r.measurement !== undefined).length;
    const lines = [
      `Inspected ${measured} of ${results.length} targets on ${page.url()} — ${describeScale(viewport)}${vueLine}`,
      ...results.flatMap((result, i) => formatResult(result, i + 1)),
    ];

    const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    if (input.include_screenshot && measured > 0) {
      content.push({ type: "image", data: await boxedScreenshot(page, results), mimeType: "image/png" });
    }
    hmrFor(page).markSeen();
    return withAuthNote({ content }, auth, login_visible);
  } catch (error) {
    return errorResult(describeSessionFailure("Inspect", input, error));
  }
}

function formatResult(result: InspectResult, index: number): string[] {
  if (!result.measurement) return [`${index}. ${result.target} — ${result.error ?? "not measured"}`];
  const lines = formatInspection(result.measurement, index);
  if (result.component) lines.push(`   ${formatComponentLine(result.component)}`);
  return lines;
}

/** The page with every measured target boxed, numbered to match the list. */
async function boxedScreenshot(page: Parameters<typeof highlightElements>[0], results: InspectResult[]): Promise<string> {
  const highlights: Highlight[] = [];
  results.forEach((result, i) => {
    const m = result.measurement;
    if (!m || m.box.width <= 0 || m.box.height <= 0) return;
    highlights.push({ selector: result.target, box: m.box, label: String(i + 1), colour: HIGHLIGHT_INSPECT_COLOUR });
  });
  await highlightElements(page, highlights);
  try {
    const png = await page.screenshot({ type: "png" });
    return toBase64(await resizeForOutput(png));
  } finally {
    await clearHighlights(page);
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function registerInspectTool(server: McpServer): void {
  server.registerTool(
    INSPECT_TOOL_NAME,
    {
      title: "Inspect",
      description:
        "Measure how elements are actually built, to check UI work against what was intended: the box in viewport " +
        "pixels, font family/size/weight/line-height, text and effective background colour with the WCAG contrast " +
        "ratio, padding, margin, gap, border and radius, whether it is visible, clipped or overflowing, and how it " +
        "aligns to its parent and previous sibling — plus a screenshot with each target boxed. Targets are refs from " +
        "framewatch_snapshot (`e8`) or CSS selectors. With no targets it returns a design inventory of the page: every " +
        "font, size, weight, colour, spacing value and radius in use, with counts — the fastest way to spot the one " +
        "13px label on a 14px page.",
      inputSchema: inspectInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => inspectElements(args),
  );
}
