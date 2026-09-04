import type { Page } from "playwright";
import { ConsoleCollector } from "./console.js";
import { DomCollector } from "./dom.js";
import { NetworkCollector } from "./network.js";
import { PerformanceCollector } from "./performance.js";
import type { CapturedContext, LayerFlags } from "./index.js";

/**
 * Context layers for a page that outlives one tool call.
 *
 * `framewatch_capture` gets a fresh page every time, so it can attach layers,
 * record, and throw the whole thing away. `framewatch_interact` cannot: its
 * page stays open between calls — that is what makes click → look → type →
 * look possible — and two of the four layers cannot be attached twice to the
 * same page at all. `page.exposeBinding` refuses a name that is already taken,
 * and an init script, once added, can never be removed.
 *
 * So the layers live as long as the page does, and each call *drains* them
 * instead of attaching its own: `ensure` installs whatever this call asked for
 * and is not there yet, `clear` empties the collectors so the call reports
 * only what its own action caused, and `collect` reads them afterwards.
 *
 * A layer that was installed for an earlier call keeps collecting even when
 * this call did not ask for it — nothing can uninstall it — but it is cleared
 * with the rest and simply not reported. The cost is a MutationObserver that
 * nobody reads; the alternative is a page that has to be thrown away and
 * rebuilt whenever the flags change, which would defeat the tool.
 */
export class SessionLayers {
  readonly #page: Page;
  #console: ConsoleCollector | null = null;
  #network: NetworkCollector | null = null;
  #dom: DomCollector | null = null;
  #performance: PerformanceCollector | null = null;
  /** Layers that could not be installed on this page, one note each. */
  #notes: string[] = [];

  constructor(page: Page) {
    this.#page = page;
  }

  /**
   * Install every requested layer that is not there yet.
   *
   * Failures become notes rather than exceptions, for the same reason as in
   * `attachLayers`: the interaction is the point and the context is the bonus,
   * so a layer that will not install must not take the tool call down with it.
   */
  async ensure(flags: LayerFlags): Promise<void> {
    this.#notes = [];

    if (flags.console && !this.#console) {
      this.#console = new ConsoleCollector(this.#page).attach();
    }
    if (flags.network && !this.#network) {
      this.#network = new NetworkCollector(this.#page).attach();
    }
    // The injected probes go in with `runNow`: the page is already loaded by
    // the time this runs, and an init script alone would not reach it until
    // the next navigation.
    if (flags.dom && !this.#dom) {
      this.#dom = await this.#install(new DomCollector(this.#page), "DOM");
    }
    if (flags.performance && !this.#performance) {
      this.#performance = await this.#install(new PerformanceCollector(this.#page), "performance");
    }
  }

  /** Empty every installed collector, so the next window starts from nothing. */
  clear(): void {
    this.#console?.clear();
    this.#network?.clear();
    this.#dom?.clear();
    this.#performance?.clear();
  }

  /**
   * What the requested layers saw, rebased onto `origin` (epoch ms).
   *
   * Only the layers this call asked for are reported, whatever else happens to
   * be installed. Purely synchronous and never touches the page, so it still
   * works after the page has navigated, frozen or died.
   */
  collect(origin: number, flags: LayerFlags): CapturedContext {
    const context: CapturedContext = { notes: [...this.#notes] };

    if (flags.console && this.#console) {
      context.console = this.#console.entries(origin);
      if (this.#console.dropped > 0) {
        context.notes.push(`Console output was capped — ${this.#console.dropped} entries dropped (errors kept first).`);
      }
    }
    if (flags.network && this.#network) {
      context.network = this.#network.events(origin);
      if (this.#network.dropped > 0) {
        context.notes.push(`Network log was capped — ${this.#network.dropped} events dropped (failures kept first).`);
      }
    }
    if (flags.dom && this.#dom) {
      context.dom = this.#dom.records(origin);
      if (this.#dom.dropped > 0) {
        context.notes.push(`DOM log was capped — ${this.#dom.dropped} mutations dropped.`);
      }
    }
    if (flags.performance && this.#performance) {
      context.performance = this.#performance.samples(origin);
      if (this.#performance.dropped > 0) {
        context.notes.push(`Performance log was capped — ${this.#performance.dropped} entries dropped.`);
      }
    }

    return context;
  }

  async #install<T extends { attach(options: { runNow: boolean }): Promise<T> }>(
    collector: T,
    name: string,
  ): Promise<T | null> {
    try {
      return await collector.attach({ runNow: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      this.#notes.push(`The ${name} layer could not be installed: ${reason}`);
      return null;
    }
  }
}

/**
 * The layers belonging to `page`, created on first use.
 *
 * Keyed weakly by page, so a session that is reopened (a viewport change that
 * needed touch, a crashed tab) starts with fresh collectors and the old ones
 * are collected along with the page they watched.
 */
const byPage = new WeakMap<Page, SessionLayers>();

export function layersFor(page: Page): SessionLayers {
  const existing = byPage.get(page);
  if (existing) return existing;
  const created = new SessionLayers(page);
  byPage.set(page, created);
  return created;
}
