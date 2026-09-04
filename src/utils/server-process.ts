import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import {
  MAX_SERVER_LINE_LENGTH,
  MAX_SERVER_LOG_LINES,
  SERVER_PORT_POLL_MS,
  SERVER_PORT_PROBE_TIMEOUT_MS,
  SERVER_STOP_GRACE_MS,
} from "../constants.js";
import { BoundedLog } from "./bounded-log.js";

/**
 * Dev server process manager.
 *
 * FrameWatch can start the app it is about to look at. One server runs at a
 * time — the tools that use it take no server argument, so a second would have
 * no way of being addressed — and it is owned for as long as the MCP server
 * lives, then stopped on shutdown. Nothing here is allowed to outlive the
 * process that spawned it.
 *
 * **Readiness is the port, not the log line.** `ready_pattern` is matched and
 * reported (dev servers print the URL they actually bound to, which is worth
 * repeating back), but what makes a server "running" is that something answers
 * on its port: that is the condition the next tool call depends on, and a
 * pattern that fires early — or a regex that never matches a server that is
 * working perfectly — would report the wrong thing in both directions.
 */

/** A server that is up, with everything worth telling the caller about it. */
export interface RunningServer {
  command: string;
  port: number;
  pid: number;
  cwd: string;
  url: string;
  /** How long the port took to answer. */
  ready_ms: number;
  /** The output line that matched `ready_pattern`, if one did. */
  ready_line?: string;
}

/** What a stopped server left behind. */
export interface StoppedServer {
  command: string;
  port: number;
  pid: number;
  uptime_ms: number;
  /** How it went: exit code, or the signal that ended it. */
  exit_code: number | null;
  exit_signal: string | null;
  /** True when SIGTERM was ignored and the process had to be killed outright. */
  forced: boolean;
}

export interface StartDevServerOptions {
  command: string;
  port: number;
  ready_pattern: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms: number;
}

/** A start that failed, carrying the output that explains why. */
export class DevServerError extends Error {
  readonly output: string[];
  constructor(message: string, output: string[] = []) {
    super(message);
    this.name = "DevServerError";
    this.output = output;
  }
}

interface ServerState {
  child: ChildProcess;
  info: RunningServer;
  log: BoundedLog<string>;
  startedAt: number;
  /** Resolves when the process is gone, whatever ended it. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isExited: boolean;
}

let current: ServerState | null = null;

/** The running server, or null. A process that has since died counts as null. */
export function getDevServer(): RunningServer | null {
  if (!current || current.isExited) return null;
  return { ...current.info };
}

/** The last `count` output lines of the running server, oldest first. */
export function devServerOutput(count: number): string[] {
  if (!current) return [];
  const lines = current.log.items;
  return lines.slice(Math.max(0, lines.length - count)) as string[];
}

/**
 * Spawn a dev server and wait until its port answers.
 *
 * @throws DevServerError when a server is already running, when the port is
 * already taken by something else, when the process exits before the port
 * opens, or when it never opens at all. Each of those carries the output the
 * server produced, because that is where the reason actually is.
 */
export async function startDevServer(options: StartDevServerOptions): Promise<RunningServer> {
  if (getDevServer()) {
    const running = current!.info;
    throw new DevServerError(
      `a dev server is already running (pid ${running.pid}, port ${running.port}: ${running.command}). ` +
        "Stop it with framewatch_stop_server first.",
    );
  }
  // A dead server from an earlier call is just history; clear it out.
  current = null;

  let ready: RegExp;
  try {
    ready = new RegExp(options.ready_pattern, "i");
  } catch (error) {
    throw new DevServerError(
      `\`ready_pattern\` is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Something already on the port would make every readiness check pass
  // instantly and hand the caller a server that is not theirs.
  if (await isPortOpen(options.port)) {
    throw new DevServerError(
      `port ${options.port} is already in use by another process. Stop whatever is on it, or start this ` +
        "server on a different port.",
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const child = spawn(options.command, {
    shell: true,
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stopping it stops the whole tree: `npm run
    // dev` is a shell that spawns node that spawns a bundler, and killing the
    // shell alone would orphan every one of its children.
    detached: process.platform !== "win32",
  });

  const log = new BoundedLog<string>(MAX_SERVER_LOG_LINES, isNotable);
  const startedAt = Date.now();
  let readyLine: string | undefined;

  const watch = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return;
    createInterface({ input: stream }).on("line", (line) => {
      const text = elide(line);
      log.add(text);
      // Keep the *first* matching line: later ones are usually a rebuild
      // saying "ready" again, and the first is the one that named the URL.
      if (readyLine === undefined && ready.test(line)) readyLine = text;
    });
  };
  watch(child.stdout);
  watch(child.stderr);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      if (current?.child === child) current.isExited = true;
      resolve({ code, signal });
    });
    // A command that cannot be spawned at all (no shell) never emits "exit".
    child.once("error", (error) => {
      log.add(`spawn failed: ${elide(error.message)}`);
      if (current?.child === child) current.isExited = true;
      resolve({ code: null, signal: null });
    });
  });

  const info: RunningServer = {
    command: options.command,
    port: options.port,
    pid: child.pid ?? -1,
    cwd,
    url: `http://localhost:${options.port}`,
    ready_ms: 0,
  };
  current = { child, info, log, startedAt, exited, isExited: false };

  const outcome = await waitForPort(child, exited, options.port, options.timeout_ms);
  const tail = log.toArray();

  if (outcome === "exited") {
    const { code, signal } = await exited;
    current = null;
    throw new DevServerError(
      `the server exited before port ${options.port} opened ` +
        `(${signal ? `killed by ${signal}` : `exit code ${code ?? "unknown"}`}).`,
      tail,
    );
  }
  if (outcome === "timeout") {
    await killTree(child, exited);
    current = null;
    throw new DevServerError(
      `the server did not open port ${options.port} within ${options.timeout_ms}ms` +
        (readyLine !== undefined
          ? ` — it printed a line matching \`ready_pattern\` ("${readyLine}"), so it may be listening on a ` +
            "different port than the one given."
          : ". Check the command, the port, and `ready_pattern`."),
      tail,
    );
  }

  info.ready_ms = Date.now() - startedAt;
  if (readyLine !== undefined) info.ready_line = readyLine;
  return { ...info };
}

/**
 * Stop the running server, or return null if there is none.
 *
 * SIGTERM to the whole process group first — dev servers use it to clean up
 * their own children and their sockets — then SIGKILL if it is still there
 * after SERVER_STOP_GRACE_MS.
 */
export async function stopDevServer(): Promise<StoppedServer | null> {
  const state = current;
  current = null;
  if (!state) return null;

  const { code, signal, forced } = state.isExited
    ? { ...(await state.exited), forced: false }
    : await killTree(state.child, state.exited);

  return {
    command: state.info.command,
    port: state.info.port,
    pid: state.info.pid,
    uptime_ms: Date.now() - state.startedAt,
    exit_code: code,
    exit_signal: signal,
    forced,
  };
}

/** Stop the server on the way out. Never throws — shutdown must not be blocked by it. */
export async function shutdownDevServer(): Promise<void> {
  try {
    await stopDevServer();
  } catch {
    // Nothing left to do about it at shutdown.
  }
}

type PortOutcome = "open" | "exited" | "timeout";

/** Poll the port until it answers, the process dies, or `timeoutMs` runs out. */
async function waitForPort(
  child: ChildProcess,
  exited: Promise<unknown>,
  port: number,
  timeoutMs: number,
): Promise<PortOutcome> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let dead = false;
  void exited.then(() => {
    dead = true;
  });

  for (;;) {
    if (await isPortOpen(port)) return "open";
    // Checked after the port: a server that answered and then exited in the
    // same instant still counts as having started.
    if (dead || child.exitCode !== null || child.signalCode !== null) return "exited";
    if (Date.now() >= deadline) return "timeout";
    await sleep(Math.min(SERVER_PORT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * True when something accepts a TCP connection on `port`.
 *
 * Both loopback addresses are tried: a server bound only to `::1` (Node's
 * default when the host resolves to IPv6 first) does not answer on 127.0.0.1,
 * and reporting that as "never started" would be wrong.
 */
export function isPortOpen(port: number, timeoutMs: number = SERVER_PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return Promise.all(["127.0.0.1", "::1"].map((host) => probe(host, port, timeoutMs))).then((results) =>
    results.some(Boolean),
  );
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * End the process and everything it spawned.
 *
 * The negative pid signals the process group created by `detached: true`; if
 * that fails (the group is gone, or this is Windows) the child alone is
 * signalled instead.
 */
async function killTree(
  child: ChildProcess,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; forced: boolean }> {
  signalTree(child, "SIGTERM");
  const graceful = await Promise.race([exited, sleep(SERVER_STOP_GRACE_MS).then(() => null)]);
  if (graceful !== null) return { ...graceful, forced: false };

  signalTree(child, "SIGKILL");
  return { ...(await exited), forced: true };
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such group (already reaped, or never detached): signal the child itself.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Lines worth keeping when the log is full: the ones that say what went wrong. */
function isNotable(line: string): boolean {
  return /error|fail|fatal|exception|EADDRINUSE|ENOENT|not found/i.test(line);
}

function elide(line: string): string {
  const flat = line.replace(/\s+$/, "");
  return flat.length > MAX_SERVER_LINE_LENGTH ? `${flat.slice(0, MAX_SERVER_LINE_LENGTH)}…` : flat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
