import type { Page } from "playwright";
import { LAYER_FLUSH_MS, MAX_LAYER_BATCH, MAX_LAYER_RECORDS_PER_DOCUMENT } from "../../constants.js";

/**
 * In-page probe plumbing, shared by the DOM and performance layers.
 *
 * Console and network are Playwright events, but "what changed in the DOM" and
 * "when did the browser paint" only exist inside the page, so those two layers
 * inject an observer and push what it sees back to Node.
 *
 * The push is an `exposeBinding` function rather than one `page.evaluate` at
 * the end of the recording, for one reason: a navigation destroys the document
 * and everything buffered in it. Bindings and init scripts are reinstalled on
 * every new document, so a capture that navigates keeps the records from both
 * pages — and a capture whose page freezes or dies keeps whatever it pushed
 * before it went.
 *
 * Each probe inlines its own batching queue (page scripts cannot import, and
 * `eval`ing a shared one would break on any page with a strict CSP). Records
 * are stamped when they are *made*, never when their batch is flushed, so
 * batching cannot move a record onto the wrong diff card.
 */

/** Config handed to the page-side script. Must stay JSON-serialisable. */
export interface ProbeConfig {
  /** Name of the `window` function the page pushes batches through. */
  binding: string;
  /** How long to coalesce records before pushing a batch. */
  flush_ms: number;
  /** Records one batch may carry. */
  max_batch: number;
  /** Records the probe may push over the lifetime of one document. */
  max_records: number;
}

export function probeConfig(binding: string): ProbeConfig {
  return {
    binding,
    flush_ms: LAYER_FLUSH_MS,
    max_batch: MAX_LAYER_BATCH,
    max_records: MAX_LAYER_RECORDS_PER_DOCUMENT,
  };
}

/**
 * Expose `config.binding` on the page and arrange for `script` to run at the
 * start of every document (including after a navigation).
 *
 * `onBatch` must never throw: it runs as the resolution of a promise the page
 * is holding, so a throw here surfaces inside the page under test as an
 * unhandled rejection — which the console layer would then dutifully report as
 * a bug in the user's app. It is wrapped here so callers cannot get that wrong.
 */
export async function installProbe<T>(
  page: Page,
  config: ProbeConfig,
  script: (config: ProbeConfig) => void,
  onBatch: (records: T[]) => void,
  options: InstallOptions = {},
): Promise<void> {
  await page.exposeBinding(config.binding, (_source, batch: unknown) => {
    try {
      if (Array.isArray(batch)) onBatch(batch as T[]);
    } catch {
      // A collector must never break the page it is watching.
    }
  });
  await page.addInitScript(script, config);

  if (options.runNow === true) {
    // Init scripts only reach *new* documents, so a probe installed on a page
    // that is already loaded would watch nothing until the next navigation.
    // Running it once by hand covers the document that is already there; the
    // probes guard against being installed twice, so the init script running
    // later on the same document is harmless.
    await page.evaluate(script, config).catch(() => {});
  }
}

export interface InstallOptions {
  /**
   * Also run the probe against the document the page already has. Needed for
   * `framewatch_interact`, which acts on a page that is open before the layer
   * is asked for; captures attach before navigating and do not need it.
   */
  runNow?: boolean;
}
