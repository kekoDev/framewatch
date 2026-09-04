import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_SCREENSHOT_WAIT_MS, DEFAULT_VIEWPORT, NAVIGATION_TIMEOUT_MS, SELECTOR_TIMEOUT_MS } from "../constants.js";
import { withPage } from "../engine/browser.js";
import { getDimensions, resizeForOutput, toBase64 } from "../utils/image.js";
import { loginFormVisible, resolveStorageState, storageStateField, withAuthNote } from "../utils/storage-state.js";

export const SCREENSHOT_TOOL_NAME = "framewatch_screenshot";

export const screenshotInputShape = {
  url: z
    .string()
    .url()
    .describe("URL to screenshot, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_SCREENSHOT_WAIT_MS)
    .describe("Wait time (ms) after page load before screenshot"),
  viewport: z
    .object({
      width: z.number().int().min(1).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  selector: z.string().optional().describe("CSS selector to screenshot a specific element instead of the viewport"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before taking the screenshot"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` / `selector` to appear (must be > 0)"),
  storage_state: storageStateField,
};

export const screenshotInputSchema = z.object(screenshotInputShape);
export type ScreenshotInput = z.input<typeof screenshotInputSchema>;
type ParsedScreenshotInput = z.output<typeof screenshotInputSchema>;

/**
 * Take a single screenshot of a page and return it as an MCP image content
 * block (base64 PNG, resized to max OUTPUT_MAX_WIDTH wide) plus a one-line
 * text summary. All failures — including invalid input — are reported as
 * `isError` results rather than thrown so the MCP client sees a useful message.
 */
export async function takeScreenshot(rawInput: ScreenshotInput): Promise<CallToolResult> {
  const parsed = screenshotInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Screenshot failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  try {
    const auth = await resolveStorageState(input.storage_state);
    const contextOptions = auth ? { storageState: auth.state } : {};
    const shot = await withPage({ viewport, contextOptions }, async (page) => {
      const response = await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });

      if (input.wait_for) {
        await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
      }
      if (input.wait_ms > 0) {
        await page.waitForTimeout(input.wait_ms);
      }

      const png = input.selector
        ? await page.locator(input.selector).first().screenshot({ type: "png", timeout: input.wait_for_timeout_ms })
        : await page.screenshot({ type: "png" });

      return {
        png,
        title: await page.title(),
        finalUrl: page.url(),
        status: response?.status() ?? null,
        // A login form on the page after restoring a session is the expiry signal.
        loginVisible: auth ? await loginFormVisible(page) : false,
      };
    });

    const resized = await resizeForOutput(shot.png);
    const { width, height } = await getDimensions(resized);

    const summaryParts = [
      `Screenshot of ${shot.finalUrl}`,
      shot.status !== null && shot.status >= 400 ? `HTTP ${shot.status}` : null,
      shot.title ? `"${shot.title}"` : null,
      `${width}x${height}`,
      `viewport ${viewport.width}x${viewport.height}`,
      input.selector ? `element ${input.selector}` : null,
    ].filter((p): p is string => p !== null);

    return withAuthNote(
      {
        content: [
          { type: "image", data: toBase64(resized), mimeType: "image/png" },
          { type: "text", text: summaryParts.join(" — ") },
        ],
      },
      auth,
      shot.loginVisible,
    );
  } catch (error) {
    return errorResult(describeFailure(input, error));
  }
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Turn a Playwright/Node error into a one-line, actionable message. Matches on
 * the failing Playwright call (the message prefix) rather than on substrings
 * of user-supplied selectors, so a navigation failure is never blamed on an
 * element.
 */
export function describeFailure(
  input: Pick<ParsedScreenshotInput, "url" | "wait_for" | "selector" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const prefix = `Screenshot of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${firstLine})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  if (input.selector && /^locator\.screenshot:/.test(message)) {
    return `${prefix} element "${input.selector}" not found or not visible within ${input.wait_for_timeout_ms}ms. ${firstLine}`;
  }
  return `${prefix} ${firstLine}`;
}

export function registerScreenshotTool(server: McpServer): void {
  server.registerTool(
    SCREENSHOT_TOOL_NAME,
    {
      title: "Screenshot",
      description:
        "Take a single screenshot of a web page (or one element on it) and return it as a PNG image. " +
        "Good for checking the current visual state of a running app.",
      inputSchema: screenshotInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => takeScreenshot(args),
  );
}
