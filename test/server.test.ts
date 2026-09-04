import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RawServer, SERVER_ENTRY } from "./helpers/raw-server.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";
import { freePort } from "./helpers/free-port.js";
import { isPortOpen } from "../src/utils/server-process.js";

const FAKE_DEV_SERVER = fileURLToPath(new URL("./helpers/fake-dev-server.mjs", import.meta.url));

const PKG_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;

let client: Client;
let fixtures: FixtureServer;

beforeAll(async () => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`${SERVER_ENTRY} not found — run \`npm run build\` first (npm test does this via pretest)`);
  }
  fixtures = await startFixtureServer();
  client = new Client({ name: "framewatch-test-client", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: "pipe" });
  transport.stderr?.resume(); // drain so the child can never block on a full pipe
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await fixtures?.close();
});

type Block = { type: string; data?: string; mimeType?: string; text?: string };

describe("framewatch MCP server over stdio (SDK client)", () => {
  it("identifies itself as framewatch with the package.json version", () => {
    expect(client.getServerVersion()?.name).toBe("framewatch");
    expect(client.getServerVersion()?.version).toBe(PKG_VERSION);
  });

  it("advertises instructions that describe every registered tool", async () => {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(instructions).toContain(tool.name);
    }
    expect(instructions).toMatch(/animation|changes over time/i);
  });

  it("registers all seventeen tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "framewatch_accessibility",
      "framewatch_api_mock",
      "framewatch_capture",
      "framewatch_compare",
      "framewatch_dead_clicks",
      "framewatch_form_test",
      "framewatch_inspect",
      "framewatch_interact",
      "framewatch_links",
      "framewatch_responsive",
      "framewatch_rtl",
      "framewatch_save_auth",
      "framewatch_screenshot",
      "framewatch_seo",
      "framewatch_snapshot",
      "framewatch_start_server",
      "framewatch_stop_server",
      "framewatch_wait_for",
    ]);
  });

  it("lists the framewatch_screenshot tool with a read-only annotation and url input", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("framewatch_screenshot");

    const tool = tools.find((t) => t.name === "framewatch_screenshot")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.idempotentHint).toBe(true);
    expect(tool.inputSchema.required).toContain("url");
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["url", "wait_ms", "viewport", "selector", "wait_for"]),
    );
  });

  it("screenshots a local fixture page over the protocol (no network needed)", async () => {
    const result = await client.callTool({
      name: "framewatch_screenshot",
      arguments: { url: `${fixtures.url}/basic.html`, wait_ms: 0, selector: "#box" },
    });
    expect(result.isError).toBeFalsy();
    const image = (result.content as Block[]).find((c) => c.type === "image")!;
    const meta = await sharp(Buffer.from(image.data!, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([200, 100]);
  });

  it("screenshots https://example.com and returns an image block in the cheaper of PNG and JPEG", async () => {
    const result = await client.callTool({
      name: "framewatch_screenshot",
      arguments: { url: "https://example.com", wait_ms: 500 },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    const image = content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    // The image budget picks whichever encoding is smaller for this page.
    expect(image!.mimeType).toMatch(/^image\/(png|jpeg)$/);

    const buffer = Buffer.from(image!.data!, "base64");
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe(image!.mimeType === "image/png" ? "png" : "jpeg");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(450);

    const text = content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("https://example.com");
    expect(text).toContain("Example Domain");
  });

  it("lists the framewatch_capture tool as read-only but not idempotent, with url required", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "framewatch_capture");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.destructiveHint).toBe(false);
    expect(tool!.annotations?.idempotentHint).toBe(false);
    expect(tool!.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["url", "duration_ms", "sensitivity", "max_frames", "interval_ms", "viewport", "wait_for"]),
    );
  });

  it("captures a local fixture page over the protocol and returns several image blocks", async () => {
    const result = await client.callTool({
      name: "framewatch_capture",
      arguments: { url: `${fixtures.url}/splash.html`, duration_ms: 1500, viewport: { width: 400, height: 300 } },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    expect(content[0].type).toBe("text");
    expect(content[0].text).toMatch(/Captured \d+ meaningful frames from \d+ raw frames/);
    const images = content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(2);
    const meta = await sharp(Buffer.from(images[0].data!, "base64")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 400, 300]);
  });

  it("lists the framewatch_interact tool as stateful (not read-only, not idempotent) with action required", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "framewatch_interact");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(false);
    expect(tool!.annotations?.destructiveHint).toBe(false);
    expect(tool!.annotations?.idempotentHint).toBe(false);
    expect(tool!.inputSchema.required).toEqual(["action"]);
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["action", "selector", "value", "x", "y", "delta_x", "delta_y", "url", "wait_ms", "viewport"]),
    );
  });

  it("advertises the capture interactions array in its JSON schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "framewatch_capture")!;
    const interactions = (tool.inputSchema.properties as Record<string, { type?: string; items?: unknown }>).interactions;
    expect(interactions).toBeDefined();
    expect(interactions.type).toBe("array");
    expect(JSON.stringify(interactions.items)).toContain("swipe");
  });

  it("performs an interaction over the protocol and returns before and after frames", async () => {
    const result = await client.callTool({
      name: "framewatch_interact",
      arguments: {
        url: `${fixtures.url}/interactive.html`,
        action: "click",
        selector: "#btn",
        wait_ms: 300,
        viewport: { width: 400, height: 300 },
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    expect(content[0].text).toContain('click "#btn"');
    const images = content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(2);
    const meta = await sharp(Buffer.from(images[0].data!, "base64")).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 400, 300]);
  });

  it("replays a capture interaction script over the protocol", async () => {
    const result = await client.callTool({
      name: "framewatch_capture",
      arguments: {
        url: `${fixtures.url}/interactive.html`,
        duration_ms: 1000,
        viewport: { width: 400, height: 300 },
        interactions: [{ action: "click", selector: "#btn", delay_ms: 200 }],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    expect(content[0].text).toContain("Interactions: 1/1 replayed");
    expect(content.some((c) => c.type === "text" && /\[interaction\]/.test(c.text ?? ""))).toBe(true);
  });

  it("lists framewatch_responsive as read-only and idempotent, with url required", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "framewatch_responsive")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.idempotentHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(["url"]);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["url", "viewports", "wait_ms", "wait_for"]),
    );
  });

  it("captures a page at several viewports over the protocol", async () => {
    const result = await client.callTool({
      name: "framewatch_responsive",
      arguments: {
        url: `${fixtures.url}/responsive.html`,
        wait_ms: 0,
        viewports: [
          { name: "phone", width: 320, height: 240 },
          { name: "desktop", width: 900, height: 300 },
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(content[0].text).toContain("2 of 2 viewports");
    const meta = await sharp(Buffer.from(content.find((c) => c.type === "image")!.data!, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
  });

  it("runs an accessibility audit over the protocol and names the rules that failed", async () => {
    const result = await client.callTool({
      name: "framewatch_accessibility",
      arguments: { url: `${fixtures.url}/a11y-bad.html`, wait_ms: 0 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Block[]).map((c) => c.text ?? "").join("\n");
    expect(text).toContain("image-alt");
    expect(text).toContain("WCAG2AA");
  });

  it("compares two pages over the protocol and returns both frames plus the overlay", async () => {
    const result = await client.callTool({
      name: "framewatch_compare",
      arguments: {
        url_a: `${fixtures.url}/compare-a.html`,
        url_b: `${fixtures.url}/compare-b.html`,
        wait_ms: 0,
        viewport: { width: 400, height: 300 },
      },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Block[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(3);
    expect(content[0].text).toContain("5.00% of pixels differ");
  });

  it("starts and stops a dev server over the protocol, with structured results", async () => {
    const port = await freePort();
    const command = [JSON.stringify(process.execPath), JSON.stringify(FAKE_DEV_SERVER), "--port", String(port)].join(" ");

    const started = await client.callTool({ name: "framewatch_start_server", arguments: { command, port } });
    expect(started.isError).toBeFalsy();
    expect(started.structuredContent).toMatchObject({ status: "running", port });

    // It is a real server: the screenshot tool can see it.
    const shot = await client.callTool({
      name: "framewatch_screenshot",
      arguments: { url: `http://127.0.0.1:${port}/`, wait_ms: 0 },
    });
    expect(shot.isError).toBeFalsy();
    expect((shot.content as Block[]).find((c) => c.type === "text")?.text).toContain("fake dev server");

    const stopped = await client.callTool({ name: "framewatch_stop_server", arguments: {} });
    expect(stopped.isError).toBeFalsy();
    expect(stopped.structuredContent).toMatchObject({ status: "stopped", port });
  });

  it("reports not_running when asked to stop a server it never started", async () => {
    const result = await client.callTool({ name: "framewatch_stop_server", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "not_running" });
  });

  it("rejects invalid input (non-URL) with an error result instead of crashing", async () => {
    const result = await client.callTool({
      name: "framewatch_screenshot",
      arguments: { url: "not a url" },
    });
    expect(result.isError).toBe(true);

    // Server must still be alive afterwards.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });
});

describe("framewatch server process lifecycle (raw stdio)", () => {
  let server: RawServer;

  afterEach(async () => {
    await server?.dispose();
  });

  async function initAndLaunchBrowser(env?: NodeJS.ProcessEnv): Promise<RawServer> {
    server = new RawServer(env);
    await server.initialize();
    const res = await server.callTool("framewatch_screenshot", { url: `${fixtures.url}/basic.html`, wait_ms: 0 });
    expect(res.result?.isError).toBeFalsy();
    return server;
  }

  it("exits cleanly (code 0, no signal) when the client closes stdin, even with a browser running", async () => {
    await initAndLaunchBrowser();
    server.child.stdin!.end();

    const status = await server.waitForExit(5000);
    expect(status).toEqual({ code: 0, signal: null });
    expect(server.stderr.join("\n")).toMatch(/shutting down \(stdin/);
  });

  it("owns SIGINT: shuts the browser down and exits with code 0 (not Playwright's 130)", async () => {
    await initAndLaunchBrowser();
    server.child.kill("SIGINT");

    const status = await server.waitForExit(5000);
    expect(status).toEqual({ code: 0, signal: null });
    expect(server.stderr.join("\n")).toContain("shutting down (SIGINT)");
  });

  it("still shuts down when stderr is gone (no EPIPE livelock)", async () => {
    await initAndLaunchBrowser();
    // Close our read end of the child's stderr: its next log write gets EPIPE.
    server.child.stderr!.destroy();
    server.child.stdin!.end();

    const status = await server.waitForExit(5000);
    expect(status.code).toBe(0);
  });

  it("stops the dev server it started when the client goes away", async () => {
    const port = await freePort();
    const command = [JSON.stringify(process.execPath), JSON.stringify(FAKE_DEV_SERVER), "--port", String(port)].join(" ");

    server = new RawServer();
    await server.initialize();
    const started = await server.callTool("framewatch_start_server", { command, port });
    expect(started.result?.isError).toBeFalsy();
    expect(await isPortOpen(port)).toBe(true);

    server.child.stdin!.end();
    expect(await server.waitForExit(10_000)).toEqual({ code: 0, signal: null });

    // The dev server was a child of the process that just exited; it must not
    // have outlived it, still holding the port.
    expect(await isPortOpen(port)).toBe(false);
  }, 20_000);

  it("tells the user how to install Chromium when Playwright's browser is missing", async () => {
    server = new RawServer({ PLAYWRIGHT_BROWSERS_PATH: "/nonexistent/framewatch-no-browsers" });
    await server.initialize();
    const res = await server.callTool("framewatch_screenshot", { url: `${fixtures.url}/basic.html`, wait_ms: 0 });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("npx playwright install chromium");
  });
});

describe("bin entry", () => {
  it("starts the stdio server when launched through a symlink, as npm's bin shim does", async () => {
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const link = join(mkdtempSync(join(tmpdir(), "framewatch-bin-")), "framewatch-mcp-server");
    symlinkSync(SERVER_ENTRY, link);

    const server = new RawServer({}, link);
    try {
      const init = await Promise.race([
        server.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("no initialize response via symlink")), 5000)),
      ]);
      expect((init as any).result.serverInfo.name).toBe("framewatch");
    } finally {
      await server.dispose();
    }
  });
});

describe("createServer (in-process embedding)", () => {
  it("can be imported and connected to an in-memory transport without hijacking stdin", async () => {
    const dataListenersBefore = process.stdin.listenerCount("data");
    const { createServer } = await import("../src/index.js");
    expect(process.stdin.listenerCount("data")).toBe(dataListenersBefore);

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverSide);
    const embedded = new Client({ name: "embedded", version: "0" });
    await embedded.connect(clientSide);

    const { tools } = await embedded.listTools();
    expect(tools.map((t) => t.name)).toContain("framewatch_screenshot");
    await embedded.close();
    await server.close();
  });
});

describe("image budget over stdio", () => {
  it("fits a heavy result to MAX_MCP_OUTPUT_TOKENS instead of letting the client drop it", async () => {
    const server = new RawServer({ MAX_MCP_OUTPUT_TOKENS: "6000" });
    try {
      await server.initialize();
      const reply = await server.request("tools/call", {
        name: "framewatch_capture",
        arguments: { url: `${fixtures.url}/heavy.html`, duration_ms: 1500, sensitivity: 0, max_frames: 6 },
      });
      const content = reply.result.content as Block[];
      const imgs = content.filter((c) => c.type === "image");
      expect(imgs.length).toBeGreaterThanOrEqual(1);
      // Well inside the cap: 6000 tokens at 3 chars each, minus the text.
      const chars = imgs.reduce((n, c) => n + (c.data?.length ?? 0), 0);
      expect(chars).toBeLessThan(6000 * 3);
      const note = content.filter((c) => c.type === "text").map((c) => c.text ?? "").at(-1)!;
      expect(note).toMatch(/^Image budget: \d+ of \d+ images kept/);
      expect(note).toContain("MAX_MCP_OUTPUT_TOKENS=6000");
    } finally {
      await server.dispose();
    }
  });

  it("leaves a light result alone at the default cap", async () => {
    const result = await client.callTool({ name: "framewatch_screenshot", arguments: { url: `${fixtures.url}/basic.html` } });
    const content = result.content as Block[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(content.some((c) => c.type === "text" && (c.text ?? "").startsWith("Image budget"))).toBe(false);
  });
});
