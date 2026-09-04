import type { ConsoleMessage, Page } from "playwright";
import { MAX_HMR_EVENTS } from "../constants.js";
import { parseViteLine } from "../utils/vue-rules.js";

/**
 * What Vite did to the session page while nobody was looking.
 *
 * Vite's client announces every hot update in the console, so a watcher on
 * the page can tell the difference between "the page has not changed since
 * you saved" and "it changed 300ms ago" without reloading anything. The
 * watcher belongs to the session page and lives as long as it does: it is
 * attached when the page is created (see `getSessionPage`), and every tool
 * that touches the page stamps `markSeen` on its way out. "Since the last
 * look" is then exactly the window `framewatch_wait_for` cares about — an
 * update that landed between the agent's save and its next call still
 * counts, and one from an earlier edit does not.
 */

export interface HmrEvent {
  /** Epoch ms. */
  t: number;
  kind: "update" | "css" | "reload";
  path: string;
}

export class HmrWatcher {
  readonly #page: Page;
  readonly #events: HmrEvent[] = [];
  readonly #waiters = new Set<(event: HmrEvent) => void>();
  #connected = false;
  #lastSeen: number = Date.now();

  constructor(page: Page) {
    this.#page = page;
    page.on("console", this.#onConsole);
  }

  /** Vite's client said hello, or has sent an update: this is a dev-server page. */
  get connected(): boolean {
    return this.#connected || this.#events.length > 0;
  }

  /** When a tool last looked at this page. */
  get lastSeen(): number {
    return this.#lastSeen;
  }

  markSeen(): void {
    this.#lastSeen = Date.now();
  }

  /** The most recent event, whenever it happened. */
  get latest(): HmrEvent | undefined {
    return this.#events[this.#events.length - 1];
  }

  /**
   * The first event newer than `since`, waiting up to `timeoutMs` for one to
   * arrive. Resolves immediately when one already has.
   */
  waitForEvent(since: number, timeoutMs: number): Promise<HmrEvent | null> {
    const already = this.#events.find((event) => event.t > since);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => {
      const done = (event: HmrEvent | null): void => {
        clearTimeout(timer);
        this.#waiters.delete(onEvent);
        resolve(event);
      };
      const onEvent = (event: HmrEvent): void => {
        if (event.t > since) done(event);
      };
      const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
      this.#waiters.add(onEvent);
    });
  }

  detach(): void {
    this.#page.off("console", this.#onConsole);
  }

  readonly #onConsole = (message: ConsoleMessage): void => {
    const event = parseViteLine(message.text());
    if (!event) return;
    if (event.kind === "connected") {
      this.#connected = true;
      return;
    }
    const record: HmrEvent = { t: Date.now(), kind: event.kind, path: event.path };
    this.#events.push(record);
    if (this.#events.length > MAX_HMR_EVENTS) this.#events.shift();
    for (const waiter of [...this.#waiters]) waiter(record);
  };
}

const byPage = new WeakMap<Page, HmrWatcher>();

/** The watcher for `page`, created (and attached) on first use. */
export function hmrFor(page: Page): HmrWatcher {
  const existing = byPage.get(page);
  if (existing) return existing;
  const created = new HmrWatcher(page);
  byPage.set(page, created);
  return created;
}

/** Whether the page loaded Vite's client script — a dev-server page even before it logged anything. */
export async function hasViteClient(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return !!(doc && doc.querySelector('script[src*="/@vite/client"]'));
    });
  } catch {
    return false;
  }
}
