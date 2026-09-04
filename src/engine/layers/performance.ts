import type { Page } from "playwright";
import { MAX_PERF_SAMPLES } from "../../constants.js";
import type { PerformanceInfo } from "../../types.js";
import { installProbe, probeConfig, type InstallOptions, type ProbeConfig } from "./probe.js";

/**
 * Performance layer.
 *
 * Three PerformanceObservers installed at document start report when the
 * browser first painted, when it settled on the largest contentful element,
 * and every time the layout jumped. Each entry carries two clocks:
 * `entry.startTime` (the metric itself — ms since *this document's*
 * navigation start, so an LCP of 800ms means the same thing here as in
 * Lighthouse) and, derived from it and `performance.timeOrigin`, the
 * wall-clock instant it happened, which decides the diff card it lands on.
 *
 * `buffered: true` means the observers also receive entries recorded before
 * they were registered, so nothing is lost to the gap between document start
 * and the first observer callback. After a navigation the timers restart with
 * the new document, which is correct: the new page's LCP is not a continuation
 * of the old page's.
 *
 * Layout shifts are counted whether or not they followed user input, unlike
 * Chrome's CLS. FrameWatch is watching what the page *looks* like, and a jump
 * that happens right after a click is often exactly the one being hunted.
 */

const BINDING = "__framewatch_perf";

export type PerfKind = "paint" | "lcp" | "shift";

/** One performance entry, as pushed by the page. Timestamps are absolute (epoch ms). */
export interface RawPerfRecord {
  /** Absolute time the browser recorded the entry (not when the observer saw it). */
  t: number;
  kind: PerfKind;
  /** `entry.startTime` — ms since this document's navigation start. */
  start: number;
  /** Paint entry name: "first-contentful-paint" or "first-paint". */
  name?: string;
  /** Layout shift score. */
  value?: number;
}

/** One performance entry, rebased onto the recording clock. */
export interface PerfSample {
  timestamp_ms: number;
  kind: PerfKind;
  start_ms: number;
  name?: string;
  value?: number;
}

/**
 * The page-side probe. Written against `globalThis` for the same reasons as
 * the DOM probe: no DOM lib at compile time, and everything it touches may be
 * missing in the page it lands in (PerformanceObserver entry types vary by
 * browser and are gated behind flags in some embedded contexts).
 */
const PERF_PROBE = (config: ProbeConfig): void => {
  const g = globalThis as any;
  // Main frame only: LCP, FCP and layout shift are whole-page metrics.
  if (g.top && g.top !== g) return;
  // The probe can be asked for twice on one document (installed on a page that
  // is already open, then re-run by the init script); a second set of observers
  // would report every entry twice.
  const installed = config.binding + "_observing";
  if (g[installed]) return;
  g[installed] = true;
  const send = g[config.binding];
  if (typeof send !== "function" || typeof g.PerformanceObserver !== "function") return;

  let queue: unknown[] = [];
  let scheduled = false;
  let budget = config.max_records;

  const flush = (): void => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const result = send(batch);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The page is being torn down; there is nowhere left to push to.
    }
  };

  const push = (record: unknown): void => {
    if (budget <= 0) return;
    budget--;
    if (queue.length >= config.max_batch) flush();
    queue.push(record);
    if (!scheduled) {
      scheduled = true;
      g.setTimeout(flush, config.flush_ms);
    }
  };

  try {
    g.addEventListener("pagehide", flush, true);
  } catch {
    // Not fatal: records wait for the timer instead.
  }

  // `entry.startTime` is measured from this document's navigation start, and
  // `performance.timeOrigin` is that instant in epoch ms — so the two together
  // give the wall-clock moment the browser actually painted or shifted. That is
  // what a record has to be stamped with: an observer callback can run long
  // after the entry it reports (LCP in particular), and stamping with Date.now()
  // would file a paint on whichever frame happened to be next.
  const origin = typeof g.performance?.timeOrigin === "number" ? g.performance.timeOrigin : null;

  const observe = (type: string, kind: string): void => {
    try {
      new g.PerformanceObserver((list: any) => {
        for (const entry of list.getEntries()) {
          const start = typeof entry.startTime === "number" ? entry.startTime : 0;
          push({
            t: origin === null ? Date.now() : origin + start,
            kind,
            start,
            ...(kind === "paint" ? { name: String(entry.name || "") } : {}),
            ...(kind === "shift" ? { value: typeof entry.value === "number" ? entry.value : 0 } : {}),
          });
        }
      }).observe({ type, buffered: true });
    } catch {
      // This entry type is unsupported here; the others still report.
    }
  };

  observe("paint", "paint");
  observe("largest-contentful-paint", "lcp");
  observe("layout-shift", "shift");
};

export class PerformanceCollector {
  readonly #page: Page;
  readonly #limit: number;
  readonly #records: RawPerfRecord[] = [];
  #dropped = 0;

  constructor(page: Page, limit: number = MAX_PERF_SAMPLES) {
    this.#page = page;
    this.#limit = Math.max(1, limit);
  }

  /**
   * Install the probe. Call before the page navigates, or pass
   * `{ runNow: true }` to also measure the document that is already loaded —
   * `buffered: true` means the observers still receive what it recorded
   * earlier, so a page that painted before this ran is not lost.
   */
  async attach(options: InstallOptions = {}): Promise<this> {
    const config = probeConfig(BINDING);
    await installProbe<RawPerfRecord>(this.#page, config, PERF_PROBE, (batch) => this.#ingest(batch), options);
    return this;
  }

  /** Entries the cap refused. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Forget everything collected so far. See `BoundedLog.clear`. */
  clear(): void {
    this.#records.length = 0;
    this.#dropped = 0;
  }

  /**
   * Collected entries in time order, rebased onto the recording clock
   * (`origin` is the recording's start in epoch ms). Entries from before the
   * recording started keep their negative timestamp: first paint routinely
   * happens before frame 0, and belongs on the first card.
   */
  samples(origin: number): PerfSample[] {
    return this.#records.map((record) => ({
      timestamp_ms: Math.round(record.t - origin),
      kind: record.kind,
      start_ms: Math.round(record.start),
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.value !== undefined ? { value: record.value } : {}),
    }));
  }

  #ingest(batch: RawPerfRecord[]): void {
    for (const record of batch) {
      // The page pushes this, so nothing about it is trusted.
      if (!record || typeof record.t !== "number" || typeof record.start !== "number") continue;
      if (record.kind !== "paint" && record.kind !== "lcp" && record.kind !== "shift") continue;
      if (this.#records.length >= this.#limit) {
        this.#dropped++;
        continue;
      }
      this.#records.push(record);
    }
  }
}

/**
 * Reduce one card's entries to the numbers worth printing beside it.
 *
 * Only what actually happened in this window is reported — LCP is not repeated
 * on every card after it was measured, because a number that never changes on
 * twenty cards is noise, not context. Returns undefined when the window is
 * empty, so cards with nothing to report carry no Performance section at all.
 */
export function summarisePerformance(samples: PerfSample[]): PerformanceInfo | undefined {
  if (samples.length === 0) return undefined;

  let paint: PerfSample | undefined;
  let lcp: PerfSample | undefined;
  let shifts = 0;
  let score = 0;

  for (const sample of samples) {
    if (sample.kind === "paint") {
      // Prefer first-contentful-paint; first-paint is the fallback when the
      // browser reported only that (both arrive together on a normal load).
      if (!paint || (paint.name !== "first-contentful-paint" && sample.name === "first-contentful-paint")) {
        paint = sample;
      }
    } else if (sample.kind === "lcp") {
      // LCP grows as the browser finds larger elements: the last one wins.
      if (!lcp || sample.start_ms >= lcp.start_ms) lcp = sample;
    } else {
      shifts++;
      score += sample.value ?? 0;
    }
  }

  const info: PerformanceInfo = {};
  if (paint) info.paint_time_ms = paint.start_ms;
  if (shifts > 0) {
    info.layout_shifts = shifts;
    info.layout_shift_score = Math.round(score * 10_000) / 10_000;
  }
  if (lcp) info.lcp_ms = lcp.start_ms;
  return Object.keys(info).length > 0 ? info : undefined;
}
