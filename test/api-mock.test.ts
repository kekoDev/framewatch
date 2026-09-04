import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { mockApi } from "../src/tools/api-mock.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type Block = { type: string; data?: string; text?: string };
type Result = Awaited<ReturnType<typeof mockApi>>;

const text = (result: Result): string =>
  (result.content as Block[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
const images = (result: Result): Block[] => (result.content as Block[]).filter((block) => block.type === "image");
/** The summary block: the capture line, the mock report, then the context tally. */
const summary = (result: Result): string => ((result.content as Block[])[0]?.text ?? "");
const url = (file: string): string => `${fixtures.url}/${file}`;

describe("mockApi — the scenarios a page is never shown in development", () => {
  it("renders the empty state when the list comes back empty", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", scenario: "empty" }],
      duration_ms: 1500,
    });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("products: empty");
    expect(images(result).length).toBeGreaterThan(0);
  });

  it("renders the error state when the API 500s", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", scenario: "error" }],
      duration_ms: 1500,
    });

    expect(text(result)).toContain("products: error HTTP 500");
  });

  it("renders whatever the caller's own body says", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [
        {
          url_pattern: "**/api/products*",
          response: { body: { items: [{ name: "Mocked A" }, { name: "Mocked B" }] } },
        },
      ],
      duration_ms: 1500,
    });

    expect(text(result)).toContain("products: ready 2");
  });

  it("makes a body that is not JSON break the page the way a broken API would", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", scenario: "malformed" }],
      duration_ms: 1500,
    });

    // The page called res.json() and it threw — a SyntaxError, not an HTTP error.
    expect(text(result)).toContain("products: error SyntaxError");
  });

  it("makes the request fail outright when the scenario is offline", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", scenario: "offline" }],
      duration_ms: 1500,
    });

    expect(text(result)).toContain("products: error TypeError");
    expect(text(result)).toContain("abort failed");
  });

  it("holds a delayed response back, so the waiting state is on film", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", response: { body: [{ name: "Late" }], delay_ms: 900 } }],
      duration_ms: 2500,
    });

    const report = text(result);
    expect(report).toContain("products: loading");
    expect(report).toContain("products: ready 1");
    // The loading screen and the loaded screen are different colours: both are
    // kept, so there is more than one card.
    expect(images(result).length).toBeGreaterThan(1);
  });
});

describe("mockApi — a mock that never matched", () => {
  it("says so, because a page that looks fine proves nothing", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/orders*", scenario: "empty" }],
      duration_ms: 1500,
    });

    expect(text(result)).toContain("✗ **/api/orders* — no request matched it");
    // The real endpoint answered instead, which is the other half of the story.
    expect(text(result)).toContain("products: ready 3");
  });

  it("explains the missing `**` when the pattern was written as a bare path", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "/api/products", scenario: "empty" }],
      duration_ms: 1500,
    });

    const report = text(result);
    expect(report).toContain("no request matched it");
    expect(report).toContain("**/api/products*");
  });
});

describe("mockApi — requests no mock matched", () => {
  it("names the ones the real server answered", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/orders*", scenario: "empty" }],
      duration_ms: 1500,
    });

    const report = text(result);
    expect(report).toContain("Unmatched, answered by the real server:");
    expect(report).toMatch(/GET \S+\/api\/products → 200/);
  });

  it("never counts the page's own navigation as unmatched traffic", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/orders*", scenario: "empty" }],
      duration_ms: 1500,
    });

    // The network layer still shows the navigation, and should — it is the
    // unmatched tally that must not claim the page fetched itself.
    expect(summary(result)).toContain("Unmatched, answered by the real server:");
    expect(summary(result)).not.toContain("api-mock.html →");
  });

  it("says so out loud when there were none", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/*", scenario: "empty" }],
      duration_ms: 1500,
    });

    expect(text(result)).toContain("Every request the page made was matched by a mock.");
  });

  it("leaves the page itself alone even when a pattern matches everything", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/*", scenario: "empty" }],
      duration_ms: 1500,
    });

    // If the document had been mocked the page would be `[]`, not the app.
    expect(text(result)).toContain("products: empty");
  });

  it("blocks them instead when asked to, so the page runs with no backend at all", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/orders*", scenario: "empty" }],
      block_unmatched: true,
      duration_ms: 1500,
    });

    const report = text(result);
    expect(report).toContain("Unmatched, blocked before they left the browser:");
    expect(report).toContain("products: error TypeError");
  });
});

describe("mockApi — which mock wins", () => {
  it("gives the request to the first matching mock the caller wrote", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [
        { url_pattern: "**/api/products*", scenario: "empty" },
        { url_pattern: "**/api/products*", scenario: "error" },
      ],
      duration_ms: 1500,
    });

    const report = text(result);
    expect(report).toContain("products: empty");
    expect(report).toContain("✓ **/api/products* → 200 empty ×1");
    expect(report).toContain("✗ **/api/products* — no request matched it");
  });

  it("lets a `times` mock expire and the next one take over", async () => {
    const result = await mockApi({
      url: url("api-mock-flow.html"),
      mocks: [{ url_pattern: "**/api/products*", scenario: "error", times: 1 }],
      interactions: [
        { action: "click", selector: "#load", delay_ms: 300 },
        { action: "click", selector: "#load", delay_ms: 600 },
      ],
      duration_ms: 3000,
    });

    const report = text(result);
    expect(report).toContain("page 1: failed HTTP 500");
    // The second click fell through to the real server.
    expect(report).toContain("page 2: ok 3");
    expect(report).toContain("first request only");
  });
});

describe("mockApi — a response the recording never sees", () => {
  it("says the delay outlived the recording rather than leaving a blank page unexplained", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/products*", response: { body: [], delay_ms: 9000 } }],
      duration_ms: 1500,
    });

    const report = text(result);
    expect(report).toContain("! **/api/products*");
    expect(report).toContain("longer than the 1500ms recording");
    expect(report).toContain("products: loading");
    expect(report).not.toContain("products: empty");
  });
});

describe("mockApi — invalid input", () => {
  it("rejects a call with no mocks in it", async () => {
    const result = await mockApi({ url: url("api-mock.html"), mocks: [] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid input");
  });

  it("rejects a mock with no pattern to match on", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ scenario: "empty" } as never],
    });
    expect(result.isError).toBe(true);
  });

  it("rejects a body too large to send", async () => {
    const result = await mockApi({
      url: url("api-mock.html"),
      mocks: [{ url_pattern: "**/api/*", response: { body: "x".repeat(2_000_001) } }],
      duration_ms: 1500,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("too large");
  });

  it("reports an unreachable page rather than throwing", async () => {
    const result = await mockApi({
      url: "http://127.0.0.1:1/nothing-here",
      mocks: [{ url_pattern: "**/api/*", scenario: "empty" }],
      duration_ms: 1500,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("failed");
  });
});
