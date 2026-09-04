import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_READY_PATTERN,
  DEFAULT_SERVER_TIMEOUT_MS,
  MAX_SERVER_TIMEOUT_MS,
  MIN_SERVER_TIMEOUT_MS,
  SERVER_OUTPUT_TAIL,
} from "../constants.js";
import {
  DevServerError,
  devServerOutput,
  getDevServer,
  startDevServer,
  stopDevServer,
  type RunningServer,
  type StoppedServer,
} from "../utils/server-process.js";

export const START_SERVER_TOOL_NAME = "framewatch_start_server";
export const STOP_SERVER_TOOL_NAME = "framewatch_stop_server";

export const startServerInputShape = {
  command: z.string().min(1).describe("Shell command to start the server, e.g. 'npm run dev'"),
  port: z.number().int().min(1).max(65535).describe("Port the server will listen on"),
  ready_pattern: z
    .string()
    .default(DEFAULT_READY_PATTERN)
    .describe(
      "Regex matched against the server's output. The matching line is reported back (dev servers print the URL " +
        "they actually bound to), but readiness itself is decided by the port answering.",
    ),
  cwd: z.string().optional().describe("Working directory to run the command in (defaults to the current one)"),
  env: z.record(z.string()).optional().describe("Extra environment variables for the server process"),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_SERVER_TIMEOUT_MS)
    .max(MAX_SERVER_TIMEOUT_MS)
    .default(DEFAULT_SERVER_TIMEOUT_MS)
    .describe("Max time (ms) to wait for the port to start answering"),
};

export const startServerInputSchema = z.object(startServerInputShape);
export type StartServerInput = z.input<typeof startServerInputSchema>;

/** Structured result of `framewatch_start_server`. */
export const startServerOutputShape = {
  status: z.literal("running"),
  port: z.number().int(),
  pid: z.number().int(),
  url: z.string(),
  command: z.string(),
  cwd: z.string(),
  ready_ms: z.number().int(),
  ready_line: z.string().optional(),
};

/** Structured result of `framewatch_stop_server`. */
export const stopServerOutputShape = {
  status: z.enum(["stopped", "not_running"]),
  port: z.number().int().optional(),
  pid: z.number().int().optional(),
  command: z.string().optional(),
  uptime_ms: z.number().int().optional(),
  exit_code: z.number().int().nullable().optional(),
  exit_signal: z.string().nullable().optional(),
  /** True when the server ignored SIGTERM and had to be killed. */
  forced: z.boolean().optional(),
};

/**
 * Start the app's dev server so the rest of FrameWatch has something to look
 * at.
 *
 * One server runs at a time. Asking for the one that is already running is a
 * no-op that reports its status (the tool is idempotent); asking for a
 * different one while it is up is an error naming what to stop first, because
 * silently replacing a running server is not something a tool should decide.
 */
export async function startServer(rawInput: StartServerInput): Promise<CallToolResult> {
  const parsed = startServerInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Start server failed: invalid input — ${issues}`);
  }
  const input = parsed.data;

  const running = getDevServer();
  if (running && running.command === input.command && running.port === input.port) {
    return runningResult(running, `Dev server is already running — ${describeRunning(running)}`);
  }

  try {
    const started = await startDevServer({
      command: input.command,
      port: input.port,
      ready_pattern: input.ready_pattern,
      timeout_ms: input.timeout_ms,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
    return runningResult(started, `Dev server running — ${describeRunning(started)}`);
  } catch (error) {
    return errorResult(describeStartFailure(input, error));
  }
}

/**
 * Stop the dev server FrameWatch started.
 *
 * Never an error: there being nothing to stop is a normal answer, and a caller
 * cleaning up after itself should not have to know whether the earlier start
 * succeeded.
 */
export async function stopServer(): Promise<CallToolResult> {
  let stopped: StoppedServer | null;
  try {
    stopped = await stopDevServer();
  } catch (error) {
    return errorResult(`Stop server failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }

  if (!stopped) {
    return {
      content: [{ type: "text", text: "No dev server is running (FrameWatch did not start one, or it has already been stopped)." }],
      structuredContent: { status: "not_running" },
    };
  }

  const how = stopped.forced
    ? "killed (it did not exit on SIGTERM)"
    : stopped.exit_signal
      ? `stopped by ${stopped.exit_signal}`
      : `stopped with exit code ${stopped.exit_code ?? "unknown"}`;

  return {
    content: [
      {
        type: "text",
        text: `Dev server ${how} — pid ${stopped.pid}, port ${stopped.port}, up for ${seconds(stopped.uptime_ms)}s: ${stopped.command}`,
      },
    ],
    structuredContent: {
      status: "stopped",
      port: stopped.port,
      pid: stopped.pid,
      command: stopped.command,
      uptime_ms: stopped.uptime_ms,
      exit_code: stopped.exit_code,
      exit_signal: stopped.exit_signal,
      forced: stopped.forced,
    },
  };
}

function runningResult(server: RunningServer, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      status: "running",
      port: server.port,
      pid: server.pid,
      url: server.url,
      command: server.command,
      cwd: server.cwd,
      ready_ms: server.ready_ms,
      ...(server.ready_line !== undefined ? { ready_line: server.ready_line } : {}),
    },
  };
}

function describeRunning(server: RunningServer): string {
  const parts = [
    `pid ${server.pid}`,
    `port ${server.port}`,
    server.url,
    `ready in ${seconds(server.ready_ms)}s`,
    `command: ${server.command}`,
  ];
  const text = parts.join(", ");
  return server.ready_line !== undefined ? `${text}\nIt said: ${server.ready_line}` : text;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Explain a failed start, with the server's own output underneath.
 *
 * That output is the whole point: "exit code 1" says nothing, while the three
 * lines above it are usually a missing script, a syntax error or a port
 * clash — the actual answer.
 */
export function describeStartFailure(input: { command: string; port: number }, error: unknown): string {
  const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
  const lines = [`Start server failed: \`${input.command}\` on port ${input.port} — ${message}`];

  const output = error instanceof DevServerError ? error.output : devServerOutput(SERVER_OUTPUT_TAIL);
  const tail = output.slice(Math.max(0, output.length - SERVER_OUTPUT_TAIL));
  if (tail.length > 0) {
    lines.push("Last output from the server:");
    for (const line of tail) lines.push(`  ${line}`);
  } else if (error instanceof DevServerError) {
    lines.push("The server produced no output.");
  }

  return lines.join("\n");
}

export function registerServerTools(server: McpServer): void {
  server.registerTool(
    START_SERVER_TOOL_NAME,
    {
      title: "Start dev server",
      description:
        "Start the app's dev server (e.g. `npm run dev`) and wait until its port answers, so the other FrameWatch " +
        "tools have something to point at. One server runs at a time and FrameWatch stops it when it shuts down. " +
        "If the command fails or the port never opens, the server's own output comes back with the error.",
      inputSchema: startServerInputShape,
      outputSchema: startServerOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => startServer(args),
  );

  server.registerTool(
    STOP_SERVER_TOOL_NAME,
    {
      title: "Stop dev server",
      description:
        "Stop the dev server FrameWatch started, along with everything it spawned. Reports `not_running` rather " +
        "than failing when there is nothing to stop.",
      inputSchema: {},
      outputSchema: stopServerOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => stopServer(),
  );
}
