import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser } from "../src/engine/browser.js";
import { captureInputSchema, capturePage, describeCaptureFailure } from "../src/tools/capture.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };
type Result = Awaited<ReturnType<typeof capturePage>>;

function imageBlocks(result: Result): ImageBlock[] {
  return result.content.filter((c) => c.type === "image") as ImageBlock[];
}

function textBlocks(result: Result): TextBlock[] {
  return result.content.filter((c) => c.type === "text") as TextBlock[];
}

/** The per-card metadata blocks (every text block after the summary). */
function cardTexts(result: Result): string[] {
  return textBlocks(result)
    .slice(1)
    .map((t) => t.text);
}

/** Parse "Captured N meaningful frames from M raw frames" out of the summary line. */
function counts(result: Result): { cards: number; raw: number } {
  const m = /Captured (\d+) meaningful frames from (\d+) raw frames/.exec(textBlocks(result)[0]?.text ?? "");
  if (!m) throw new Error(`unexpected summary: ${textBlocks(result)[0]?.text}`);
  return { cards: Number(m[1]), raw: Number(m[2]) };
}

const VIEWPORT = { width: 400, height: 300 };

describe("capturePage on the splash fixture", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({ url: `${fixtures.url}/splash.html`, duration_ms: 2500, viewport: VIEWPORT });
  });

  it("returns a non-error result whose summary counts more raw frames than cards", () => {
    expect(result.isError).toBeFalsy();
    const summary = textBlocks(result)[0].text;
    expect(summary).toMatch(/Captured \d+ meaningful frames from \d+ raw frames \(\d+ms recording\)/);
    expect(summary).toContain(`${fixtures.url}/splash.html`);
    expect(summary).toContain("FrameWatch Splash Fixture");
    const { cards, raw } = counts(result);
    expect(cards).toBeGreaterThanOrEqual(2);
    expect(raw).toBeGreaterThan(cards);
    // 2500ms at 10fps → roughly 25 interval frames plus the final one.
    expect(raw).toBeGreaterThanOrEqual(15);
  });

  it("labels the first card [initial] at ~0ms with no Changed line", () => {
    const first = cardTexts(result)[0];
    expect(first).toMatch(/^Frame 1 @ \d+ms \[initial\]/);
    expect(first).not.toMatch(/Changed:/);
    // The very first screenshot can race the navigation commit and be dropped, so allow one interval.
    const ts = Number(/@ (\d+)ms/.exec(first)![1]);
    expect(ts).toBeLessThan(250);
  });

  it("reports at least one [animation] card whose change region is where the logo fades in (full-res viewport coords)", () => {
    const animation = cardTexts(result).filter((t) => /\[animation\]/.test(t));
    expect(animation.length).toBeGreaterThanOrEqual(1);

    // First animation card: only the logo (100,60 200x120) has changed versus the blank initial frame.
    const m = /Changed: ([\d.]+)% — region: (\d+),(\d+) (\d+)x(\d+)/.exec(animation[0]);
    expect(m, animation[0]).not.toBeNull();
    const [, percent, x, y, w, h] = m!.map(Number);
    expect(percent).toBeGreaterThan(0);
    // Padded by 20px: expect roughly 80,40 240x160 (the logo plus padding), well short of the full 400x300 frame.
    expect(x).toBeGreaterThanOrEqual(70);
    expect(x).toBeLessThanOrEqual(100);
    expect(y).toBeGreaterThanOrEqual(30);
    expect(y).toBeLessThanOrEqual(60);
    expect(x + w).toBeGreaterThanOrEqual(300);
    expect(x + w).toBeLessThanOrEqual(330);
    expect(y + h).toBeGreaterThanOrEqual(180);
    expect(y + h).toBeLessThanOrEqual(210);
  });

  it("returns one PNG (<= 800px wide) per card plus one crop per card with a cropped change region", async () => {
    const texts = cardTexts(result);
    const crops = texts.filter((t) => /Changed: (?!0\.0%)/.test(t) && !/full-frame change/.test(t)).length;
    expect(crops).toBeGreaterThanOrEqual(1);

    const images = imageBlocks(result);
    expect(images).toHaveLength(texts.length + crops);
    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBeLessThanOrEqual(800);
    }

    // Blocks alternate image → meta text (→ crop image) for every card, after the summary text.
    const blocks = result.content.map((c) => c.type);
    expect(blocks[0]).toBe("text");
    expect(blocks[1]).toBe("image");
    expect(blocks[2]).toBe("text");
  });

  it("ends with a card that reports no visual change once the page has gone static", () => {
    const texts = cardTexts(result);
    expect(texts[texts.length - 1]).toContain("Changed: 0.0% — no visual change since previous frame");
  });
});

describe("capturePage frame selection", () => {
  it("returns only a few cards for a mostly static page (basic.html flips its background once at 600ms)", async () => {
    const result = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 2000, viewport: VIEWPORT });
    expect(result.isError).toBeFalsy();
    const { cards, raw } = counts(result);
    expect(raw).toBeGreaterThanOrEqual(15);
    expect(cards).toBeGreaterThanOrEqual(2);
    expect(cards).toBeLessThanOrEqual(4);
  });

  it("honours sensitivity: 1 ('keep none') still returns the first and last frames, nothing else", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/splash.html`,
      duration_ms: 1500,
      sensitivity: 1,
      viewport: VIEWPORT,
    });
    expect(result.isError).toBeFalsy();
    expect(counts(result).cards).toBe(2);
    const texts = cardTexts(result);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/\[initial\]/);
    expect(texts[1]).toMatch(/\[animation\]/);
    // First frame is blank, last has the logo + subtitle: a real change is still reported between them.
    expect(texts[1]).toMatch(/Changed: [1-9][\d.]*% — region:/);
  });

  it("caps the number of cards at max_frames (1 → exactly one card; 3 → exactly three)", async () => {
    const one = await capturePage({ url: `${fixtures.url}/splash.html`, duration_ms: 1500, max_frames: 1, viewport: VIEWPORT });
    expect(one.isError).toBeFalsy();
    expect(counts(one).cards).toBe(1);
    expect(cardTexts(one)).toHaveLength(1);
    expect(imageBlocks(one)).toHaveLength(1);

    // sensitivity 0 keeps every raw frame, so the cap is what limits the output.
    const three = await capturePage({
      url: `${fixtures.url}/splash.html`,
      duration_ms: 1500,
      max_frames: 3,
      sensitivity: 0,
      viewport: VIEWPORT,
    });
    expect(three.isError).toBeFalsy();
    expect(counts(three).cards).toBe(3);
    expect(cardTexts(three)).toHaveLength(3);
  });

  it("honours interval_ms (500ms over a 1500ms recording → at most 5 raw frames instead of ~16)", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 1500,
      interval_ms: 500,
      viewport: VIEWPORT,
    });
    expect(result.isError).toBeFalsy();
    const { raw } = counts(result);
    expect(raw).toBeGreaterThanOrEqual(3);
    expect(raw).toBeLessThanOrEqual(5);
  });
});

describe("capturePage output images", () => {
  it("honours the viewport: full-frame images are the viewport size, resized to max 800px wide", async () => {
    const small = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 600, viewport: { width: 600, height: 300 } });
    expect(small.isError).toBeFalsy();
    const smallMeta = await sharp(Buffer.from(imageBlocks(small)[0].data, "base64")).metadata();
    expect([smallMeta.width, smallMeta.height]).toEqual([600, 300]);

    // Default viewport is 1280x720 → scaled down to 800x450.
    const wide = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 600 });
    expect(wide.isError).toBeFalsy();
    const wideMeta = await sharp(Buffer.from(imageBlocks(wide)[0].data, "base64")).metadata();
    expect([wideMeta.width, wideMeta.height]).toEqual([800, 450]);
  });
});

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe("capturePage wait_for", () => {
  it("waits for `wait_for` to be visible before recording, so the first frame already shows it", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 600,
      wait_for: "#late",
      viewport: VIEWPORT,
    });
    expect(result.isError).toBeFalsy();
    // #late (orangered) is appended after 600ms at left:300 top:30 size 120x60.
    const first = Buffer.from(imageBlocks(result)[0].data, "base64");
    expectColour(await pixelAt(first, 360, 60), [255, 69, 0]);
  });
});

describe("capturePage failures", () => {
  it("returns an MCP error result (not a thrown exception) naming the url for an unreachable URL", async () => {
    const closed = await startFixtureServer();
    await closed.close(); // port is now free → connection refused
    const result = await capturePage({ url: `${closed.url}/`, duration_ms: 500 });

    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    const text = textBlocks(result)[0].text;
    expect(text).toContain(closed.url);
    expect(text).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("returns an MCP error result naming the selector and timeout when `wait_for` never appears", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 500,
      wait_for: "#does-not-exist",
      wait_for_timeout_ms: 500,
    });

    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    const text = textBlocks(result)[0].text;
    expect(text).toContain(`${fixtures.url}/basic.html`);
    expect(text).toContain('"#does-not-exist"');
    expect(text).toMatch(/did not become visible within 500ms/);
  });

  it("returns an MCP error result (not a thrown ZodError) naming the offending field for invalid input", async () => {
    const badUrl = await capturePage({ url: "not a url" });
    expect(badUrl.isError).toBe(true);
    expect(textBlocks(badUrl)[0].text).toMatch(/url/i);

    const badDuration = await capturePage({ url: "http://localhost/", duration_ms: 100 });
    expect(badDuration.isError).toBe(true);
    expect(imageBlocks(badDuration)).toHaveLength(0);
    expect(textBlocks(badDuration)[0].text).toContain("duration_ms");
  });
});

/**
 * Compare a pixel to an expected colour with a small tolerance. Output images
 * are palette-quantised (`png({ quality: 80 })`), so a channel can land a step
 * or two off the source colour; the assertion is about which colour is there,
 * not about the quantiser's exact choice.
 */
function expectColour(actual: [number, number, number], expected: [number, number, number], tolerance = 6): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
  }
}

describe("captureInputSchema", () => {
  it("applies the documented defaults", () => {
    const parsed = captureInputSchema.parse({ url: "http://localhost:3000/" });
    expect(parsed.duration_ms).toBe(5000);
    expect(parsed.sensitivity).toBe(0.06);
    expect(parsed.max_frames).toBe(20);
    expect(parsed.interval_ms).toBe(100);
    expect(parsed.wait_for_timeout_ms).toBe(10_000);
    expect(parsed.viewport).toBeUndefined();
    expect(parsed.wait_for).toBeUndefined();
  });

  it("rejects values outside the documented bounds", () => {
    const ok = (extra: Record<string, unknown>) => captureInputSchema.safeParse({ url: "http://localhost/", ...extra }).success;
    expect(ok({ duration_ms: 499 })).toBe(false);
    expect(ok({ duration_ms: 500 })).toBe(true);
    expect(ok({ duration_ms: 30_000 })).toBe(true);
    expect(ok({ duration_ms: 30_001 })).toBe(false);
    expect(ok({ max_frames: 0 })).toBe(false);
    expect(ok({ max_frames: 1 })).toBe(true);
    expect(ok({ max_frames: 30 })).toBe(true);
    expect(ok({ max_frames: 31 })).toBe(false);
    expect(ok({ sensitivity: -0.01 })).toBe(false);
    expect(ok({ sensitivity: 0 })).toBe(true);
    expect(ok({ sensitivity: 1 })).toBe(true);
    expect(ok({ sensitivity: 1.01 })).toBe(false);
    expect(ok({ interval_ms: 15 })).toBe(false);
    expect(ok({ interval_ms: 16 })).toBe(true);
    expect(ok({ interval_ms: 2000 })).toBe(true);
    expect(ok({ interval_ms: 2001 })).toBe(false);
    expect(ok({ wait_for_timeout_ms: 0 })).toBe(false);
  });
});

describe("describeCaptureFailure", () => {
  const base = { url: "http://localhost:3000/", wait_for_timeout_ms: 5000 };

  it("turns Playwright's missing-browser error into an actionable install hint", () => {
    const err = new Error(
      "browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1234/chrome-headless-shell\n" +
        "║     npx playwright install                                  ║",
    );
    const text = describeCaptureFailure(base, err);
    expect(text).toContain("npx playwright install chromium");
    expect(text).toContain(base.url);
  });

  it("identifies a wait_for timeout without leaking the multi-line call log", () => {
    const err = new Error("page.waitForSelector: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#x') to be visible");
    const text = describeCaptureFailure({ ...base, wait_for: "#x" }, err);
    expect(text).toContain('"#x"');
    expect(text).toContain("5000ms");
    expect(text).not.toContain("\n");
  });

  it("does not blame wait_for for a navigation failure", () => {
    const err = new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/\nCall log:\n  - navigating to ...");
    const text = describeCaptureFailure({ ...base, wait_for: "#x" }, err);
    expect(text).not.toContain('"#x"');
    expect(text).toContain("ERR_CONNECTION_REFUSED");
    expect(text).not.toContain("\n");
  });
});

describe("capturePage navigation", () => {
  it("reports the page it ended on and tags the navigation frame", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/redirect.html`,
      duration_ms: 1200,
      interval_ms: 100,
      viewport: { width: 400, height: 300 },
    });

    expect(result.isError).toBeFalsy();
    const summary = textBlocks(result)[0].text;
    expect(summary).toContain("→ ");
    expect(summary).toContain("recorder-target.html");
    expect(summary).toContain("FrameWatch Recorder Target");
    expect(cardTexts(result).some((t) => t.includes("[navigation]"))).toBe(true);
  });

  it("does not add a redirect arrow for a page that stays put", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 600,
      interval_ms: 200,
      viewport: { width: 400, height: 300 },
    });
    expect(textBlocks(result)[0].text).not.toContain("→");
  });
});

describe("capturePage viewport bounds", () => {
  it("rejects a viewport large enough to exhaust memory during a recording", () => {
    expect(captureInputSchema.safeParse({ url: "http://localhost/", viewport: { width: 99999, height: 400 } }).success).toBe(false);
    expect(captureInputSchema.safeParse({ url: "http://localhost/", viewport: { width: 400, height: 99999 } }).success).toBe(false);
    expect(captureInputSchema.safeParse({ url: "http://localhost/", viewport: { width: 3840, height: 2160 } }).success).toBe(true);
  });
});

describe("capturePage on a page whose main thread is blocked", () => {
  it("returns promptly instead of waiting out Playwright's default timeouts on screenshot and title", async () => {
    const started = Date.now();
    const result = await capturePage({
      url: `${fixtures.url}/busy.html`,
      duration_ms: 2000,
      interval_ms: 100,
      viewport: { width: 400, height: 300 },
    });
    const elapsed = Date.now() - started;

    // The fixture blocks its main thread for 10s. Before the screenshot and
    // title timeouts this took ~60s for a 2s capture.
    expect(elapsed).toBeLessThan(9000);
    expect(result.isError).toBeFalsy();
    // The frames captured before the page froze are still returned.
    expect(imageBlocks(result).length).toBeGreaterThanOrEqual(1);
  }, 40_000);
});

describe("capturePage when the browser dies mid-recording", () => {
  it("returns the frames it already captured instead of failing on the post-recording page.title()", async () => {
    const timer = setTimeout(() => void closeBrowser(), 600);
    try {
      const result = await capturePage({
        url: `${fixtures.url}/splash.html`,
        duration_ms: 8000,
        interval_ms: 100,
        viewport: { width: 400, height: 300 },
      });

      expect(result.isError).toBeFalsy();
      expect(imageBlocks(result).length).toBeGreaterThanOrEqual(1);
      expect(textBlocks(result)[0].text).toMatch(/Captured \d+ meaningful frames/);
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);
});

describe("capturePage interactions", () => {
  it("replays the script during the recording and returns an [interaction] card for each step", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 2000,
      viewport: VIEWPORT,
      interactions: [
        { action: "click", selector: "#btn", delay_ms: 300 },
        { action: "type", selector: "#text", value: "hello", delay_ms: 300 },
      ],
    });

    expect(result.isError).toBeFalsy();
    const interactionCards = cardTexts(result).filter((t) => /\[interaction\]/.test(t));
    expect(interactionCards).toHaveLength(2);
    // Every interaction card sits at or after its cumulative delay.
    const at = (t: string) => Number(/@ (\d+)ms/.exec(t)![1]);
    expect(at(interactionCards[0])).toBeGreaterThanOrEqual(280);
    expect(at(interactionCards[1])).toBeGreaterThanOrEqual(580);
    // The click reveals #panel, so the frame really did change.
    expect(interactionCards[0]).toMatch(/Changed: [1-9][\d.]*%/);
  });

  it("reports the replayed steps in the summary", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 800,
      viewport: VIEWPORT,
      interactions: [{ action: "click", selector: "#btn" }, { action: "scroll", delta_y: 400 }],
    });

    expect(result.isError).toBeFalsy();
    const summary = textBlocks(result)[0].text;
    expect(summary).toContain("Interactions: 2/2 replayed");
    expect(summary).toContain('click "#btn"');
    expect(summary).toContain("scroll by 0,400");
  });

  it("says nothing about interactions when no script was given", async () => {
    const result = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 600, viewport: VIEWPORT });
    expect(textBlocks(result)[0].text).not.toContain("Interactions:");
  });

  it("keeps the frames it already captured when a step fails, and names the failing step", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 800,
      viewport: VIEWPORT,
      interaction_timeout_ms: 400,
      interactions: [
        { action: "click", selector: "#btn" },
        { action: "click", selector: "#nope" },
        { action: "click", selector: "#btn" },
      ],
    });

    // A broken step is a finding, not a tool failure: the frames still come back.
    expect(result.isError).toBeFalsy();
    expect(imageBlocks(result).length).toBeGreaterThanOrEqual(1);

    const summary = textBlocks(result)[0].text;
    expect(summary).toContain("Interactions: 1/3 replayed");
    expect(summary).toContain("Step 2");
    expect(summary).toContain("#nope");
    // The state at the moment of failure is kept as its own card.
    expect(cardTexts(result).some((t) => /\[error\]/.test(t))).toBe(true);
    // The third step never ran.
    expect(cardTexts(result).filter((t) => /\[interaction\]/.test(t))).toHaveLength(1);
  });

  it("opens a touch-enabled page for tap and swipe steps", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 900,
      viewport: VIEWPORT,
      interactions: [{ action: "tap", selector: "#touch", delay_ms: 200 }],
    });

    expect(result.isError).toBeFalsy();
    expect(textBlocks(result)[0].text).toContain("Interactions: 1/1 replayed");
    // #touch (220,120 120x40) turns orange only when it receives a real touchstart.
    const images = imageBlocks(result);
    const last = Buffer.from(images[images.length - 1].data, "base64");
    expectColour(await pixelAt(last, 280, 140), [255, 140, 0]);
  });

  it("keeps recording until the script finishes, even past duration_ms", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 500,
      viewport: VIEWPORT,
      interactions: [{ action: "click", selector: "#btn", delay_ms: 1200 }],
    });

    expect(result.isError).toBeFalsy();
    const recorded = Number(/\((\d+)ms recording\)/.exec(textBlocks(result)[0].text)![1]);
    expect(recorded).toBeGreaterThanOrEqual(1200);
    expect(cardTexts(result).some((t) => /\[interaction\]/.test(t))).toBe(true);
  });

  it("rejects an unusable step as invalid input, before launching a browser", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/interactive.html`,
      duration_ms: 500,
      interactions: [{ action: "click" }],
    });
    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    expect(textBlocks(result)[0].text).toMatch(/selector/);
  });
});

describe("captureInputSchema interactions", () => {
  const parse = (interactions: unknown) =>
    captureInputSchema.safeParse({ url: "http://localhost/", interactions });

  it("accepts the documented capture actions and defaults delay_ms to 0", () => {
    const parsed = captureInputSchema.parse({
      url: "http://localhost/",
      interactions: [{ action: "click", selector: "#a" }],
    });
    expect(parsed.interactions![0].delay_ms).toBe(0);
    for (const action of ["click", "tap", "type", "key", "scroll", "swipe", "hover", "select", "wait", "navigate"]) {
      const step: Record<string, unknown> = { action };
      if (action === "type") step.value = "x";
      if (action === "key") step.value = "Enter";
      if (action === "navigate") step.value = "http://x/";
      if (action === "scroll") step.delta_y = 10;
      if (action === "swipe") Object.assign(step, { x: 1, y: 1, delta_x: 5 });
      if (action === "select") Object.assign(step, { selector: "#a", value: "b" });
      if (action === "click" || action === "tap" || action === "hover") step.selector = "#a";
      expect(parse([step]).success, action).toBe(true);
    }
  });

  it("accepts every action the executor supports, including the ones only interact used to offer", () => {
    expect(parse([{ action: "hover", selector: "#a" }]).success).toBe(true);
    expect(parse([{ action: "select", selector: "#a", value: "b" }]).success).toBe(true);
    expect(parse([{ action: "key", value: "Enter" }]).success).toBe(true);
  });

  it("rejects a `key` step with no key to press", () => {
    expect(parse([{ action: "key" }]).success).toBe(false);
    expect(parse([{ action: "key", value: "" }]).success).toBe(false);
  });

  it("rejects a step that is missing the fields its action needs", () => {
    expect(parse([{ action: "type" }]).success).toBe(false);
    expect(parse([{ action: "navigate" }]).success).toBe(false);
    expect(parse([{ action: "scroll" }]).success).toBe(false);
    expect(parse([{ action: "swipe", x: 1, y: 2 }]).success).toBe(false);
    expect(parse([{ action: "click", x: 1 }]).success).toBe(false);
  });
});
