import { z } from "zod";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CAPTURE_INTERVAL_MS,
  DEFAULT_CAPTURE_DURATION_MS,
  DEFAULT_MAX_FRAMES,
  DEFAULT_SENSITIVITY,
  DEFAULT_VIEWPORT,
  MAX_CAPTURE_DURATION_MS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  MAX_FRAMES_CAP,
  MAX_INTERACTIONS,
  MIN_CAPTURE_DURATION_MS,
  NAVIGATION_TIMEOUT_MS,
  PAGE_INFO_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import { buildDiffCards } from "../engine/differ.js";
import { applyContext, attachLayers, summariseContext, type CapturedContext } from "../engine/layers/index.js";
import {
  CAPTURE_ACTIONS,
  describeInteraction,
  executeInteraction,
  interactionFieldShape,
  needsTouch,
  refineInteraction,
  type Interaction,
} from "../engine/interaction.js";
import { recordFrames, type FrameRecorder } from "../engine/recorder.js";
import { formatDiffCards, type InteractionReport } from "../utils/format.js";
import type { DiffCard, Viewport } from "../types.js";
import { describeAuth, loginFormVisible, resolveStorageState, storageStateField, type ResolvedAuth } from "../utils/storage-state.js";

export const CAPTURE_TOOL_NAME = "framewatch_capture";

/**
 * Re-exported where it is used: the capture summary's context lines. It lives
 * with the layers themselves now that `framewatch_interact` reports them too.
 */
export { summariseContext };

/**
 * One step of a replayable interaction script. `delay_ms` is a wait *before*
 * the action, so a `wait` step is just a delay with nothing after it, and the
 * delays of successive steps accumulate over the recording.
 */
export const captureInteractionSchema = z
  .object({
    action: z
      .enum(CAPTURE_ACTIONS)
      .describe("What to do: click, tap, type, key, scroll, swipe, hover, select, wait or navigate"),
    ...interactionFieldShape,
    delay_ms: z.number().int().min(0).default(0).describe("Wait this long (ms) before performing this action"),
  })
  .superRefine(refineInteraction);

export const captureInputShape = {
  url: z.string().url().describe("URL to capture, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  duration_ms: z
    .number()
    .int()
    .min(MIN_CAPTURE_DURATION_MS)
    .max(MAX_CAPTURE_DURATION_MS)
    .default(DEFAULT_CAPTURE_DURATION_MS)
    .describe("How long to record (ms)"),
  sensitivity: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_SENSITIVITY)
    .describe("Frame change threshold (0 = keep all, 1 = keep none). 0.06 means ~6% of grid cells must change."),
  max_frames: z
    .number()
    .int()
    .min(1)
    .max(MAX_FRAMES_CAP)
    .default(DEFAULT_MAX_FRAMES)
    .describe("Maximum diff cards to return"),
  interval_ms: z
    .number()
    .int()
    .min(16)
    .max(2000)
    .default(CAPTURE_INTERVAL_MS)
    .describe("Raw frame capture interval (ms) — 100 = 10fps"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before recording starts"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  interactions: z
    .array(captureInteractionSchema)
    .max(MAX_INTERACTIONS)
    .optional()
    .describe(
      "Sequence of user interactions to replay during the recording. Selectors may be CSS or Playwright's " +
      'role form, e.g. role=button[name="Sign in"] — take the role and name from framewatch_snapshot',
    ),
  interaction_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) an interaction step may spend waiting for its target element"),
  include_console: z
    .boolean()
    .default(true)
    .describe("Attach console logs, uncaught errors and unhandled rejections to the frames they happened between"),
  include_network: z
    .boolean()
    .default(false)
    .describe("Attach network requests (method, url, status, duration) to the frames they settled between"),
  include_dom: z
    .boolean()
    .default(false)
    .describe("Attach a summary of the DOM mutations between frames — which elements were added, removed or restyled"),
  include_performance: z
    .boolean()
    .default(false)
    .describe("Attach paint timing, largest contentful paint and layout shifts to the frames they were measured at"),
  storage_state: storageStateField,
};

export const captureInputSchema = z.object(captureInputShape);
export type CaptureInput = z.input<typeof captureInputSchema>;
export type ParsedCaptureInput = z.output<typeof captureInputSchema>;

/**
 * Hooks a caller can run inside a capture session.
 *
 * `framewatch_api_mock` uses `prepare` to install its request routes before
 * anything navigates; `framewatch_capture` itself passes none.
 */
export interface CaptureHooks {
  /**
   * Run against the page and its context before the layers are attached and
   * before the navigation. Anything that has to be in place for the very first
   * request the page makes belongs here.
   */
  prepare?: (page: Page, context: BrowserContext) => Promise<void>;
  /**
   * Run once the recording has stopped, while the page is still open. For
   * releasing anything `prepare` installed that would otherwise outlive the
   * call — a route still sleeping out a delay has nothing left to answer.
   * A failure here is swallowed: the frames have already been taken.
   */
  finish?: (page: Page, context: BrowserContext) => Promise<void>;
}

/** Everything one capture session produced, before anything formats it. */
export interface CaptureRun {
  cards: DiffCard[];
  /** Raw frames the recorder took, before the differ chose between them. */
  total_frames: number;
  duration_ms: number;
  /** URL that was requested. */
  url: string;
  /** URL the page ended on, when it could be read. */
  final_url?: string;
  title?: string;
  /** Frames the recorder had to drop (screenshot failures). */
  dropped: number;
  context: CapturedContext;
  /** Present only when an interaction script was replayed. */
  interactions?: InteractionReport;
  /** The viewport the frames were recorded at. */
  viewport: Viewport;
  /** The saved auth that was applied, if any, and whether the page still showed a login form afterwards. */
  auth: ResolvedAuth | null;
  login_visible: boolean;
}

/**
 * Run one capture session: navigate, record, replay the script, diff.
 *
 * Throws on failure rather than returning an error result — each caller has
 * its own wording for what went wrong (see `describeCaptureFailure`).
 *
 * Shared with `framewatch_api_mock`, which needs this exact flow with its
 * routes installed first. One navigation, one recorder, one differ, and one
 * place to fix any of them.
 */
export async function runCapture(input: ParsedCaptureInput, hooks: CaptureHooks = {}): Promise<CaptureRun> {
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };
  const interactions = input.interactions ?? [];
  // Touch has to be decided when the context is created, so read it off the
  // script rather than turning it on for every capture: `hasTouch` puts
  // `ontouchstart` on window, which flips feature detection in most UI
  // libraries and would silently change what a plain capture records.
  const contextOptions: BrowserContextOptions = needsTouch(interactions) ? { hasTouch: true } : {};

  const report: InteractionReport | undefined =
    interactions.length > 0 ? { total: interactions.length, completed: 0, steps: [] } : undefined;

  const auth = await resolveStorageState(input.storage_state);
  if (auth) contextOptions.storageState = auth.state;

  const recording = await withPage({ viewport, contextOptions }, async (page, context) => {
    // Before anything else, including the layers: whatever the caller needs in
    // place for the page's very first request.
    if (hooks.prepare) await hooks.prepare(page, context);

    // Layers go on before the navigation: a script that throws while the page
    // loads, the request that never comes back and first paint all happen
    // before frame 0 exists, and they are the most useful things here.
    const layers = await attachLayers(page, {
      console: input.include_console,
      network: input.include_network,
      dom: input.include_dom,
      performance: input.include_performance,
    });
    try {
      // "commit" rather than "load": splash/loading animations must be recorded from the very start.
      await page.goto(input.url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS });
      if (input.wait_for) {
        await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
      }
      const result = await recordFrames(
        page,
        { duration_ms: input.duration_ms, interval_ms: input.interval_ms },
        report && ((recorder) => replayScript(page, recorder, interactions, input.interaction_timeout_ms, report)),
      );
      // Drain the layers before anything else can close the page. `collect`
      // reads only what Node already holds, so a page that froze, navigated
      // away or crashed still yields everything it managed to report.
      const collected = layers.collect(result.started_at);
      // The page may have died mid-recording (crash, closed browser). Frames
      // already captured are still worth returning, so never let reading the
      // title or url turn a partial recording into an error.
      // A login form on the page after restoring a session is the expiry signal.
      const loginVisible = auth ? await loginFormVisible(page) : false;
      return { ...result, context: collected, loginVisible, ...(await describePage(page)) };
    } finally {
      layers.detach();
      if (hooks.finish) await hooks.finish(page, context).catch(() => {});
    }
  });

  const { cards, total_frames } = await buildDiffCards(recording.frames, {
    sensitivity: input.sensitivity,
    max_frames: input.max_frames,
  });
  applyContext(cards, recording.context);

  return {
    cards,
    total_frames,
    duration_ms: recording.duration_ms,
    url: input.url,
    final_url: recording.finalUrl,
    title: recording.title,
    dropped: recording.dropped,
    context: recording.context,
    interactions: report,
    viewport,
    auth,
    login_visible: recording.loginVisible,
  };
}

/**
 * The main FrameWatch tool: record a page for `duration_ms` and return only
 * the meaningful visual changes as diff cards (see the README, framewatch_capture).
 *
 * Flow: navigate (waiting only for the navigation to commit, so loading and
 * splash animations are recorded from their first frame) → optionally wait
 * for `wait_for` → record raw frames every `interval_ms`, replaying
 * `interactions` as the recording runs → smart-diff them into at most
 * `max_frames` cards → format. All failures — including invalid input — are
 * reported as `isError` results rather than thrown so the MCP client sees a
 * useful message.
 */
export async function capturePage(rawInput: CaptureInput): Promise<CallToolResult> {
  const parsed = captureInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Capture failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  let run: CaptureRun;
  try {
    run = await runCapture(input);
  } catch (error) {
    return errorResult(describeCaptureFailure(input, error));
  }

  return formatDiffCards({
    cards: run.cards,
    total_frames: run.total_frames,
    duration_ms: run.duration_ms,
    url: run.url,
    final_url: run.final_url,
    title: run.title,
    dropped: run.dropped,
    interactions: run.interactions,
    viewport: run.viewport,
    notes: [...(summariseContext(run.context, run.cards.length) ?? []), ...authLines(run)],
  });
}

/** The auth line for a run's summary, when there is one (see `describeAuth`). */
export function authLines(run: Pick<CaptureRun, "auth" | "login_visible">): string[] {
  const line = run.auth ? describeAuth(run.auth, run.login_visible) : null;
  return line ? [line] : [];
}

/**
 * Replay the interaction script while the recorder runs, forcing a frame after
 * every step so the differ always keeps the result of each action.
 *
 * A failing step ends the script but never the capture: the frames recorded so
 * far are the most useful thing FrameWatch can hand back (they show the state
 * the page was actually in when the selector did not match), so the failure is
 * recorded in `report` and a forced "error" frame is captured instead of
 * throwing. The recording then plays out the rest of its duration.
 */
async function replayScript(
  page: Page,
  recorder: FrameRecorder,
  interactions: Interaction[],
  timeoutMs: number,
  report: InteractionReport,
): Promise<void> {
  for (let i = 0; i < interactions.length; i++) {
    const step = interactions[i];
    let outcome;
    try {
      outcome = await executeInteraction(page, step, { timeout_ms: timeoutMs });
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      report.failed_index = i + 1;
      await recorder.captureNow("error");
      return;
    }
    report.completed++;
    report.steps.push(describeInteraction(step) + (outcome.note ?? ""));
    await recorder.captureNow("interaction");
  }
}

/**
 * Title and final url of a page. Both are cosmetic, so neither is allowed to
 * fail or delay the result: the page may have died during the recording, and
 * `page.title()` blocks for Playwright's full default timeout while the main
 * thread is busy — exactly the case a developer points this tool at.
 */
async function describePage(page: Page): Promise<{ title?: string; finalUrl?: string }> {
  if (page.isClosed()) return {};
  const finalUrl = safely(() => page.url());
  // Settle the losing side too: a page.title() that outlives the race would
  // otherwise reject unobserved when the context is closed underneath it.
  const title = page.title().catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), PAGE_INFO_TIMEOUT_MS);
  });
  try {
    return { title: await Promise.race([title, giveUp]), finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Turn a Playwright/Node error into a one-line, actionable message. Mirrors
 * `describeFailure` in screenshot.ts: matches on the failing Playwright call
 * (the message prefix) rather than on substrings of user-supplied selectors,
 * so a navigation failure is never blamed on an element.
 */
export function describeCaptureFailure(
  input: Pick<ParsedCaptureInput, "url" | "wait_for" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const prefix = `Capture of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  return `${prefix} ${firstLine}`;
}

export function registerCaptureTool(server: McpServer): void {
  server.registerTool(
    CAPTURE_TOOL_NAME,
    {
      title: "Capture",
      description:
        "Record a web page for a few seconds and return only the meaningful visual changes as diff cards: " +
        "a full-frame PNG plus a crop of the changed region and its position for each kept frame. " +
        "Use it to check animations, splash/loading screens, transitions and anything that changes over time. " +
        "Lower `sensitivity` to keep more frames; `max_frames` caps the output. " +
        "Each frame can also carry the context for the interval that produced it: console output and uncaught " +
        "errors (on by default), plus network requests, DOM mutations and paint/layout-shift timing via " +
        "`include_network`, `include_dom` and `include_performance` — that is how you find out *why* a frame " +
        "looks wrong, not just that it does.",
      inputSchema: captureInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => capturePage(args),
  );
}
