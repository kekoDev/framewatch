import type { Page } from "playwright";
import { MAX_STYLE_SAMPLES } from "../../constants.js";

/**
 * Style layer: computed values of named elements, sampled through the recording.
 *
 * A frame diff says the logo changed; this says its opacity went from 0.3 to
 * 0.7 between the two cards, in the page's own numbers. The sampler reads
 * `getComputedStyle` for every watched element on the recorder's interval,
 * and each card is then given the values that moved since the previous card.
 * An element that matched nothing is reported as such, because a watch on a
 * mistyped selector that silently produced nothing would be worse than none.
 */

export interface StyleWatch {
  selector: string;
  properties: string[];
  /** What to call it in the output. Defaults to the selector. */
  label?: string;
}

/** One reading: label → property → computed value, or null when the selector matched nothing. */
export interface StyleSample {
  timestamp_ms: number;
  values: Record<string, Record<string, string> | null>;
}

export class StyleSampler {
  readonly #page: Page;
  readonly #watches: Array<{ label: string; selector: string; properties: string[] }>;
  readonly #interval: number;
  readonly #samples: Array<{ t: number; values: StyleSample["values"] }> = [];
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #dropped = 0;

  constructor(page: Page, watches: readonly StyleWatch[], intervalMs: number) {
    this.#page = page;
    this.#watches = watches.map((w) => ({ label: w.label ?? w.selector, selector: w.selector, properties: w.properties }));
    this.#interval = Math.max(16, intervalMs);
  }

  get labels(): string[] {
    return this.#watches.map((w) => w.label);
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** Take a reading now and keep taking them on the interval until `stop`. */
  start(): void {
    const tick = async (): Promise<void> => {
      if (this.#stopped) return;
      await this.#read();
      if (!this.#stopped) this.#timer = setTimeout(tick, this.#interval);
    };
    void tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  /** Readings rebased onto the recording clock (`origin` in epoch ms), ascending. */
  samples(origin: number): StyleSample[] {
    return this.#samples.map((s) => ({ timestamp_ms: Math.round(s.t - origin), values: s.values }));
  }

  async #read(): Promise<void> {
    if (this.#samples.length >= MAX_STYLE_SAMPLES) {
      this.#dropped++;
      return;
    }
    try {
      const values = await this.#page.evaluate(readStylesInPage, this.#watches);
      this.#samples.push({ t: Date.now(), values });
    } catch {
      // The page navigated or closed mid-read; the next tick tries again.
    }
  }
}

/**
 * The lines for one card. With no previous sample every value is listed (the
 * starting state); afterwards only what changed, as `old → new`, plus "no
 * change" so a quiet element is distinguishable from an unwatched one.
 */
export function renderStyleChanges(prev: StyleSample | undefined, curr: StyleSample | undefined): string | undefined {
  if (!curr) return undefined;
  const lines: string[] = [];
  for (const [label, now] of Object.entries(curr.values)) {
    const before = prev ? prev.values[label] : undefined;
    if (now === null) {
      lines.push(before ? `  ${label}: gone` : `  ${label}: selector matched nothing`);
      continue;
    }
    if (!prev || before === undefined) {
      lines.push(`  ${label}: ${Object.entries(now).map(([p, v]) => `${p} ${v}`).join(", ")}`);
      continue;
    }
    if (before === null) {
      lines.push(`  ${label}: appeared — ${Object.entries(now).map(([p, v]) => `${p} ${v}`).join(", ")}`);
      continue;
    }
    const changed = Object.entries(now).filter(([p, v]) => before[p] !== v);
    lines.push(changed.length === 0 ? `  ${label}: no change` : `  ${label}: ${changed.map(([p, v]) => `${p} ${before[p]} → ${v}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** The sample a card should be judged on: the latest at or before its timestamp, else the first. */
export function sampleForCard(samples: readonly StyleSample[], timestampMs: number): StyleSample | undefined {
  let chosen: StyleSample | undefined;
  for (const sample of samples) {
    if (sample.timestamp_ms <= timestampMs) chosen = sample;
    else break;
  }
  return chosen ?? samples[0];
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Serialised into Chromium: nothing here may reference a module value.
 */
function readStylesInPage(watches: Array<{ label: string; selector: string; properties: string[] }>): StyleSample["values"] {
  const doc = (globalThis as any).document;
  const win = (globalThis as any).window;
  const out: StyleSample["values"] = {};
  for (const watch of watches) {
    let element: any = null;
    try {
      element = doc ? doc.querySelector(watch.selector) : null;
    } catch {
      element = null;
    }
    if (!element) {
      out[watch.label] = null;
      continue;
    }
    const style = win.getComputedStyle(element);
    const values: Record<string, string> = {};
    for (const property of watch.properties) {
      values[property] = String(style.getPropertyValue(property) || style[property] || "");
    }
    out[watch.label] = values;
  }
  return out;
}
