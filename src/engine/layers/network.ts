import type { Page, Request, Response } from "playwright";
import { MAX_NETWORK_EVENTS, MAX_NETWORK_URL_LENGTH } from "../../constants.js";
import type { NetworkEvent } from "../../types.js";
import { BoundedLog } from "../../utils/bounded-log.js";

/**
 * Network layer.
 *
 * Records one event per request that settles during a capture: method, url,
 * status, how long it took, and when it landed. A request is timestamped at
 * the moment it *settled*, not when it was sent, because that is the instant
 * that can explain the frame next to it — a spinner disappears when the
 * response arrives, not when the fetch was issued.
 *
 * Durations come from Chromium's own `request.timing()` rather than from wall
 * clock in the event handler, so they measure the request and not Node's event
 * loop. Failed requests have no timing, and fall back to wall clock.
 *
 * Requests still in flight when the recording ends are reported too, as
 * `status: 0, error: "pending"` — a request that never comes back is a finding,
 * and silently dropping it would hide exactly the bug a developer is chasing.
 */

/** One settled request, stamped with absolute (epoch) time and an already-shortened url. */
export interface NetworkRecord {
  at: number;
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  error?: string;
}

/** In-flight bookkeeping for a request we have seen start but not settle. */
interface InFlight {
  started: number;
  status: number;
}

/**
 * Shorten a URL for display, keeping both ends: the path says what was asked
 * for and the tail usually carries the identifying part of a query string.
 * data: URIs are collapsed outright — they are content, not an address.
 */
export function shortenUrl(url: string, maxLength: number = MAX_NETWORK_URL_LENGTH): string {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const head = comma === -1 ? url.slice(0, 40) : url.slice(0, Math.min(comma, 40));
    return `${head},…(${url.length} chars)`;
  }
  if (url.length <= maxLength) return url;
  const keepEnd = Math.floor((maxLength - 1) / 3);
  const keepStart = maxLength - 1 - keepEnd;
  return `${url.slice(0, keepStart)}…${url.slice(url.length - keepEnd)}`;
}

/** A response worth keeping when the cap is full: anything that failed or errored. */
function isNotable(record: NetworkRecord): boolean {
  return record.error !== undefined || record.status === 0 || record.status >= 400;
}

export class NetworkCollector {
  readonly #page: Page;
  readonly #limit: number;
  readonly #log: BoundedLog<NetworkRecord>;
  /** Requests seen start but not yet settled. Keyed by Playwright's Request identity. */
  readonly #inFlight = new Map<Request, InFlight>();
  #attached = false;

  readonly #onRequest = (request: Request): void => {
    this.#inFlight.set(request, { started: Date.now(), status: 0 });
  };

  readonly #onResponse = (response: Response): void => {
    // Read the status synchronously here; at `requestfinished` it would cost an
    // await, and an async handler would reorder events against the recording.
    const pending = this.#inFlight.get(response.request());
    if (pending) pending.status = response.status();
  };

  readonly #onFinished = (request: Request): void => {
    this.#settle(request);
  };

  readonly #onFailed = (request: Request): void => {
    this.#settle(request, request.failure()?.errorText ?? "request failed");
  };

  constructor(page: Page, limit: number = MAX_NETWORK_EVENTS) {
    this.#page = page;
    this.#limit = Math.max(1, Math.floor(limit));
    this.#log = new BoundedLog<NetworkRecord>(limit, isNotable);
  }

  /** Start listening. Idempotent. */
  attach(): this {
    if (this.#attached) return this;
    this.#attached = true;
    this.#page.on("request", this.#onRequest);
    this.#page.on("response", this.#onResponse);
    this.#page.on("requestfinished", this.#onFinished);
    this.#page.on("requestfailed", this.#onFailed);
    return this;
  }

  /** Stop listening. Collected events are kept. */
  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.#page.off("request", this.#onRequest);
    this.#page.off("response", this.#onResponse);
    this.#page.off("requestfinished", this.#onFinished);
    this.#page.off("requestfailed", this.#onFailed);
  }

  /** Events refused or evicted by the cap, settled and pending alike. */
  get dropped(): number {
    return this.#log.dropped + this.#pendingOverflow();
  }

  /** Requests that never settled before the recording ended. */
  get pending(): number {
    return this.#inFlight.size;
  }

  /**
   * Pending requests bypass the log (they are synthesised at read time), so
   * they need their own bound — a page holding open hundreds of long-poll
   * connections would otherwise put every one of them in the response.
   */
  #pendingOverflow(): number {
    return Math.max(0, this.#inFlight.size - this.#limit);
  }

  /**
   * Forget everything collected so far, in-flight requests included. See
   * `BoundedLog.clear`.
   *
   * Dropping the in-flight map is deliberate: a request that was already
   * running before this window started did not begin here, and reporting it
   * as this action's pending request would be a lie about cause.
   */
  clear(): void {
    this.#log.clear();
    this.#inFlight.clear();
  }

  /**
   * Collected events in settle order, with timestamps rebased onto the
   * recording clock (`origin` is the recording's start in epoch ms). Requests
   * still in flight are appended as `pending`, timestamped when they started,
   * so they sort next to the frame that issued them.
   */
  events(origin: number): NetworkEvent[] {
    const settled: NetworkEvent[] = this.#log.items.map((record) => ({
      method: record.method,
      url: record.url,
      status: record.status,
      duration_ms: record.duration_ms,
      timestamp_ms: Math.round(record.at - origin),
      ...(record.error !== undefined ? { error: record.error } : {}),
    }));

    const now = Date.now();
    let room = this.#limit;
    for (const [request, info] of this.#inFlight) {
      if (room-- <= 0) break;
      settled.push({
        method: request.method(),
        url: shortenUrl(request.url()),
        status: 0,
        duration_ms: Math.max(0, Math.round(now - info.started)),
        timestamp_ms: Math.round(info.started - origin),
        error: "pending",
      });
    }
    return settled.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  }

  /**
   * Move a request out of flight and into the log. Chromium's timing gives an
   * absolute `startTime` and offsets from it; `responseEnd` is -1 for a request
   * that never got that far, so both the duration and the settle time fall back
   * to wall clock.
   */
  #settle(request: Request, error?: string): void {
    const pending = this.#inFlight.get(request);
    if (!pending) return;
    this.#inFlight.delete(request);

    const now = Date.now();
    let duration = now - pending.started;
    let at = now;
    try {
      const timing = request.timing();
      if (timing.startTime > 0 && timing.responseEnd >= 0) {
        duration = timing.responseEnd;
        at = timing.startTime + timing.responseEnd;
      }
    } catch {
      // Timing is unavailable once the page is gone; wall clock still is.
    }

    this.#log.add({
      at,
      method: request.method(),
      // Shortened here rather than on the way out: a page can request a
      // multi-megabyte data: URI, and holding a hundred of those until the
      // recording ends is a lot of memory for text that will be elided anyway.
      url: shortenUrl(request.url()),
      status: pending.status,
      duration_ms: Math.max(0, Math.round(duration)),
      ...(error !== undefined ? { error } : {}),
    });
  }
}
