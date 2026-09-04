import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_RESPONSIVE_VIEWPORTS,
  DEFAULT_RESPONSIVE_WAIT_MS,
  MAX_RESPONSIVE_VIEWPORTS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  OVERFLOW_TOLERANCE_PX,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import { getDimensions, resizeForOutput, toBase64 } from "../utils/image.js";
import { resolveStorageState, storageStateField, withAuthNote, type StorageState } from "../utils/storage-state.js";

export const RESPONSIVE_TOOL_NAME = "framewatch_responsive";

const viewportSchema = z.object({
  name: z.string().min(1).describe("Label for this size, e.g. 'mobile', 'tablet', 'desktop'"),
  width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH),
  height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT),
});

export const responsiveInputShape = {
  url: z.string().url().describe("URL to capture, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  viewports: z
    .array(viewportSchema)
    .min(1)
    .max(MAX_RESPONSIVE_VIEWPORTS)
    .default([...DEFAULT_RESPONSIVE_VIEWPORTS])
    .describe("Viewport sizes to capture (defaults to mobile 375x812, tablet 768x1024, desktop 1440x900)"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_RESPONSIVE_WAIT_MS)
    .describe("Wait time (ms) after page load before each screenshot"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before each screenshot"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  storage_state: storageStateField,
};

export const responsiveInputSchema = z.object(responsiveInputShape);
export type ResponsiveInput = z.input<typeof responsiveInputSchema>;
type ParsedViewport = z.output<typeof viewportSchema>;

/** How one viewport turned out. Either it produced a shot, or it produced a reason. */
interface ViewportShot {
  viewport: ParsedViewport;
  png?: Buffer;
  /** Document width vs viewport width, for the overflow check. */
  layout?: LayoutInfo;
  error?: string;
}

interface LayoutInfo {
  scroll_width: number;
  client_width: number;
  scroll_height: number;
  client_height: number;
}

/**
 * Capture one page at several viewport sizes and return one screenshot per
 * size, labelled, so a whole responsive range can be reviewed in a single
 * look.
 *
 * Each viewport gets its own browser context rather than one page being
 * resized, for two reasons: a page that has already laid itself out at 1440px
 * often keeps state a genuine mobile visitor never had (a menu built by a
 * matchMedia listener that ran once), and independent contexts can load
 * concurrently — three 2s waits cost 2s, not 6s.
 *
 * A viewport that fails is reported next to the ones that worked instead of
 * failing the call: "desktop is fine, mobile times out" is itself the finding.
 * Only a run where every viewport failed comes back as an error.
 */
export async function captureResponsive(rawInput: ResponsiveInput): Promise<CallToolResult> {
  const parsed = responsiveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Responsive capture failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  // Read the auth state once, before any context exists: a missing or stale
  // file is one problem with the call, not one problem per viewport.
  let storageState: StorageState | undefined;
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    storageState = auth?.state;
  } catch (error) {
    return errorResult(`Responsive capture of ${input.url} failed: ${describeViewportFailure(input, error)}`);
  }

  const shots = await Promise.all(input.viewports.map((viewport) => captureOne(input, viewport, storageState)));
  const captured = shots.filter((shot) => shot.png !== undefined);
  if (captured.length === 0) {
    const reasons = shots.map((shot) => `${shot.viewport.name}: ${shot.error ?? "no screenshot"}`).join("; ");
    return errorResult(`Responsive capture of ${input.url} failed at every viewport — ${reasons}`);
  }

  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: summarise(input.url, shots),
    },
  ];

  for (const shot of shots) {
    if (!shot.png) {
      content.push({ type: "text", text: `${label(shot.viewport)} — failed: ${shot.error ?? "no screenshot"}` });
      continue;
    }
    const resized = await resizeForOutput(shot.png);
    const { width, height } = await getDimensions(resized);
    content.push({ type: "image", data: toBase64(resized), mimeType: "image/png" });
    content.push({ type: "text", text: describeShot(shot, width, height) });
  }

  return withAuthNote({ content }, auth);
}

/** Screenshot `url` at one viewport. Never throws — a failure is part of the result. */
async function captureOne(
  input: z.output<typeof responsiveInputSchema>,
  viewport: ParsedViewport,
  storageState?: StorageState,
): Promise<ViewportShot> {
  try {
    const options = {
      viewport: { width: viewport.width, height: viewport.height },
      ...(storageState ? { contextOptions: { storageState } } : {}),
    };
    const result = await withPage(options, async (page) => {
      await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      if (input.wait_for) {
        await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
      }
      if (input.wait_ms > 0) {
        await page.waitForTimeout(input.wait_ms);
      }
      const png = await page.screenshot({ type: "png" });
      return { png, layout: await readLayout(page) };
    });
    return { viewport, ...result };
  } catch (error) {
    return { viewport, error: describeViewportFailure(input, error) };
  }
}

/**
 * The document's laid-out size against the viewport it was given. Horizontal
 * overflow is the classic responsive bug and it is invisible in a screenshot —
 * the content that sticks out is simply cropped away — so it is measured
 * rather than left to the eye.
 *
 * Cosmetic: a page that dies before this is read still returns its screenshot.
 */
async function readLayout(page: Page): Promise<LayoutInfo | undefined> {
  try {
    // `globalThis as any` rather than the DOM globals: this package is
    // compiled with the Node lib only, and the page it lands in may be
    // mid-teardown, so nothing here can be assumed to exist.
    return await page.evaluate(() => {
      const el = (globalThis as any).document?.documentElement;
      if (!el) return undefined;
      return {
        scroll_width: Math.round(el.scrollWidth),
        client_width: Math.round(el.clientWidth),
        scroll_height: Math.round(el.scrollHeight),
        client_height: Math.round(el.clientHeight),
      };
    });
  } catch {
    return undefined;
  }
}

function label(viewport: ParsedViewport): string {
  return `${viewport.name} ${viewport.width}x${viewport.height}`;
}

/** One line per viewport: what it is, how big the image is, and whether the content fits. */
function describeShot(shot: ViewportShot, imageWidth: number, imageHeight: number): string {
  const parts = [label(shot.viewport), `image ${imageWidth}x${imageHeight}`];

  const layout = shot.layout;
  if (layout) {
    if (layout.scroll_width > layout.client_width + OVERFLOW_TOLERANCE_PX) {
      parts.push(
        `horizontal overflow: content is ${layout.scroll_width}px wide in a ${layout.client_width}px viewport ` +
          `(+${layout.scroll_width - layout.client_width}px)`,
      );
    }
    if (layout.scroll_height > layout.client_height) {
      parts.push(`page scrolls to ${layout.scroll_height}px (${scrolls(layout)} screens)`);
    }
  }

  return parts.join(" — ");
}

function scrolls(layout: LayoutInfo): string {
  return (layout.scroll_height / Math.max(1, layout.client_height)).toFixed(1);
}

/** The opening line: what was captured, and an up-front warning about anything that overflowed. */
function summarise(url: string, shots: ViewportShot[]): string {
  const captured = shots.filter((shot) => shot.png !== undefined);
  const failed = shots.filter((shot) => shot.png === undefined);

  const names = captured.map((shot) => label(shot.viewport)).join(", ");
  const lines = [`Captured ${url} at ${captured.length} of ${shots.length} viewports: ${names}`];

  if (failed.length > 0) {
    lines.push(`Failed: ${failed.map((shot) => shot.viewport.name).join(", ")}`);
  }

  const overflowing = captured.filter(
    (shot) => shot.layout !== undefined && shot.layout.scroll_width > shot.layout.client_width + OVERFLOW_TOLERANCE_PX,
  );
  if (overflowing.length > 0) {
    lines.push(
      `Horizontal overflow at ${overflowing.map((shot) => shot.viewport.name).join(", ")} — ` +
        "content is wider than the viewport, so something is sticking out past the right edge.",
    );
  }

  return lines.join("\n");
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a viewport that failed. Mirrors `describeFailure` in
 * screenshot.ts: match on the failing Playwright call, never on substrings of
 * a user-supplied selector.
 */
export function describeViewportFailure(input: { wait_for?: string; wait_for_timeout_ms: number }, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return "Playwright's Chromium browser is not installed. Run `npx playwright install chromium` and try again.";
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms`;
  }
  return firstLine;
}

export function registerResponsiveTool(server: McpServer): void {
  server.registerTool(
    RESPONSIVE_TOOL_NAME,
    {
      title: "Responsive",
      description:
        "Screenshot the same page at several viewport sizes in one call (mobile, tablet and desktop by default) " +
        "and return one labelled image per size. Each size loads in its own fresh browser context, so a mobile " +
        "shot is what a phone would really get rather than a resized desktop layout. Content that is wider than " +
        "its viewport is reported as horizontal overflow — the commonest responsive bug, and one a screenshot " +
        "alone hides because the overflowing part is simply cropped off.",
      inputSchema: responsiveInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => captureResponsive(args),
  );
}
