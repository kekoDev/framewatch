import {
  CELL_THRESHOLD,
  CROP_PADDING_PX,
  CROP_SKIP_COVERAGE,
  DIFF_HEIGHT,
  DIFF_WIDTH,
  GRID_SIZE,
  MERGE_WINDOW_MS,
  PIXEL_THRESHOLD,
} from "../constants.js";
import type {
  BoundingBox,
  ChangeRegion,
  DiffCard,
  FrameTrigger,
  GridDiffResult,
  PixelDiffResult,
  PixelMaskResult,
  RawFrame,
} from "../types.js";
import { cropRegion, resizeForOutput, toBase64, toDiffBuffer, toGrayscale } from "../utils/image.js";

/**
 * Smart diff engine.
 *
 * Pure image/array logic — no Playwright. Frames are compared on a low-res
 * grayscale grid (fast, tolerant of noise) to decide which ones to keep, then
 * the kept frames are compared pixel-by-pixel at full resolution to locate the
 * exact change region for cropping.
 */

function assertSameSize(fn: string, prev: Buffer, curr: Buffer, width: number, height: number): void {
  const expected = width * height;
  if (prev.length !== expected || curr.length !== expected) {
    throw new Error(
      `${fn}: buffer length mismatch — expected ${expected} (${width}x${height}), got ${prev.length} and ${curr.length}`,
    );
  }
}

/**
 * Grid comparison of two same-size 1-channel raw buffers.
 *
 * The image is divided into GRID_SIZE x GRID_SIZE cells of
 * floor(width / GRID_SIZE) x floor(height / GRID_SIZE) pixels. A cell counts
 * as changed when its mean absolute pixel difference exceeds CELL_THRESHOLD.
 * The bbox is the union of all changed cells, in buffer coordinates.
 *
 * @throws if either buffer's length is not width * height.
 */
export function computeGridDiff(prev: Buffer, curr: Buffer, width: number, height: number): GridDiffResult {
  assertSameSize("computeGridDiff", prev, curr, width, height);

  const cellWidth = Math.floor(width / GRID_SIZE);
  const cellHeight = Math.floor(height / GRID_SIZE);
  const cellPixels = cellWidth * cellHeight;
  const totalCells = GRID_SIZE * GRID_SIZE;

  let changedCells = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;

  for (let gy = 0; gy < GRID_SIZE; gy++) {
    const y0 = gy * cellHeight;
    const y1 = y0 + cellHeight;
    for (let gx = 0; gx < GRID_SIZE; gx++) {
      const x0 = gx * cellWidth;
      const x1 = x0 + cellWidth;
      let cellDiff = 0;
      for (let py = y0; py < y1; py++) {
        const row = py * width;
        for (let px = x0; px < x1; px++) {
          const idx = row + px;
          const d = prev[idx] - curr[idx];
          cellDiff += d < 0 ? -d : d;
        }
      }
      if (cellPixels > 0 && cellDiff / cellPixels > CELL_THRESHOLD) {
        changedCells++;
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
      }
    }
  }

  const bbox: BoundingBox | null =
    changedCells > 0 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;

  return { changedCells, totalCells, changeRatio: changedCells / totalCells, bbox };
}

/**
 * Per-pixel comparison of two same-size 1-channel raw buffers at full
 * resolution. A pixel counts as changed when |prev - curr| > PIXEL_THRESHOLD.
 * The bbox is tight and inclusive of the last changed pixel
 * (width = maxX - minX + 1); changePercent is 0..100.
 *
 * @throws if either buffer's length is not width * height.
 */
export function computePixelDiff(prev: Buffer, curr: Buffer, width: number, height: number): PixelDiffResult {
  assertSameSize("computePixelDiff", prev, curr, width, height);

  const totalPixels = width * height;
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const d = prev[idx] - curr[idx];
      if (d > PIXEL_THRESHOLD || d < -PIXEL_THRESHOLD) {
        changedPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bbox: BoundingBox | null =
    changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;

  return {
    changedPixels,
    totalPixels,
    changePercent: totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0,
    bbox,
  };
}

/**
 * `computePixelDiff` plus the mask itself: one byte per pixel, 1 where the
 * pixel changed. `framewatch_compare` paints that mask over the second image
 * so a reviewer can see *where* two pages differ, not just by how much.
 *
 * Kept separate from `computePixelDiff` because the capture path runs it on
 * every card and has no use for a second full-frame buffer per frame.
 *
 * @throws if either buffer's length is not width * height.
 */
export function computePixelMask(prev: Buffer, curr: Buffer, width: number, height: number): PixelMaskResult {
  assertSameSize("computePixelMask", prev, curr, width, height);

  const totalPixels = width * height;
  const mask = new Uint8Array(totalPixels);
  let changedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const d = prev[idx] - curr[idx];
      if (d > PIXEL_THRESHOLD || d < -PIXEL_THRESHOLD) {
        mask[idx] = 1;
        changedPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bbox: BoundingBox | null =
    changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;

  return {
    mask,
    changedPixels,
    totalPixels,
    changePercent: totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0,
    bbox,
  };
}

/** Pad a bbox by `padding` on every side and clamp it to [0, 0, frameWidth, frameHeight]. */
export function padBoundingBox(bbox: BoundingBox, padding: number, frameWidth: number, frameHeight: number): BoundingBox {
  const x0 = Math.max(0, bbox.x - padding);
  const y0 = Math.max(0, bbox.y - padding);
  const x1 = Math.min(frameWidth, bbox.x + bbox.width + padding);
  const y1 = Math.min(frameHeight, bbox.y + bbox.height + padding);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Decide whether a frame with the given grid change ratio should be kept.
 * sensitivity <= 0 → always true ("keep all"); sensitivity >= 1 → always
 * false ("keep none"); otherwise changeRatio > sensitivity (so the default
 * 0.06 keeps 4/64 = 0.0625 and drops 3/64).
 */
export function exceedsSensitivity(changeRatio: number, sensitivity: number): boolean {
  if (sensitivity <= 0) return true;
  if (sensitivity >= 1) return false;
  return changeRatio > sensitivity;
}

export interface FrameSelectionInput {
  timestamp_ms: number;
  is_interaction: boolean;
  trigger?: FrameTrigger;
}

export interface SelectFramesOptions {
  /** Grid change ratio a frame must exceed to be kept (0 = keep all, 1 = keep none). */
  sensitivity: number;
  /** Hard cap on the number of frames returned. */
  max_frames: number;
}

/** A frame is forced when the recorder captured it because of an event; the differ always keeps it. */
function isForced(frame: FrameSelectionInput): boolean {
  return frame.is_interaction || frame.trigger !== undefined;
}

/** Protected frames (first, last, forced) are never dropped by merging or by the max_frames cap. */
function isProtected(frames: FrameSelectionInput[], index: number): boolean {
  return index === 0 || index === frames.length - 1 || isForced(frames[index]);
}

/**
 * Pure selection logic — decides which raw frame indices become diff cards.
 * `diffBuffers[i]` is the low-res diff buffer (see `toDiffBuffer`) for
 * `frames[i]`. Returns ascending raw-frame indices.
 *
 * Rules, in order:
 *  1. Frame 0 is always kept.
 *  2. Each later frame is compared (grid diff) against the LAST KEPT frame —
 *     not the previous raw frame, so slow drifts accumulate and are eventually
 *     kept. Forced frames (interaction / trigger) are kept regardless.
 *  3. The last frame is always kept.
 *  4. Kept frames within MERGE_WINDOW_MS of the first frame of a cluster are
 *     merged into that cluster's last ("settled") frame, unless protected
 *     (first, last, forced). Windows are anchored, not sliding, so a
 *     continuous animation is thinned to ~every MERGE_WINDOW_MS, not
 *     collapsed to one frame.
 *  5. If still over `max_frames`, protected frames are kept first and the
 *     remaining slots are filled by sampling unprotected frames evenly.
 */
export function selectFrames(frames: FrameSelectionInput[], diffBuffers: Buffer[], options: SelectFramesOptions): number[] {
  if (frames.length === 0) return [];

  // Rules 1–2: walk frames, comparing against the last kept frame.
  const kept: number[] = [0];
  let lastKept = 0;
  for (let i = 1; i < frames.length; i++) {
    let keep = isForced(frames[i]);
    if (!keep) {
      const grid = computeGridDiff(diffBuffers[lastKept], diffBuffers[i], DIFF_WIDTH, DIFF_HEIGHT);
      keep = exceedsSensitivity(grid.changeRatio, options.sensitivity);
    }
    if (keep) {
      kept.push(i);
      lastKept = i;
    }
  }

  // Rule 3: the last frame is always kept.
  const last = frames.length - 1;
  if (kept[kept.length - 1] !== last) kept.push(last);

  return capFrames(frames, mergeCloseFrames(frames, kept), options.max_frames);
}

/**
 * Rule 4 — merge kept frames that are closer than MERGE_WINDOW_MS.
 *
 * A frame is protected when it is the first, the last, or forced; protected
 * frames are never dropped and never absorb neighbours. For unprotected
 * frames, a window is anchored at the first frame of a cluster: every
 * following unprotected frame within MERGE_WINDOW_MS of that anchor belongs
 * to the cluster, and only the cluster's last ("settled") frame survives. The
 * next cluster starts at the first frame outside the window — windows never
 * slide, so a continuous 100ms-step animation is thinned to roughly every
 * MERGE_WINDOW_MS rather than collapsed to a single frame.
 */
function mergeCloseFrames(frames: FrameSelectionInput[], kept: number[]): number[] {
  const merged: number[] = [];
  let j = 0;
  while (j < kept.length) {
    if (isProtected(frames, kept[j])) {
      merged.push(kept[j]);
      j++;
      continue;
    }
    const anchorTs = frames[kept[j]].timestamp_ms;
    let k = j;
    while (
      k + 1 < kept.length &&
      !isProtected(frames, kept[k + 1]) &&
      frames[kept[k + 1]].timestamp_ms - anchorTs < MERGE_WINDOW_MS
    ) {
      k++;
    }
    merged.push(kept[k]);
    j = k + 1;
  }
  return merged;
}

/**
 * Rule 5 — enforce `max_frames`.
 *
 * Protected frames (first, last, forced) are kept first. If they alone exceed
 * the cap, the first and last frames win, then forced frames in time order
 * until the cap is hit. Otherwise the remaining slots are filled with
 * unprotected frames sampled evenly by position. Output stays ascending.
 */
function capFrames(frames: FrameSelectionInput[], kept: number[], maxFrames: number): number[] {
  if (maxFrames < 1) maxFrames = 1;
  if (kept.length <= maxFrames) return kept;

  const last = frames.length - 1;
  const protectedFrames: number[] = [];
  const unprotected: number[] = [];
  for (const index of kept) {
    if (isProtected(frames, index)) protectedFrames.push(index);
    else unprotected.push(index);
  }

  let chosen: number[];
  if (protectedFrames.length >= maxFrames) {
    // First and last take priority, then the earliest forced frames.
    const ends = protectedFrames.filter((i) => i === 0 || i === last);
    const forced = protectedFrames.filter((i) => i !== 0 && i !== last);
    chosen = [...ends, ...forced.slice(0, Math.max(0, maxFrames - ends.length))];
    if (chosen.length > maxFrames) chosen = chosen.slice(0, maxFrames);
  } else {
    const slots = maxFrames - protectedFrames.length;
    const sampled: number[] = [];
    for (let i = 0; i < slots; i++) {
      // Centred even sampling: pick the middle of each of `slots` equal bands.
      sampled.push(unprotected[Math.floor(((i + 0.5) * unprotected.length) / slots)]);
    }
    chosen = [...protectedFrames, ...sampled];
  }

  return chosen.sort((a, b) => a - b);
}

export interface BuildDiffCardsOptions {
  sensitivity: number;
  max_frames: number;
}

export interface DiffCardsResult {
  cards: DiffCard[];
  /** Number of raw frames that were examined. */
  total_frames: number;
}

/**
 * End-to-end: raw frames → diff cards. Computes the low-res diff buffer for
 * every frame, runs `selectFrames`, then builds one card per selected frame
 * with the resized full frame and (for every card but the first) the padded
 * full-resolution change region versus the previous CARD, plus its crop.
 */
export async function buildDiffCards(frames: RawFrame[], options: BuildDiffCardsOptions): Promise<DiffCardsResult> {
  if (frames.length === 0) return { cards: [], total_frames: 0 };

  const diffBuffers = await Promise.all(frames.map((f) => toDiffBuffer(f.buffer)));
  const selected = selectFrames(frames, diffBuffers, options);

  const cards: DiffCard[] = [];
  let prevGray: { data: Buffer; width: number; height: number } | null = null;

  for (let c = 0; c < selected.length; c++) {
    const frame = frames[selected[c]];
    const card: DiffCard = {
      index: c + 1,
      timestamp_ms: frame.timestamp_ms,
      trigger: cardTrigger(frame, c === 0),
      full_frame: toBase64(await resizeForOutput(frame.buffer)),
    };

    const gray = await toGrayscale(frame.buffer);
    if (prevGray !== null) {
      card.change_region = await buildChangeRegion(prevGray, gray, frame.buffer);
    }
    prevGray = gray;
    cards.push(card);
  }

  return { cards, total_frames: frames.length };
}

/** First card is "initial"; otherwise the recorder's trigger, or "interaction", or "animation". */
function cardTrigger(frame: RawFrame, isFirst: boolean): FrameTrigger {
  if (isFirst) return "initial";
  if (frame.trigger !== undefined) return frame.trigger;
  return frame.is_interaction ? "interaction" : "animation";
}

/**
 * Full-resolution change region between two consecutive cards: padded pixel
 * bbox plus a crop of the current frame, unless the padded bbox already covers
 * >= CROP_SKIP_COVERAGE of the frame (the full frame shows the same thing).
 * Frames of different sizes (e.g. across a viewport change) are treated as a
 * whole-frame change.
 */
async function buildChangeRegion(
  prev: { data: Buffer; width: number; height: number },
  curr: { data: Buffer; width: number; height: number },
  currPng: Buffer,
): Promise<ChangeRegion> {
  const { width, height } = curr;

  let pixelBbox: BoundingBox | null;
  let changePercent: number;
  if (prev.width !== width || prev.height !== height) {
    pixelBbox = { x: 0, y: 0, width, height };
    changePercent = 100;
  } else {
    const diff = computePixelDiff(prev.data, curr.data, width, height);
    pixelBbox = diff.bbox;
    changePercent = diff.changePercent;
  }

  if (pixelBbox === null) {
    return { bbox: { x: 0, y: 0, width: 0, height: 0 }, change_percent: 0 };
  }

  const bbox = padBoundingBox(pixelBbox, CROP_PADDING_PX, width, height);
  const region: ChangeRegion = { bbox, change_percent: changePercent };

  const coverage = (bbox.width * bbox.height) / (width * height);
  if (coverage < CROP_SKIP_COVERAGE) {
    region.crop = toBase64(await resizeForOutput(await cropRegion(currPng, bbox)));
  }
  return region;
}
