import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CROP_PADDING_PX,
  DEFAULT_COMPARE_WAIT_MS,
  DEFAULT_VIEWPORT,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  PAGE_INFO_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { getSessionPage, withPage, withSessionLock } from "../engine/browser.js";
import { computePixelMask, padBoundingBox } from "../engine/differ.js";
import type { BoundingBox, Viewport } from "../types.js";
import { getDimensions, overlayMask, resizeForOutput, toBase64, toGrayscale } from "../utils/image.js";
import { resolveStorageState, storageStateField, withAuthNote, type StorageState } from "../utils/storage-state.js";

export const COMPARE_TOOL_NAME = "framewatch_compare";

/** `url_a` accepts this instead of a URL, meaning "whatever framewatch_interact is looking at". */
export const CURRENT_PAGE = "current";

/**
 * Either a URL or the literal "current". `z.string().url()` cannot express
 * that, so the check is spelled out — and the message says both options,
 * because "invalid url" on the word `current` is a confusing thing to read.
 */
const sideSchema = z.string().refine((value) => value === CURRENT_PAGE || isUrl(value), {
  message: `must be a URL, or "${CURRENT_PAGE}" to use the page framewatch_interact currently has open`,
});

export const compareInputShape = {
  url_a: sideSchema.describe(
    `First URL — the "before" side. Pass "${CURRENT_PAGE}" to compare against the page framewatch_interact has open, ` +
      "in whatever state your interactions left it.",
  ),
  url_b: sideSchema.describe('Second URL — the "after" side.'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_COMPARE_WAIT_MS)
    .describe("Wait time (ms) after page load before each screenshot"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) on both sides before capturing"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport for both sides (defaults to 1280x720, or the open page's size when comparing against `current`)"),
  storage_state: storageStateField,
};

export const compareInputSchema = z.object(compareInputShape);
export type CompareInput = z.input<typeof compareInputSchema>;
type ParsedCompareInput = z.output<typeof compareInputSchema>;

/** One captured side of the comparison. */
interface Side {
  png: Buffer;
  /** Where the shot was actually taken (after redirects), or the open page's URL. */
  url: string;
  title?: string;
}

/**
 * Compare two pages — or the same page before and after a change — and show
 * what moved.
 *
 * Returns both screenshots plus an overlay: side B with every differing pixel
 * tinted, which is the part that turns "3.4% changed" into something a reader
 * can act on. The comparison is the same pixel comparison the capture engine
 * uses between frames, so a change region here means what it means there.
 *
 * The two sides are captured one after the other rather than at once, so both
 * get an unloaded machine and the same `wait_ms` means the same thing for
 * each; a difference in the result should come from the pages, not from which
 * of them was competing for the CPU. (Which of the two goes first is decided
 * by `"current"` — see below — not by their order in the input.)
 */
export async function comparePages(rawInput: CompareInput): Promise<CallToolResult> {
  const parsed = compareInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Compare failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  // The open page is the one side that cannot be resized — doing so would
  // change the state being compared — so it is captured first whichever side
  // it is, and its size is what the other side is then captured at. Frames of
  // two different sizes cannot be compared pixel for pixel at all.
  const openIsB = input.url_b === CURRENT_PAGE && input.url_a !== CURRENT_PAGE;
  const [firstSide, secondSide] = openIsB ? [input.url_b, input.url_a] : [input.url_a, input.url_b];

  try {
    // Both URL sides get the same saved auth: they are two views of one app,
    // and a comparison where only one side is signed in compares the login
    // screen with the app. ("current" is read as it is, never reloaded.)
    const auth = await resolveStorageState(input.storage_state);
    const storageState = auth?.state;

    const first = await captureSide(input, firstSide, undefined, storageState);
    const notes: string[] = [];
    let viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

    if (firstSide === CURRENT_PAGE) {
      const open = await sizeOf(first.png);
      if (input.viewport && (input.viewport.width !== open.width || input.viewport.height !== open.height)) {
        notes.push(
          `Ignored \`viewport\` ${input.viewport.width}x${input.viewport.height}: the open page is ` +
            `${open.width}x${open.height} and resizing it would change the state being compared. ` +
            "Both sides were captured at the open page's size.",
        );
      }
      viewport = open;
    }

    const second = await captureSide(input, secondSide, viewport, storageState);
    const [a, b] = openIsB ? [second, first] : [first, second];
    return withAuthNote(await render(input, a, b, notes), auth);
  } catch (error) {
    return errorResult(describeCompareFailure(input, error));
  }
}

/**
 * Screenshot one side.
 *
 * A URL gets a fresh context, so nothing from the other side (or from an
 * earlier tool call) can leak into it. "current" instead reads the page
 * `framewatch_interact` has open, *without* touching it: the whole point of
 * that option is to compare a hand-built state — three clicks deep into a
 * flow — against a plain URL, and reloading or resizing it would destroy the
 * very thing being compared.
 */
async function captureSide(
  input: ParsedCompareInput,
  side: string,
  viewport?: Viewport,
  storageState?: StorageState,
): Promise<Side> {
  if (side === CURRENT_PAGE) {
    // Under the session lock: an interaction running in parallel would
    // otherwise be screenshotted half way through.
    return withSessionLock(async () => {
      const { page } = await getSessionPage();
      if (page.url() === "about:blank") {
        throw new Error(
          `no page is open, so there is no "${CURRENT_PAGE}" state to compare — ` +
            "use framewatch_interact first, or pass a URL here.",
        );
      }
      return { png: await page.screenshot({ type: "png" }), url: page.url(), title: await safeTitle(page) };
    });
  }

  const options = {
    viewport: viewport ?? input.viewport ?? { ...DEFAULT_VIEWPORT },
    ...(storageState ? { contextOptions: { storageState } } : {}),
  };
  return withPage(options, async (page) => {
    await page.goto(side, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    if (input.wait_for) {
      await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
    }
    if (input.wait_ms > 0) {
      await page.waitForTimeout(input.wait_ms);
    }
    return { png: await page.screenshot({ type: "png" }), url: page.url(), title: await safeTitle(page) };
  });
}

/**
 * Build the result: a summary, both frames, and (when the two are comparable
 * and actually differ) the overlay.
 *
 * Sides of different sizes are reported as such rather than being stretched to
 * match. Rescaling one of them would resample every pixel in it, and the
 * "differences" that came back would be the resampling, not the pages.
 */
async function render(input: ParsedCompareInput, a: Side, b: Side, notes: string[]): Promise<CallToolResult> {
  const [grayA, grayB] = await Promise.all([toGrayscale(a.png), toGrayscale(b.png)]);
  const nameA = describeSide(input.url_a, a);
  const nameB = describeSide(input.url_b, b);
  const sameSize = grayA.width === grayB.width && grayA.height === grayB.height;

  const lines: string[] = [];
  let overlay: Buffer | undefined;
  let overlayNote = "";

  if (!sameSize) {
    lines.push(
      `Compared ${nameA} against ${nameB} — the two frames are different sizes ` +
        `(${grayA.width}x${grayA.height} vs ${grayB.width}x${grayB.height}), so they cannot be compared pixel ` +
        "for pixel. Both are below.",
    );
  } else {
    const diff = computePixelMask(grayA.data, grayB.data, grayA.width, grayA.height);
    const region: BoundingBox | null =
      diff.bbox === null ? null : padBoundingBox(diff.bbox, CROP_PADDING_PX, grayA.width, grayA.height);

    lines.push(
      `Compared ${nameA} against ${nameB} at ${grayA.width}x${grayA.height} — ` +
        `${diff.changePercent.toFixed(2)}% of pixels differ` +
        (region === null
          ? ". The two are pixel-identical."
          : `, all of it within ${region.x},${region.y} ${region.width}x${region.height}.`),
    );

    if (region !== null) {
      overlay = await resizeForOutput(await overlayMask(b.png, diff.mask, grayA.width, grayA.height));
      overlayNote =
        `Diff overlay — B with every differing pixel tinted. ${diff.changedPixels} of ${diff.totalPixels} ` +
        `pixels changed (${diff.changePercent.toFixed(2)}%), within ` +
        `${region.x},${region.y} ${region.width}x${region.height}.`;
    }
  }

  const content: CallToolResult["content"] = [{ type: "text", text: [...lines, ...notes].join("\n") }];
  await pushFrame(content, a.png, `A — ${nameA}`);
  await pushFrame(content, b.png, `B — ${nameB}`);
  if (overlay) {
    content.push({ type: "image", data: toBase64(overlay), mimeType: "image/png" });
    content.push({ type: "text", text: overlayNote });
  }
  return { content };
}

async function pushFrame(content: CallToolResult["content"], png: Buffer, label: string): Promise<void> {
  const resized = await resizeForOutput(png);
  const { width, height } = await getDimensions(resized);
  content.push({ type: "image", data: toBase64(resized), mimeType: "image/png" });
  content.push({ type: "text", text: `${label} — image ${width}x${height}` });
}

/** How a side is named in the output: where it ended up, and its title if it has one. */
function describeSide(requested: string, side: Side): string {
  const where = requested === CURRENT_PAGE ? `the open page (${side.url})` : side.url;
  return side.title ? `${where} "${side.title}"` : where;
}

/** Cosmetic, and never allowed to fail or stall: a busy page still gets compared. */
async function safeTitle(page: Page): Promise<string | undefined> {
  return Promise.race([
    page.title().catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PAGE_INFO_TIMEOUT_MS)),
  ]);
}

async function sizeOf(png: Buffer): Promise<Viewport> {
  const { width, height } = await getDimensions(png);
  return { width, height };
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a failed comparison. Mirrors `describeFailure` in
 * screenshot.ts, with one addition: a `page.goto` failure names which of the
 * two sides could not be opened, which is the first thing you want to know.
 */
export function describeCompareFailure(
  input: Pick<ParsedCompareInput, "url_a" | "url_b" | "wait_for" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const prefix = "Compare failed:";

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (/^page\.goto:/.test(message)) {
    const side = failingSide(input, message);
    return `${prefix} could not open ${side} — ${firstLine}`;
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  return `${prefix} ${firstLine}`;
}

/** Playwright quotes the URL it tried in a goto failure; that says which side broke. */
function failingSide(input: Pick<ParsedCompareInput, "url_a" | "url_b">, message: string): string {
  if (input.url_b !== CURRENT_PAGE && message.includes(input.url_b)) return `url_b (${input.url_b})`;
  if (input.url_a !== CURRENT_PAGE && message.includes(input.url_a)) return `url_a (${input.url_a})`;
  return "one of the two pages";
}

export function registerCompareTool(server: McpServer): void {
  server.registerTool(
    COMPARE_TOOL_NAME,
    {
      title: "Compare",
      description:
        "Compare two pages — two URLs, or the same URL before and after a code change — and show what moved. " +
        "Returns both screenshots, the percentage of pixels that differ, the region they differ in, and an " +
        `overlay of the second page with every changed pixel tinted. Pass "${CURRENT_PAGE}" as \`url_a\` to ` +
        "compare against the page framewatch_interact has open, in whatever state your interactions left it.",
      inputSchema: compareInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => comparePages(args),
  );
}
