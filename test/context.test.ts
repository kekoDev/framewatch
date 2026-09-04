import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import { ConsoleCollector, NetworkCollector, PerformanceCollector } from "../src/engine/layers/index.js";
import { capturePage, captureInputSchema } from "../src/tools/capture.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * Browser-backed tests for the four context layers, driven through
 * `framewatch_capture` — the only place they are wired up. The pure mapping and
 * bucketing logic is unit-tested in layers.test.ts.
 */

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type Result = Awaited<ReturnType<typeof capturePage>>;
type TextBlock = { type: "text"; text: string };

const VIEWPORT = { width: 400, height: 300 };

function textBlocks(result: Result): string[] {
  return result.content.filter((c): c is TextBlock => c.type === "text").map((c) => c.text);
}

/** The summary block (everything before the first card). */
function summary(result: Result): string {
  return textBlocks(result)[0];
}

/** The per-card metadata blocks, in card order. */
function cardTexts(result: Result): string[] {
  return textBlocks(result).slice(1);
}

/** Every line of a named section, across all cards, with its "  " indent stripped. */
function sectionLines(result: Result, header: string): string[] {
  const lines: string[] = [];
  for (const text of cardTexts(result)) {
    let inside = false;
    for (const line of text.split("\n")) {
      if (line === `${header}:` || line.startsWith(`${header}:`)) {
        inside = true;
        continue;
      }
      if (!line.startsWith("  ")) {
        inside = false;
        continue;
      }
      if (inside) lines.push(line.slice(2));
    }
  }
  return lines;
}

describe("console layer", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({ url: `${fixtures.url}/console.html`, duration_ms: 1800, viewport: VIEWPORT });
  });

  it("is on by default and reports every level the page used", () => {
    expect(result.isError).toBeFalsy();
    const lines = sectionLines(result, "Console");
    expect(lines).toContain("[log] fixture log line");
    expect(lines).toContain("[info] fixture info line");
    expect(lines).toContain("[warn] fixture warn line");
    expect(lines).toContain("[error] fixture error line");
  });

  it("reports an uncaught exception and an unhandled rejection, with the frame they came from", () => {
    const errors = sectionLines(result, "Console").filter((line) => line.startsWith("[error]"));
    const uncaught = errors.find((line) => line.includes("fixture uncaught boom"));
    const rejected = errors.find((line) => line.includes("fixture unhandled rejection"));
    expect(uncaught, errors.join("\n")).toBeDefined();
    expect(rejected, errors.join("\n")).toBeDefined();
    // Neither is a console API call: both only reach us through `pageerror`.
    expect(uncaught).toMatch(/^\[error\] Error: fixture uncaught boom \(at .*console\.html:\d+:\d+\)$/);
  });

  it("flattens objects and multi-line text onto a single line each", () => {
    const lines = sectionLines(result, "Console");
    expect(lines.some((line) => line.startsWith("[log] {shape:"))).toBe(true);
    expect(lines).toContain("[log] first line ↵ second line");
    for (const line of lines) expect(line).not.toContain("\n");
  });

  it("attaches each entry to the frame whose window it fell in, in page order", () => {
    // The fixture logs at 0ms, 300ms, 700ms, 1000ms, 1100ms and 1300ms; whatever
    // frames are kept, the entries must stay in order and never repeat.
    const lines = sectionLines(result, "Console");
    const order = ["fixture log line", "fixture warn line", "fixture error line", "fixture uncaught boom"];
    const positions = order.map((needle) => lines.findIndex((line) => line.includes(needle)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions]).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("tallies the layer in the summary", () => {
    expect(summary(result)).toMatch(/Context — console: \d+ entries/);
  });

  it("can be turned off, leaving no Console section and no console tally", async () => {
    const off = await capturePage({
      url: `${fixtures.url}/console.html`,
      duration_ms: 900,
      viewport: VIEWPORT,
      include_console: false,
    });
    expect(off.isError).toBeFalsy();
    expect(cardTexts(off).some((text) => text.includes("Console:"))).toBe(false);
    expect(summary(off)).not.toContain("console:");
  });

  it("says so plainly when a page logs nothing at all", async () => {
    const quiet = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 600, viewport: VIEWPORT });
    expect(quiet.isError).toBeFalsy();
    expect(summary(quiet)).toContain("console: silent");
    expect(cardTexts(quiet).some((text) => text.includes("Console:"))).toBe(false);
  });
});

describe("network layer", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({
      url: `${fixtures.url}/network.html`,
      duration_ms: 1600,
      viewport: VIEWPORT,
      include_network: true,
      include_console: false,
    });
  });

  it("reports the document request and each fetch with its status", () => {
    expect(result.isError).toBeFalsy();
    const lines = sectionLines(result, "Network");
    expect(lines.some((line) => /^GET \S+network\.html → 200 \(\d+ms\)$/.test(line))).toBe(true);
    expect(lines.some((line) => /^GET \S+\/api\/ok → 200 \(\d+ms\)$/.test(line))).toBe(true);
    expect(lines.some((line) => /^GET \S+\/api\/missing → 404 \(\d+ms\)$/.test(line))).toBe(true);
  });

  it("reports a request that never came back rather than dropping it", () => {
    const lines = sectionLines(result, "Network");
    const pending = lines.find((line) => line.includes("/api/pending"));
    expect(pending, lines.join("\n")).toMatch(/^GET \S+\/api\/pending → pending \(\d+ms\)$/);
    expect(summary(result)).toContain("(1 still pending)");
  });

  it("counts only settled requests in the tally", () => {
    expect(summary(result)).toMatch(/network: 3 requests \(1 still pending\)/);
  });

  it("is off by default", async () => {
    const off = await capturePage({ url: `${fixtures.url}/network.html`, duration_ms: 800, viewport: VIEWPORT });
    expect(off.isError).toBeFalsy();
    expect(cardTexts(off).some((text) => text.includes("Network:"))).toBe(false);
    expect(summary(off)).not.toContain("network:");
  });

  it("names the network error for a request that could not be made at all", async () => {
    const dead = await startFixtureServer();
    const port = new URL(dead.url).port;
    await dead.close();

    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 1200,
      viewport: VIEWPORT,
      include_network: true,
      include_console: false,
      interactions: [{ action: "navigate", value: `http://127.0.0.1:${port}/gone`, delay_ms: 300 }],
    });

    expect(result.isError).toBeFalsy();
    const failed = sectionLines(result, "Network").find((line) => line.includes(":" + port));
    expect(failed, textBlocks(result).join("\n")).toMatch(/→ net::ERR_/);
  });
});

describe("DOM layer", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({
      url: `${fixtures.url}/dom.html`,
      duration_ms: 1800,
      viewport: VIEWPORT,
      include_dom: true,
      include_console: false,
    });
  });

  it("names the element behind each structural change", () => {
    expect(result.isError).toBeFalsy();
    const lines = sectionLines(result, "DOM");
    expect(lines).toContain("+ div.modal in div#app");
    expect(lines).toContain("- div.spinner from div#app");
  });

  it("collapses an inline-style animation into one counted line", () => {
    const styled = sectionLines(result, "DOM").find((line) => line.startsWith("~ div#app [style]"));
    expect(styled, sectionLines(result, "DOM").join("\n")).toMatch(/^~ div#app \[style\] ×\d+$/);
  });

  it("reports a text edit as a change to the containing element", () => {
    expect(sectionLines(result, "DOM").some((line) => line.startsWith("~ text in p#label"))).toBe(true);
  });

  it("ignores head content and script source, which say nothing about what the page looks like", () => {
    const lines = sectionLines(result, "DOM");
    for (const line of lines) {
      expect(line).not.toContain("script");
      expect(line).not.toContain("head");
      expect(line).not.toContain("style in");
    }
  });

  it("is off by default", async () => {
    const off = await capturePage({ url: `${fixtures.url}/dom.html`, duration_ms: 800, viewport: VIEWPORT });
    expect(off.isError).toBeFalsy();
    expect(cardTexts(off).some((text) => text.includes("DOM:"))).toBe(false);
  });

  it("keeps observing after the document is replaced by a navigation", async () => {
    const navigated = await capturePage({
      url: `${fixtures.url}/redirect.html`,
      duration_ms: 1400,
      viewport: VIEWPORT,
      include_dom: true,
      include_console: false,
    });
    expect(navigated.isError).toBeFalsy();
    // recorder-target.html is a fresh document: its body arriving is the proof
    // the probe was reinstalled rather than lost with the old page.
    const afterNav = cardTexts(navigated)
      .filter((text) => /\[navigation\]/.test(text) || text.includes("recorder-target"))
      .join("\n");
    const lines = sectionLines(navigated, "DOM");
    expect(lines.filter((line) => line === "+ body in html").length, afterNav).toBeGreaterThanOrEqual(2);
  });
});

describe("performance layer", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({
      url: `${fixtures.url}/perf.html`,
      duration_ms: 1500,
      viewport: VIEWPORT,
      include_performance: true,
      include_console: false,
    });
  });

  it("reports first paint and largest contentful paint as ms since navigation start", () => {
    expect(result.isError).toBeFalsy();
    const lines = sectionLines(result, "Performance");
    const paint = lines.find((line) => line.startsWith("paint "));
    const lcp = lines.find((line) => line.startsWith("lcp "));
    expect(paint, lines.join("\n")).toMatch(/^paint \d+ms$/);
    expect(lcp, lines.join("\n")).toMatch(/^lcp \d+ms$/);
    // Both are document-relative, so a 1.5s recording cannot produce a 10s paint.
    expect(Number(/(\d+)/.exec(paint!)![1])).toBeLessThan(5000);
  });

  it("counts the layout shift the fixture causes and scores it", () => {
    const shifts = sectionLines(result, "Performance").find((line) => line.startsWith("layout shifts "));
    expect(shifts, sectionLines(result, "Performance").join("\n")).toMatch(/^layout shifts [1-9]\d* \(score 0\.\d+\)$/);
  });

  it("reports each measurement once, on the frame it happened at", () => {
    const lines = sectionLines(result, "Performance");
    expect(lines.filter((line) => line.startsWith("lcp "))).toHaveLength(1);
    // First paint and first contentful paint are simultaneous here, so they
    // normally reduce to one line; a frame boundary between them makes two.
    expect(lines.filter((line) => line.startsWith("paint ")).length).toBeLessThanOrEqual(2);
    // Cards with nothing measured carry no Performance section at all.
    expect(cardTexts(result).filter((text) => text.includes("Performance:")).length).toBeLessThan(cardTexts(result).length);
  });

  it("is off by default", async () => {
    const off = await capturePage({ url: `${fixtures.url}/perf.html`, duration_ms: 800, viewport: VIEWPORT });
    expect(off.isError).toBeFalsy();
    expect(cardTexts(off).some((text) => text.includes("Performance:"))).toBe(false);
  });

  it("stamps entries with when the browser recorded them, not when the observer saw them", async () => {
    const samples = await withPage({ viewport: VIEWPORT }, async (page) => {
      const collector = await new PerformanceCollector(page).attach();
      const origin = Date.now();
      await page.goto(`${fixtures.url}/perf.html`, { waitUntil: "commit" });
      // Long enough for the paint (~immediate) and the layout shift (600ms) to
      // be observed at very different moments.
      await page.waitForTimeout(1200);
      return collector.samples(origin);
    });

    const paint = samples.find((sample) => sample.kind === "paint");
    const shift = samples.find((sample) => sample.kind === "shift");
    expect(paint, JSON.stringify(samples)).toBeDefined();
    expect(shift, JSON.stringify(samples)).toBeDefined();
    // The two are measured hundreds of ms apart, so their observer callbacks
    // ran at very different times.
    expect(shift!.start_ms - paint!.start_ms).toBeGreaterThan(300);

    // Every timestamp is `timeOrigin + startTime` rebased on one origin, so
    // `timestamp_ms - start_ms` is the *same* constant for every entry however
    // long after the fact its callback ran — only rounding separates them.
    // Reading the clock at observation time instead makes each entry drift by
    // its own callback latency.
    const offsets = samples.map((sample) => sample.timestamp_ms - sample.start_ms);
    expect(Math.max(...offsets) - Math.min(...offsets), JSON.stringify(samples)).toBeLessThanOrEqual(1);
  });
});

describe("all four layers together", () => {
  it("attaches every layer to the same capture and tallies them all", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/network.html`,
      duration_ms: 1400,
      viewport: VIEWPORT,
      include_console: true,
      include_network: true,
      include_dom: true,
      include_performance: true,
    });

    expect(result.isError).toBeFalsy();
    const line = summary(result);
    expect(line).toMatch(/Context — .*console: /);
    expect(line).toMatch(/network: /);
    expect(line).toMatch(/DOM: /);
    expect(line).toMatch(/performance: /);
    expect(sectionLines(result, "Network").length).toBeGreaterThan(0);
    expect(sectionLines(result, "DOM").length).toBeGreaterThan(0);
  });

  it("keeps the sections in their documented order on a single card", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/console.html`,
      duration_ms: 1200,
      viewport: VIEWPORT,
      include_console: true,
      include_network: true,
      include_dom: true,
    });

    const card = cardTexts(result).find((text) => text.includes("Console:") && text.includes("Network:"));
    expect(card, cardTexts(result).join("\n===\n")).toBeDefined();
    const at = (header: string): number => card!.indexOf(`${header}:`);
    expect(at("Console")).toBeLessThan(at("Network"));
    if (at("DOM") >= 0) expect(at("Network")).toBeLessThan(at("DOM"));
  });

  it("adds no context at all when every layer is off", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/console.html`,
      duration_ms: 700,
      viewport: VIEWPORT,
      include_console: false,
    });
    expect(result.isError).toBeFalsy();
    expect(summary(result)).not.toContain("Context —");
  });
});

describe("layer collection under load", () => {
  it("keeps errors and drops noise once the console cap is reached", async () => {
    const kept = await withPage({ viewport: VIEWPORT }, async (page) => {
      const collector = new ConsoleCollector(page, 3).attach();
      await page.goto(`${fixtures.url}/basic.html`, { waitUntil: "load" });
      await page.evaluate(() => {
        for (let i = 0; i < 50; i++) console.log("noise " + i);
        console.error("the error that matters");
        for (let i = 0; i < 50; i++) console.log("more noise " + i);
      });
      await page.waitForTimeout(100);
      collector.detach();
      return { entries: collector.entries(Date.now()), dropped: collector.dropped };
    });

    expect(kept.entries).toHaveLength(3);
    expect(kept.entries.some((entry) => entry.text === "the error that matters")).toBe(true);
    expect(kept.dropped).toBeGreaterThan(90);
  });

  it("keeps failures over successes once the network cap is reached", async () => {
    const kept = await withPage({ viewport: VIEWPORT }, async (page) => {
      const collector = new NetworkCollector(page, 3).attach();
      await page.goto(`${fixtures.url}/basic.html`, { waitUntil: "load" });
      await page.evaluate(async (base) => {
        const gets: Promise<unknown>[] = [];
        for (let i = 0; i < 12; i++) gets.push(fetch(`${base}/api/ok?i=${i}`).catch(() => null));
        gets.push(fetch(`${base}/api/missing`).catch(() => null));
        await Promise.all(gets);
      }, fixtures.url);
      await page.waitForTimeout(200);
      collector.detach();
      return { events: collector.events(Date.now()), dropped: collector.dropped };
    });

    expect(kept.events).toHaveLength(3);
    expect(kept.events.some((event) => event.status === 404)).toBe(true);
    expect(kept.dropped).toBeGreaterThan(5);
  });

  it("elides a huge log line at collection time rather than holding it in memory", async () => {
    const entries = await withPage({ viewport: VIEWPORT }, async (page) => {
      const collector = new ConsoleCollector(page).attach();
      await page.goto(`${fixtures.url}/basic.html`, { waitUntil: "load" });
      await page.evaluate(() => console.log("x".repeat(200_000)));
      await page.waitForTimeout(100);
      collector.detach();
      return collector.entries(Date.now());
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].text.length).toBeLessThan(400);
    expect(entries[0].text).toContain("(200000 chars)");
  });

  it("bounds requests that never settle, which do not pass through the event cap", async () => {
    const collected = await withPage({ viewport: VIEWPORT }, async (page) => {
      const collector = new NetworkCollector(page, 2).attach();
      await page.goto(`${fixtures.url}/basic.html`, { waitUntil: "load" });
      await page.evaluate((base) => {
        for (let i = 0; i < 8; i++) void fetch(`${base}/api/pending?i=${i}`);
      }, fixtures.url);
      await page.waitForTimeout(300);
      const events = collector.events(Date.now());
      return { events, pending: collector.pending, dropped: collector.dropped };
    });

    expect(collected.pending).toBeGreaterThanOrEqual(6);
    expect(collected.events.filter((event) => event.error === "pending").length).toBeLessThanOrEqual(2);
    expect(collected.dropped).toBeGreaterThan(0);
  });

  it("survives a page that freezes its main thread, reporting what it said before", async () => {
    const started = Date.now();
    const result = await capturePage({
      url: `${fixtures.url}/busy.html`,
      duration_ms: 1500,
      viewport: VIEWPORT,
      include_console: true,
      include_network: true,
      include_dom: true,
      include_performance: true,
    });
    // The fixture blocks its main thread for 10s; the layers must not wait for it.
    expect(Date.now() - started).toBeLessThan(9000);
    expect(result.isError).toBeFalsy();
    expect(summary(result)).toContain("Context —");
  }, 40_000);
});

describe("captureInputSchema context flags", () => {
  it("defaults console on and the other three off", () => {
    const parsed = captureInputSchema.parse({ url: "http://localhost:3000/" });
    expect(parsed.include_console).toBe(true);
    expect(parsed.include_network).toBe(false);
    expect(parsed.include_dom).toBe(false);
    expect(parsed.include_performance).toBe(false);
  });

  it("rejects a non-boolean flag rather than coercing it", () => {
    const parse = (extra: Record<string, unknown>) =>
      captureInputSchema.safeParse({ url: "http://localhost/", ...extra }).success;
    expect(parse({ include_dom: "yes" })).toBe(false);
    expect(parse({ include_network: 1 })).toBe(false);
    expect(parse({ include_performance: true })).toBe(true);
  });
});
