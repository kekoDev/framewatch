import {
  MAX_MOCK_URLS_LISTED,
  MAX_UNMATCHED_LISTED,
  MOCK_SLOW_DELAY_MS,
} from "../constants.js";

/**
 * What a mock means, and what one run of them is worth reporting.
 *
 * Everything here is pure: no Playwright, no page, no socket. The engine turns
 * a `ResolvedMock` into a real route and counts what happened; this file
 * decides what a scenario expands to, how a body is encoded, which mock wins
 * when two patterns match, and how the result reads.
 */

/* ── Scenarios ────────────────────────────────────────────────────────── */

/**
 * The shorthands. Each expands to a response the caller can then override
 * field by field, which is what makes them worth having: `slow` with your own
 * body is one word plus a body, not a hand-written response.
 */
export const MOCK_SCENARIOS = [
  "empty",
  "error",
  "unauthorized",
  "not_found",
  "slow",
  "malformed",
  "offline",
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/**
 * Failures the browser can be told to report. These four are the ones a
 * developer actually means: the request failed, it hung, nothing was
 * listening, or there is no network at all.
 */
export const ABORT_REASONS = ["failed", "timedout", "connectionrefused", "internetdisconnected"] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

/** One mock exactly as the caller wrote it. */
export interface MockSpec {
  url_pattern?: string;
  scenario?: MockScenario;
  response?: {
    status?: number;
    body?: unknown;
    delay_ms?: number;
    headers?: Record<string, string>;
  };
  abort?: AbortReason;
  times?: number;
}

/** A mock with every question answered, ready for the engine to install. */
export type ResolvedMock =
  | {
      kind: "abort";
      url_pattern: string;
      reason: AbortReason;
      times?: number;
      scenario?: MockScenario;
    }
  | {
      kind: "fulfill";
      url_pattern: string;
      status: number;
      /** Already encoded — the exact bytes the page will receive. */
      body: string;
      /** Header names lower-cased, so `content-type` can only be set once. */
      headers: Record<string, string>;
      delay_ms: number;
      times?: number;
      scenario?: MockScenario;
    };

/** What each scenario means, before the caller's own `response` is laid over it. */
const SCENARIOS: Readonly<Record<MockScenario, { status?: number; body?: unknown; delay_ms?: number; abort?: AbortReason }>> =
  {
    // An empty array, not `{ items: [] }`: no shape is right for every API, so
    // the shorthand covers the common one and the report prints what it served,
    // which is how a mismatch becomes visible instead of mysterious.
    empty: { status: 200, body: [] },
    error: { status: 500, body: { error: "Internal server error" } },
    unauthorized: { status: 401, body: { error: "Unauthorized" } },
    not_found: { status: 404, body: { error: "Not found" } },
    slow: { status: 200, delay_ms: MOCK_SLOW_DELAY_MS },
    // Deliberately not JSON, deliberately served as JSON. See `encodeBody`.
    malformed: { status: 200, body: "not json" },
    offline: { abort: "failed" },
  };

/**
 * Turn one written mock into one the engine can install.
 *
 * The scenario supplies defaults and the caller's own fields win one at a
 * time, so `{ scenario: "slow", response: { body } }` keeps the delay and takes
 * the body. An explicit `abort` beats a scenario that would have answered: a
 * caller who asked for a dead request means it.
 */
export function resolveMock(spec: MockSpec): ResolvedMock {
  const scenario = spec.scenario;
  const preset = scenario ? SCENARIOS[scenario] : {};
  const response = spec.response ?? {};

  const reason = spec.abort ?? preset.abort;
  if (reason !== undefined) {
    return {
      kind: "abort",
      url_pattern: spec.url_pattern ?? "",
      reason,
      ...(spec.times !== undefined ? { times: spec.times } : {}),
      ...(scenario !== undefined ? { scenario } : {}),
    };
  }

  const body = response.body !== undefined ? response.body : preset.body;
  const encoded = encodeBody(body);
  const headers: Record<string, string> = {};
  if (encoded.content_type !== undefined) headers["content-type"] = encoded.content_type;
  // The caller's headers land last and are lower-cased on the way in, so a
  // `Content-Type` of their own replaces the one the body implied rather than
  // sitting next to it as a second header.
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  return {
    kind: "fulfill",
    url_pattern: spec.url_pattern ?? "",
    status: response.status ?? preset.status ?? 200,
    body: encoded.body,
    headers,
    delay_ms: response.delay_ms ?? preset.delay_ms ?? 0,
    ...(spec.times !== undefined ? { times: spec.times } : {}),
    ...(scenario !== undefined ? { scenario } : {}),
  };
}

/**
 * Encode a body into the bytes the page will actually receive.
 *
 * A string is sent verbatim. This is the whole reason the malformed scenario
 * works: `JSON.stringify("not json")` is `"not json"`, which parses perfectly,
 * so encoding a string would make a broken API impossible to simulate. It goes
 * out as `application/json` because these stand in for API responses — anyone
 * mocking a page or a script says so in `headers`.
 *
 * Anything else is JSON, including `null`. Only an absent body means "no body",
 * and it carries no content type at all.
 */
export function encodeBody(body: unknown): { body: string; content_type?: string } {
  if (body === undefined) return { body: "" };
  if (typeof body === "string") return { body, content_type: "application/json" };
  return { body: JSON.stringify(body), content_type: "application/json" };
}

/**
 * The order to hand mocks to Playwright.
 *
 * Playwright checks routes last-registered-first; a caller reads their list
 * top-down and expects the first pattern that matches to win. Reversing on the
 * way in is what reconciles the two, and is the only reason this is not just a
 * loop in the engine.
 */
export function installOrder<T>(mocks: readonly T[]): T[] {
  return [...mocks].reverse();
}

/**
 * The advice for a pattern that matched nothing, when the pattern itself looks
 * like the reason.
 *
 * Patterns are matched against the whole URL, so `/api/orders` matches nothing
 * on a page served from `http://localhost:3000` — by far the most common way
 * to write a mock that silently does nothing. A pattern that already starts
 * with a wildcard, or that is a full URL, is left alone: a wrong guess here is
 * worse than no guess.
 */
export function patternHint(pattern: string): string | undefined {
  if (pattern.startsWith("*") || pattern.includes("://")) return undefined;
  const path = pattern.startsWith("/") ? pattern : `/${pattern}`;
  const suggestion = `**${path}${path.endsWith("*") ? "" : "*"}`;
  return `patterns are matched against the whole URL, so a path needs a leading \`**\` — try \`${suggestion}\``;
}

/* ── The report ───────────────────────────────────────────────────────── */

/** What one mock did during a run. */
export interface MockActivity {
  mock: ResolvedMock;
  /** Requests this mock intercepted. */
  hits: number;
  /**
   * Requests it actually answered. Lower than `hits` when a delayed response
   * outlived the recording — the request was caught but the page never got a
   * reply, which is a finding rather than a bug in the count.
   */
  answered: number;
  /** The first few URLs it intercepted, for the report. */
  urls: string[];
}

/** A request no mock matched. */
export interface UnmatchedRequest {
  method: string;
  url: string;
  /** What the real server answered, when it was allowed to. */
  status?: number;
  /** Set when `block_unmatched` killed it before it left the browser. */
  blocked?: boolean;
}

export interface MockReportInput {
  activity: MockActivity[];
  unmatched: UnmatchedRequest[];
  block_unmatched: boolean;
  /** The recording length, so a delay that outlives it can be named. */
  duration_ms: number;
}

/**
 * The mock report, as lines for the capture summary.
 *
 * A mock that never matched leads, because it is the finding this tool exists
 * to surface: mock the products endpoint, watch the app call `/api/product-list`,
 * see a page that looks perfectly fine, and learn nothing at all. The same
 * reasoning puts the unmatched requests in — a run that quietly used the real
 * backend for half its data is not the test anybody thought they ran.
 */
export function formatMockReport(input: MockReportInput): string[] {
  const { activity, unmatched, block_unmatched, duration_ms } = input;
  const served = activity.filter((entry) => entry.hits > 0);
  const missed = activity.filter((entry) => entry.hits === 0);
  const requests = served.reduce((total, entry) => total + entry.hits, 0);

  const headline =
    `API mocks — ${activity.length} declared, ` +
    `${served.length} served ${count(requests, "request")}` +
    (missed.length > 0 ? `, ${missed.length} never matched.` : ".");
  const lines = [headline];

  for (const entry of activity) {
    lines.push(`  ${formatActivity(entry, duration_ms)}`);
  }

  if (unmatched.length > 0) {
    lines.push(
      block_unmatched
        ? "  Unmatched, blocked before they left the browser:"
        : "  Unmatched, answered by the real server:",
    );
    for (const request of unmatched.slice(0, MAX_UNMATCHED_LISTED)) {
      const outcome = request.blocked ? "" : request.status !== undefined ? ` → ${request.status}` : " → no response";
      lines.push(`    ${request.method} ${request.url}${outcome}`);
    }
    if (unmatched.length > MAX_UNMATCHED_LISTED) {
      lines.push(`    … and ${unmatched.length - MAX_UNMATCHED_LISTED} more`);
    }
  } else {
    lines.push("  Every request the page made was matched by a mock.");
  }

  return lines;
}

/** One mock's line in the report: the mark, the pattern, what it serves, and what it did. */
function formatActivity(entry: MockActivity, duration_ms: number): string {
  const { mock, hits, answered, urls } = entry;

  if (hits === 0) {
    const hint = patternHint(mock.url_pattern);
    return `✗ ${mock.url_pattern} — no request matched it${hint ? ` (${hint})` : ""}.`;
  }

  const late = mock.kind === "fulfill" && answered < hits && mock.delay_ms >= duration_ms;
  const mark = late ? "!" : "✓";
  let line = `${mark} ${mock.url_pattern} → ${describeMock(mock)} ×${hits}`;

  if (late && mock.kind === "fulfill") {
    line +=
      ` — delayed ${mock.delay_ms}ms, longer than the ${duration_ms}ms recording, ` +
      `so ${hits === 1 ? "the request" : `${hits - answered} of them`} never got an answer.`;
  } else if (urls.length > 0) {
    // Only a handful of URLs are ever kept, so the remainder is counted off the
    // hits — a mock that answered fifty polls must not report "and 1 more"
    // simply because three is all the sample it has.
    const listed = urls.slice(0, MAX_MOCK_URLS_LISTED);
    const more = hits > listed.length ? `, … and ${hits - listed.length} more` : "";
    line += ` (${listed.join(", ")}${more})`;
  }

  return line;
}

/**
 * What a mock serves, in a few words. Names the scenario when there was one —
 * "200 empty" says more than "200" and is what the caller wrote.
 */
export function describeMock(mock: ResolvedMock): string {
  const parts: string[] = [];

  if (mock.kind === "abort") {
    parts.push(`abort ${mock.reason}`);
  } else {
    parts.push(String(mock.status));
    if (mock.scenario !== undefined && mock.scenario !== "slow") parts.push(mock.scenario);
    if (mock.delay_ms > 0) parts.push(`after ${mock.delay_ms}ms`);
  }

  let text = parts.join(" ");
  if (mock.times !== undefined) {
    text += mock.times === 1 ? ", first request only" : `, first ${mock.times} requests only`;
  }
  return text;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
