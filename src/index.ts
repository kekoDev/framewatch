#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "./engine/browser.js";
import { registerAllTools } from "./tools/index.js";
import { shutdownDevServer } from "./utils/server-process.js";

export const SERVER_NAME = "framewatch";
export const SERVER_VERSION: string = readPackageVersion();

/**
 * Build a fully configured FrameWatch McpServer (not yet connected to a
 * transport). Exported so tests and embedders can wire their own transport;
 * importing this module has no side effects — the stdio server only starts
 * when this file is executed directly (`node dist/index.js` / the npm bin).
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "FrameWatch gives you visual eyes on running web apps. Use framewatch_screenshot to see the " +
        "current state of a page. Pass a `selector` to zoom in on one element, or `wait_for` to wait " +
        "for an element before capturing. Use framewatch_capture to record a page for a few seconds " +
        "and get back only the frames where something meaningful changed (animations, splash screens, " +
        "transitions, anything that changes over time), each with a crop of the changed region and its " +
        "position. Lower `sensitivity` to keep more frames, raise `max_frames` for longer sequences. " +
        "Pass `interactions` to replay a click/type/scroll/tap/swipe script while it records — that is how you " +
        "test a flow such as a login. Use framewatch_interact for one action at a time: it keeps the page open " +
        "between calls, so you can click, look at the result, type, and look again without replaying the flow. " +
        "Before acting, use framewatch_snapshot to read that page as a tree of named elements — every field, button " +
        "and link with its accessible name and a ref like `e8` — and pass the ref as `ref` to framewatch_interact " +
        "instead of guessing a selector from a screenshot (mode `interactive` lists only what can be acted on; " +
        "`include_snapshot` on interact returns fresh refs after each action). When you are building or checking UI, " +
        "use framewatch_inspect on refs or selectors to measure how elements are really built: box in viewport px, " +
        "font, text and background colour with the WCAG contrast ratio, padding, margin, gap, border, radius, " +
        "clipping and overflow, and alignment to parent and previous sibling, with each target boxed on a " +
        "screenshot; call it with no targets for a design inventory of the page (fonts, sizes, colours, spacing " +
        "and radii in use, with counts) to spot the odd one out. On a Vue app, inspect also names the component " +
        "behind each element with its props and state, snapshot's `include_components` returns the component tree, " +
        "and every session tool reads the page the moment the app is mounted and its router ready instead of " +
        "sleeping. After you save a file, use framewatch_wait_for (`until: hot_update`) to return the moment Vite " +
        "has patched the open page — no reload, no replayed flow — and `navigate` goes through vue-router when the " +
        "app has one, keeping its state. Every tool that returns frames states the viewport " +
        "and image scale: coordinates and regions are always in viewport px, not image px. " +
        "Both capture and interact can attach the context behind a frame — console output and uncaught errors " +
        "(on by default), plus network requests, DOM mutations and paint timing via `include_network`, " +
        "`include_dom` and `include_performance` — which is how you find out why a frame looks wrong. " +
        "Use framewatch_responsive to see one page at mobile, tablet and desktop widths at once (it also " +
        "reports content that overflows its viewport), framewatch_accessibility to run an axe-core WCAG audit, " +
        "and framewatch_compare to diff two URLs — or the page interact has open against a URL — with an " +
        "overlay of every pixel that differs. Use framewatch_form_test on anything with fields in it: it fills " +
        "every form with valid data, with nothing, with special characters, with Arabic and with harmless XSS " +
        "payloads, one fresh page per strategy, and reports what each one produced — the validation shown, the " +
        "requests made, the console output, the values silently truncated. Use framewatch_seo to audit what a search " +
        "engine and a link preview make of a page: title and description with their lengths, canonical, robots " +
        "directives and robots.txt, Open Graph tags with the share image fetched and measured, the heading outline, " +
        "images with no alt text, and JSON-LD structured data — all read from the rendered DOM, so a client-rendered " +
        "app is measured properly. Use framewatch_dead_clicks to find the controls that look clickable and do " +
        "nothing: it clicks every link, button, click role and pointer-cursor element on the page and reports the " +
        "ones where absolutely nothing happened — no navigation, no DOM change, no request, no console output — " +
        "plus the ones whose handler threw, with a screenshot of them boxed in red. It really does press every " +
        "button, so pass `exclude` or `selector` to keep it away from anything destructive. " +
        "Use framewatch_links to check where every link on a page actually goes: 404s, server errors, redirect " +
        "chains, redirects that end on an error page, and `#fragment` links that point at no element. It reuses " +
        "the browser's own result for the images, scripts and stylesheets the page already loaded, retries a " +
        "refused HEAD as a GET before calling anything broken, and reports a 401/403/429 as a refused check " +
        "rather than a dead link. Raise `depth` to follow the site's internal links a level at a time. " +
        "Use framewatch_api_mock to answer the page's own API calls yourself and record what it does with the " +
        "answer: the empty list, the 500, the 401, the response that takes five seconds, the body that is not " +
        "valid JSON, the request that fails outright — one word each via `scenario`, or set the status, body, " +
        "headers and delay by hand. It returns the same diff cards as framewatch_capture, plus a report of " +
        "what each mock actually served, including any that matched nothing — which is how you find out a " +
        "pattern was wrong instead of trusting a page that looked fine. " +
        "Use framewatch_rtl to test a page in LTR and RTL and get back only what failed to mirror — a box that " +
        "did not move, text that stayed left-aligned, padding that did not swap, an icon that did not flip — with " +
        "both screenshots and every finding boxed. " +
        "For an app behind a login, run the flow once with " +
        "framewatch_save_auth and pass the file it writes as `storage_state` to any of these tools — they then " +
        "open the page already signed in instead of replaying the login every time. " +
        "If the app is not running yet, framewatch_start_server runs its " +
        "dev server (e.g. `npm run dev`) and waits for the port; framewatch_stop_server stops it again.",
    },
  );
  registerAllTools(server);
  return server;
}

/** Run the server on stdio until the client disconnects or the process is signalled. */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  // stderr may be closed by the host (e.g. parent died); never let a log write
  // turn into an uncaught 'error' event that re-enters the handlers below.
  process.stderr.on("error", () => {});

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      // The dev server is a child process of this one; leaving it behind would
      // hold its port and outlive the client that asked for it.
      await shutdownDevServer();
      await closeBrowser();
    } finally {
      await server.close().catch(() => {});
      process.exit(exitCode);
    }
  };

  // Client went away. The SDK transport only fires onclose on protocol errors,
  // so watch stdin EOF directly — once Chromium is running it would otherwise
  // keep the event loop (and a headless browser) alive forever.
  process.stdin.on("end", () => void shutdown("stdin closed"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
  transport.onclose = () => void shutdown("transport closed");

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (err) => {
    log(`uncaught exception: ${formatError(err)}`);
    void shutdown("uncaught exception", 1);
  });
  process.on("unhandledRejection", (err) => {
    log(`unhandled rejection: ${formatError(err)}`);
  });

  await server.connect(transport);
  log(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`);
}

/** stdout is the MCP channel — all diagnostics go to stderr, and never throw. */
function log(message: string): void {
  try {
    process.stderr.write(`[framewatch] ${message}\n`);
  } catch {
    // stderr is gone; nothing sensible to do.
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * True when this file is the process entry point. npm's bin shim is a symlink,
 * so compare real paths: import.meta.url is already resolved, argv[1] is not.
 */
function isRunDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  main().catch((err) => {
    log(`fatal: ${formatError(err)}`);
    process.exit(1);
  });
}
