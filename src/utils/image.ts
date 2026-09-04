import sharp from "sharp";
import { DIFF_HEIGHT, DIFF_WIDTH, OUTPUT_MAX_WIDTH, OVERLAY_ALPHA, OVERLAY_COLOUR } from "../constants.js";
import type { BoundingBox } from "../types.js";

/**
 * Resize a PNG for delivery to the MCP client: fit within `maxWidth`,
 * never enlarge, keep aspect ratio, re-encode as PNG.
 *
 * `quality` puts sharp into palette mode (libimagequant), which is what keeps
 * screenshots small — dropping it quadruples the payload on noisy frames. Its
 * default effort (7) is far too slow for a capture, though: a single noisy
 * 1280x720 frame costs ~600ms and one capture encodes up to 60 images.
 * `effort: 1` is ~6x faster for ~15% more bytes.
 */
export async function resizeForOutput(png: Buffer, maxWidth: number = OUTPUT_MAX_WIDTH): Promise<Buffer> {
  return sharp(png)
    .resize(maxWidth, null, { fit: "inside", withoutEnlargement: true })
    .png({ quality: 80, effort: 1, compressionLevel: 6 })
    .toBuffer();
}

/** Read the pixel dimensions of an encoded image buffer. */
export async function getDimensions(image: Buffer): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(image).metadata();
  if (width === undefined || height === undefined) {
    throw new Error("Could not read image dimensions");
  }
  return { width, height };
}

/** Base64-encode a binary buffer (MCP image content blocks expect base64 data). */
export function toBase64(buffer: Buffer): string {
  return buffer.toString("base64");
}

/**
 * Resize + grayscale a PNG to DIFF_WIDTH x DIFF_HEIGHT (fit: "fill") and
 * return raw 1-channel pixels (length DIFF_WIDTH * DIFF_HEIGHT). This is the
 * low-res representation the smart diff engine compares frames with.
 */
export async function toDiffBuffer(png: Buffer): Promise<Buffer> {
  return sharp(png).resize(DIFF_WIDTH, DIFF_HEIGHT, { fit: "fill" }).grayscale().raw().toBuffer();
}

/** Full-resolution grayscale raw pixels (1 channel) plus dimensions. */
export async function toGrayscale(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Crop a PNG to `bbox` (must already be clamped to the image) and re-encode as PNG. */
export async function cropRegion(png: Buffer, bbox: BoundingBox): Promise<Buffer> {
  return sharp(png)
    .extract({ left: bbox.x, top: bbox.y, width: bbox.width, height: bbox.height })
    .png()
    .toBuffer();
}

/**
 * Paint `mask` over `png` in OVERLAY_COLOUR and return the result as a PNG.
 *
 * This is the compare tool's diff overlay: the second page as it really looks,
 * with every pixel that differs from the first tinted, so a reviewer can see
 * *where* the two differ instead of hunting for it. The tint is translucent
 * (OVERLAY_ALPHA) so what changed stays readable underneath it.
 *
 * `mask` must be one byte per pixel, row-major, matching `width` x `height`.
 */
export async function overlayMask(png: Buffer, mask: Uint8Array, width: number, height: number): Promise<Buffer> {
  const pixels = width * height;
  if (mask.length !== pixels) {
    throw new Error(`overlayMask: mask length mismatch — expected ${pixels} (${width}x${height}), got ${mask.length}`);
  }

  const rgba = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    if (mask[i] === 0) continue;
    const at = i * 4;
    rgba[at] = OVERLAY_COLOUR.r;
    rgba[at + 1] = OVERLAY_COLOUR.g;
    rgba[at + 2] = OVERLAY_COLOUR.b;
    rgba[at + 3] = OVERLAY_ALPHA;
  }

  return sharp(png)
    .composite([{ input: rgba, raw: { width, height, channels: 4 }, blend: "over" }])
    .png()
    .toBuffer();
}
