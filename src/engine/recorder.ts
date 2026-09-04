import type { Frame, Page } from "playwright";
import {
  CAPTURE_INTERVAL_MS,
  SCREENSHOT_FINAL_TIMEOUT_MS,
  SCREENSHOT_RETRY_ATTEMPTS,
  SCREENSHOT_RETRY_DELAY_MS,
  SCREENSHOT_TIMEOUT_MS,
} from "../constants.js";
import type { FrameTrigger, RawFrame } from "../types.js";

/**
 * Frame recorder.
 *
 * Captures raw PNG screenshots of a page at a fixed interval using a
 * self-scheduling `setTimeout` chain aligned to `start + n * interval`, so two
 * screenshots are never in flight at the same time. If one screenshot takes
 * longer than the interval, the missed ticks are skipped rather than bunched.
 *
 * Every screenshot is bounded by an explicit timeout: Chromium blocks
 * screenshots while a cross-document navigation is pending or the main thread
 * is busy, and Playwright's 30s default would otherwise stall the recording
 * (and stop(), which waits for the in-flight shot) for minutes.
 */

export interface RecorderOptions {
  /** Interval between interval frames. Default CAPTURE_INTERVAL_MS. */
  interval_ms?: number;
}

export interface RecordingResult {
  /** All captured frames in ascending timestamp_ms order (forced frames interleaved in time order). */
  frames: RawFrame[];
  /** Actual wall-clock recording length in ms. */
  duration_ms: number;
  /** Interval ticks whose screenshot failed (e.g. mid-navigation) and were skipped. */
  dropped: number;
  /**
   * Epoch ms of timestamp 0. The context layers start collecting before the
   * navigation, so they stamp absolute time and need this to rebase onto the
   * same clock the frames use.
   */
  started_at: number;
}

export class FrameRecorder {
  readonly #page: Page;
  readonly #interval: number;
  readonly #frames: RawFrame[] = [];
  #startedAt = 0;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  /** The currently running interval tick (screenshot), if any. */
  #inFlight: Promise<void> | null = null;
  /** Serialises every screenshot (interval + out-of-band) so no two are ever in flight together. */
  #chain: Promise<unknown> = Promise.resolve();
  #dropped = 0;
  /** Per-screenshot timeout — see the class doc. */
  readonly #screenshotTimeout: number;
  /** True while the last screenshot attempt timed out; stop() then skips the final frame. */
  #unresponsive = false;
  /** Main-frame URL (without fragment) of the last navigation we reacted to. */
  #lastNavUrl: string | null = null;
  /** Set by a navigation; the next frame that lands is tagged "navigation". */
  #pendingNavTag = false;
  /** Set by the first stop(); later calls return the same result instead of capturing again. */
  #result: Promise<RecordingResult> | null = null;
  /**
   * Main-frame navigation → the next frame that lands is tagged "navigation"
   * (and so is always kept by the differ). Attached in start(), removed in
   * stop().
   *
   * Tagging rather than taking a dedicated screenshot matters twice over.
   * Playwright emits this event for same-document navigations too, so the
   * common scroll-spy / router pattern (a `history.replaceState` on every
   * animation frame) fires it ~60 times a second — a screenshot per event
   * would starve the recorder. And a screenshot requested at commit time is
   * the one most likely to block: Chromium has not painted the new document
   * yet, so the request hangs until it does, holds up every capture queued
   * behind it, and can be lost entirely if the recording ends first. The next
   * frame the loop takes shows the same navigation and always arrives.
   *
   * Fragment-only changes are ignored outright: `#a` → `#b` navigates nothing.
   */
  readonly #onFrameNavigated = (frame: Frame): void => {
    if (frame !== this.#page.mainFrame()) return;

    const url = stripFragment(frame.url());
    if (url === this.#lastNavUrl) return;
    this.#lastNavUrl = url;
    this.#pendingNavTag = true;
  };

  constructor(page: Page, options: RecorderOptions = {}) {
    this.#page = page;
    const interval = options.interval_ms;
    // A zero/negative/NaN interval would turn the tick chain into a tight
    // screenshot loop (setTimeout coerces NaN and Infinity to ~1ms).
    this.#interval = typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : CAPTURE_INTERVAL_MS;
    this.#screenshotTimeout = Math.max(SCREENSHOT_TIMEOUT_MS, this.#interval * 2);
  }

  /** Frames captured so far (live view, in capture order). */
  get frames(): readonly RawFrame[] {
    return this.#frames;
  }

  /**
   * Start the interval loop; timestamp 0 is now. The first frame is captured
   * immediately. Idempotent, and a no-op once the recorder has been stopped.
   */
  start(): void {
    if (this.#running || this.#result) return;
    this.#running = true;
    this.#startedAt = Date.now();
    this.#lastNavUrl = stripFragment(this.#page.url());
    this.#page.on("framenavigated", this.#onFrameNavigated);
    this.#tick(0);
  }

  /**
   * Capture one frame right now (outside the interval), tagged with `trigger`
   * (is_interaction = trigger === "interaction"). Waits for any in-flight
   * screenshot first. Resolves to the frame, or null if the screenshot
   * failed. Never throws.
   */
  captureNow(trigger: FrameTrigger): Promise<RawFrame | null> {
    return this.#capture(trigger);
  }

  /** Stop the loop, wait for any in-flight screenshot, capture one final frame, and return the result. */
  async stop(): Promise<RecordingResult> {
    if (!this.#result) {
      this.#result = this.#doStop();
    }
    return this.#result;
  }

  async #doStop(): Promise<RecordingResult> {
    this.#running = false;
    this.#page.off("framenavigated", this.#onFrameNavigated);
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
    // Always try for a final frame — it is the settled end state, and it may
    // still be carrying a pending navigation tag. If the last attempt timed
    // out, bound this one tightly so a wedged page cannot stall shutdown while
    // a page that has since recovered still gets captured.
    if (!this.#page.isClosed()) {
      await this.#capture(undefined, this.#unresponsive ? SCREENSHOT_FINAL_TIMEOUT_MS : undefined);
    }
    const duration_ms = this.#elapsed();
    const frames = [...this.#frames].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    return { frames, duration_ms, dropped: this.#dropped, started_at: this.#startedAt };
  }

  #elapsed(): number {
    return Date.now() - this.#startedAt;
  }

  /** Run interval tick `n`, then schedule the next tick that is still in the future. */
  #tick(n: number): void {
    if (!this.#running) return;
    this.#timer = null;
    if (this.#page.isClosed()) {
      // Nothing left to record — stop silently rather than counting every remaining tick as dropped.
      this.#running = false;
      return;
    }
    this.#inFlight = this.#capture(undefined)
      .then((frame) => {
        if (frame === null && !this.#page.isClosed()) this.#dropped++;
      })
      .finally(() => {
        this.#inFlight = null;
        if (!this.#running || this.#page.isClosed()) return;
        // Next tick strictly in the future: skip any ticks already missed so screenshots never bunch up.
        const elapsed = this.#elapsed();
        const next = Math.max(n + 1, Math.floor(elapsed / this.#interval) + 1);
        this.#timer = setTimeout(() => this.#tick(next), next * this.#interval - elapsed);
      });
  }

  /**
   * Take one screenshot (after any in-flight one has finished) and append it.
   *
   * The frame is stamped when the screenshot *resolves*, not when it was
   * requested: a screenshot that waits on a pending navigation returns the new
   * document, and stamping it with the request time would report the change as
   * having happened far earlier than it did.
   *
   * Resolves to the frame, or null if the screenshot failed. Never throws.
   */
  #capture(trigger: FrameTrigger | undefined, timeoutMs?: number): Promise<RawFrame | null> {
    const run = async (): Promise<RawFrame | null> => {
      const buffer = await this.#screenshot(timeoutMs ?? this.#screenshotTimeout);
      if (buffer === null) return null;
      // A navigation since the last frame? This one shows it.
      let effective = trigger;
      if (this.#pendingNavTag) {
        this.#pendingNavTag = false;
        effective ??= "navigation";
      }
      const frame: RawFrame = {
        buffer,
        timestamp_ms: this.#elapsed(),
        is_interaction: effective === "interaction",
        ...(effective !== undefined ? { trigger: effective } : {}),
      };
      this.#frames.push(frame);
      return frame;
    };
    const result = this.#chain.then(run, run);
    this.#chain = result;
    return result;
  }

  /**
   * One bounded screenshot. Returns null on failure (never throws) and records
   * whether the page stopped responding. Chromium refuses a screenshot until
   * it has produced its first frame — right after a navigation commits that
   * happens about half the time — so that specific error is retried briefly.
   */
  async #screenshot(timeoutMs: number): Promise<Buffer | null> {
    for (let attempt = 0; attempt < SCREENSHOT_RETRY_ATTEMPTS; attempt++) {
      try {
        const buffer = await this.#page.screenshot({ type: "png", timeout: timeoutMs });
        this.#unresponsive = false;
        return buffer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Timeout .*exceeded/i.test(message)) {
          // The page is blocked; retrying only stalls the recording further.
          this.#unresponsive = true;
          return null;
        }
        if (!/Unable to capture screenshot/i.test(message) || this.#page.isClosed()) {
          return null;
        }
        await delay(SCREENSHOT_RETRY_DELAY_MS);
      }
    }
    return null;
  }
}

/** Compare navigation URLs without their fragment — `#a` → `#b` navigates nothing. */
function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convenience: start → (run `during(recorder)` concurrently if given) → wait
 * `duration_ms` from start → stop. If `during` rejects, the recorder is
 * stopped first and the error is rethrown.
 */
export async function recordFrames(
  page: Page,
  options: RecorderOptions & { duration_ms: number },
  during?: (recorder: FrameRecorder) => Promise<void>,
): Promise<RecordingResult> {
  const recorder = new FrameRecorder(page, options);
  recorder.start();

  let timer: NodeJS.Timeout | undefined;
  const duration = Number.isFinite(options.duration_ms) ? Math.max(0, options.duration_ms) : 0;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, duration);
  });

  // There is nothing left to record once the page is gone: end the recording
  // immediately instead of idling out the rest of the duration.
  let onGone: (() => void) | undefined;
  const pageGone = new Promise<void>((resolve) => {
    onGone = (): void => resolve();
    page.once("close", onGone);
    page.once("crash", onGone);
  });

  try {
    const elapse = Promise.race([wait, pageGone]);
    if (during) {
      // Let a failing `during` short-circuit the wait; a successful one still waits out the duration.
      await Promise.all([elapse, during(recorder)]);
    } else {
      await elapse;
    }
  } catch (error) {
    clearTimeout(timer);
    if (onGone) {
      page.off("close", onGone);
      page.off("crash", onGone);
    }
    await recorder.stop();
    throw error;
  }
  clearTimeout(timer);
  if (onGone) {
    page.off("close", onGone);
    page.off("crash", onGone);
  }
  return recorder.stop();
}
