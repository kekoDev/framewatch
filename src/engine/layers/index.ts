import type { Page } from "playwright";
import { MAX_DOM_LINES_PER_CARD } from "../../constants.js";
import type { ConsoleEntry, DiffCard, NetworkEvent } from "../../types.js";
import { ConsoleCollector } from "./console.js";
import { DomCollector, renderDomChanges, type DomRecord } from "./dom.js";
import { NetworkCollector } from "./network.js";
import { PerformanceCollector, summarisePerformance, type PerfSample } from "./performance.js";

export { ConsoleCollector, describePageError, normaliseText, toConsoleLevel } from "./console.js";
export { SessionLayers, layersFor } from "./session.js";
export { NetworkCollector, shortenUrl } from "./network.js";
export { DomCollector, renderDomChanges } from "./dom.js";
export { PerformanceCollector, summarisePerformance } from "./performance.js";
export type { ConsoleRecord } from "./console.js";
export type { NetworkRecord } from "./network.js";
export type { DomOp, DomRecord, RawDomRecord } from "./dom.js";
export type { PerfKind, PerfSample, RawPerfRecord } from "./performance.js";

/**
 * Context layers.
 *
 * Four collectors watch a page while it is recorded — what it logged, what it
 * fetched, what it changed in the DOM, and when it painted — and their output
 * is then split across the diff cards by time, so each card carries the
 * context for the interval that produced it.
 *
 * All four are attached before the page navigates, because the most valuable
 * things they see (a script that throws on load, the request that never comes
 * back, first paint) happen before frame 0 exists. Records from that window
 * carry negative timestamps and land on the first card.
 *
 * Nothing here can fail a capture. A layer that cannot be installed is
 * reported as a note and the recording goes ahead without it: frames are the
 * point, and context is the bonus.
 */

/** Which layers to collect. Mirrors the `include_*` inputs of framewatch_capture. */
export interface LayerFlags {
  console: boolean;
  network: boolean;
  dom: boolean;
  performance: boolean;
}

/** Everything the layers gathered, rebased onto the recording clock. */
export interface CapturedContext {
  console?: ConsoleEntry[];
  network?: NetworkEvent[];
  dom?: DomRecord[];
  performance?: PerfSample[];
  /** Anything the user should know about the collection itself (caps hit, layers unavailable). */
  notes: string[];
}

/** Layers attached to a live page, waiting to be drained. */
export interface AttachedLayers {
  /**
   * Take everything collected so far and rebase it onto the recording clock.
   * `origin` is the recording's start in epoch ms. Purely synchronous and
   * never touches the page, so it still works after the page has frozen,
   * navigated away, crashed or been closed.
   */
  collect(origin: number): CapturedContext;
  /** Stop listening. Safe to call more than once. */
  detach(): void;
}

const EMPTY: AttachedLayers = { collect: () => ({ notes: [] }), detach: () => {} };

/**
 * Attach the requested layers to `page`. Call before navigating.
 *
 * The two injected layers (DOM, performance) can genuinely fail to install —
 * a page can be closed underneath us, and `exposeBinding` refuses a name that
 * is already taken — so each is attached independently and a failure becomes a
 * note rather than an exception.
 */
export async function attachLayers(page: Page, flags: LayerFlags): Promise<AttachedLayers> {
  if (!flags.console && !flags.network && !flags.dom && !flags.performance) return EMPTY;

  const notes: string[] = [];
  const consoleCollector = flags.console ? new ConsoleCollector(page).attach() : null;
  const networkCollector = flags.network ? new NetworkCollector(page).attach() : null;

  const domCollector = flags.dom ? await attachOrNote(new DomCollector(page), "DOM", notes) : null;
  const perfCollector = flags.performance ? await attachOrNote(new PerformanceCollector(page), "performance", notes) : null;

  return {
    collect(origin: number): CapturedContext {
      const context: CapturedContext = { notes: [...notes] };

      if (consoleCollector) {
        context.console = consoleCollector.entries(origin);
        if (consoleCollector.dropped > 0) {
          context.notes.push(`Console output was capped — ${consoleCollector.dropped} entries dropped (errors kept first).`);
        }
      }
      if (networkCollector) {
        // Requests still in flight are events in their own right (see
        // `NetworkCollector.events`), so the caller can count them from the
        // list; there is no separate note for them.
        context.network = networkCollector.events(origin);
        if (networkCollector.dropped > 0) {
          context.notes.push(`Network log was capped — ${networkCollector.dropped} events dropped (failures kept first).`);
        }
      }
      if (domCollector) {
        context.dom = domCollector.records(origin);
        if (domCollector.dropped > 0) {
          context.notes.push(`DOM log was capped — ${domCollector.dropped} mutations dropped.`);
        }
      }
      if (perfCollector) {
        context.performance = perfCollector.samples(origin);
        if (perfCollector.dropped > 0) {
          context.notes.push(`Performance log was capped — ${perfCollector.dropped} entries dropped.`);
        }
      }
      return context;
    },
    detach(): void {
      consoleCollector?.detach();
      networkCollector?.detach();
    },
  };
}

async function attachOrNote<T extends { attach(): Promise<T> }>(collector: T, name: string, notes: string[]): Promise<T | null> {
  try {
    return await collector.attach();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    notes.push(`The ${name} layer could not be installed: ${reason}`);
    return null;
  }
}

/**
 * Hang the collected context off the cards it belongs to.
 *
 * Each card owns the half-open interval ending at its own timestamp: card N
 * gets everything after card N-1 and up to and including card N — "since the
 * last frame", which is what the context is for. The first card also absorbs
 * everything from before the recording started (page load), and the last card
 * absorbs anything that arrived after the final frame, so nothing collected is
 * silently thrown away.
 *
 * Mutates `cards` in place.
 */
export function applyContext(cards: DiffCard[], context: CapturedContext): void {
  if (cards.length === 0) return;

  if (context.console) {
    assign(cards, context.console, (card, entries) => {
      if (entries.length > 0) card.console_entries = entries;
    });
  }
  if (context.network) {
    assign(cards, context.network, (card, events) => {
      if (events.length > 0) card.network_events = events;
    });
  }
  if (context.dom) {
    assign(cards, context.dom, (card, records) => {
      const snapshot = renderDomChanges(records, MAX_DOM_LINES_PER_CARD);
      if (snapshot !== undefined) card.dom_snapshot = snapshot;
    });
  }
  if (context.performance) {
    assign(cards, context.performance, (card, samples) => {
      const info = summarisePerformance(samples);
      if (info !== undefined) card.performance = info;
    });
  }
}

/** Bucket `items` by card (see `applyContext`) and hand each card its own. */
function assign<T extends { timestamp_ms: number }>(
  cards: DiffCard[],
  items: T[],
  attach: (card: DiffCard, items: T[]) => void,
): void {
  const buckets: T[][] = cards.map(() => []);
  const last = cards.length - 1;

  for (const item of items) {
    // Items are already in time order, but a card boundary search is cheap and
    // does not depend on that holding for every layer.
    let index = cards.findIndex((card) => item.timestamp_ms <= card.timestamp_ms);
    if (index === -1) index = last;
    buckets[index].push(item);
  }

  for (let i = 0; i < cards.length; i++) {
    attach(cards[i], buckets[i]);
  }
}

/**
 * Lines about the collection itself, for a tool's summary.
 *
 * The first is a tally of every layer that ran, including the ones that saw
 * nothing: silence after `include_network: true` is otherwise ambiguous — it
 * could mean the page made no requests or that the layer never installed — and
 * that difference is exactly what someone reading the result needs to know.
 * Anything a layer had to drop follows on its own line.
 *
 * `cardCount` is how many cards the context could be hung off. Zero means the
 * page produced no frames at all, and that is precisely when the console is
 * worth reading: a page that died before its first screenshot usually said
 * why, so its errors are carried up into the summary.
 */
export function summariseContext(context: CapturedContext, cardCount: number): string[] | undefined {
  const parts: string[] = [];
  if (context.console) {
    parts.push(context.console.length > 0 ? `console: ${count(context.console.length, "entry", "entries")}` : "console: silent");
  }
  if (context.network) {
    const pending = context.network.filter((event) => event.error === "pending").length;
    const settled = context.network.length - pending;
    const text = settled > 0 ? `network: ${count(settled, "request", "requests")}` : "network: no requests";
    parts.push(pending > 0 ? `${text} (${pending} still pending)` : text);
  }
  if (context.dom) {
    parts.push(context.dom.length > 0 ? `DOM: ${count(context.dom.length, "mutation", "mutations")}` : "DOM: no mutations");
  }
  if (context.performance) {
    parts.push(
      context.performance.length > 0
        ? `performance: ${count(context.performance.length, "entry", "entries")}`
        : "performance: nothing measured",
    );
  }

  const notes = parts.length > 0 ? [`Context — ${parts.join("; ")}`, ...context.notes] : [...context.notes];

  if (cardCount === 0) {
    const errors = (context.console ?? []).filter((entry) => entry.level === "error");
    for (const entry of errors.slice(0, MAX_ORPHANED_ERRORS)) {
      notes.push(`  [error] ${entry.text}`);
    }
    if (errors.length > MAX_ORPHANED_ERRORS) {
      notes.push(`  … and ${errors.length - MAX_ORPHANED_ERRORS} more errors`);
    }
  }

  return notes.length > 0 ? notes : undefined;
}

/** Console errors reported in the summary when a capture produced no frames at all. */
const MAX_ORPHANED_ERRORS = 5;

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
