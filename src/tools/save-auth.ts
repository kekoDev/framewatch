import { z } from "zod";
import type { BrowserContextOptions, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_AUTH_STATE_PATH,
  DEFAULT_VIEWPORT,
  MAX_INTERACTIONS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SAVE_AUTH_STEP_DELAY_MS,
  SAVE_AUTH_WAIT_FOR_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  CAPTURE_ACTIONS,
  describeInteraction,
  executeInteraction,
  interactionFieldShape,
  needsTouch,
  refineInteraction,
} from "../engine/interaction.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { storageStateSummary, writeStorageState, type StorageState } from "../utils/storage-state.js";

export const SAVE_AUTH_TOOL_NAME = "framewatch_save_auth";

/** One step of the login flow. Same shape as a capture script, with a settle time that suits a form. */
export const saveAuthInteractionSchema = z
  .object({
    action: z
      .enum(CAPTURE_ACTIONS)
      .describe("What to do: click, tap, type, key, scroll, swipe, hover, select, wait or navigate"),
    ...interactionFieldShape,
    delay_ms: z
      .number()
      .int()
      .min(0)
      .default(SAVE_AUTH_STEP_DELAY_MS)
      .describe("Wait this long (ms) before performing this step, so the previous one can settle"),
  })
  .superRefine(refineInteraction);

export const saveAuthInputShape = {
  url: z
    .string()
    .url()
    .describe("Where the flow starts — the login page or the gate, e.g. http://localhost:3000"),
  interactions: z
    .array(saveAuthInteractionSchema)
    .max(MAX_INTERACTIONS)
    .describe(
      "The login/setup steps to run, in order. Use `key` with `Enter` (or a `\\n` at the end of a typed " +
        "value) to submit a form.",
    ),
  output_path: z
    .string()
    .min(1)
    .default(DEFAULT_AUTH_STATE_PATH)
    .describe("Where to write the state file. Relative paths are resolved against the server's working directory."),
  wait_for: z
    .string()
    .optional()
    .describe(
      "CSS selector that proves the flow worked, e.g. '.feed' or '.dashboard'. Strongly recommended: without " +
        "it a flow that silently failed still saves a signed-out state.",
    ),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SAVE_AUTH_WAIT_FOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` after the last step (must be > 0)"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) one step may spend waiting for its target element"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
      is_mobile: z
        .boolean()
        .default(false)
        .describe("Emulate a phone (mobile viewport meta handling). Set it if the app serves a separate mobile UI."),
      has_touch: z
        .boolean()
        .optional()
        .describe("Give the page touch events. Defaults to on when the flow taps or swipes, or when `is_mobile` is set."),
    })
    .optional()
    .describe("Viewport for the flow (defaults to 1280x720). A phone-shaped app wants 390x844 with `is_mobile`."),
};

export const saveAuthInputSchema = z.object(saveAuthInputShape);
export type SaveAuthInput = z.input<typeof saveAuthInputSchema>;

/** What the browser side of the run produced: either a state, or the step that stopped it. */
interface Outcome {
  png?: Buffer;
  finalUrl?: string;
  state?: StorageState;
  failure?: string;
  completed: string[];
}

/**
 * Run a login flow once and save what it produced, so no other tool has to
 * replay it.
 *
 * The saved file is Playwright's storage state — cookies plus per-origin
 * localStorage — which every other FrameWatch tool takes as `storage_state`.
 * Two rules make it trustworthy:
 *
 *   - Nothing is written unless the flow finished, including `wait_for`. A
 *     state file that is not signed in is worse than no file at all: every
 *     later call would load it and quietly get the login screen back.
 *   - The final frame is always returned, success or failure. When a flow
 *     breaks, the picture of where it stopped is the thing that explains why.
 *
 * There is no auto-refresh. When a saved session expires the login screen
 * simply appears in the next capture, which is the clearest possible signal to
 * run this tool again.
 */
export async function saveAuth(rawInput: SaveAuthInput): Promise<CallToolResult> {
  const parsed = saveAuthInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Saving auth state failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  const viewport = {
    width: input.viewport?.width ?? DEFAULT_VIEWPORT.width,
    height: input.viewport?.height ?? DEFAULT_VIEWPORT.height,
  };
  // Touch follows the script, as it does in framewatch_capture: `hasTouch`
  // changes what feature detection sees, so it is not turned on for a flow
  // that never touches anything.
  const hasTouch = input.viewport?.has_touch ?? (input.viewport?.is_mobile === true || needsTouch(input.interactions));
  const contextOptions: BrowserContextOptions = {
    ...(hasTouch ? { hasTouch: true } : {}),
    ...(input.viewport?.is_mobile ? { isMobile: true } : {}),
  };

  try {
    const outcome = await withPage({ viewport, contextOptions }, async (page, context): Promise<Outcome> => {
      const completed: string[] = [];
      await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });

      for (const step of input.interactions) {
        try {
          await executeInteraction(page, step, { timeout_ms: input.timeout_ms });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { failure: message, completed, png: await safeScreenshot(page), finalUrl: safely(() => page.url()) };
        }
        completed.push(describeInteraction(step));
      }

      if (input.wait_for) {
        try {
          await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
        } catch {
          return {
            failure:
              `the flow ran, but "${input.wait_for}" never became visible within ${input.wait_for_timeout_ms}ms, ` +
              "so it did not sign in",
            completed,
            png: await safeScreenshot(page),
            finalUrl: safely(() => page.url()),
          };
        }
      }

      return {
        state: await context.storageState(),
        completed,
        png: await safeScreenshot(page),
        finalUrl: safely(() => page.url()),
      };
    });

    return outcome.state
      ? await succeed(input, outcome, outcome.state)
      : fail(`Saving auth state failed: ${outcome.failure}`, outcome);
  } catch (error) {
    return errorResult(describeSaveAuthFailure(input, error));
  }
}

/** Write the state and describe what is in it — and what to do with it next. */
async function succeed(
  input: z.output<typeof saveAuthInputSchema>,
  outcome: Outcome,
  state: StorageState,
): Promise<CallToolResult> {
  await writeStorageState(state, input.output_path);

  const lines = [`Saved auth state to ${input.output_path} — ${storageStateSummary(state)}.`];
  if (outcome.completed.length > 0) {
    lines.push(`Ran ${outcome.completed.length} step${outcome.completed.length === 1 ? "" : "s"}: ${outcome.completed.join("; ")}`);
  }
  if (outcome.finalUrl) lines.push(`Ended on ${outcome.finalUrl}`);

  if (state.cookies.length === 0 && state.origins.every((origin) => origin.localStorage.length === 0)) {
    lines.push(
      "Nothing was stored, so this file will not keep you signed in. Check that the flow really completed " +
        "(add `wait_for`), and note that sessions kept only in sessionStorage or in memory cannot be saved.",
    );
  } else {
    lines.push(
      `Pass storage_state: "${input.output_path}" to framewatch_screenshot, framewatch_capture, ` +
        "framewatch_interact, framewatch_responsive, framewatch_accessibility or framewatch_compare to start " +
        "past this flow. The file holds live session credentials — keep it out of version control.",
    );
  }

  return { content: await withFrame(outcome.png, lines.join("\n")) };
}

/** The failure, plus the frame it happened on. */
function fail(message: string, outcome: Outcome): CallToolResult {
  const lines = [message];
  if (outcome.completed.length > 0) lines.push(`Completed before it stopped: ${outcome.completed.join("; ")}`);
  if (outcome.finalUrl) lines.push(`Page at that moment: ${outcome.finalUrl}`);
  lines.push("Nothing was written — a state file that is not signed in would make every later call fail silently.");

  const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
  return { isError: true, content: pushFrame(content, outcome.png) };
}

async function withFrame(png: Buffer | undefined, text: string): Promise<CallToolResult["content"]> {
  const content: CallToolResult["content"] = [];
  if (png) {
    content.push({ type: "image", data: toBase64(await resizeForOutput(png)), mimeType: "image/png" });
  }
  content.push({ type: "text", text });
  return content;
}

/** The failure frame is attached raw-ish: it is evidence, and resizing it can itself fail. */
function pushFrame(content: CallToolResult["content"], png: Buffer | undefined): CallToolResult["content"] {
  if (png) content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  return content;
}

/** A screenshot is always worth having and never worth failing over. */
async function safeScreenshot(page: Page): Promise<Buffer | undefined> {
  try {
    if (page.isClosed()) return undefined;
    return await page.screenshot({ type: "png" });
  } catch {
    return undefined;
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
 * One actionable line for a failure that happened outside the flow itself
 * (launching the browser, opening the URL, writing the file). Mirrors
 * `describeFailure` in screenshot.ts.
 */
export function describeSaveAuthFailure(input: { url: string; output_path: string }, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const prefix = "Saving auth state failed:";

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (/^page\.goto:/.test(message)) {
    return `${prefix} could not open ${input.url} — ${firstLine}`;
  }
  if (/EACCES|EPERM|ENOTDIR|EISDIR/.test(message)) {
    return `${prefix} could not write ${input.output_path} — ${firstLine}`;
  }
  return `${prefix} ${firstLine}`;
}

export function registerSaveAuthTool(server: McpServer): void {
  server.registerTool(
    SAVE_AUTH_TOOL_NAME,
    {
      title: "Save auth",
      description:
        "Run a login or gate flow once and save the browser state it produces (cookies and localStorage) to a " +
        "file. Every other FrameWatch tool takes that file as `storage_state` and opens the page already signed " +
        "in, so an app behind a login can be tested without replaying the flow on every call. Give `wait_for` a " +
        "selector that only exists once signed in: nothing is written unless it appears, so a state file always " +
        "means a real session. When a saved session expires the login screen shows up in the next capture — run " +
        "this again then.",
      inputSchema: saveAuthInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => saveAuth(args),
  );
}
