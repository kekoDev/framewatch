import { describe, expect, it } from "vitest";
import {
  applyContext,
  describePageError,
  normaliseText,
  renderDomChanges,
  shortenUrl,
  summarisePerformance,
  toConsoleLevel,
  type CapturedContext,
  type DomRecord,
  type PerfSample,
} from "../src/engine/layers/index.js";
import { summariseContext } from "../src/tools/capture.js";
import type { DiffCard } from "../src/types.js";

/**
 * Unit tests for the pure half of the context layers: the mapping, wording and
 * bucketing decisions. The browser-backed half is in context.test.ts.
 */

describe("toConsoleLevel", () => {
  it("maps Chromium's console types onto the four reported levels", () => {
    expect(toConsoleLevel("error")).toBe("error");
    expect(toConsoleLevel("assert")).toBe("error");
    expect(toConsoleLevel("warning")).toBe("warn");
    expect(toConsoleLevel("info")).toBe("info");
    expect(toConsoleLevel("count")).toBe("info");
    expect(toConsoleLevel("timeEnd")).toBe("info");
    expect(toConsoleLevel("log")).toBe("log");
    expect(toConsoleLevel("debug")).toBe("log");
    expect(toConsoleLevel("table")).toBe("log");
    expect(toConsoleLevel("dir")).toBe("log");
    expect(toConsoleLevel("trace")).toBe("log");
  });

  it("falls back to 'log' for a type it has never heard of", () => {
    expect(toConsoleLevel("startGroupCollapsed")).toBe("log");
    expect(toConsoleLevel("")).toBe("log");
  });
});

describe("normaliseText", () => {
  it("flattens newlines so one entry can never look like two", () => {
    expect(normaliseText("first\nsecond")).toBe("first ↵ second");
    expect(normaliseText("Error: x\n    at foo (a.js:1:1)")).toBe("Error: x ↵ at foo (a.js:1:1)");
    expect(normaliseText("  padded  ")).toBe("padded");
  });

  it("elides an over-long entry and says how long it really was", () => {
    const text = normaliseText("x".repeat(500), 20);
    expect(text.startsWith("x".repeat(20))).toBe(true);
    expect(text).toContain("(500 chars)");
    expect(text).not.toContain("\n");
  });

  it("leaves text within the limit exactly as it is", () => {
    expect(normaliseText("short enough", 20)).toBe("short enough");
  });
});

describe("describePageError", () => {
  it("names the error and the frame it came from", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at handler (http://localhost:3000/app.js:12:5)\n    at other (x.js:1:1)";
    expect(describePageError(error)).toBe("Error: boom (at handler (http://localhost:3000/app.js:12:5))");
  });

  it("falls back to the message alone when there is no usable stack", () => {
    const error = new TypeError("nope");
    error.stack = "TypeError: nope";
    expect(describePageError(error)).toBe("TypeError: nope");
  });

  it("still says something for an error with no message", () => {
    const error = new Error("");
    error.stack = "";
    expect(describePageError(error)).toBe("Error");
  });
});

describe("shortenUrl", () => {
  it("leaves a normal url untouched", () => {
    expect(shortenUrl("http://localhost:3000/api/login")).toBe("http://localhost:3000/api/login");
  });

  it("keeps both ends of a long url, so the host and the identifying tail both survive", () => {
    const url = `http://localhost:3000/api/items?${"k=v&".repeat(80)}id=42`;
    const short = shortenUrl(url, 60);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short.startsWith("http://localhost:3000/api/items?")).toBe(true);
    expect(short.endsWith("id=42")).toBe(true);
    expect(short).toContain("…");
  });

  it("collapses a data: URI to its media type and a size", () => {
    const short = shortenUrl(`data:image/png;base64,${"A".repeat(5000)}`);
    expect(short.startsWith("data:image/png;base64,")).toBe(true);
    expect(short).toContain("chars)");
    expect(short.length).toBeLessThan(80);
  });
});

describe("renderDomChanges", () => {
  const record = (overrides: Partial<DomRecord>): DomRecord => ({ timestamp_ms: 0, op: "+", target: "div", ...overrides });

  it("returns undefined when there is nothing to report", () => {
    expect(renderDomChanges([])).toBeUndefined();
  });

  it("describes each kind of mutation in its own shape", () => {
    const text = renderDomChanges([
      record({ op: "+", target: "div.modal", parent: "div#app" }),
      record({ op: "-", target: "span.spinner", parent: "div#app" }),
      record({ op: "~", target: "div#app", detail: "class" }),
      record({ op: "t", target: "p#label" }),
    ]);
    expect(text).toBe(
      ["  + div.modal in div#app", "  - span.spinner from div#app", "  ~ div#app [class]", "  ~ text in p#label"].join("\n"),
    );
  });

  it("collapses repeats into one counted line, in first-seen order", () => {
    const records = [
      record({ op: "~", target: "#logo", detail: "style" }),
      record({ op: "+", target: "li", parent: "ul#list" }),
      record({ op: "~", target: "#logo", detail: "style" }),
      record({ op: "~", target: "#logo", detail: "style" }),
    ];
    expect(renderDomChanges(records)).toBe("  ~ #logo [style] ×3\n  + li in ul#list");
  });

  it("caps the number of lines and says how much it left out", () => {
    const records = Array.from({ length: 20 }, (_, i) => record({ op: "+", target: `div.item-${i}`, parent: "ul" }));
    const text = renderDomChanges(records, 3)!;
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("  … and 17 more changes across 17 elements");
  });

  it("counts every hidden occurrence, not just the hidden groups", () => {
    const records = [
      record({ op: "+", target: "a", parent: "body" }),
      ...Array.from({ length: 5 }, () => record({ op: "+", target: "b", parent: "body" })),
    ];
    expect(renderDomChanges(records, 1)).toBe("  + a in body\n  … and 5 more changes across 1 elements");
  });

  it("still shows one line when asked for none", () => {
    expect(renderDomChanges([record({ target: "div", parent: "body" })], 0)).toBe("  + div in body");
  });
});

describe("summarisePerformance", () => {
  const sample = (overrides: Partial<PerfSample>): PerfSample => ({
    timestamp_ms: 0,
    kind: "paint",
    start_ms: 0,
    ...overrides,
  });

  it("returns undefined for an empty window, so the card carries no Performance section", () => {
    expect(summarisePerformance([])).toBeUndefined();
  });

  it("prefers first-contentful-paint over first-paint whichever order they arrive in", () => {
    const fp = sample({ kind: "paint", start_ms: 40, name: "first-paint" });
    const fcp = sample({ kind: "paint", start_ms: 90, name: "first-contentful-paint" });
    expect(summarisePerformance([fp, fcp])?.paint_time_ms).toBe(90);
    expect(summarisePerformance([fcp, fp])?.paint_time_ms).toBe(90);
  });

  it("falls back to first-paint when that is all the browser reported", () => {
    expect(summarisePerformance([sample({ kind: "paint", start_ms: 40, name: "first-paint" })])?.paint_time_ms).toBe(40);
  });

  it("takes the largest LCP in the window, since LCP only ever grows", () => {
    const info = summarisePerformance([
      sample({ kind: "lcp", start_ms: 200 }),
      sample({ kind: "lcp", start_ms: 850 }),
      sample({ kind: "lcp", start_ms: 400 }),
    ]);
    expect(info?.lcp_ms).toBe(850);
  });

  it("counts layout shifts and sums their scores", () => {
    const info = summarisePerformance([
      sample({ kind: "shift", start_ms: 100, value: 0.125 }),
      sample({ kind: "shift", start_ms: 200, value: 0.0625 }),
    ]);
    expect(info?.layout_shifts).toBe(2);
    expect(info?.layout_shift_score).toBe(0.1875);
  });

  it("rounds the score rather than reporting float noise", () => {
    const info = summarisePerformance([
      sample({ kind: "shift", value: 0.1 }),
      sample({ kind: "shift", value: 0.2 }),
    ]);
    expect(info?.layout_shift_score).toBe(0.3);
  });

  it("omits the shift fields entirely when nothing shifted", () => {
    const info = summarisePerformance([sample({ kind: "lcp", start_ms: 10 })]);
    expect(info).toEqual({ lcp_ms: 10 });
  });
});

describe("applyContext bucketing", () => {
  const cards = (): DiffCard[] => [
    { index: 1, timestamp_ms: 0, trigger: "initial", full_frame: "a" },
    { index: 2, timestamp_ms: 500, trigger: "animation", full_frame: "b" },
    { index: 3, timestamp_ms: 1000, trigger: "animation", full_frame: "c" },
  ];

  const entry = (timestamp_ms: number) => ({ level: "log" as const, text: `t${timestamp_ms}`, timestamp_ms });

  function contextWith(timestamps: number[]): CapturedContext {
    return { console: timestamps.map(entry), notes: [] };
  }

  it("gives each card the window that ends at its own timestamp", () => {
    const built = cards();
    applyContext(built, contextWith([0, 1, 500, 501, 1000]));
    expect(built[0].console_entries?.map((e) => e.timestamp_ms)).toEqual([0]);
    expect(built[1].console_entries?.map((e) => e.timestamp_ms)).toEqual([1, 500]);
    expect(built[2].console_entries?.map((e) => e.timestamp_ms)).toEqual([501, 1000]);
  });

  it("puts everything from before the recording on the first card", () => {
    const built = cards();
    applyContext(built, contextWith([-800, -1]));
    expect(built[0].console_entries).toHaveLength(2);
    expect(built[1].console_entries).toBeUndefined();
  });

  it("puts anything that arrived after the final frame on the last card", () => {
    const built = cards();
    applyContext(built, contextWith([1001, 5000]));
    expect(built[2].console_entries?.map((e) => e.timestamp_ms)).toEqual([1001, 5000]);
  });

  it("leaves a card with an empty window with no Console section at all", () => {
    const built = cards();
    applyContext(built, contextWith([1000]));
    expect(built[0].console_entries).toBeUndefined();
    expect(built[1].console_entries).toBeUndefined();
    expect(built[2].console_entries).toHaveLength(1);
  });

  it("attaches nothing for a layer that was not collected", () => {
    const built = cards();
    applyContext(built, { notes: [] });
    for (const card of built) {
      expect(card.console_entries).toBeUndefined();
      expect(card.network_events).toBeUndefined();
      expect(card.dom_snapshot).toBeUndefined();
      expect(card.performance).toBeUndefined();
    }
  });

  it("does nothing at all when there are no cards", () => {
    expect(() => applyContext([], contextWith([0, 100]))).not.toThrow();
  });

  it("renders DOM records into a snapshot and reduces performance samples per card", () => {
    const built = cards();
    applyContext(built, {
      notes: [],
      dom: [
        { timestamp_ms: 200, op: "+", target: "div.modal", parent: "div#app" },
        { timestamp_ms: 900, op: "-", target: "span.spinner", parent: "div#app" },
      ],
      performance: [
        { timestamp_ms: 100, kind: "paint", start_ms: 120, name: "first-contentful-paint" },
        { timestamp_ms: 900, kind: "shift", start_ms: 880, value: 0.25 },
      ],
    });
    expect(built[1].dom_snapshot).toBe("  + div.modal in div#app");
    expect(built[2].dom_snapshot).toBe("  - span.spinner from div#app");
    expect(built[1].performance).toEqual({ paint_time_ms: 120 });
    expect(built[2].performance).toEqual({ layout_shifts: 1, layout_shift_score: 0.25 });
    expect(built[0].performance).toBeUndefined();
  });
});

describe("summariseContext", () => {
  const entry = (level: "log" | "error", text: string) => ({ level, text, timestamp_ms: 0 });
  const request = (error?: string) => ({
    method: "GET",
    url: "http://x/",
    status: error ? 0 : 200,
    duration_ms: 1,
    timestamp_ms: 0,
    ...(error !== undefined ? { error } : {}),
  });

  it("returns nothing when no layer was collected", () => {
    expect(summariseContext({ notes: [] }, 3)).toBeUndefined();
  });

  it("tallies each collected layer, naming the ones that saw nothing", () => {
    const notes = summariseContext(
      { notes: [], console: [], network: [], dom: [], performance: [] },
      3,
    );
    expect(notes).toEqual(["Context — console: silent; network: no requests; DOM: no mutations; performance: nothing measured"]);
  });

  it("counts entries, and singularises where it should", () => {
    const notes = summariseContext(
      {
        notes: [],
        console: [entry("log", "a")],
        dom: [
          { timestamp_ms: 0, op: "+", target: "div" },
          { timestamp_ms: 1, op: "+", target: "p" },
        ],
      },
      3,
    );
    expect(notes).toEqual(["Context — console: 1 entry; DOM: 2 mutations"]);
  });

  it("separates settled requests from those still in flight", () => {
    const notes = summariseContext({ notes: [], network: [request(), request(), request("pending")] }, 3);
    expect(notes).toEqual(["Context — network: 2 requests (1 still pending)"]);
  });

  it("does not count a failed request as pending", () => {
    const notes = summariseContext({ notes: [], network: [request("net::ERR_CONNECTION_REFUSED")] }, 3);
    expect(notes).toEqual(["Context — network: 1 request"]);
  });

  it("keeps the collector's own notes after the tally", () => {
    const notes = summariseContext({ notes: ["DOM log was capped — 12 mutations dropped."], dom: [] }, 3);
    expect(notes).toEqual(["Context — DOM: no mutations", "DOM log was capped — 12 mutations dropped."]);
  });

  it("carries console errors into the summary when there are no cards to hang them on", () => {
    const notes = summariseContext(
      { notes: [], console: [entry("log", "chatter"), entry("error", "it exploded"), entry("error", "and again")] },
      0,
    )!;
    expect(notes[0]).toBe("Context — console: 3 entries");
    expect(notes.slice(1)).toEqual(["  [error] it exploded", "  [error] and again"]);
  });

  it("caps those orphaned errors and says how many it left out", () => {
    const console = Array.from({ length: 9 }, (_, i) => entry("error", `error ${i}`));
    const notes = summariseContext({ notes: [], console }, 0)!;
    expect(notes.filter((line) => line.startsWith("  [error]"))).toHaveLength(5);
    expect(notes[notes.length - 1]).toBe("  … and 4 more errors");
  });

  it("leaves errors on their cards when there are cards", () => {
    const notes = summariseContext({ notes: [], console: [entry("error", "it exploded")] }, 2)!;
    expect(notes).toEqual(["Context — console: 1 entry"]);
  });
});
