import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fitToBudget } from "../utils/budget.js";
import { registerAccessibilityTool } from "./accessibility.js";
import { registerApiMockTool } from "./api-mock.js";
import { registerCaptureTool } from "./capture.js";
import { registerCompareTool } from "./compare.js";
import { registerDeadClicksTool } from "./dead-clicks.js";
import { registerFormTestTool } from "./form-test.js";
import { registerInspectTool } from "./inspect.js";
import { registerInteractTool } from "./interact.js";
import { registerLinksTool } from "./links.js";
import { registerResponsiveTool } from "./responsive.js";
import { registerRtlTool } from "./rtl.js";
import { registerSaveAuthTool } from "./save-auth.js";
import { registerScreenshotTool } from "./screenshot.js";
import { registerSeoTool } from "./seo.js";
import { registerServerTools } from "./server.js";
import { registerSnapshotTool } from "./snapshot.js";
import { registerWaitForTool } from "./wait-for.js";

export { registerScreenshotTool, takeScreenshot, SCREENSHOT_TOOL_NAME } from "./screenshot.js";
export { registerCaptureTool, capturePage, CAPTURE_TOOL_NAME } from "./capture.js";
export { registerApiMockTool, mockApi, API_MOCK_TOOL_NAME } from "./api-mock.js";
export { registerInteractTool, performInteraction, INTERACT_TOOL_NAME } from "./interact.js";
export { registerSnapshotTool, snapshotPage, SNAPSHOT_TOOL_NAME } from "./snapshot.js";
export { registerInspectTool, inspectElements, INSPECT_TOOL_NAME } from "./inspect.js";
export { registerWaitForTool, waitFor, WAIT_FOR_TOOL_NAME } from "./wait-for.js";
export { registerResponsiveTool, captureResponsive, RESPONSIVE_TOOL_NAME } from "./responsive.js";
export { registerAccessibilityTool, auditAccessibility, ACCESSIBILITY_TOOL_NAME } from "./accessibility.js";
export { registerCompareTool, comparePages, COMPARE_TOOL_NAME, CURRENT_PAGE } from "./compare.js";
export { registerSaveAuthTool, saveAuth, SAVE_AUTH_TOOL_NAME } from "./save-auth.js";
export { registerFormTestTool, testForms, FORM_TEST_TOOL_NAME } from "./form-test.js";
export { registerSeoTool, auditSeo, SEO_TOOL_NAME } from "./seo.js";
export { registerDeadClicksTool, findDeadClicks, DEAD_CLICKS_TOOL_NAME } from "./dead-clicks.js";
export { registerLinksTool, checkLinks, LINKS_TOOL_NAME } from "./links.js";
export { registerRtlTool, testRtl, RTL_TOOL_NAME } from "./rtl.js";
export {
  registerServerTools,
  startServer,
  stopServer,
  START_SERVER_TOOL_NAME,
  STOP_SERVER_TOOL_NAME,
} from "./server.js";

/**
 * Register every FrameWatch tool on the given server.
 *
 * Every handler is wrapped so its result passes through the image budget on
 * the way out (see `utils/budget.ts`): a result over the client's cap loses
 * all its images, so this is the one place that guarantees none ever is.
 */
export function registerAllTools(server: McpServer): void {
  budgetEveryTool(server);
  registerScreenshotTool(server);
  registerCaptureTool(server);
  registerInteractTool(server);
  registerSnapshotTool(server);
  registerInspectTool(server);
  registerWaitForTool(server);
  registerResponsiveTool(server);
  registerAccessibilityTool(server);
  registerCompareTool(server);
  registerSaveAuthTool(server);
  registerFormTestTool(server);
  registerSeoTool(server);
  registerDeadClicksTool(server);
  registerLinksTool(server);
  registerApiMockTool(server);
  registerRtlTool(server);
  registerServerTools(server);
}

function budgetEveryTool(server: McpServer): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  // The generic signature cannot be re-expressed around a wrapper without
  // restating the SDK's types; the shape is (name, config, handler).
  (server as unknown as { registerTool: unknown }).registerTool = (name: unknown, config: unknown, handler: (...args: unknown[]) => unknown) =>
    original(name, config, async (...args: unknown[]) => fitToBudget((await handler(...args)) as Parameters<typeof fitToBudget>[0]));
}
