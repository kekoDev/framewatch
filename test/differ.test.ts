import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { RawFrame } from "../src/types.js";
import {
  CELL_THRESHOLD,
  CROP_PADDING_PX,
  DEFAULT_SENSITIVITY,
  DIFF_HEIGHT,
  DIFF_WIDTH,
  GRID_SIZE,
  MERGE_WINDOW_MS,
  OUTPUT_MAX_WIDTH,
  PIXEL_THRESHOLD,
} from "../src/constants.js";
import {
  buildDiffCards,
  computeGridDiff,
  computePixelDiff,
  exceedsSensitivity,
  padBoundingBox,
  selectFrames,
  type FrameSelectionInput,
} from "../src/engine/differ.js";
import { cropRegion, toDiffBuffer, toGrayscale } from "../src/utils/image.js";

/** Solid-colour PNG of the given size. */
async function solidPng(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

/** White PNG with a solid-colour square at (x, y) of size `size`. */
async function squarePng(
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  rgb: [number, number, number] = [0, 0, 0],
): Promise<Buffer> {
  const square = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: square, left: x, top: y }])
    .png()
    .toBuffer();
}

/** Read one RGB pixel from an encoded image. */
async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

/** Raw 1-channel buffer filled with `value`. */
function raw(width: number, height: number, value: number): Buffer {
  return Buffer.alloc(width * height, value);
}

/** Fill an axis-aligned rectangle of a raw 1-channel buffer with `value` (mutates). */
function fillRect(buf: Buffer, width: number, x: number, y: number, w: number, h: number, value: number): Buffer {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) buf[py * width + px] = value;
  }
  return buf;
}

describe("toDiffBuffer", () => {
  it("returns DIFF_WIDTH*DIFF_HEIGHT single-channel grayscale pixels regardless of input size", async () => {
    const png = await solidPng(1280, 720, [255, 0, 0]); // pure red
    const buf = await toDiffBuffer(png);
    expect(buf.length).toBe(DIFF_WIDTH * DIFF_HEIGHT);
    // Pure red in any real grayscale conversion lands strictly between 0 and 255;
    // a channel drop would give exactly 255 (R), 0 (G) or 0 (B).
    const v = buf[0];
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(255);
    // Solid input → every pixel identical.
    expect(buf[buf.length - 1]).toBe(v);
  });
});

describe("toGrayscale", () => {
  it("returns full-resolution single-channel pixels with the original dimensions", async () => {
    const png = await solidPng(64, 48, [0, 0, 0]);
    const { data, width, height } = await toGrayscale(png);
    expect(width).toBe(64);
    expect(height).toBe(48);
    expect(data.length).toBe(64 * 48);
    expect(data[0]).toBe(0);
    const white = await toGrayscale(await solidPng(64, 48, [255, 255, 255]));
    expect(white.data[64 * 48 - 1]).toBe(255);
  });
});

describe("cropRegion", () => {
  it("crops a PNG to the bbox and keeps the pixels at the right offsets", async () => {
    // 200x100 white with a black 20x20 square at (50, 30).
    const png = await squarePng(200, 100, 50, 30, 20);
    const crop = await cropRegion(png, { x: 40, y: 20, width: 60, height: 50 });
    const meta = await sharp(crop).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(50);
    // Square top-left (50,30) → (10,10) inside the crop; (5,5) is still white.
    expect(await pixelAt(crop, 10, 10)).toEqual([0, 0, 0]);
    expect(await pixelAt(crop, 5, 5)).toEqual([255, 255, 255]);
  });
});

describe("computeGridDiff", () => {
  const W = DIFF_WIDTH;
  const H = DIFF_HEIGHT;

  it("reports zero changed cells and a null bbox for identical buffers", () => {
    const a = raw(W, H, 128);
    const b = raw(W, H, 128);
    const result = computeGridDiff(a, b, W, H);
    expect(result.changedCells).toBe(0);
    expect(result.totalCells).toBe(GRID_SIZE * GRID_SIZE);
    expect(result.changeRatio).toBe(0);
    expect(result.bbox).toBeNull();
  });

  it("counts a single fully-changed cell and returns that cell as the bbox", () => {
    const cellW = Math.floor(W / GRID_SIZE); // 40
    const cellH = Math.floor(H / GRID_SIZE); // 30
    const a = raw(W, H, 0);
    // Blacken exactly cell (gx=2, gy=3) → fully changed.
    const b = fillRect(raw(W, H, 0), W, 2 * cellW, 3 * cellH, cellW, cellH, 255);
    const result = computeGridDiff(a, b, W, H);
    expect(result.changedCells).toBe(1);
    expect(result.changeRatio).toBeCloseTo(1 / 64, 10);
    expect(result.bbox).toEqual({ x: 2 * cellW, y: 3 * cellH, width: cellW, height: cellH });
  });

  it("unions the bbox of a change that spans several cells", () => {
    const cellW = Math.floor(W / GRID_SIZE);
    const cellH = Math.floor(H / GRID_SIZE);
    const a = raw(W, H, 0);
    // Rectangle from the middle of cell (1,1) to the middle of cell (3,2): touches cells gx 1..3, gy 1..2 = 6 cells.
    const x = cellW + cellW / 2;
    const y = cellH + cellH / 2;
    const w = 2 * cellW;
    const h = cellH;
    const b = fillRect(raw(W, H, 0), W, x, y, w, h, 255);
    const result = computeGridDiff(a, b, W, H);
    expect(result.changedCells).toBe(6);
    expect(result.bbox).toEqual({ x: cellW, y: cellH, width: 3 * cellW, height: 2 * cellH });
  });

  it("ignores cells whose mean difference is at or below CELL_THRESHOLD", () => {
    const a = raw(W, H, 100);
    // Uniform shift of exactly CELL_THRESHOLD → mean diff == threshold → NOT changed (strict >).
    const atThreshold = raw(W, H, 100 + CELL_THRESHOLD);
    expect(computeGridDiff(a, atThreshold, W, H).changedCells).toBe(0);
    // One more → every cell changed.
    const above = raw(W, H, 100 + CELL_THRESHOLD + 1);
    expect(computeGridDiff(a, above, W, H).changedCells).toBe(GRID_SIZE * GRID_SIZE);
    // A large change confined to a small part of a cell averages out below the threshold.
    const cellW = Math.floor(W / GRID_SIZE);
    const cellH = Math.floor(H / GRID_SIZE);
    const tiny = fillRect(raw(W, H, 100), W, 0, 0, 2, 2, 255); // 4 px * 155 / 1200 px ≈ 0.5 mean
    expect(computeGridDiff(a, tiny, W, H).changedCells).toBe(0);
    expect(cellW * cellH).toBeGreaterThan(4);
  });

  it("throws when a buffer length does not match width*height", () => {
    const good = raw(W, H, 0);
    const short = raw(W, H - 1, 0);
    expect(() => computeGridDiff(good, short, W, H)).toThrow(/length/i);
    expect(() => computeGridDiff(short, good, W, H)).toThrow(/length/i);
  });
});

describe("computePixelDiff", () => {
  it("returns a tight inclusive bbox, the changed pixel count and a percentage", () => {
    const W = 100;
    const H = 50;
    const a = raw(W, H, 0);
    // 10x5 rectangle at (20, 10) → last changed pixel is (29, 14).
    const b = fillRect(raw(W, H, 0), W, 20, 10, 10, 5, 255);
    const result = computePixelDiff(a, b, W, H);
    expect(result.changedPixels).toBe(50);
    expect(result.totalPixels).toBe(W * H);
    expect(result.changePercent).toBeCloseTo((50 / (W * H)) * 100, 10);
    expect(result.bbox).toEqual({ x: 20, y: 10, width: 10, height: 5 });
  });

  it("returns zero changes and a null bbox when every pixel is within PIXEL_THRESHOLD", () => {
    const W = 40;
    const H = 30;
    const a = raw(W, H, 50);
    const b = raw(W, H, 50 + PIXEL_THRESHOLD); // exactly at threshold → not changed
    const result = computePixelDiff(a, b, W, H);
    expect(result.changedPixels).toBe(0);
    expect(result.changePercent).toBe(0);
    expect(result.bbox).toBeNull();
    // Single pixel just above threshold in the bottom-right corner → 1x1 bbox there.
    const c = raw(W, H, 50);
    c[W * H - 1] = 50 + PIXEL_THRESHOLD + 1;
    expect(computePixelDiff(a, c, W, H)).toEqual({
      changedPixels: 1,
      totalPixels: W * H,
      changePercent: (1 / (W * H)) * 100,
      bbox: { x: W - 1, y: H - 1, width: 1, height: 1 },
    });
  });

  it("throws when a buffer length does not match width*height", () => {
    expect(() => computePixelDiff(raw(10, 10, 0), raw(10, 9, 0), 10, 10)).toThrow(/length/i);
  });
});

describe("padBoundingBox", () => {
  it("grows the box by `padding` on every side", () => {
    expect(padBoundingBox({ x: 100, y: 80, width: 50, height: 40 }, 20, 1280, 720)).toEqual({
      x: 80,
      y: 60,
      width: 90,
      height: 80,
    });
  });

  it("clamps to the frame edges", () => {
    // Near top-left: x/y cannot go below 0, width/height shrink accordingly.
    expect(padBoundingBox({ x: 5, y: 3, width: 10, height: 10 }, 20, 1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 35,
      height: 33,
    });
    // Near bottom-right: right/bottom edges cannot exceed the frame.
    expect(padBoundingBox({ x: 1270, y: 715, width: 10, height: 5 }, 20, 1280, 720)).toEqual({
      x: 1250,
      y: 695,
      width: 30,
      height: 25,
    });
    // Whole frame stays the whole frame.
    expect(padBoundingBox({ x: 0, y: 0, width: 1280, height: 720 }, 20, 1280, 720)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    });
  });
});

describe("exceedsSensitivity", () => {
  it("keeps everything at sensitivity 0 and nothing at sensitivity 1", () => {
    expect(exceedsSensitivity(0, 0)).toBe(true);
    expect(exceedsSensitivity(1, 0)).toBe(true);
    expect(exceedsSensitivity(0, 1)).toBe(false);
    expect(exceedsSensitivity(1, 1)).toBe(false);
  });

  it("at the default 0.06 keeps 4/64 changed cells and drops 3/64", () => {
    expect(DEFAULT_SENSITIVITY).toBe(0.06);
    expect(exceedsSensitivity(4 / 64, DEFAULT_SENSITIVITY)).toBe(true);
    expect(exceedsSensitivity(3 / 64, DEFAULT_SENSITIVITY)).toBe(false);
    // Strictly greater: a ratio equal to the sensitivity is dropped.
    expect(exceedsSensitivity(0.5, 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectFrames helpers: low-res diff buffers are DIFF_WIDTH x DIFF_HEIGHT.
// ---------------------------------------------------------------------------

/** A low-res diff buffer that is uniformly `value`. */
function diffBuf(value: number): Buffer {
  return raw(DIFF_WIDTH, DIFF_HEIGHT, value);
}

/** A low-res diff buffer (background 0) with a block of `cells` grid cells set to 255 (top-left, row-major). */
function diffBufWithCells(cells: number): Buffer {
  const cellW = Math.floor(DIFF_WIDTH / GRID_SIZE);
  const cellH = Math.floor(DIFF_HEIGHT / GRID_SIZE);
  const buf = diffBuf(0);
  for (let i = 0; i < cells; i++) {
    const gx = i % GRID_SIZE;
    const gy = Math.floor(i / GRID_SIZE);
    fillRect(buf, DIFF_WIDTH, gx * cellW, gy * cellH, cellW, cellH, 255);
  }
  return buf;
}

function frame(timestamp_ms: number, extra: Partial<FrameSelectionInput> = {}): FrameSelectionInput {
  return { timestamp_ms, is_interaction: false, ...extra };
}

describe("selectFrames", () => {
  const opts = { sensitivity: DEFAULT_SENSITIVITY, max_frames: 20 };

  it("always keeps the first and last frame, so a static recording yields [0, last]", () => {
    const frames = [frame(0), frame(100), frame(200), frame(300), frame(400)];
    const diffs = frames.map(() => diffBuf(128));
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 4]);
    // A single frame is both first and last.
    expect(selectFrames([frame(0)], [diffBuf(0)], opts)).toEqual([0]);
  });

  it("keeps a frame whose grid change exceeds the sensitivity and drops those that do not", () => {
    // Frames spaced 500ms apart so the merge window never applies.
    const frames = [frame(0), frame(500), frame(1000), frame(1500), frame(2000)];
    const diffs = [
      diffBuf(0),
      diffBuf(0), // unchanged → dropped
      diffBufWithCells(8), // 8/64 = 0.125 > 0.06 → kept
      diffBufWithCells(8), // same as last kept → dropped
      diffBufWithCells(8), // last → kept anyway
    ];
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 2, 4]);
    // 3 cells is below the 0.06 threshold.
    const small = [diffBuf(0), diffBufWithCells(3), diffBuf(0)];
    expect(selectFrames(frames.slice(0, 3), small, opts)).toEqual([0, 2]);
  });

  it("compares against the last KEPT frame, so a slow fade is eventually kept even though each step is tiny", () => {
    // Whole-frame brightness ramps by 10 per step: each step's mean diff (10) is below CELL_THRESHOLD (15)
    // versus the PREVIOUS raw frame, so a previous-frame comparison would never keep anything but first/last.
    // Versus the last kept frame (0 → 20 at step 2) every cell exceeds the threshold → kept.
    const steps = 7;
    const frames = Array.from({ length: steps }, (_, i) => frame(i * 500));
    const diffs = Array.from({ length: steps }, (_, i) => diffBuf(i * 10));
    const kept = selectFrames(frames, diffs, opts);
    expect(kept).toEqual([0, 2, 4, 6]);
  });

  it("always keeps forced frames (trigger set or is_interaction) even when nothing changed visually", () => {
    const frames = [
      frame(0),
      frame(500, { trigger: "navigation" }),
      frame(1000),
      frame(1500, { is_interaction: true }),
      frame(2000, { trigger: "error" }),
      frame(2500),
    ];
    const diffs = frames.map(() => diffBuf(77)); // no visual change at all
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 1, 3, 4, 5]);
    // Even at sensitivity 1 ("keep none") forced frames survive.
    expect(selectFrames(frames, diffs, { ...opts, sensitivity: 1 })).toEqual([0, 1, 3, 4, 5]);
  });

  it("thins a continuous 100ms-step animation to ~every MERGE_WINDOW_MS instead of collapsing it to one frame", () => {
    expect(MERGE_WINDOW_MS).toBe(200);
    // 10 frames, every one visually different from the last kept (alternating patterns) → all 10 pass the
    // sensitivity check. Merging must drop only the earlier frame of each <200ms pair, leaving ~half.
    const frames = Array.from({ length: 10 }, (_, i) => frame(i * 100));
    const diffs = frames.map((_, i) => (i % 2 === 0 ? diffBuf(0) : diffBufWithCells(16)));
    const kept = selectFrames(frames, diffs, opts);
    expect(kept).toEqual([0, 2, 4, 6, 8, 9]);
  });

  it("collapses a whole cluster of 3+ close frames to its settled last one, anchored at the cluster start", () => {
    // 500/550/600 are one anchored window (all within 200ms of 500), so only
    // 600 — the settled state — survives. A pairwise implementation that only
    // ever compares neighbours would keep 550 as well.
    const frames = [frame(0), frame(500), frame(550), frame(600), frame(1500)];
    const diffs = frames.map((_, i) => (i % 2 === 0 ? diffBuf(0) : diffBufWithCells(16)));
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 3, 4]);
  });

  it("starts a new window at the first frame outside the previous one rather than sliding it", () => {
    // 500 anchors a window ending at 700: 650 joins it, 750 does not and
    // anchors the next. A sliding window would swallow 750 too.
    const frames = [frame(0), frame(500), frame(650), frame(750), frame(1500)];
    const diffs = frames.map((_, i) => (i % 2 === 0 ? diffBuf(0) : diffBufWithCells(16)));
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 2, 3, 4]);
  });

  it("drops the earlier of two unprotected kept frames that are < MERGE_WINDOW_MS apart", () => {
    const frames = [frame(0), frame(500), frame(650), frame(1500), frame(2000)];
    const diffs = [diffBuf(0), diffBufWithCells(16), diffBufWithCells(32), diffBufWithCells(48), diffBufWithCells(48)];
    // Pre-merge every frame is kept; 500 and 650 are 150ms apart → 500 is dropped, 650 ("settled") survives.
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 2, 3, 4]);
    // Exactly MERGE_WINDOW_MS apart is NOT merged (strict <).
    const spaced = [frame(0), frame(500), frame(700), frame(1500)];
    const spacedDiffs = [diffBuf(0), diffBufWithCells(16), diffBufWithCells(32), diffBufWithCells(48)];
    expect(selectFrames(spaced, spacedDiffs, opts)).toEqual([0, 1, 2, 3]);
  });

  it("never merges away the first, the last or a forced frame", () => {
    // first(0) and last(100) are 100ms apart → both kept.
    expect(selectFrames([frame(0), frame(100)], [diffBuf(0), diffBuf(0)], opts)).toEqual([0, 1]);
    // An unprotected changed frame sandwiched between forced frames within the window is kept; no forced frame is dropped.
    const frames = [
      frame(0),
      frame(100, { trigger: "navigation" }),
      frame(150),
      frame(250, { is_interaction: true }),
      frame(300),
    ];
    const diffs = [diffBuf(0), diffBuf(0), diffBufWithCells(16), diffBufWithCells(16), diffBufWithCells(16)];
    expect(selectFrames(frames, diffs, opts)).toEqual([0, 1, 2, 3, 4]);
    // Two forced frames 50ms apart → both kept; the unprotected one before them is merged only against its own cluster.
    const forcedPair = [frame(0), frame(500), frame(520, { trigger: "error" }), frame(570, { trigger: "error" }), frame(1000)];
    const forcedDiffs = [diffBuf(0), diffBufWithCells(16), diffBuf(0), diffBuf(0), diffBuf(0)];
    expect(selectFrames(forcedPair, forcedDiffs, opts)).toEqual([0, 1, 2, 3, 4]);
  });

  it("caps at max_frames, keeping first/last/forced and sampling the rest evenly (ascending)", () => {
    // 12 frames 500ms apart, every one changed vs the last kept → 12 kept before the cap.
    const frames = Array.from({ length: 12 }, (_, i) => frame(i * 500));
    const diffs = frames.map((_, i) => (i % 2 === 0 ? diffBuf(0) : diffBufWithCells(16)));
    expect(selectFrames(frames, diffs, opts)).toHaveLength(12);

    const capped = selectFrames(frames, diffs, { ...opts, max_frames: 5 });
    expect(capped).toHaveLength(5);
    expect(capped[0]).toBe(0);
    expect(capped[4]).toBe(11);
    expect([...capped].sort((a, b) => a - b)).toEqual(capped);
    // The 3 sampled frames come from 1..10 and are spread out: one from each third, not the first three.
    const sampled = capped.slice(1, 4);
    expect(sampled[0]).toBeGreaterThanOrEqual(1);
    expect(sampled[0]).toBeLessThan(4);
    expect(sampled[1]).toBeGreaterThanOrEqual(4);
    expect(sampled[1]).toBeLessThan(7);
    expect(sampled[2]).toBeGreaterThanOrEqual(7);
    expect(sampled[2]).toBeLessThanOrEqual(10);

    // Forced frames take priority over sampled ones.
    const withForced = frames.map((f, i) => (i === 3 || i === 7 ? { ...f, trigger: "navigation" as const } : f));
    const cappedForced = selectFrames(withForced, diffs, { ...opts, max_frames: 5 });
    expect(cappedForced).toHaveLength(5);
    expect(cappedForced).toContain(0);
    expect(cappedForced).toContain(3);
    expect(cappedForced).toContain(7);
    expect(cappedForced).toContain(11);
    expect([...cappedForced].sort((a, b) => a - b)).toEqual(cappedForced);

    // max_frames of 1 → only the first frame; 2 → first and last.
    expect(selectFrames(frames, diffs, { ...opts, max_frames: 1 })).toEqual([0]);
    expect(selectFrames(frames, diffs, { ...opts, max_frames: 2 })).toEqual([0, 11]);
  });

  it("when protected frames alone exceed max_frames, keeps first + last + the earliest forced frames", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(i * 500, i > 0 ? { trigger: "error" } : {}));
    const diffs = frames.map(() => diffBuf(0));
    expect(selectFrames(frames, diffs, { ...opts, max_frames: 4 })).toEqual([0, 1, 2, 9]);
  });
});

describe("buildDiffCards", () => {
  const opts = { sensitivity: DEFAULT_SENSITIVITY, max_frames: 20 };

  it("returns no cards for empty input", async () => {
    expect(await buildDiffCards([], opts)).toEqual({ cards: [], total_frames: 0 });
  });

  it("turns PNG frames into 1-based cards with triggers, padded change bboxes and matching crops", async () => {
    const W = 640;
    const H = 480;
    const white = await solidPng(W, H);
    const squareA = await squarePng(W, H, 100, 100, 100); // black 100x100 at (100,100)
    const squareB = await squarePng(W, H, 300, 200, 100); // moved to (300,200)
    const frames: RawFrame[] = [
      { buffer: white, timestamp_ms: 0, is_interaction: false },
      { buffer: white, timestamp_ms: 500, is_interaction: false }, // static → dropped
      { buffer: squareA, timestamp_ms: 1000, is_interaction: false }, // appears → animation
      { buffer: squareA, timestamp_ms: 1500, is_interaction: false }, // static → dropped
      { buffer: squareB, timestamp_ms: 2000, is_interaction: true }, // moved by an interaction
      { buffer: squareB, timestamp_ms: 3000, is_interaction: false }, // last → kept, no visual change
    ];

    const { cards, total_frames } = await buildDiffCards(frames, opts);
    expect(total_frames).toBe(6);
    expect(cards.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    expect(cards.map((c) => c.timestamp_ms)).toEqual([0, 1000, 2000, 3000]);
    expect(cards.map((c) => c.trigger)).toEqual(["initial", "animation", "interaction", "animation"]);

    // First card: full frame only, no change region.
    expect(cards[0].change_region).toBeUndefined();
    const full = await sharp(Buffer.from(cards[0].full_frame, "base64")).metadata();
    expect(full.format).toBe("png");
    expect(full.width).toBe(W);
    expect(full.height).toBe(H);

    // Second card: square appeared → padded bbox around (100,100,100,100).
    const region = cards[1].change_region;
    expect(region).toBeDefined();
    expect(region!.bbox).toEqual({
      x: 100 - CROP_PADDING_PX,
      y: 100 - CROP_PADDING_PX,
      width: 100 + 2 * CROP_PADDING_PX,
      height: 100 + 2 * CROP_PADDING_PX,
    });
    expect(region!.change_percent).toBeCloseTo(((100 * 100) / (W * H)) * 100, 1);
    expect(region!.crop).toBeDefined();
    const crop = Buffer.from(region!.crop!, "base64");
    const cropMeta = await sharp(crop).metadata();
    expect(cropMeta.width).toBe(region!.bbox.width);
    expect(cropMeta.height).toBe(region!.bbox.height);
    // The square sits CROP_PADDING_PX inside the crop; the padding ring is white.
    expect(await pixelAt(crop, CROP_PADDING_PX + 50, CROP_PADDING_PX + 50)).toEqual([0, 0, 0]);
    expect(await pixelAt(crop, 5, 5)).toEqual([255, 255, 255]);

    // Third card: compared against the previous CARD (squareA), so the bbox spans both old and new positions.
    const moved = cards[2].change_region!;
    expect(moved.bbox).toEqual({
      x: 100 - CROP_PADDING_PX,
      y: 100 - CROP_PADDING_PX,
      width: 300 + 2 * CROP_PADDING_PX,
      height: 200 + 2 * CROP_PADDING_PX,
    });
    expect(moved.change_percent).toBeCloseTo(((2 * 100 * 100) / (W * H)) * 100, 1);
    const movedCrop = await sharp(Buffer.from(moved.crop!, "base64")).metadata();
    expect(movedCrop.width).toBe(moved.bbox.width);
    expect(movedCrop.height).toBe(moved.bbox.height);

    // Fourth (last) card: nothing changed since the previous card → zero region, no crop.
    expect(cards[3].change_region).toEqual({ bbox: { x: 0, y: 0, width: 0, height: 0 }, change_percent: 0 });
  });

  it("diffs each card against the previous CARD, ignoring the raw frames that were dropped in between", async () => {
    const W = 640;
    const H = 480;
    const white = await solidPng(W, H);
    const squareA = await squarePng(W, H, 100, 100, 100);
    const squareB = await squarePng(W, H, 300, 200, 100);
    // A dropped in-between frame that is visibly different from squareA but
    // too small to pass the grid sensitivity: a 12x12 dot far away at (600,450).
    const squareAWithDot = await sharp(squareA)
      .composite([{ input: await solidPng(12, 12, [0, 0, 0]), left: 600, top: 450 }])
      .png()
      .toBuffer();

    const frames: RawFrame[] = [
      { buffer: white, timestamp_ms: 0, is_interaction: false },
      { buffer: squareA, timestamp_ms: 1000, is_interaction: false },
      { buffer: squareAWithDot, timestamp_ms: 1500, is_interaction: false }, // dropped: dot is sub-threshold
      { buffer: squareB, timestamp_ms: 2000, is_interaction: false },
    ];

    const { cards } = await buildDiffCards(frames, opts);
    expect(cards.map((c) => c.timestamp_ms)).toEqual([0, 1000, 2000]);

    // squareB vs the previous CARD (squareA) covers both square positions and
    // nothing else. Diffing against the previous RAW frame would also pick up
    // the dot at (600,450) and stretch the box to the frame's bottom-right.
    expect(cards[2].change_region!.bbox).toEqual({
      x: 100 - CROP_PADDING_PX,
      y: 100 - CROP_PADDING_PX,
      width: 300 + 2 * CROP_PADDING_PX,
      height: 200 + 2 * CROP_PADDING_PX,
    });
  });

  it("omits the crop when the padded change region covers the whole frame", async () => {
    const W = 640;
    const H = 480;
    const frames: RawFrame[] = [
      { buffer: await solidPng(W, H, [255, 255, 255]), timestamp_ms: 0, is_interaction: false },
      { buffer: await solidPng(W, H, [0, 0, 0]), timestamp_ms: 1000, is_interaction: false },
    ];
    const { cards } = await buildDiffCards(frames, opts);
    expect(cards).toHaveLength(2);
    const region = cards[1].change_region!;
    expect(region.bbox).toEqual({ x: 0, y: 0, width: W, height: H });
    expect(region.change_percent).toBe(100);
    expect(region.crop).toBeUndefined();
  });

  it("resizes full frames and crops wider than OUTPUT_MAX_WIDTH while reporting full-resolution bboxes", async () => {
    const W = 1280;
    const H = 720;
    const frames: RawFrame[] = [
      { buffer: await solidPng(W, H), timestamp_ms: 0, is_interaction: false },
      // 1000x300 block at (100,100): padded bbox 1040x340 → wider than 800 → crop gets downscaled.
      {
        buffer: await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
          .composite([
            {
              input: await sharp({ create: { width: 1000, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } } })
                .png()
                .toBuffer(),
              left: 100,
              top: 100,
            },
          ])
          .png()
          .toBuffer(),
        timestamp_ms: 1000,
        is_interaction: false,
      },
    ];
    const { cards } = await buildDiffCards(frames, opts);
    expect(cards).toHaveLength(2);
    const full = await sharp(Buffer.from(cards[1].full_frame, "base64")).metadata();
    expect(full.width).toBe(OUTPUT_MAX_WIDTH);
    expect(full.height).toBe(450);
    const region = cards[1].change_region!;
    expect(region.bbox).toEqual({ x: 80, y: 80, width: 1040, height: 340 });
    const crop = await sharp(Buffer.from(region.crop!, "base64")).metadata();
    expect(crop.width).toBe(OUTPUT_MAX_WIDTH);
    expect(crop.height).toBe(Math.round((340 * OUTPUT_MAX_WIDTH) / 1040));
  });

  it("uses the recorder's trigger on cards, prefers it over is_interaction, and honours max_frames", async () => {
    const W = 320;
    const H = 240;
    const white = await solidPng(W, H);
    const frames: RawFrame[] = [
      { buffer: white, timestamp_ms: 0, is_interaction: false, trigger: "navigation" }, // first → still "initial"
      { buffer: white, timestamp_ms: 500, is_interaction: false, trigger: "navigation" },
      { buffer: white, timestamp_ms: 1000, is_interaction: true, trigger: "error" },
      { buffer: white, timestamp_ms: 1500, is_interaction: true },
      { buffer: white, timestamp_ms: 2000, is_interaction: false },
    ];
    const all = await buildDiffCards(frames, opts);
    expect(all.cards.map((c) => c.trigger)).toEqual(["initial", "navigation", "error", "interaction", "animation"]);
    expect(all.cards.map((c) => c.index)).toEqual([1, 2, 3, 4, 5]);

    const capped = await buildDiffCards(frames, { ...opts, max_frames: 3 });
    expect(capped.total_frames).toBe(5);
    expect(capped.cards.map((c) => c.timestamp_ms)).toEqual([0, 500, 2000]);
    expect(capped.cards.map((c) => c.index)).toEqual([1, 2, 3]);
  });
});
