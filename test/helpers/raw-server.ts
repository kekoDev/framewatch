import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

/**
 * Minimal raw JSON-RPC driver for the built server. Unlike the SDK client it
 * never sends signals, so tests can observe exactly how the server reacts to
 * stdin EOF, SIGINT, or a dead stderr pipe.
 */
export class RawServer {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();

  constructor(env: NodeJS.ProcessEnv = {}, entry: string = SERVER_ENTRY) {
    this.child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
    createInterface({ input: this.child.stderr! }).on("line", (line) => this.stderr.push(line));
    this.exited = new Promise((resolve) => this.child.on("exit", (code, signal) => resolve({ code, signal })));
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize(): Promise<any> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw-test-client", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request("tools/call", { name, arguments: args });
  }

  /** Resolve with the exit status, or reject if the process is still alive after `ms`. */
  async waitForExit(ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`server still running after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([this.exited, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Make sure nothing is left behind if a test fails mid-way. */
  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }
}
