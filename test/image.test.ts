import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { getDimensions, resizeForOutput, toBase64 } from "../src/utils/image.js";

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe("resizeForOutput", () => {
  it("shrinks a wide image to the 800px max width, keeping aspect ratio", async () => {
    const input = await solidPng(1600, 800);
    const out = await resizeForOutput(input);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(400);
  });

  it("does not enlarge an image narrower than the max width", async () => {
    const input = await solidPng(400, 300);
    const out = await resizeForOutput(input);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it("honours a custom max width", async () => {
    const input = await solidPng(1000, 500);
    const out = await resizeForOutput(input, 500);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(500);
    expect(meta.height).toBe(250);
  });
});

describe("getDimensions", () => {
  it("returns the pixel width and height of a PNG buffer", async () => {
    const input = await solidPng(123, 45);
    expect(await getDimensions(input)).toEqual({ width: 123, height: 45 });
  });
});

describe("toBase64", () => {
  it("encodes a buffer as a base64 string that round-trips", async () => {
    const input = await solidPng(10, 10);
    const encoded = toBase64(input);
    expect(typeof encoded).toBe("string");
    expect(Buffer.from(encoded, "base64").equals(input)).toBe(true);
  });
});

describe("resizeForOutput encoding", () => {
  it("uses palette quantisation (quality 80) so photo-like frames are smaller than lossless PNG", async () => {
    // Noisy image: lossless PNG compresses poorly, palette quantisation helps a lot.
    const width = 400;
    const height = 300;
    const raw = Buffer.alloc(width * height * 3);
    let seed = 42;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = seed % 256;
    }
    const lossless = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const out = await resizeForOutput(lossless);
    expect(out.length).toBeLessThan(lossless.length * 0.6);
  });
});

describe("resizeForOutput performance", () => {
  it("encodes a noisy full-viewport frame quickly enough to run 60 times per capture", async () => {
    // sharp's png({ quality }) turns on libimagequant. At the default effort
    // that costs ~600ms for a noisy 1280x720 frame — and buildDiffCards
    // encodes up to 60 images (30 full frames + 30 crops) per capture.
    const width = 1280;
    const height = 720;
    const raw = Buffer.alloc(width * height * 3);
    let seed = 7;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = seed % 256;
    }
    const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();

    const started = Date.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) await resizeForOutput(png);
    const perImage = (Date.now() - started) / runs;

    expect(perImage).toBeLessThan(300);
  });
});
