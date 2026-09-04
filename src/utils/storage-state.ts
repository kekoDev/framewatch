import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_AUTH_STATE_PATH } from "../constants.js";

/**
 * Saved browser state — cookies plus per-origin localStorage.
 *
 * This is exactly what Playwright's `context.storageState()` returns and what
 * `browser.newContext({ storageState })` accepts, which is the whole point:
 * `framewatch_save_auth` runs a login once, writes this to disk, and every
 * other tool loads it instead of replaying the flow (see the README,
 * framewatch_save_auth).
 *
 * The type is spelled out rather than imported because Playwright exports it
 * only as the return type of a method, and the tools need to name it.
 */
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * Read a state file written by `framewatch_save_auth`.
 *
 * Every failure — no file, unreadable file, not JSON, JSON of the wrong shape
 * — comes back as one line naming the path and the tool that produces a good
 * one. A stale or missing auth file is the single most likely thing to go
 * wrong in an authenticated capture, and "ENOENT: no such file or directory,
 * open '…'" is not what the reader needs to see.
 */
export async function readStorageState(path: string): Promise<StorageState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "not found"
        : code === "EISDIR"
          ? "is a directory, not a file"
          : code === "EACCES"
            ? "could not be read (permission denied)"
            : `could not be read (${firstLine(error)})`;
    throw new Error(`${prefix(path)} ${reason}. ${RECREATE}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${prefix(path)} is not valid JSON (${firstLine(error)}). ${RECREATE}`);
  }

  if (!isStorageState(parsed)) {
    throw new Error(
      `${prefix(path)} is not a browser state file — it has no \`cookies\` and \`origins\` arrays. ${RECREATE}`,
    );
  }
  return parsed;
}

/** The word that turns automatic pickup off for one call. */
export const NO_STORAGE_STATE = "none";

/** Where the saved auth lives unless `FRAMEWATCH_AUTH_STATE` says otherwise. */
export function defaultAuthPath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const override = env.FRAMEWATCH_AUTH_STATE;
  return override && override.trim() !== "" ? override : join(cwd, DEFAULT_AUTH_STATE_PATH);
}

/** A state that is about to be applied to a page, and where it came from. */
export interface ResolvedAuth {
  path: string;
  state: StorageState;
  /** Picked up from the default location without being asked for. */
  auto: boolean;
  /** The file's modification time, when it could be read. */
  saved_at?: Date;
}

/**
 * The auth to apply for one call.
 *
 * An explicit path is read as it always was, and a missing one still fails
 * loudly. With nothing asked for, the default file is used when it exists —
 * the agent then cannot forget to pass it, which is the whole point — and
 * `"none"` opens the page signed out. A default file that cannot be read is an
 * error rather than a silent sign-out, because "the page showed the login
 * form" would be blamed on the app.
 */
export async function resolveStorageState(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<ResolvedAuth | null> {
  if (requested === NO_STORAGE_STATE) return null;
  if (requested !== undefined && requested.trim() !== "") {
    return { path: requested, state: await readStorageState(requested), auto: false, ...(await savedAt(requested)) };
  }
  const path = defaultAuthPath(env, cwd);
  let exists: boolean;
  try {
    exists = (await stat(path)).isFile();
  } catch {
    exists = false;
  }
  if (!exists) return null;
  try {
    return { path, state: await readStorageState(path), auto: true, ...(await savedAt(path)) };
  } catch (error) {
    throw new Error(`${firstLine(error)} It was picked up automatically; pass storage_state: "${NO_STORAGE_STATE}" to open the page without it.`);
  }
}

async function savedAt(path: string): Promise<{ saved_at?: Date }> {
  try {
    return { saved_at: (await stat(path)).mtime };
  } catch {
    return {};
  }
}

/**
 * The line a tool prints about the auth it applied, or null when there is
 * nothing to say (an explicit file that worked). A login form on the page
 * after restoring a session is the expiry signal, and it is named as such
 * whether the file was automatic or not.
 */
export function describeAuth(auth: ResolvedAuth, loginVisible: boolean): string | null {
  const when = auth.saved_at ? ` (saved ${ago(auth.saved_at)})` : "";
  if (loginVisible) {
    return `Auth: ${auth.path}${when} did not sign you in — this page shows a login form. Run framewatch_save_auth again to refresh it.`;
  }
  if (!auth.auto) return null;
  return `Auth: using ${auth.path}${when} — pass storage_state: "${NO_STORAGE_STATE}" to open the page signed out.`;
}

/** Whether the page is showing a login form: a visible password field. */
export async function loginFormVisible(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      if (!doc) return false;
      const fields = doc.querySelectorAll('input[type="password"]');
      for (let i = 0; i < fields.length; i++) {
        const rect = fields[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

/** The text block for `describeAuth`, when there is one. */
export function authNote(auth: ResolvedAuth | null, loginVisible: boolean): { type: "text"; text: string } | null {
  if (!auth) return null;
  const text = describeAuth(auth, loginVisible);
  return text ? { type: "text", text } : null;
}

/** A tool result with the auth line appended, when there is one. Error results are left alone. */
export function withAuthNote(result: CallToolResult, auth: ResolvedAuth | null, loginVisible = false): CallToolResult {
  const note = authNote(auth, loginVisible);
  if (!note || result.isError) return result;
  return { ...result, content: [...result.content, note] };
}

function ago(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Write a state file, creating the directories on the way to it. */
export async function writeStorageState(state: StorageState, path: string): Promise<void> {
  const parent = dirname(path);
  if (parent) await mkdir(parent, { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** One phrase describing what a state actually carries, for the tool's summary. */
export function storageStateSummary(state: StorageState): string {
  const cookies = state.cookies.length;
  const origins = state.origins.length;
  const keys = state.origins.reduce((total, origin) => total + origin.localStorage.length, 0);
  if (cookies === 0 && keys === 0) return "no cookies and nothing in storage";
  return `${count(cookies, "cookie")}, ${count(origins, "origin")} with ${count(keys, "stored key")}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const RECREATE = "Run framewatch_save_auth to create it.";

function prefix(path: string): string {
  return `Auth state file "${path}"`;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

function isStorageState(value: unknown): value is StorageState {
  if (typeof value !== "object" || value === null) return false;
  const { cookies, origins } = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(cookies) && Array.isArray(origins);
}

/**
 * The `storage_state` input every page-opening tool accepts. One definition so
 * the wording (and therefore what an agent believes it does) is the same in
 * all of them.
 */
export const storageStateField = z
  .string()
  .optional()
  .describe(
    "Path to an auth state file saved by framewatch_save_auth. The page opens with those cookies and " +
      "storage already in place, so a login/gate does not have to be replayed. Omit it and the default file " +
      "(.framewatch/auth.json) is used automatically when it exists; pass \"none\" to open the page signed out. " +
      "If the saved session has expired the result says so — re-run framewatch_save_auth then.",
  );
