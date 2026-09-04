import type { ConsoleMessage, Page } from "playwright";
import { MAX_CONSOLE_ENTRIES, MAX_CONSOLE_TEXT_LENGTH } from "../../constants.js";
import type { ConsoleEntry } from "../../types.js";
import { BoundedLog } from "../../utils/bounded-log.js";

/**
 * Console layer.
 *
 * Collects everything the page says while a capture runs: `console.*` calls,
 * uncaught exceptions, unhandled promise rejections, and the tab crashing.
 * Entries are stamped with absolute time and rebased onto the recording clock
 * by `entries(origin)`, because collection starts *before* the navigation —
 * an error thrown during page load is usually the most valuable thing here,
 * and it happens before frame 0 exists.
 *
 * Nothing in this layer touches the page. It is all Playwright events, so a
 * page that has frozen, navigated away or died still yields whatever it said
 * before it went.
 */

export type ConsoleLevel = ConsoleEntry["level"];

/** One collected message, stamped with absolute (epoch) time and already normalised. */
export interface ConsoleRecord {
  at: number;
  level: ConsoleLevel;
  text: string;
}

/**
 * Map Chromium's console message types onto the four levels FrameWatch
 * reports. `assert` is an error because that is what a failed assertion is;
 * `count`/`timeEnd` are instrumentation, so they sit with `info`; everything
 * else that is not clearly a warning or an error is a plain log.
 */
export function toConsoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case "error":
    case "assert":
      return "error";
    case "warning":
      return "warn";
    case "info":
    case "count":
    case "timeEnd":
      return "info";
    default:
      return "log";
  }
}

/**
 * Reduce a message to one printable line. Console output is rendered one entry
 * per line, so an embedded newline (a stack trace, a pretty-printed object)
 * would otherwise be indistinguishable from the next entry.
 */
export function normaliseText(text: string, maxLength: number = MAX_CONSOLE_TEXT_LENGTH): string {
  const flat = text.replace(/\s*\n\s*/g, " ↵ ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}… (${flat.length} chars)` : flat;
}

/**
 * Describe an uncaught error the way a developer reads a stack trace: the
 * message, then where it came from. Playwright hands `pageerror` a real Error
 * whose `stack` is "Name: message\n    at fn (url:line:col)"; the top frame is
 * the actionable part and the rest is noise in a one-line entry.
 */
export function describePageError(error: Error): string {
  const head = error.message ? `${error.name}: ${error.message}` : error.name || "Error";
  const frame = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  return frame ? `${head} (${frame})` : head;
}

export class ConsoleCollector {
  readonly #page: Page;
  readonly #log: BoundedLog<ConsoleRecord>;
  #attached = false;

  readonly #onConsole = (message: ConsoleMessage): void => {
    this.#record(toConsoleLevel(message.type()), message.text());
  };

  readonly #onPageError = (error: Error): void => {
    this.#record("error", describePageError(error));
  };

  readonly #onCrash = (): void => {
    // Not a console message, but it is the explanation for every frame after
    // it, and there is nowhere better for the page to tell us it has died.
    this.#record("error", "Page crashed (the browser tab stopped responding)");
  };

  constructor(page: Page, limit: number = MAX_CONSOLE_ENTRIES) {
    this.#page = page;
    this.#log = new BoundedLog<ConsoleRecord>(limit, (entry) => entry.level === "error");
  }

  /** Start listening. Idempotent. */
  attach(): this {
    if (this.#attached) return this;
    this.#attached = true;
    this.#page.on("console", this.#onConsole);
    this.#page.on("pageerror", this.#onPageError);
    this.#page.on("crash", this.#onCrash);
    return this;
  }

  /** Stop listening. Collected entries are kept. */
  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#page.off("console", this.#onConsole);
    this.#page.off("pageerror", this.#onPageError);
    this.#page.off("crash", this.#onCrash);
  }

  /** Entries refused or evicted by the cap. */
  get dropped(): number {
    return this.#log.dropped;
  }

  /** Forget everything collected so far. See `BoundedLog.clear`. */
  clear(): void {
    this.#log.clear();
  }

  /**
   * Collected entries, oldest first, with timestamps rebased onto the
   * recording clock (`origin` is the recording's start in epoch ms). Entries
   * from before the recording started keep their negative timestamp: they
   * happened during page load, and pretending otherwise would put them out of
   * order with the rest.
   */
  entries(origin: number): ConsoleEntry[] {
    return this.#log.items.map((record) => ({
      level: record.level,
      text: record.text,
      timestamp_ms: Math.round(record.at - origin),
    }));
  }

  /**
   * Text is normalised here rather than on the way out: `console.log` of a
   * megabyte-long string is one call, and holding a hundred of those until the
   * recording ends is a real amount of memory to keep for text that will be
   * elided anyway.
   */
  #record(level: ConsoleLevel, text: string): void {
    this.#log.add({ at: Date.now(), level, text: normaliseText(text) });
  }
}
