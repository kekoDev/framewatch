import sharp from "sharp";
import type { CallToolResult, ImageContent } from "@modelcontextprotocol/sdk/types.js";
import {
  BUDGET_CHARS_PER_TOKEN,
  BUDGET_JPEG_QUALITY,
  BUDGET_LAST_RESORT_WIDTHS,
  BUDGET_MARGIN_TOKENS,
  BUDGET_SUGGESTED_TOKENS,
  BUDGET_WIDTHS,
  DEFAULT_MCP_OUTPUT_TOKENS,
} from "../constants.js";

/**
 * The image budget.
 *
 * Claude Code caps one MCP tool result at `MAX_MCP_OUTPUT_TOKENS` (25,000 by
 * default) and counts base64 image data toward it. A result over the cap is
 * written to a file and replaced with a reference, so the model sees no
 * images at all — and a single screenshot of a real page is 180 KB of PNG,
 * which is over on its own. Every result therefore passes through here on
 * its way out: each image is encoded the cheapest way that is still faithful,
 * and if the result still does not fit it is degraded in a fixed order —
 * crops first, then frame size, then frames from the middle — and says so.
 * Fewer images that arrive beat all of them lost.
 */

export interface ImageMark {
  /** A `crop` duplicates part of a frame and is the first thing to go. */
  role?: "frame" | "crop";
  /** Never dropped while any unmarked frame remains (first/last/interaction frames). */
  keep?: boolean;
}

const META_KEY = "framewatch";

/** Stamp an image block with its role, for `fitToBudget` to read (and strip). */
export function markImage(block: ImageContent, mark: ImageMark): ImageContent {
  return { ...block, _meta: { ...(block._meta ?? {}), [META_KEY]: mark } };
}

/** The cap in force: what the shell that started Claude Code exported, or the default. */
export function capFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MAX_MCP_OUTPUT_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_OUTPUT_TOKENS;
}

/** Base64 characters of image data a result may carry once its text is paid for. */
export function imageBudgetChars(capTokens: number, textChars: number): number {
  const textTokens = Math.ceil(textChars / BUDGET_CHARS_PER_TOKEN);
  return Math.max(0, (capTokens - textTokens - BUDGET_MARGIN_TOKENS) * BUDGET_CHARS_PER_TOKEN);
}

export interface BudgetStats {
  total: number;
  kept: number;
  crops_dropped: number;
  frames_dropped: number;
  /** Width the surviving frames were shrunk to, or undefined when untouched. */
  width?: number;
  cap_tokens: number;
}

export function describeBudget(stats: BudgetStats): string {
  const cuts: string[] = [];
  if (stats.crops_dropped > 0) cuts.push(`${stats.crops_dropped} crop${stats.crops_dropped === 1 ? "" : "s"} dropped`);
  if (stats.frames_dropped > 0) cuts.push(`${stats.frames_dropped} frame${stats.frames_dropped === 1 ? "" : "s"} dropped`);
  if (stats.width !== undefined) cuts.push(`frames at ${stats.width}px`);
  const kb = Math.round((imageBudgetChars(stats.cap_tokens, 0) * 0.75) / 1024);
  return (
    `Image budget: ${stats.kept} of ${stats.total} images kept — ${cuts.join(", ")} — to fit MAX_MCP_OUTPUT_TOKENS=${stats.cap_tokens} ` +
    `(~${kb} KB of images per result). Set MAX_MCP_OUTPUT_TOKENS=${BUDGET_SUGGESTED_TOKENS} in the shell that starts Claude Code for full results.`
  );
}

export interface FitOptions {
  /** Override the cap (tests); defaults to `capFromEnv()`. */
  cap_tokens?: number;
}

interface Candidate {
  data: string;
  mimeType: string;
}

interface Slot {
  /** Index into `result.content`. */
  index: number;
  /** The block as the tool produced it — kept verbatim when nothing beats it. */
  original: Candidate;
  role: "frame" | "crop";
  keep: boolean;
  source: Buffer;
  width: number;
  /** Encodings by width, filled lazily. */
  encoded: Map<number, Candidate>;
  dropped: boolean;
  /** Width in force for this slot (its own width when untouched). */
  at: number;
}

const OMITTED = "(image omitted — see the Image budget line)";

export async function fitToBudget(result: CallToolResult, options: FitOptions = {}): Promise<CallToolResult> {
  const content = result.content;
  const slots: Slot[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block.type !== "image") continue;
    const mark = ((block._meta ?? {})[META_KEY] ?? {}) as ImageMark;
    const source = Buffer.from(block.data, "base64");
    let width = 0;
    try {
      width = (await sharp(source).metadata()).width ?? 0;
    } catch {
      // Not an image sharp can read: leave the block exactly as it is.
      continue;
    }
    slots.push({
      index: i,
      original: { data: block.data, mimeType: block.mimeType },
      role: mark.role === "crop" ? "crop" : "frame",
      keep: mark.keep === true,
      source,
      width,
      encoded: new Map(),
      dropped: false,
      at: width,
    });
  }
  if (slots.length === 0) return result;

  const cap = options.cap_tokens ?? capFromEnv();
  const textChars = content.reduce((n, c) => (c.type === "text" ? n + c.text.length : n), 0);
  // Leave room for the note this may have to add.
  const budget = imageBudgetChars(cap, textChars + 400);

  const encode = async (slot: Slot, width: number): Promise<Candidate> => {
    const target = Math.min(width, slot.width);
    const cached = slot.encoded.get(target);
    if (cached) return cached;
    let image = sharp(slot.source);
    if (target < slot.width) image = image.resize(target, null, { fit: "inside", withoutEnlargement: true });
    const [png, jpeg] = await Promise.all([
      image.clone().png({ quality: 80, effort: 1, compressionLevel: 6 }).toBuffer(),
      image.clone().jpeg({ quality: BUDGET_JPEG_QUALITY, mozjpeg: true }).toBuffer(),
    ]);
    let best: Candidate =
      jpeg.length < png.length
        ? { data: jpeg.toString("base64"), mimeType: "image/jpeg" }
        : { data: png.toString("base64"), mimeType: "image/png" };
    // At its own size, what the tool produced is a candidate too — and when
    // it is already the smallest, it goes out untouched.
    if (target === slot.width && slot.original.data.length <= best.data.length) best = slot.original;
    slot.encoded.set(target, best);
    return best;
  };
  const total = async (): Promise<number> => {
    let sum = 0;
    for (const slot of slots) {
      if (slot.dropped) continue;
      sum += (await encode(slot, slot.at)).data.length;
    }
    return sum;
  };
  const fits = async (): Promise<boolean> => (await total()) <= budget;

  let cropsDropped = 0;
  let framesDropped = 0;
  let width: number | undefined;

  if (!(await fits())) {
    // 1. Crops duplicate what a frame already shows.
    for (const slot of slots) {
      if (slot.role === "crop" && !slot.dropped) {
        slot.dropped = true;
        cropsDropped++;
      }
    }
  }
  // 2. Smaller frames, all of them together, so they still compare.
  for (const step of BUDGET_WIDTHS) {
    if (await fits()) break;
    for (const slot of slots) if (!slot.dropped) slot.at = Math.min(slot.at, step);
    width = step;
  }
  // 3. Frames from the middle outwards: unprotected first, then protected,
  //    never the last one standing.
  if (!(await fits())) {
    const live = () => slots.filter((s) => !s.dropped);
    const order = (protectedToo: boolean): Slot[] => {
      const alive = live();
      const first = alive[0];
      const last = alive[alive.length - 1];
      const candidates = alive.filter((s) => s !== first && s !== last && (protectedToo || !s.keep));
      // Middle outwards: sort by distance from the centre, farthest last.
      const centre = (alive.length - 1) / 2;
      return candidates.sort((a, b) => Math.abs(alive.indexOf(a) - centre) - Math.abs(alive.indexOf(b) - centre));
    };
    for (const protectedToo of [false, true]) {
      for (const slot of order(protectedToo)) {
        if (await fits()) break;
        slot.dropped = true;
        framesDropped++;
      }
    }
    // Down to the first and the last; then the first goes too.
    while (!(await fits()) && live().length > 1) {
      live()[0].dropped = true;
      framesDropped++;
    }
  }
  // 4. One image left and still over: shrink it as far as it takes.
  for (const step of BUDGET_LAST_RESORT_WIDTHS) {
    if (await fits()) break;
    for (const slot of slots) if (!slot.dropped) slot.at = Math.min(slot.at, step);
    width = step;
  }

  const degraded = cropsDropped > 0 || framesDropped > 0 || width !== undefined;
  const out: CallToolResult["content"] = [];
  for (let i = 0; i < content.length; i++) {
    const slot = slots.find((s) => s.index === i);
    if (!slot) {
      out.push(content[i]);
      continue;
    }
    if (slot.dropped) {
      out.push({ type: "text", text: OMITTED });
      continue;
    }
    const best = await encode(slot, slot.at);
    const block = content[i] as ImageContent;
    const { _meta, ...rest } = block;
    const meta = _meta ? Object.fromEntries(Object.entries(_meta).filter(([key]) => key !== META_KEY)) : undefined;
    out.push({ ...rest, data: best.data, mimeType: best.mimeType, ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}) });
  }
  if (degraded) {
    const kept = slots.filter((s) => !s.dropped).length;
    out.push({
      type: "text",
      text: describeBudget({ total: slots.length, kept, crops_dropped: cropsDropped, frames_dropped: framesDropped, width, cap_tokens: cap }),
    });
  }
  return { ...result, content: out };
}
