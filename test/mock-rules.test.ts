import { describe, expect, it } from "vitest";
import { MOCK_SLOW_DELAY_MS } from "../src/constants.js";
import {
  describeMock,
  encodeBody,
  formatMockReport,
  installOrder,
  patternHint,
  resolveMock,
  type MockActivity,
  type ResolvedMock,
} from "../src/utils/mock-rules.js";

/** A fulfilling mock, narrowed so a test can read the fields that only it has. */
const fulfilled = (mock: ResolvedMock): Extract<ResolvedMock, { kind: "fulfill" }> => {
  if (mock.kind !== "fulfill") throw new Error(`expected a fulfilling mock, got ${mock.kind}`);
  return mock;
};

describe("resolveMock — the scenario shorthands", () => {
  it("serves `empty` as an empty array, so a list renders its empty state", () => {
    const mock = fulfilled(resolveMock({ url_pattern: "**/api/items*", scenario: "empty" }));
    expect(mock.status).toBe(200);
    expect(mock.body).toBe("[]");
    expect(mock.headers["content-type"]).toBe("application/json");
  });

  it("serves `error` as a 500 with a message the app can display", () => {
    const mock = fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "error" }));
    expect(mock.status).toBe(500);
    expect(JSON.parse(mock.body)).toEqual({ error: "Internal server error" });
  });

  it("serves `unauthorized` as a 401", () => {
    expect(fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "unauthorized" })).status).toBe(401);
  });

  it("serves `not_found` as a 404", () => {
    expect(fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "not_found" })).status).toBe(404);
  });

  it("gives `slow` a delay and nothing else", () => {
    const mock = fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "slow" }));
    expect(mock.delay_ms).toBe(MOCK_SLOW_DELAY_MS);
    expect(mock.status).toBe(200);
  });

  it("serves `malformed` as text that is not JSON, under a JSON content type", () => {
    const mock = fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "malformed" }));
    expect(mock.body).toBe("not json");
    expect(mock.headers["content-type"]).toBe("application/json");
    expect(() => JSON.parse(mock.body)).toThrow();
  });

  it("makes `offline` abort the request rather than answer it", () => {
    const mock = resolveMock({ url_pattern: "**/api/*", scenario: "offline" });
    expect(mock.kind).toBe("abort");
    expect(mock.kind === "abort" && mock.reason).toBe("failed");
  });
});

describe("resolveMock — an explicit response overrides the scenario field by field", () => {
  it("keeps the scenario's delay while taking the caller's body", () => {
    const mock = fulfilled(
      resolveMock({ url_pattern: "**/api/*", scenario: "slow", response: { body: { items: [1, 2] } } }),
    );
    expect(mock.delay_ms).toBe(MOCK_SLOW_DELAY_MS);
    expect(JSON.parse(mock.body)).toEqual({ items: [1, 2] });
  });

  it("keeps the scenario's body while taking the caller's status", () => {
    const mock = fulfilled(resolveMock({ url_pattern: "**/api/*", scenario: "error", response: { status: 503 } }));
    expect(mock.status).toBe(503);
    expect(JSON.parse(mock.body)).toEqual({ error: "Internal server error" });
  });

  it("lets an explicit abort beat a scenario that would have answered", () => {
    const mock = resolveMock({ url_pattern: "**/api/*", scenario: "empty", abort: "timedout" });
    expect(mock.kind === "abort" && mock.reason).toBe("timedout");
  });

  it("lets the caller's own content-type beat the one the body implies", () => {
    const mock = fulfilled(
      resolveMock({
        url_pattern: "**/page",
        response: { body: "<p>hi</p>", headers: { "Content-Type": "text/html" } },
      }),
    );
    expect(mock.headers["content-type"]).toBe("text/html");
    expect(mock.body).toBe("<p>hi</p>");
  });

  it("carries `times` through, so a mock can stop applying after the first request", () => {
    expect(resolveMock({ url_pattern: "**/api/*", scenario: "error", times: 1 }).times).toBe(1);
  });

  it("defaults a bare response with no status to 200", () => {
    expect(fulfilled(resolveMock({ url_pattern: "**/api/*", response: { body: { ok: true } } })).status).toBe(200);
  });
});

describe("encodeBody", () => {
  it("turns an object into JSON", () => {
    expect(encodeBody({ items: [] })).toEqual({ body: '{"items":[]}', content_type: "application/json" });
  });

  it("turns an array into JSON", () => {
    expect(encodeBody([1, 2]).body).toBe("[1,2]");
  });

  it("sends a string verbatim, so a malformed body stays malformed", () => {
    // The whole point of the malformed scenario: JSON.stringify would turn
    // `not json` into `"not json"`, which parses perfectly.
    expect(encodeBody("not json").body).toBe("not json");
  });

  it("sends a string as JSON, because these stand in for API responses", () => {
    expect(encodeBody("not json").content_type).toBe("application/json");
  });

  it("gives an absent body no content type at all", () => {
    expect(encodeBody(undefined)).toEqual({ body: "" });
  });

  it("encodes null as JSON rather than treating it as absent", () => {
    expect(encodeBody(null)).toEqual({ body: "null", content_type: "application/json" });
  });
});

describe("installOrder", () => {
  it("reverses, so the first mock the caller wrote is the one that matches first", () => {
    // Playwright checks routes last-registered-first; the caller reads their
    // list top-down. Registering in reverse is what reconciles the two.
    expect(installOrder(["a", "b", "c"])).toEqual(["c", "b", "a"]);
  });

  it("does not disturb the caller's array", () => {
    const mocks = ["a", "b"];
    installOrder(mocks);
    expect(mocks).toEqual(["a", "b"]);
  });
});

describe("patternHint", () => {
  it("explains the leading `**` for a bare path, which is the usual mistake", () => {
    const hint = patternHint("/api/products");
    expect(hint).toContain("whole URL");
    expect(hint).toContain("**/api/products*");
  });

  it("says nothing about a pattern that already starts with a wildcard", () => {
    expect(patternHint("**/api/products*")).toBeUndefined();
  });

  it("says nothing about a full URL, which is a legitimate pattern", () => {
    expect(patternHint("http://localhost:3000/api/products")).toBeUndefined();
  });

  it("explains the wildcard for a bare path with no scheme and no slash", () => {
    expect(patternHint("api/products")).toContain("**/api/products*");
  });
});

/* ── The report ───────────────────────────────────────────────────────── */

const activity = (
  pattern: string,
  hits: number,
  overrides: Partial<MockActivity> = {},
  spec: Parameters<typeof resolveMock>[0] = {},
): MockActivity => ({
  mock: resolveMock({ url_pattern: pattern, scenario: "empty", ...spec }),
  hits,
  answered: hits,
  urls: [],
  ...overrides,
});

describe("formatMockReport", () => {
  it("leads with what every mock did, including the ones that did nothing", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/products*", 3), activity("**/api/orders*", 0)],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    });
    expect(lines[0]).toBe("API mocks — 2 declared, 1 served 3 requests, 1 never matched.");
  });

  it("marks a mock that never matched, because that is the finding", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/orders*", 0)],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("✗ **/api/orders* — no request matched it");
  });

  it("adds the whole-URL hint when the pattern that missed was a bare path", () => {
    const lines = formatMockReport({
      activity: [activity("/api/orders", 0)],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("**/api/orders*");
  });

  it("reports how many requests each live mock answered", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/products*", 3)],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("✓ **/api/products* → 200 empty ×3");
  });

  it("counts the requests it did not name against the hits, not against the sample it kept", () => {
    // Only a few URLs are ever stored, so a mock hit fifty times must not
    // report "and 1 more" just because that is all the sample it has.
    const lines = formatMockReport({
      activity: [activity("**/api/poll*", 50, { urls: ["/api/poll?1", "/api/poll?2", "/api/poll?3"] })],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("… and 47 more");
  });

  it("names the requests that no mock matched, so a half-mocked run is visible", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/products*", 1)],
      unmatched: [
        { method: "GET", url: "http://app/api/session", status: 200 },
        { method: "GET", url: "http://app/main.css", status: 200 },
      ],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("Unmatched, answered by the real server:");
    expect(lines).toContain("GET http://app/api/session → 200");
  });

  it("says so out loud when nothing went unmocked", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/products*", 1)],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("Every request the page made was matched by a mock.");
  });

  it("reports blocked requests as blocked, not as answered", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/products*", 1)],
      unmatched: [{ method: "GET", url: "http://app/api/session", blocked: true }],
      block_unmatched: true,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("Unmatched, blocked before they left the browser:");
    expect(lines).toContain("GET http://app/api/session");
  });

  it("calls out a response the recording ended before it could arrive", () => {
    const lines = formatMockReport({
      activity: [
        activity("**/api/slow*", 1, { answered: 0 }, { scenario: "slow", response: { delay_ms: 9000 } }),
      ],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    }).join("\n");
    expect(lines).toContain("! **/api/slow*");
    expect(lines).toContain("delayed 9000ms, longer than the 5000ms recording");
  });

  it("counts a matched-but-unanswered mock as served, not as never matched", () => {
    const lines = formatMockReport({
      activity: [activity("**/api/slow*", 1, { answered: 0 }, { scenario: "slow", response: { delay_ms: 9000 } })],
      unmatched: [],
      block_unmatched: false,
      duration_ms: 5000,
    });
    expect(lines[0]).toContain("1 served 1 request");
    expect(lines[0]).not.toContain("never matched");
  });
});

describe("describeMock", () => {
  it("describes a fulfilling mock by its status and scenario", () => {
    expect(describeMock(resolveMock({ url_pattern: "**/a", scenario: "empty" }))).toBe("200 empty");
  });

  it("describes an aborting mock by what the browser will report", () => {
    expect(describeMock(resolveMock({ url_pattern: "**/a", abort: "connectionrefused" }))).toBe(
      "abort connectionrefused",
    );
  });

  it("mentions a delay, since it changes what the recording will show", () => {
    expect(describeMock(resolveMock({ url_pattern: "**/a", response: { status: 200, delay_ms: 800 } }))).toBe(
      "200 after 800ms",
    );
  });

  it("mentions `times`, since it explains why later requests behaved differently", () => {
    expect(describeMock(resolveMock({ url_pattern: "**/a", scenario: "error", times: 1 }))).toBe(
      "500 error, first request only",
    );
  });
});
