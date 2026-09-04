import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  DEFAULT_SNAPSHOT_WAIT_MS,
  MAX_SNAPSHOT_MAX_CHARS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
  VUE_READY_TIMEOUT_MS,
} from "../constants.js";
import { getSessionPage, withSessionLock, type SessionOptions } from "../engine/browser.js";
import { hmrFor } from "../engine/hmr.js";
import { takeSnapshot, type PageSnapshot } from "../engine/snapshot.js";
import { componentTree, detectVue, waitForVueReady } from "../engine/vue.js";
import { describeVue, formatComponentTree, type VueInfo } from "../utils/vue-rules.js";
import { describeScale } from "../utils/format.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { loginFormVisible, resolveStorageState, storageStateField, withAuthNote, type ResolvedAuth } from "../utils/storage-state.js";
import type { Viewport } from "../types.js";

export const SNAPSHOT_TOOL_NAME = "framewatch_snapshot";

export const snapshotInputShape = {
  url: z
    .string()
    .url()
    .optional()
    .describe("Open this URL first. Omit to read the page left open by framewatch_interact / framewatch_inspect."),
  selector: z.string().optional().describe("Only this container, e.g. `main` or `#checkout`"),
  mode: z
    .enum(["full", "interactive"])
    .default("full")
    .describe("`full` is the whole tree with headings and text; `interactive` is a flat list of what can be clicked, typed into or chosen"),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(MAX_SNAPSHOT_MAX_CHARS)
    .default(DEFAULT_SNAPSHOT_MAX_CHARS)
    .describe("Cut the tree past this many characters (a note says how many lines went)"),
  include_screenshot: z.boolean().default(false).describe("Also return a screenshot of the page as it was read"),
  include_components: z
    .boolean()
    .default(false)
    .describe("On a Vue app: also return the component tree (names and nesting) from the root"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_SNAPSHOT_WAIT_MS)
    .describe(
      "Settle time (ms) after opening `url`. On a Vue app this is a ceiling: the page is read as soon as the app " +
        "is mounted and its router ready",
    ),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before reading"),
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

export const snapshotInputSchema = z.object(snapshotInputShape);
export type SnapshotInput = z.input<typeof snapshotInputSchema>;

/**
 * Read the page as a tree of named elements, on the interact session's page so
 * the refs it hands out are the ones the next `framewatch_interact` or
 * `framewatch_inspect` can use.
 */
export function snapshotPage(rawInput: SnapshotInput): Promise<CallToolResult> {
  return withSessionLock(() => runSnapshot(rawInput));
}

async function runSnapshot(rawInput: SnapshotInput): Promise<CallToolResult> {
  const parsed = snapshotInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Snapshot failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  try {
    const opened = await openSessionPage(input, "Snapshot");
    if ("error" in opened) return errorResult(opened.error);
    const { page, vue, auth, login_visible } = opened;

    const snapshot = await takeSnapshot(page, {
      ...(input.selector ? { selector: input.selector } : {}),
      mode: input.mode,
      max_chars: input.max_chars,
    });

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const title = await page.title().catch(() => "");
    const lines = [
      `Snapshot of ${page.url()}${title ? ` — "${title}"` : ""} — ${describeScale(viewport).replace(/, images.*$/, "")} — ${describeCounts(snapshot)}${vue ? ` — ${describeVue(vue)}` : ""}`,
      ...(input.include_screenshot ? [describeScale(viewport)] : []),
      ...(input.selector ? [`Scope: ${input.selector}`] : []),
      REF_HINT,
      "",
      snapshot.text,
      ...(snapshot.cut_lines > 0
        ? [`… ${snapshot.cut_lines} more lines cut — raise \`max_chars\`, pass \`selector\`, or use mode "interactive".`]
        : []),
    ];
    if (input.include_components) {
      lines.push("", ...(await describeComponents(page, vue)));
    }

    const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    if (input.include_screenshot) {
      const png = await page.screenshot({ type: "png" });
      content.unshift({ type: "image", data: toBase64(await resizeForOutput(png)), mimeType: "image/png" });
    }
    hmrFor(page).markSeen();
    return withAuthNote({ content }, auth, login_visible);
  } catch (error) {
    return errorResult(describeSessionFailure("Snapshot", input, error));
  }
}

const REF_HINT =
  "Refs: pass one as `ref` to framewatch_interact (to act on it) or framewatch_inspect (to measure it). " +
  "They stay valid until the page changes — snapshot again after an action that re-rendered. " +
  'In a framewatch_capture script, target the same element with a selector such as role=button[name="Sign in"].';

export function describeCounts(snapshot: Pick<PageSnapshot, "elements" | "interactive">): string {
  return `${snapshot.elements} elements, ${snapshot.interactive} interactive`;
}

/** The component tree, or why there is none. */
async function describeComponents(page: Awaited<ReturnType<typeof getSessionPage>>["page"], vue: VueInfo | null): Promise<string[]> {
  if (!vue) return ["Components: no Vue app on this page"];
  if (vue.major < 3) return ["Components: Vue 2 — component details need Vue 3"];
  if (vue.production) return ["Components: production build — no component data on elements"];
  const tree = await componentTree(page);
  if (!tree) return ["Components: could not be read"];
  return formatComponentTree(tree.root, tree.total);
}

/** Input the session-page tools share: where to open, how long to wait, what size. */
export interface SessionPageInput {
  url?: string;
  wait_ms?: number;
  wait_for?: string;
  wait_for_timeout_ms?: number;
  viewport?: Viewport;
  storage_state?: string;
}

/**
 * The session page, opened at `url` when one is given. Shared by snapshot and
 * inspect, which both read the page interact drives; `toolName` is only for
 * the error wording.
 */
export interface OpenedSessionPage {
  page: Awaited<ReturnType<typeof getSessionPage>>["page"];
  vue: VueInfo | null;
  /** The saved auth in force for this call, if any. */
  auth: ResolvedAuth | null;
  /** Whether the page showed a login form after opening — only checked when `url` was given. */
  login_visible: boolean;
}

export async function openSessionPage(input: SessionPageInput, toolName: string): Promise<OpenedSessionPage | { error: string }> {
  const options: SessionOptions = {};
  if (input.viewport) options.viewport = input.viewport;
  const auth = await resolveStorageState(input.storage_state);
  if (auth) options.storageState = { path: auth.path, state: auth.state };

  const { page, previousUrl } = await getSessionPage(options);
  const target = input.url ?? previousUrl;
  if (target !== undefined) {
    await page.goto(target, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
    if (input.wait_for) {
      await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms ?? SELECTOR_TIMEOUT_MS });
    }
    // `wait_ms` is a ceiling, not a sleep: a Vue app is read the moment it is
    // mounted and its router has resolved; a page without one gets the full wait.
    const { vue } = await waitForVueReady(page, { detect_ms: input.wait_ms ?? 0, ready_ms: VUE_READY_TIMEOUT_MS });
    if (page.url() === "about:blank") return { error: noPage(toolName) };
    return { page, vue, auth, login_visible: auth && input.url !== undefined ? await loginFormVisible(page) : false };
  }
  if (page.url() === "about:blank") return { error: noPage(toolName) };
  return { page, vue: await detectVue(page), auth, login_visible: false };
}

function noPage(toolName: string): string {
  return `${toolName} failed: no page is open yet — pass \`url\` to open one (e.g. http://localhost:3000).`;
}

export function describeSessionFailure(toolName: string, input: { url?: string; wait_for?: string; wait_for_timeout_ms?: number }, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return `${toolName} failed: Playwright's Chromium browser is not installed. Run \`npx playwright install chromium\` and try again. (${firstLine})`;
  }
  if (/^page\.goto:/.test(message)) {
    return `${toolName} failed: could not open ${input.url ?? "the page"} — ${firstLine}`;
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${toolName} failed: selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms ?? SELECTOR_TIMEOUT_MS}ms.`;
  }
  return `${toolName} failed: ${firstLine}`;
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function registerSnapshotTool(server: McpServer): void {
  server.registerTool(
    SNAPSHOT_TOOL_NAME,
    {
      title: "Snapshot",
      description:
        "Read the page as a tree of named elements — every heading, field, button and link with its accessible name " +
        "and a short ref like `e8` — so you know what is on the page and what to call it instead of guessing selectors " +
        "from a screenshot. Pass a ref as `ref` to framewatch_interact to act on that element, or to framewatch_inspect " +
        "to measure it. Works on the page framewatch_interact keeps open; pass `url` to open one. " +
        "Use mode `interactive` for a short list of only what can be acted on.",
      inputSchema: snapshotInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => snapshotPage(args),
  );
}
