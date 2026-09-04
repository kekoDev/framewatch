import { describe, expect, it } from "vitest";
import type { DiffCard } from "../src/types.js";
import { describeScale, formatCardMeta, formatDiffCards, formatInteractionLine, type CaptureSummary } from "../src/utils/format.js";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

/** Tiny, syntactically valid base64 strings — the formatter must never decode them. */
const FULL_B64 = "ZnVsbA=="; // "full"
const CROP_B64 = "Y3JvcA=="; // "crop"

function card(overrides: Partial<DiffCard> = {}): DiffCard {
  return {
    index: 1,
    timestamp_ms: 0,
    trigger: "initial",
    full_frame: FULL_B64,
    ...overrides,
  };
}

function summary(overrides: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    cards: [card()],
    total_frames: 50,
    duration_ms: 5000,
    url: "http://localhost:3000/",
    ...overrides,
  };
}

function firstText(result: ReturnType<typeof formatDiffCards>): string {
  const block = result.content[0] as TextBlock;
  expect(block.type).toBe("text");
  return block.text;
}

describe("formatDiffCards summary line", () => {
  it("states meaningful frames, raw frames, recording duration and url", () => {
    const result = formatDiffCards(summary({ cards: [card(), card({ index: 2, timestamp_ms: 300, trigger: "animation" })] }));
    expect(firstText(result)).toBe(
      "Captured 2 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/",
    );
  });
});

describe("formatDiffCards summary line — final_url", () => {
  it("appends ' → final_url' when the page ended on a different url", () => {
    const result = formatDiffCards(summary({ final_url: "http://localhost:3000/home" }));
    expect(firstText(result)).toBe(
      "Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/ → http://localhost:3000/home",
    );
  });

  it("does not append final_url when it equals the requested url", () => {
    const result = formatDiffCards(summary({ final_url: "http://localhost:3000/" }));
    expect(firstText(result)).toBe(
      "Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/",
    );
  });
});

describe("formatDiffCards summary line — title", () => {
  it("appends the page title in quotes after an em dash", () => {
    const result = formatDiffCards(summary({ title: "My App" }));
    expect(firstText(result)).toBe(
      'Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/ — "My App"',
    );
  });

  it("places the title after final_url when both are present", () => {
    const result = formatDiffCards(summary({ final_url: "http://localhost:3000/home", title: "Home" }));
    expect(firstText(result)).toBe(
      'Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/ → http://localhost:3000/home — "Home"',
    );
  });
});

describe("formatDiffCards summary line — dropped", () => {
  it("appends the dropped frame count when dropped > 0", () => {
    const result = formatDiffCards(summary({ dropped: 3 }));
    expect(firstText(result)).toBe(
      "Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/ (3 frames dropped)",
    );
  });

  it("omits the dropped suffix when dropped is 0 or undefined", () => {
    const base = "Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/";
    expect(firstText(formatDiffCards(summary({ dropped: 0 })))).toBe(base);
    expect(firstText(formatDiffCards(summary()))).toBe(base);
  });

  it("orders suffixes as final_url, title, dropped", () => {
    const result = formatDiffCards(summary({ final_url: "http://localhost:3000/x", title: "X", dropped: 1 }));
    expect(firstText(result)).toBe(
      'Captured 1 meaningful frames from 50 raw frames (5000ms recording) of http://localhost:3000/ → http://localhost:3000/x — "X" (1 frames dropped)',
    );
  });
});

describe("formatDiffCards with zero cards", () => {
  it("returns a single text block saying plainly that no frames were captured", () => {
    const result = formatDiffCards(summary({ cards: [], total_frames: 0, duration_ms: 1200 }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = firstText(result);
    expect(text).toMatch(/no frames/i);
    expect(text).toContain("http://localhost:3000/");
    expect(text).toContain("1200ms");
  });
});

describe("formatDiffCards per-card content layout", () => {
  it("emits image, text for a card without a crop, and image, text, image for a card with a crop", () => {
    const result = formatDiffCards(
      summary({
        cards: [
          card(),
          card({
            index: 2,
            timestamp_ms: 300,
            trigger: "animation",
            change_region: { crop: CROP_B64, bbox: { x: 10, y: 20, width: 30, height: 40 }, change_percent: 4.5 },
          }),
        ],
      }),
    );
    expect(result.content.map((c) => c.type)).toEqual(["text", "image", "text", "image", "text", "image"]);
  });

  it("passes full_frame and crop base64 through untouched as image/png blocks", () => {
    const result = formatDiffCards(
      summary({
        cards: [
          card(),
          card({
            index: 2,
            timestamp_ms: 300,
            trigger: "animation",
            change_region: { crop: CROP_B64, bbox: { x: 10, y: 20, width: 30, height: 40 }, change_percent: 4.5 },
          }),
        ],
      }),
    );
    const images = result.content.filter((c) => c.type === "image") as ImageBlock[];
    expect(images.map((i) => i.data)).toEqual([FULL_B64, FULL_B64, CROP_B64]);
    expect(images.every((i) => i.mimeType === "image/png")).toBe(true);
  });

  it("emits only image, text when change_region is present but crop is omitted", () => {
    const result = formatDiffCards(
      summary({
        cards: [
          card(),
          card({
            index: 2,
            timestamp_ms: 300,
            trigger: "animation",
            change_region: { bbox: { x: 0, y: 0, width: 1280, height: 720 }, change_percent: 95 },
          }),
        ],
      }),
    );
    expect(result.content.map((c) => c.type)).toEqual(["text", "image", "text", "image", "text"]);
  });
});

describe("formatCardMeta", () => {
  it("starts with 'Frame <index> @ <timestamp>ms [<trigger>]' and nothing else for a bare first card", () => {
    expect(formatCardMeta(card())).toBe("Frame 1 @ 0ms [initial]");
    expect(formatCardMeta(card({ index: 7, timestamp_ms: 1234, trigger: "navigation" }))).toBe(
      "Frame 7 @ 1234ms [navigation]",
    );
  });
});

describe("formatCardMeta — Changed line", () => {
  it("reports change_percent to one decimal and the bbox as 'x,y WxH'", () => {
    const meta = formatCardMeta(
      card({
        index: 2,
        timestamp_ms: 300,
        trigger: "animation",
        change_region: { crop: CROP_B64, bbox: { x: 10, y: 20, width: 300, height: 150 }, change_percent: 4.56 },
      }),
    );
    expect(meta).toBe("Frame 2 @ 300ms [animation]\nChanged: 4.6% — region: 10,20 300x150");
  });

  it("pads whole-number percentages to one decimal (12 → 12.0)", () => {
    const meta = formatCardMeta(
      card({
        index: 3,
        timestamp_ms: 500,
        trigger: "animation",
        change_region: { crop: CROP_B64, bbox: { x: 0, y: 0, width: 100, height: 50 }, change_percent: 12 },
      }),
    );
    expect(meta.split("\n")[1]).toBe("Changed: 12.0% — region: 0,0 100x50");
  });
});

describe("formatCardMeta — no visual change", () => {
  it("says 'no visual change since previous frame' when change_percent is 0, without a region or crop suffix", () => {
    const meta = formatCardMeta(
      card({
        index: 4,
        timestamp_ms: 2000,
        trigger: "navigation",
        change_region: { bbox: { x: 0, y: 0, width: 0, height: 0 }, change_percent: 0 },
      }),
    );
    expect(meta).toBe("Frame 4 @ 2000ms [navigation]\nChanged: 0.0% — no visual change since previous frame");
  });
});

describe("formatCardMeta — full-frame change", () => {
  it("appends '(full-frame change, see frame image)' when change_region has no crop", () => {
    const meta = formatCardMeta(
      card({
        index: 2,
        timestamp_ms: 300,
        trigger: "navigation",
        change_region: { bbox: { x: 0, y: 0, width: 1280, height: 720 }, change_percent: 97.25 },
      }),
    );
    expect(meta).toBe(
      "Frame 2 @ 300ms [navigation]\nChanged: 97.3% — region: 0,0 1280x720 (full-frame change, see frame image)",
    );
  });

  it("does not append the full-frame suffix when a crop is present", () => {
    const meta = formatCardMeta(
      card({
        index: 2,
        timestamp_ms: 300,
        trigger: "animation",
        change_region: { crop: CROP_B64, bbox: { x: 0, y: 0, width: 1280, height: 720 }, change_percent: 97.25 },
      }),
    );
    expect(meta).not.toContain("full-frame change");
  });
});

describe("formatCardMeta — Console", () => {
  it("lists console entries as '  [level] text' under a 'Console:' header", () => {
    const meta = formatCardMeta(
      card({
        console_entries: [
          { level: "error", text: "Uncaught TypeError: x is undefined", timestamp_ms: 10 },
          { level: "info", text: "Auth token stored", timestamp_ms: 20 },
        ],
      }),
    );
    expect(meta).toBe(
      "Frame 1 @ 0ms [initial]\nConsole:\n  [error] Uncaught TypeError: x is undefined\n  [info] Auth token stored",
    );
  });

  it("omits the Console section when console_entries is an empty array", () => {
    expect(formatCardMeta(card({ console_entries: [] }))).toBe("Frame 1 @ 0ms [initial]");
  });
});

describe("formatCardMeta — Network", () => {
  it("lists network events as '  METHOD url → status (Nms)' under a 'Network:' header", () => {
    const meta = formatCardMeta(
      card({
        network_events: [
          { method: "POST", url: "http://localhost:3000/api/login", status: 200, duration_ms: 340, timestamp_ms: 50 },
          { method: "GET", url: "http://localhost:3000/api/me", status: 401, duration_ms: 12, timestamp_ms: 400 },
        ],
      }),
    );
    expect(meta).toBe(
      "Frame 1 @ 0ms [initial]\nNetwork:\n  POST http://localhost:3000/api/login → 200 (340ms)\n  GET http://localhost:3000/api/me → 401 (12ms)",
    );
  });

  it("omits the Network section when network_events is an empty array", () => {
    expect(formatCardMeta(card({ network_events: [] }))).toBe("Frame 1 @ 0ms [initial]");
  });
});

describe("formatCardMeta — Performance", () => {
  it("lists all three metrics when present, in paint / layout shifts / lcp order", () => {
    const meta = formatCardMeta(card({ performance: { paint_time_ms: 120, layout_shifts: 2, lcp_ms: 850 } }));
    expect(meta).toBe("Frame 1 @ 0ms [initial]\nPerformance:\n  paint 120ms\n  layout shifts 2\n  lcp 850ms");
  });

  it("lists only the fields that are present (zero is a present value)", () => {
    const meta = formatCardMeta(card({ performance: { layout_shifts: 0 } }));
    expect(meta).toBe("Frame 1 @ 0ms [initial]\nPerformance:\n  layout shifts 0");
  });

  it("emits the Performance header even when the object has no fields set (it was requested)", () => {
    const meta = formatCardMeta(card({ performance: {} }));
    expect(meta).toBe("Frame 1 @ 0ms [initial]\nPerformance:");
  });
});

describe("formatCardMeta — DOM", () => {
  it("appends 'DOM:' followed by the snapshot text on its own lines", () => {
    const meta = formatCardMeta(card({ dom_snapshot: "+ div.modal\n- span.spinner" }));
    expect(meta).toBe("Frame 1 @ 0ms [initial]\nDOM:\n+ div.modal\n- span.spinner");
  });
});

describe("formatCardMeta — section order and absence", () => {
  const rich = card({
    index: 5,
    timestamp_ms: 2500,
    trigger: "interaction",
    change_region: { crop: CROP_B64, bbox: { x: 1, y: 2, width: 3, height: 4 }, change_percent: 1.25 },
    console_entries: [{ level: "log", text: "hi", timestamp_ms: 1 }],
    network_events: [{ method: "GET", url: "http://x/", status: 200, duration_ms: 5, timestamp_ms: 2 }],
    performance: { lcp_ms: 900 },
    dom_snapshot: "+ p",
  });

  it("orders sections as Changed, Console, Network, Performance, DOM", () => {
    expect(formatCardMeta(rich)).toBe(
      [
        "Frame 5 @ 2500ms [interaction]",
        "Changed: 1.3% — region: 1,2 3x4",
        "Console:",
        "  [log] hi",
        "Network:",
        "  GET http://x/ → 200 (5ms)",
        "Performance:",
        "  lcp 900ms",
        "DOM:",
        "+ p",
      ].join("\n"),
    );
  });

  it("has no trailing newline or empty sections when all optional data is absent", () => {
    const meta = formatCardMeta(card({ index: 9, timestamp_ms: 42, trigger: "error" }));
    expect(meta).toBe("Frame 9 @ 42ms [error]");
    expect(meta.endsWith("\n")).toBe(false);
  });

  it("uses formatCardMeta verbatim for each card's text block in formatDiffCards", () => {
    const result = formatDiffCards(summary({ cards: [card(), rich] }));
    const texts = result.content.filter((c) => c.type === "text") as TextBlock[];
    expect(texts.map((t) => t.text).slice(1)).toEqual([formatCardMeta(card()), formatCardMeta(rich)]);
  });
});

describe("formatDiffCards summary url normalisation", () => {
  it("does not claim a redirect when the final url only differs by WHATWG normalisation", () => {
    // page.url() always returns the normalised form, so a user asking for
    // "http://localhost:3000" gets back ".../" — that is not a navigation.
    const result = formatDiffCards({
      cards: [],
      total_frames: 3,
      duration_ms: 500,
      url: "http://localhost:3000",
      final_url: "http://localhost:3000/",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("→");
  });

  it("still reports a genuine redirect", () => {
    const result = formatDiffCards({
      cards: [],
      total_frames: 3,
      duration_ms: 500,
      url: "http://localhost:3000/login",
      final_url: "http://localhost:3000/dashboard",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("→ http://localhost:3000/dashboard");
  });

  it("falls back to a plain string comparison when a url cannot be parsed", () => {
    const result = formatDiffCards({
      cards: [],
      total_frames: 1,
      duration_ms: 100,
      url: "not a url",
      final_url: "also not a url",
    });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("→ also not a url");
  });
});

describe("formatInteractionLine", () => {
  it("lists every step when the whole script ran", () => {
    const text = formatInteractionLine({ total: 2, completed: 2, steps: ['click "#btn"', "scroll by 0,400"] });
    expect(text).toBe('Interactions: 2/2 replayed — click "#btn", scroll by 0,400');
  });

  it("names the failing step and its position after the steps that did run", () => {
    const text = formatInteractionLine({
      total: 3,
      completed: 1,
      steps: ['click "#btn"'],
      failed_index: 2,
      error: 'click "#nope" failed: locator.click: Timeout 400ms exceeded.',
    });
    expect(text).toBe(
      'Interactions: 1/3 replayed — click "#btn". Step 2: click "#nope" failed: locator.click: Timeout 400ms exceeded.',
    );
  });

  it("reports a script that failed on its very first step without an empty step list", () => {
    const text = formatInteractionLine({ total: 2, completed: 0, steps: [], failed_index: 1, error: "boom" });
    expect(text).toBe("Interactions: 0/2 replayed. Step 1: boom");
    expect(text).not.toContain("—");
  });

  it("falls back to the step after the last completed one when no index was recorded", () => {
    const text = formatInteractionLine({ total: 3, completed: 2, steps: ["a", "b"], error: "boom" });
    expect(text).toContain("Step 3: boom");
  });
});

describe("formatDiffCards with an interaction report", () => {
  it("puts the interaction line on its own line under the capture summary", () => {
    const result = formatDiffCards(summary({ interactions: { total: 1, completed: 1, steps: ['click "#a"'] } }));
    const [first, second] = firstText(result).split("\n");
    expect(first).toMatch(/^Captured 1 meaningful frames from 50 raw frames/);
    expect(second).toBe('Interactions: 1/1 replayed — click "#a"');
  });

  it("says nothing about interactions when no script was replayed", () => {
    expect(firstText(formatDiffCards(summary()))).not.toContain("Interactions");
  });
});

describe("describeScale", () => {
  it("says the images are at full size when the viewport fits the output width", () => {
    expect(describeScale({ width: 400, height: 300 })).toBe("viewport 400x300, images at full size");
  });

  it("names the output width and the factor when the frames were shrunk", () => {
    expect(describeScale({ width: 1280, height: 720 })).toBe(
      "viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px",
    );
  });
});

describe("formatDiffCards viewport line", () => {
  it("puts the viewport and image scale on the line after the summary", () => {
    const result = formatDiffCards(summary({ viewport: { width: 1280, height: 720 } }));
    const lines = firstText(result).split("\n");
    expect(lines[0]).toMatch(/^Captured 1 meaningful frames/);
    expect(lines[1]).toBe("Viewport 1280x720, images 800px wide (0.63×) — coordinates and regions are in viewport px");
  });

  it("says nothing about scale when the viewport is unknown", () => {
    expect(firstText(formatDiffCards(summary()))).not.toContain("Viewport");
  });
});
