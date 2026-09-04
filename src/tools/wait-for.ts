import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  DEFAULT_SNAPSHOT_WAIT_MS,
  DEFAULT_WAIT_FOR_TIMEOUT_MS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  MAX_WAIT_FOR_TIMEOUT_MS,
  VUE_DETECT_MS,
  VUE_READY_TIMEOUT_MS,
} from "../constants.js";
import { withSessionLock } from "../engine/browser.js";
import { hasViteClient, hmrFor } from "../engine/hmr.js";
import { takeSnapshot } from "../engine/snapshot.js";
import { detectVue, waitForVueReady } from "../engine/vue.js";
import { describeScale } from "../utils/format.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { storageStateField, withAuthNote } from "../utils/storage-state.js";
import { describeVue, type VueInfo } from "../utils/vue-rules.js";
import { describeCounts, describeSessionFailure, openSessionPage } from "./snapshot.js";

export const WAIT_FOR_TOOL_NAME = "framewatch_wait_for";

export const waitForInputShape = {
  url: z
    .string()
    .url()
    .optional()
    .describe("Open this URL first. Omit to wait on the page left open by framewatch_interact / framewatch_snapshot."),
  until: z
    .enum(["hot_update", "vue_ready", "selector", "network_idle"])
    .default("hot_update")
    .describe(
      "`hot_update`: Vite applied a hot update (or full reload) newer than the last tool call on this page — " +
        "use it right after saving a file. `vue_ready`: a Vue app is mounted and its router has resolved. " +
        "`selector`: `selector` is visible. `network_idle`: no requests for 500ms.",
    ),
  selector: z.string().optional().describe("For `until: selector` — the element to wait for"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .max(MAX_WAIT_FOR_TIMEOUT_MS)
    .default(DEFAULT_WAIT_FOR_TIMEOUT_MS)
    .describe("Give up after this long"),
  include_screenshot: z.boolean().default(true).describe("Return a screenshot once the condition holds"),
  include_snapshot: z.boolean().default(false).describe("Also return a framewatch_snapshot with fresh refs"),
  wait_ms: z.number().int().min(0).default(DEFAULT_SNAPSHOT_WAIT_MS).describe("Settle time (ms) after opening `url`"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT),
    })
    .optional()
    .describe("Resize the page to this first (defaults to leaving it as it is)"),
  storage_state: storageStateField,
};

export const waitForInputSchema = z.object(waitForInputShape).superRefine((value, ctx) => {
  if (value.until === "selector" && !value.selector) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`until: selector` needs a `selector`", path: ["selector"] });
  }
});
export type WaitForInput = z.input<typeof waitForInputSchema>;

/**
 * Wait for the session page to reach a state worth looking at, then look.
 *
 * The one that earns the tool its place is `hot_update`: after the agent
 * saves a file, Vite patches the open page in place, and this returns the
 * moment that patch has landed — no reload, no replayed flow, no guessed
 * sleep. The other conditions replace the guessed sleeps elsewhere.
 */
export function waitFor(rawInput: WaitForInput): Promise<CallToolResult> {
  return withSessionLock(() => runWaitFor(rawInput));
}

async function runWaitFor(rawInput: WaitForInput): Promise<CallToolResult> {
  const parsed = waitForInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Wait failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  try {
    const opened = await openSessionPage(input, "Wait");
    if ("error" in opened) return errorResult(opened.error);
    const { page, auth, login_visible } = opened;
    const watcher = hmrFor(page);
    const since = watcher.lastSeen;
    const started = Date.now();
    const elapsed = (): number => Date.now() - started;

    let headline: string;
    let vue: VueInfo | null = null;

    switch (input.until) {
      case "hot_update": {
        const event = await watcher.waitForEvent(since, input.timeout_ms);
        if (!event) {
          if (!watcher.connected && !(await hasViteClient(page))) {
            return errorResult(
              `Wait failed: ${page.url()} has no Vite dev-server connection (no \`[vite] connected.\` in the console and no /@vite/client script), so there will never be a hot update to wait for. Is this the dev server, or a built page?`,
            );
          }
          const latest = watcher.latest;
          const last = latest ? ` — last one landed ${started - latest.t}ms before this call (${latest.path})` : "";
          return errorResult(`Wait failed: No hot update within ${input.timeout_ms}ms${last}. Save the file, then call again.`);
        }
        const landed = event.t - started;
        if (event.kind === "reload") {
          await page.waitForLoadState("load", { timeout: input.timeout_ms }).catch(() => undefined);
        }
        vue = (await waitForVueReady(page, { detect_ms: VUE_DETECT_MS, ready_ms: VUE_READY_TIMEOUT_MS })).vue;
        const what = event.kind === "reload" ? "Full reload" : "Hot update";
        const kind = event.kind === "css" ? " (css)" : "";
        headline = `${what} landed after ${Math.max(0, landed)}ms${kind}${event.path ? `: ${event.path}` : ""}`;
        break;
      }
      case "vue_ready": {
        const result = await waitForVueReady(page, { detect_ms: input.timeout_ms, ready_ms: input.timeout_ms });
        if (!result.vue) return errorResult(`Wait failed: No Vue app mounted on ${page.url()} within ${input.timeout_ms}ms.`);
        vue = result.vue;
        headline = `Vue ready after ${result.waited_ms}ms`;
        break;
      }
      case "selector": {
        try {
          await page.waitForSelector(input.selector!, { state: "visible", timeout: input.timeout_ms });
        } catch {
          return errorResult(`Wait failed: "${input.selector}" did not appear within ${input.timeout_ms}ms on ${page.url()}.`);
        }
        headline = `"${input.selector}" appeared after ${elapsed()}ms`;
        vue = await detectVue(page);
        break;
      }
      case "network_idle": {
        try {
          await page.waitForLoadState("networkidle", { timeout: input.timeout_ms });
        } catch {
          return errorResult(`Wait failed: the network did not go idle within ${input.timeout_ms}ms on ${page.url()}.`);
        }
        headline = `Network idle after ${elapsed()}ms`;
        vue = await detectVue(page);
        break;
      }
    }

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const lines = [`${headline}${vue ? ` — ${describeVue(vue)}` : ""} — ${page.url()} — ${describeScale(viewport)}`];
    const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
    if (input.include_screenshot) {
      const png = await page.screenshot({ type: "png" });
      content.push({ type: "image", data: toBase64(await resizeForOutput(png)), mimeType: "image/png" });
    }
    if (input.include_snapshot) {
      const snapshot = await takeSnapshot(page, { mode: "full", max_chars: DEFAULT_SNAPSHOT_MAX_CHARS });
      const text = [`Snapshot — ${describeCounts(snapshot)} (refs valid until the page changes)`, "", snapshot.text];
      if (snapshot.cut_lines > 0) text.push(`… ${snapshot.cut_lines} more lines cut — use framewatch_snapshot with \`selector\` or mode "interactive".`);
      content.push({ type: "text", text: text.join("\n") });
    }
    watcher.markSeen();
    return withAuthNote({ content }, auth, login_visible);
  } catch (error) {
    return errorResult(describeSessionFailure("Wait", input, error));
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function registerWaitForTool(server: McpServer): void {
  server.registerTool(
    WAIT_FOR_TOOL_NAME,
    {
      title: "Wait for",
      description:
        "Wait for the open page to reach a state worth looking at, then screenshot it. After you save a file, " +
        "`until: hot_update` returns the moment Vite has patched the page in place (or reloaded it) — no reload, " +
        "no replayed flow, no guessed sleep — and names the file that changed. `vue_ready` waits for a Vue app to " +
        "mount and its router to resolve; `selector` for an element; `network_idle` for requests to stop. " +
        "Works on the page framewatch_interact / framewatch_snapshot keep open; `include_snapshot` returns fresh refs.",
      inputSchema: waitForInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => waitFor(args),
  );
}
