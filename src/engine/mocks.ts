import type { Page, Request, Route } from "playwright";
import { MAX_MOCK_URLS_LISTED, MAX_UNMATCHED_TRACKED } from "../constants.js";
import { shortenUrl } from "./layers/network.js";
import {
  installOrder,
  type MockActivity,
  type ResolvedMock,
  type UnmatchedRequest,
} from "../utils/mock-rules.js";

/**
 * Request interception for `framewatch_api_mock`.
 *
 * Installs one Playwright route per mock, answers the requests they match,
 * and keeps the tally the report is built from: what each mock served, what it
 * never served, and what the page asked for that no mock had an opinion about.
 *
 * Two rules do most of the work here:
 *
 * The page's own navigation is never mocked. A catch-all pattern is a
 * perfectly reasonable thing to write, and if the main document went through
 * the mock the page under test would be replaced by a JSON body — there would
 * be nothing left to photograph. The document is how the page got here, not
 * something the page asked for, so it is passed through untouched and left out
 * of the unmatched tally as well. Sub-resources and everything an iframe or the
 * app itself fetches are fair game.
 *
 * `times` is counted here rather than handed to Playwright. Playwright spends a
 * route's remaining uses whenever the pattern matches, which would let the
 * document request consume a `times: 1` mock before the app ever fetched
 * anything.
 */

export interface MockRouterOptions {
  /** The mocks in the order the caller wrote them; the first match wins. */
  mocks: ResolvedMock[];
  /** Abort anything no mock matched instead of letting it reach the network. */
  block_unmatched: boolean;
}

export class MockRouter {
  readonly #blockUnmatched: boolean;
  readonly #activity: MockActivity[];
  /** Unmatched requests keyed by identity, so a response can fill in its status later. */
  readonly #unmatched = new Map<Request, UnmatchedRequest>();
  #page: Page | null = null;
  /** Sleeping delays, so a recording that ends first does not leave timers behind. */
  readonly #waits = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  #disposed = false;

  readonly #onResponse = (response: { request(): Request; status(): number }): void => {
    const record = this.#unmatched.get(response.request());
    if (record && record.blocked !== true) record.status = response.status();
  };

  constructor(options: MockRouterOptions) {
    this.#blockUnmatched = options.block_unmatched;
    this.#activity = options.mocks.map((mock) => ({ mock, hits: 0, answered: 0, urls: [] }));
  }

  /**
   * Install the routes. Call before the page navigates.
   *
   * The catch-all goes on first *because* Playwright checks routes
   * last-registered-first: registering it before the mocks is what puts it
   * behind them. The mocks themselves go on in reverse (see `installOrder`),
   * which leaves the first one the caller wrote at the front of the queue.
   */
  async install(page: Page): Promise<void> {
    this.#page = page;
    page.on("response", this.#onResponse);

    await page.route("**/*", (route, request) => this.#handleUnmatched(route, request));

    for (const entry of installOrder(this.#activity)) {
      await page.route(entry.mock.url_pattern, (route, request) => this.#handleMock(entry, route, request));
    }
  }

  /** What each mock did, in the order the caller wrote them. */
  get activity(): MockActivity[] {
    return this.#activity;
  }

  /** Requests no mock matched, in the order the page made them. */
  get unmatched(): UnmatchedRequest[] {
    return [...this.#unmatched.values()];
  }

  /**
   * Stop answering. Called once the recording is over and before the page is
   * closed: a mock still sleeping out a long delay has nothing left to answer,
   * and its timer would otherwise outlive the tool call.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#page?.off("response", this.#onResponse);
    for (const wait of this.#waits) {
      clearTimeout(wait.timer);
      wait.resolve();
    }
    this.#waits.clear();
  }

  /** One mock's turn at a request. */
  async #handleMock(entry: MockActivity, route: Route, request: Request): Promise<void> {
    const { mock } = entry;

    // Not ours: the page's own document, or a mock that has already been spent.
    if (this.#isMainDocument(request) || (mock.times !== undefined && entry.hits >= mock.times)) {
      await this.#safely(() => route.fallback());
      return;
    }

    entry.hits++;
    if (entry.urls.length < MAX_MOCK_URLS_LISTED) entry.urls.push(shortenUrl(request.url()));

    if (mock.kind === "abort") {
      if (await this.#safely(() => route.abort(mock.reason))) entry.answered++;
      return;
    }

    if (mock.delay_ms > 0) await this.#wait(mock.delay_ms);
    // The recording ended while this was sleeping; there is nobody left to answer.
    if (this.#disposed) return;

    const answered = await this.#safely(() =>
      route.fulfill({ status: mock.status, headers: mock.headers, body: mock.body }),
    );
    if (answered) entry.answered++;
  }

  /** Everything no mock wanted. */
  async #handleUnmatched(route: Route, request: Request): Promise<void> {
    if (this.#isMainDocument(request)) {
      await this.#safely(() => route.continue());
      return;
    }

    if (this.#unmatched.size < MAX_UNMATCHED_TRACKED) {
      this.#unmatched.set(request, {
        method: request.method(),
        url: shortenUrl(request.url()),
        ...(this.#blockUnmatched ? { blocked: true } : {}),
      });
    }

    await this.#safely(() => (this.#blockUnmatched ? route.abort("failed") : route.continue()));
  }

  /**
   * The page's own navigation, which is never mocked and never counted. A
   * request whose frame has already gone cannot be the main document any more,
   * so a throw here means "no".
   */
  #isMainDocument(request: Request): boolean {
    try {
      return request.resourceType() === "document" && request.frame() === this.#page?.mainFrame();
    } catch {
      return false;
    }
  }

  /** A delay that a `dispose()` can cut short. */
  #wait(ms: number): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wait = {
        timer: setTimeout(() => {
          this.#waits.delete(wait);
          resolve();
        }, ms),
        resolve,
      };
      this.#waits.add(wait);
    });
  }

  /**
   * Run one route call, swallowing the failure.
   *
   * A route whose page has navigated away, closed or crashed rejects, and none
   * of that is worth failing a recording over — the frames are the point. It
   * also has to be caught rather than left floating: an unhandled rejection
   * from a route handler would surface as a crash somewhere unrelated.
   */
  async #safely(run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch {
      return false;
    }
  }
}
