import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { DEFAULT_VIEWPORT } from "../constants.js";
import type { Viewport } from "../types.js";
import type { StorageState } from "../utils/storage-state.js";
import { hmrFor } from "./hmr.js";

/**
 * Playwright browser lifecycle.
 *
 * A single Chromium instance is shared across all tool calls: it is launched
 * lazily on first use and kept alive until `closeBrowser()` (called on MCP
 * server shutdown). Each tool call gets its own BrowserContext via `withPage`
 * so state (cookies, storage, viewport) never leaks between calls.
 */

let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, handleSIGINT: false }).then((browser) => {
      // If Chromium dies (crash, external kill), forget it so the next call relaunches.
      browser.on("disconnected", () => {
        if (browserPromise === thisLaunch) browserPromise = null;
      });
      return browser;
    });
    const thisLaunch = browserPromise;
    // If launch itself fails, clear the cached rejection so callers can retry.
    browserPromise.catch(() => {
      if (browserPromise === thisLaunch) browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  session = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Already closed or never launched successfully — nothing to do.
  }
}

export interface PageOptions {
  viewport?: Viewport;
  /** Extra Playwright context options (user agent, locale, etc.). */
  contextOptions?: Omit<BrowserContextOptions, "viewport">;
}

/**
 * Run `fn` with a page inside a brand-new browser context. The context is
 * always closed afterwards, even if `fn` throws.
 */
export async function withPage<T>(options: PageOptions, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: options.viewport ?? { ...DEFAULT_VIEWPORT },
    deviceScaleFactor: 1,
    ...options.contextOptions,
  });
  try {
    const page = await context.newPage();
    return await fn(page, context);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The interaction session — "the current page".
 *
 * `framewatch_interact` is for iterative testing: click, look, type, look
 * again. That only works if the page survives between tool calls, so unlike
 * `withPage` (a fresh context per call) the session keeps one context and one
 * page alive until the browser closes. Cookies, storage, scroll position and
 * anything the app has in memory carry over from call to call.
 */
interface Session {
  context: BrowserContext;
  page: Page;
  hasTouch: boolean;
  viewport: Viewport;
  /** The saved auth this context was created with, if any (see SessionOptions). */
  storageState?: SessionStorageState;
}

/** A loaded auth state and the path it was read from — the path is its identity. */
export interface SessionStorageState {
  path: string;
  state: StorageState;
}

let session: Session | null = null;

export interface SessionOptions {
  /** Resize the current page to this. Omit to leave the page exactly as it is. */
  viewport?: Viewport;
  /** Require a touch-capable page. A session without touch is reopened to get it. */
  hasTouch?: boolean;
  /**
   * Open the page with this saved auth. Cookies and storage are fixed when the
   * context is created, so a session that was opened with different auth (or
   * none) is reopened to take it. Omit to leave whatever the session has.
   */
  storageState?: SessionStorageState;
}

export interface SessionPage {
  page: Page;
  /**
   * URL of the page that had to be discarded to satisfy `options`, if any.
   * The caller decides whether to navigate back to it — reopening resets
   * everything the old page held, which is worth telling the user about.
   */
  previousUrl?: string;
  /** Why it had to be discarded, so the caller can say so. */
  reopenedFor?: "touch" | "auth";
}

/**
 * The current page, opening one if there is none.
 *
 * An existing page is reused, resized only when `viewport` is given and
 * differs — an omitted viewport means "leave the page alone", never "reset it
 * to the default". The two things that cannot be changed in place are
 * `hasTouch` and the saved auth: both are fixed when the context is created,
 * so a session that lacks touch, or that was opened with different auth than
 * the caller now asks for, has to be reopened. That loses whatever the old
 * page held, which is why the discarded URL and the reason come back to the
 * caller.
 */
export async function getSessionPage(options: SessionOptions = {}): Promise<SessionPage> {
  const wantsTouch = options.hasTouch === true;
  const live = session !== null && !session.page.isClosed();
  const hasTouch = live && session!.hasTouch;
  // An omitted `storageState` means "leave the session's auth alone"; a named
  // one has to match the file the context was actually created from.
  const hasAuth = !live || options.storageState === undefined || session!.storageState?.path === options.storageState.path;

  if (live && (hasTouch || !wantsTouch) && hasAuth) {
    const page = session!.page;
    if (options.viewport && !sameSize(page.viewportSize(), options.viewport)) {
      await page.setViewportSize(options.viewport);
      session!.viewport = { ...options.viewport };
    }
    return { page };
  }

  // Either nothing is open, or what is open cannot do what was asked. Carry the
  // old size and auth over so reopening reproduces the page as closely as it can.
  const previousUrl = live ? safeUrl(session!.page) : undefined;
  const reopenedFor: "touch" | "auth" | undefined = live ? (wantsTouch && !hasTouch ? "touch" : "auth") : undefined;
  const viewport = options.viewport ?? session?.viewport ?? { ...DEFAULT_VIEWPORT };
  const storageState = options.storageState ?? session?.storageState;
  await closeSession();

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    ...(wantsTouch ? { hasTouch: true } : {}),
    ...(storageState ? { storageState: storageState.state } : {}),
  });
  const page = await context.newPage();
  // Vite's hot updates are announced in the console; watch from the first
  // request so framewatch_wait_for can tell "changed since you last looked".
  hmrFor(page);
  session = { context, page, hasTouch: wantsTouch, viewport, ...(storageState ? { storageState } : {}) };
  return {
    page,
    ...(previousUrl !== undefined ? { previousUrl } : {}),
    ...(reopenedFor !== undefined ? { reopenedFor } : {}),
  };
}

function sameSize(a: Viewport | null, b: Viewport): boolean {
  return a !== null && a.width === b.width && a.height === b.height;
}

/** Serialises everything that touches the session page — see `withSessionLock`. */
let sessionQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with exclusive use of the session page.
 *
 * There is one session, one page and one hand: two callers at once would both
 * find no session and open a context each (orphaning all but the last), and a
 * step that needs touch could close the page another caller is half way
 * through. An MCP client may well call tools in parallel, and
 * `framewatch_compare` reads the same page `framewatch_interact` is driving,
 * so the lock lives here with the session rather than inside either tool.
 *
 * `fn` is run whatever happened to the call before it, and the chain survives
 * a rejection.
 */
export function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = sessionQueue.then(fn, fn);
  sessionQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Close the current page, if any. The browser itself stays up. */
export async function closeSession(): Promise<void> {
  const current = session;
  session = null;
  if (!current) return;
  await current.context.close().catch(() => {});
}

/** `page.url()` throws once the page is gone; a dead page simply has no url. */
function safeUrl(page: Page): string | undefined {
  try {
    const url = page.url();
    return url === "about:blank" ? undefined : url;
  } catch {
    return undefined;
  }
}
