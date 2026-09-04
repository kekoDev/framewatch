import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { DEFAULT_READY_PATTERN } from "../src/constants.js";
import { DevServerError, getDevServer, isPortOpen, startDevServer, stopDevServer } from "../src/utils/server-process.js";
import { startServer, startServerInputSchema, stopServer, describeStartFailure } from "../src/tools/server.js";
import { freePort } from "./helpers/free-port.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-dev-server.mjs", import.meta.url));

/** The command line for a fake dev server on `port`, plus any extra flags. */
function fake(port: number, ...flags: string[]): string {
  return [JSON.stringify(process.execPath), JSON.stringify(FAKE), "--port", String(port), ...flags].join(" ");
}

// Every test must leave the module-level server slot empty, whatever it did.
afterEach(async () => {
  await stopDevServer();
});

type Block = { type: string; text?: string };
type Result = Awaited<ReturnType<typeof startServer>>;

const text = (result: Result): string =>
  (result.content as Block[])
    .filter((c) => c.type === "text")
    .map((c) => c.text!)
    .join("\n");

describe("startDevServer", () => {
  it("waits for the port and reports the process it started", async () => {
    const port = await freePort();
    const server = await startDevServer({ command: fake(port), port, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 10_000 });

    expect(server.port).toBe(port);
    expect(server.pid).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${port}`);
    expect(server.ready_ms).toBeGreaterThanOrEqual(0);
    expect(await isPortOpen(port)).toBe(true);
    expect(getDevServer()?.pid).toBe(server.pid);
  });

  it("quotes back the line that matched the ready pattern", async () => {
    const port = await freePort();
    const server = await startDevServer({
      command: fake(port),
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 10_000,
    });

    expect(server.ready_line).toContain(`Local: http://localhost:${port}/`);
  });

  it("reads the ready line from stderr as well as stdout", async () => {
    const port = await freePort();
    const server = await startDevServer({
      command: fake(port, "--stderr"),
      port,
      ready_pattern: "Local:",
      timeout_ms: 10_000,
    });

    expect(server.ready_line).toContain("Local:");
  });

  it("starts a server whose output never matches the ready pattern, because the port is what counts", async () => {
    const port = await freePort();
    const server = await startDevServer({
      command: fake(port, "--quiet"),
      port,
      ready_pattern: "this will never match anything",
      timeout_ms: 10_000,
    });

    expect(server.pid).toBeGreaterThan(0);
    expect(server.ready_line).toBeUndefined();
    expect(await isPortOpen(port)).toBe(true);
  });

  it("waits for a slow port instead of giving up on the first probe", async () => {
    const port = await freePort();
    const server = await startDevServer({
      command: fake(port, "--listen-ms", "700"),
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 10_000,
    });

    expect(server.ready_ms).toBeGreaterThanOrEqual(600);
    expect(await isPortOpen(port)).toBe(true);
  });

  it("fails with the server's own output when the command exits before listening", async () => {
    const port = await freePort();
    const failing = startDevServer({
      command: fake(port, "--exit", "1"),
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 10_000,
    });

    await expect(failing).rejects.toThrow(/exited before port \d+ opened .*exit code 1/);
    await failing.catch((error: { output: string[] }) => {
      expect(error.output.join("\n")).toContain("cannot find module 'nope'");
    });
    expect(getDevServer()).toBeNull();
  });

  it("times out, kills the process and explains when the pattern matched but the port never opened", async () => {
    const port = await freePort();
    const failing = startDevServer({
      command: fake(port, "--never-listen"),
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 1200,
    });

    await expect(failing).rejects.toThrow(/did not open port \d+ within 1200ms/);
    await expect(failing).rejects.toThrow(/may be listening on a different port/);
    expect(getDevServer()).toBeNull();
    expect(await isPortOpen(port)).toBe(false);
  });

  it("refuses to start on a port something else is already using", async () => {
    const port = await freePort();
    const squatter: Server = createServer((_req, res) => res.end("busy"));
    await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));

    try {
      await expect(
        startDevServer({ command: fake(port), port, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 5000 }),
      ).rejects.toThrow(/already in use by another process/);
      expect(getDevServer()).toBeNull();
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("refuses a second server while one is running, naming the one to stop", async () => {
    const first = await freePort();
    const second = await freePort();
    await startDevServer({ command: fake(first), port: first, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 10_000 });

    await expect(
      startDevServer({ command: fake(second), port: second, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 5000 }),
    ).rejects.toThrow(/already running \(pid \d+, port \d+/);
  });

  it("rejects a ready pattern that is not a valid regex, before spawning anything", async () => {
    const port = await freePort();
    await expect(
      startDevServer({ command: fake(port), port, ready_pattern: "([unclosed", timeout_ms: 5000 }),
    ).rejects.toThrow(/not a valid regular expression/);
    expect(await isPortOpen(port)).toBe(false);
  });

  it("passes extra environment variables through to the process", async () => {
    const port = await freePort();
    // The fake server echoes nothing, so prove it through the shell instead:
    // the command only listens on the right port if FRAMEWATCH_TEST_PORT arrived.
    const server = await startDevServer({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} --port $FRAMEWATCH_TEST_PORT`,
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 10_000,
      env: { FRAMEWATCH_TEST_PORT: String(port) },
    });

    expect(await isPortOpen(server.port)).toBe(true);
  });
});

describe("stopDevServer", () => {
  it("stops the server and frees its port", async () => {
    const port = await freePort();
    const server = await startDevServer({ command: fake(port), port, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 10_000 });

    const stopped = await stopDevServer();
    expect(stopped?.pid).toBe(server.pid);
    expect(stopped?.port).toBe(port);
    expect(stopped?.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(stopped?.forced).toBe(false);
    expect(getDevServer()).toBeNull();
    expect(await isPortOpen(port)).toBe(false);
  });

  it("returns null when there is nothing to stop", async () => {
    expect(await stopDevServer()).toBeNull();
  });

  it("kills a server that ignores SIGTERM, and says that it had to", async () => {
    const port = await freePort();
    await startDevServer({
      command: fake(port, "--ignore-sigterm"),
      port,
      ready_pattern: DEFAULT_READY_PATTERN,
      timeout_ms: 10_000,
    });

    const stopped = await stopDevServer();
    expect(stopped?.forced).toBe(true);
    expect(await isPortOpen(port)).toBe(false);
  }, 20_000);

  it("reports a server that already died on its own rather than hanging", async () => {
    const port = await freePort();
    const server = await startDevServer({ command: fake(port), port, ready_pattern: DEFAULT_READY_PATTERN, timeout_ms: 10_000 });

    // Kill it behind the manager's back, as a crashing dev server would.
    process.kill(-server.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getDevServer()).toBeNull();

    const stopped = await stopDevServer();
    expect(stopped?.pid).toBe(server.pid);
    expect(stopped?.forced).toBe(false);
  });
});

describe("framewatch_start_server / framewatch_stop_server", () => {
  it("reports the running server in both text and structured content", async () => {
    const port = await freePort();
    const result = await startServer({ command: fake(port), port });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "running", port, url: `http://localhost:${port}` });
    expect(text(result)).toContain("Dev server running");
    expect(text(result)).toContain(`port ${port}`);
  });

  it("is idempotent: starting the same server again reports the one already up", async () => {
    const port = await freePort();
    const command = fake(port);
    const first = await startServer({ command, port });
    const second = await startServer({ command, port });

    expect(second.isError).toBeFalsy();
    expect(text(second)).toContain("already running");
    expect(second.structuredContent?.pid).toBe(first.structuredContent?.pid);
  });

  it("refuses a different server while one is running, and says what to stop", async () => {
    const first = await freePort();
    const second = await freePort();
    await startServer({ command: fake(first), port: first });

    const result = await startServer({ command: fake(second), port: second });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("framewatch_stop_server");
  });

  it("returns the server's own output when the command fails", async () => {
    const port = await freePort();
    const result = await startServer({ command: fake(port, "--exit", "3"), port });

    expect(result.isError).toBe(true);
    const message = text(result);
    expect(message).toContain("Start server failed");
    expect(message).toContain("Last output from the server:");
    expect(message).toContain("cannot find module 'nope'");
  });

  it("reports invalid input as an error result rather than throwing", async () => {
    const result = await startServer({ command: "", port: 99999 } as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid input");
  });

  it("stops a running server and reports how it went", async () => {
    const port = await freePort();
    await startServer({ command: fake(port), port });

    const result = await stopServer();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "stopped", port });
    expect(text(result)).toContain("Dev server");
    expect(await isPortOpen(port)).toBe(false);
  });

  it("reports not_running instead of failing when there is nothing to stop", async () => {
    const result = await stopServer();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "not_running" });
    expect(text(result)).toContain("No dev server is running");
  });
});

describe("start server input schema", () => {
  it("defaults the ready pattern and the timeout", () => {
    const parsed = startServerInputSchema.parse({ command: "npm run dev", port: 3000 });
    expect(parsed.ready_pattern).toBe(DEFAULT_READY_PATTERN);
    expect(parsed.timeout_ms).toBe(30_000);
  });

  it("rejects an empty command and an out-of-range port", () => {
    expect(startServerInputSchema.safeParse({ command: "", port: 3000 }).success).toBe(false);
    expect(startServerInputSchema.safeParse({ command: "x", port: 0 }).success).toBe(false);
    expect(startServerInputSchema.safeParse({ command: "x", port: 70000 }).success).toBe(false);
  });

  it("rejects a timeout longer than the cap", () => {
    expect(startServerInputSchema.safeParse({ command: "x", port: 3000, timeout_ms: 999_999_999 }).success).toBe(false);
  });
});

describe("describeStartFailure", () => {
  it("names the command and port, and quotes the output underneath", () => {
    const error = new DevServerError("it exited", ["line one", "line two"]);
    const message = describeStartFailure({ command: "npm run dev", port: 3000 }, error);

    expect(message).toContain("`npm run dev` on port 3000 — it exited");
    expect(message).toContain("Last output from the server:");
    expect(message).toContain("  line one");
    expect(message).toContain("  line two");
  });

  it("says so explicitly when the server produced no output at all", () => {
    const message = describeStartFailure({ command: "x", port: 1 }, new DevServerError("boom"));
    expect(message).toContain("The server produced no output.");
  });
});
