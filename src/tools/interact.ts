import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_INTERACT_WAIT_MS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { getSessionPage, withSessionLock } from "../engine/browser.js";
import { buildDiffCards } from "../engine/differ.js";
import { applyContext, layersFor, summariseContext, type LayerFlags } from "../engine/layers/index.js";
import {
  INTERACT_ACTIONS,
  describeInteraction,
  executeInteraction,
  interactionFieldShape,
  needsTouch,
  refineInteraction,
  type Interaction,
} from "../engine/interaction.js";
import { takeSnapshot } from "../engine/snapshot.js";
import type { RawFrame } from "../types.js";
import { describeScale, formatCardMeta } from "../utils/format.js";
import { REF_SHAPE, refSelector } from "../utils/snapshot-rules.js";
import { describeAuth, loginFormVisible, resolveStorageState, storageStateField } from "../utils/storage-state.js";
import { DEFAULT_SNAPSHOT_MAX_CHARS, VUE_DETECT_MS, VUE_READY_TIMEOUT_MS } from "../constants.js";
import { hmrFor } from "../engine/hmr.js";
import { detectVue, waitForVueReady } from "../engine/vue.js";
import { describeVue, type VueInfo } from "../utils/vue-rules.js";
import { describeCounts } from "./snapshot.js";
import { markImage } from "../utils/budget.js";

export const INTERACT_TOOL_NAME = "framewatch_interact";

export const interactInputShape = {
  action: z
    .enum(INTERACT_ACTIONS)
    .describe("What to do: click, tap, type, key, scroll, swipe, navigate, select or hover"),
  ...interactionFieldShape,
  ref: z
    .string()
    .regex(REF_SHAPE, "a ref looks like `e8` (or `f1e8`) — take one from framewatch_snapshot")
    .optional()
    .describe("Element ref from framewatch_snapshot (e.g. `e8`) to act on, instead of a `selector`"),
  url: z
    .string()
    .url()
    .optional()
    .describe("Open this URL first. Omit to act on the page left open by the previous call."),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_INTERACT_WAIT_MS)
    .describe("Wait time (ms) after the action before the 'after' screenshot, so animations can settle"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for the target element"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT),
    })
    .optional()
    .describe("Resize the page to this before acting (defaults to leaving it as it is)"),
  include_console: z
    .boolean()
    .default(true)
    .describe("Report console logs, uncaught errors and unhandled rejections the action caused"),
  include_network: z
    .boolean()
    .default(false)
    .describe("Report network requests (method, url, status, duration) the action caused"),
  include_dom: z
    .boolean()
    .default(false)
    .describe("Report the DOM mutations the action caused — which elements were added, removed or restyled"),
  include_performance: z
    .boolean()
    .default(false)
    .describe("Report paint timing and layout shifts measured around the action"),
  include_snapshot: z
    .boolean()
    .default(false)
    .describe("Append a framewatch_snapshot of the page after the action, with fresh refs for the next call"),
  storage_state: storageStateField,
};

export const interactInputSchema = z.object(interactInputShape).superRefine((value, ctx) => {
  if (value.ref !== undefined && value.selector !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pass either `ref` or `selector`, not both", path: ["ref"] });
    return;
  }
  // A ref is a selector Playwright understands, so the step is validated as one.
  refineInteraction(value.ref !== undefined ? { ...value, selector: refSelector(value.ref) } : value, ctx);
});
export type InteractInput = z.input<typeof interactInputSchema>;

/**
 * Perform one interaction on the current page and show what it did.
 *
 * Unlike every other FrameWatch tool this one is stateful on purpose: the page
 * stays open between calls (see `getSessionPage`), which is what makes
 * click → look → type → look iteration possible. Pass `url` to open or move
 * the page; omit it to keep working on what is already there.
 *
 * The result is a two-frame diff card sequence — before, after, and the
 * change region between them — reusing the same diff engine as
 * `framewatch_capture` so the change bbox and crop mean the same thing in
 * both tools.
 *
 * Calls are serialised through `withSessionLock`, which every tool that
 * touches the session page shares: one page, one hand.
 */
export function performInteraction(rawInput: InteractInput): Promise<CallToolResult> {
  return withSessionLock(() => runInteraction(rawInput));
}

async function runInteraction(rawInput: InteractInput): Promise<CallToolResult> {
  const parsed = interactInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Interaction failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const selector = input.ref !== undefined ? refSelector(input.ref) : input.selector;
  const step: Interaction = {
    action: input.action,
    ...(selector !== undefined ? { selector } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.delta_x !== undefined ? { delta_x: input.delta_x } : {}),
    ...(input.delta_y !== undefined ? { delta_y: input.delta_y } : {}),
  };

  const flags: LayerFlags = {
    console: input.include_console,
    network: input.include_network,
    dom: input.include_dom,
    performance: input.include_performance,
  };

  try {
    // Cookies and storage are fixed when a context is created, so a state named
    // here applies to the page this call opens; a session already running on
    // the same state simply carries on (see `getSessionPage`).
    const auth = await resolveStorageState(input.storage_state);
    const storageState = auth ? { path: auth.path, state: auth.state } : undefined;

    const { page, previousUrl, reopenedFor } = await getSessionPage({
      ...(input.viewport ? { viewport: input.viewport } : {}),
      hasTouch: needsTouch([step]),
      ...(storageState ? { storageState } : {}),
    });

    // The layers belong to the page, not to this call (see SessionLayers), so
    // they are installed once and emptied here — this call reports what this
    // action caused, not what the last twenty did. Both happen before the
    // navigation, so a page opened by `url` has its load watched too.
    const layers = layersFor(page);
    await layers.ensure(flags);
    layers.clear();

    // `previousUrl` means the session had to be reopened (for touch, or to take
    // a different auth state); go back to where the user was unless they asked
    // for somewhere else.
    const target = input.url ?? previousUrl;
    if (target !== undefined) {
      await page.goto(target, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      // A Vue app is acted on once it is mounted and its router has resolved;
      // a plain page gets no extra wait beyond the brief look for one.
      await waitForVueReady(page, { detect_ms: VUE_DETECT_MS, ready_ms: VUE_READY_TIMEOUT_MS });
    }
    if (page.url() === "about:blank") {
      return errorResult(
        "Interaction failed: no page is open yet — pass `url` to open one (e.g. http://localhost:3000).",
      );
    }

    const vueBefore = await detectVue(page);
    // A password field before the action and none after it is a login that
    // just succeeded — the one moment the agent is thinking about auth.
    const loginBefore = await loginFormVisible(page);
    const before = await page.screenshot({ type: "png" });
    const startedAt = Date.now();
    const outcome = await executeInteraction(page, step, { timeout_ms: input.timeout_ms });
    if (input.wait_ms > 0) {
      await page.waitForTimeout(input.wait_ms);
    }
    const after = await page.screenshot({ type: "png" });
    const vueAfter = vueBefore || step.action === "navigate" ? await detectVue(page) : null;
    const loginAfter = await loginFormVisible(page);

    const frames: RawFrame[] = [
      { buffer: before, timestamp_ms: 0, is_interaction: false },
      { buffer: after, timestamp_ms: Date.now() - startedAt, is_interaction: true },
    ];
    // sensitivity 0 keeps both frames however small the change is — the point
    // of this tool is to show what one action did, including "nothing".
    const { cards } = await buildDiffCards(frames, { sensitivity: 0, max_frames: 2 });
    if (cards.length < 2) {
      return errorResult(`Interaction failed: ${describeInteraction(step)} ran, but the screenshots could not be compared.`);
    }

    // `startedAt` is the instant of the "before" frame, which puts the split
    // exactly where it belongs: everything from opening the page lands on the
    // before card (negative, i.e. "how we got here") and everything the action
    // caused lands on the after card.
    const context = layers.collect(startedAt, flags);
    applyContext(cards, context);

    const [beforeCard, afterCard] = cards;
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const headline = [
      `${summarise(step, page.url(), afterCard.change_region?.change_percent ?? 0, reopenedFor, input.ref, outcome.note)} — ${describeScale(viewport)}`,
      ...describeRoute(vueBefore, vueAfter),
      ...(summariseContext(context, cards.length) ?? []),
      ...authLines(auth, input.url !== undefined && loginBefore, loginBefore && !loginAfter),
    ].join("\n");

    const content: CallToolResult["content"] = [
      { type: "text", text: headline },
      { type: "image", data: beforeCard.full_frame, mimeType: "image/png" },
      { type: "text", text: `Before — ${formatCardMeta(beforeCard)}` },
      { type: "image", data: afterCard.full_frame, mimeType: "image/png" },
      { type: "text", text: `After — ${formatCardMeta(afterCard)}` },
    ];
    const crop = afterCard.change_region?.crop;
    if (crop) {
      content.push(markImage({ type: "image", data: crop, mimeType: "image/png" }, { role: "crop" }));
    }
    if (input.include_snapshot) {
      // Refs are reassigned by every snapshot, so the ones the caller used are
      // stale the moment this runs — which is the point: these are the fresh ones.
      const snapshot = await takeSnapshot(page, { mode: "full", max_chars: DEFAULT_SNAPSHOT_MAX_CHARS });
      const lines = [`Snapshot — ${describeCounts(snapshot)} (refs valid until the page changes)`, "", snapshot.text];
      if (snapshot.cut_lines > 0) lines.push(`… ${snapshot.cut_lines} more lines cut — use framewatch_snapshot with \`selector\` or mode "interactive".`);
      content.push({ type: "text", text: lines.join("\n") });
    }
    hmrFor(page).markSeen();
    return { content };
  } catch (error) {
    return errorResult(describeInteractFailure(input, error));
  }
}

/**
 * The auth lines: what saved state was applied (and whether it worked, when
 * this call opened the page), and — when a login form was there before the
 * action and gone after it — the reminder to save the session now.
 */
function authLines(auth: Awaited<ReturnType<typeof resolveStorageState>>, expired: boolean, justSignedIn: boolean): string[] {
  const lines: string[] = [];
  const applied = auth ? describeAuth(auth, expired) : null;
  if (applied) lines.push(applied);
  if (justSignedIn) {
    lines.push(
      "Signed in? Save this session with framewatch_save_auth (same steps, from the login page) so every later call " +
        "starts here instead of replaying the login.",
    );
  }
  return lines;
}

/**
 * The Vue line: the app and its route, and — when the action moved the
 * router — where it went, by name.
 */
function describeRoute(before: VueInfo | null, after: VueInfo | null): string[] {
  const current = after ?? before;
  if (!current) return [];
  const from = before?.route;
  const to = after?.route;
  if (from && to && from.path !== to.path) {
    const name = (route: { path: string; name?: string }): string => `${route.path}${route.name ? ` (${route.name})` : ""}`;
    return [`Vue ${current.version} — route ${name(from)} → ${name(to)}`];
  }
  return [describeVue(current)];
}

/** One line: what was done, where, and how much of the frame it moved. */
function summarise(
  step: Interaction,
  url: string,
  changePercent: number,
  reopenedFor?: "touch" | "auth",
  ref?: string,
  note?: string,
): string {
  const reopened =
    reopenedFor === "touch"
      ? " (page reopened to enable touch — page state was reset)"
      : reopenedFor === "auth"
        ? " (page reopened with the saved auth state — page state was reset)"
        : "";
  const changed = changePercent > 0 ? `${changePercent.toFixed(1)}% of the frame changed` : "no visual change";
  // The step carries the ref as an `aria-ref=` selector; the caller wrote `e8`.
  const what = (ref !== undefined ? describeInteraction(step).replaceAll(`"${refSelector(ref)}"`, ref) : describeInteraction(step)) + (note ?? "");
  return `${what} on ${url}${reopened} — ${changed}`;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Turn a failure into one actionable line. Interaction errors already name the
 * step and the reason (see `executeInteraction`), so they are passed through
 * with the page appended for context; everything else is a navigation or
 * browser problem, worded as in the other tools.
 */
export function describeInteractFailure(input: { url?: string; ref?: string }, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];

  if (input.ref !== undefined && message.includes(refSelector(input.ref))) {
    return (
      `Interaction failed: ref ${input.ref} did not resolve — the page has changed since that snapshot, or none was ` +
      `taken on this page. Run framewatch_snapshot again and use a ref from it. (${firstLine.replaceAll(`"${refSelector(input.ref)}"`, input.ref)})`
    );
  }

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      "Interaction failed: Playwright's Chromium browser is not installed. " +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (/^page\.goto:/.test(message)) {
    return `Interaction failed: could not open ${input.url ?? "the page"} — ${firstLine}`;
  }
  return input.url ? `${firstLine} (page: ${input.url})` : firstLine;
}

export function registerInteractTool(server: McpServer): void {
  server.registerTool(
    INTERACT_TOOL_NAME,
    {
      title: "Interact",
      description:
        "Perform one interaction (click, tap, type, scroll, swipe, hover, select, navigate) on a page and return " +
        "before/after screenshots plus a crop of what changed. The page stays open between calls, so you can " +
        "click, look, type and look again without replaying the whole flow — pass `url` only to open or move it. " +
        "Target an element by `ref` from framewatch_snapshot (e.g. `e8`) instead of guessing a selector; " +
        "`include_snapshot` returns the fresh refs after the action. " +
        "Each call also reports the context its own action produced: console output and uncaught errors (on by " +
        "default), plus network requests, DOM mutations and paint/layout-shift timing via `include_network`, " +
        "`include_dom` and `include_performance` — that is how you find out why a click did nothing.",
      inputSchema: interactInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => performInteraction(args),
  );
}
