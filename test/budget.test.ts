import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describeBudget, fitToBudget, imageBudgetChars, markImage } from "../src/utils/budget.js";

/**
 * The image budget: a result that would exceed the client's cap loses its
 * images entirely (Claude Code writes it to a file), so every result is
 * fitted to the cap first — cheaper encoding, then crops, then size, then
 * frames — and says what it cut.
 */

type Image = { type: "image"; data: string; mimeType: string; _meta?: Record<string, unknown> };

/** A photo-like frame — a gradient with grain — which PNG stores badly and JPEG well. */
async function noise(width = 800, height = 450): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const grain = (rand() - 0.5) * 90;
      raw[i] = Math.max(0, Math.min(255, (x / width) * 255 + grain));
      raw[i + 1] = Math.max(0, Math.min(255, (y / height) * 255 + grain));
      raw[i + 2] = Math.max(0, Math.min(255, 128 + grain));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A flat frame: one colour, tiny as PNG, no smaller as JPEG. */
async function flat(width = 800, height = 450): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#3b82f6" } }).png().toBuffer();
}

const image = (png: Buffer, meta?: Record<string, unknown>): Image => ({
  type: "image",
  data: png.toString("base64"),
  mimeType: "image/png",
  ...(meta ? { _meta: { framewatch: meta } } : {}),
});
const text = (t: string) => ({ type: "text" as const, text: t });
const images = (result: CallToolResult) => result.content.filter((c) => c.type === "image") as Image[];
const texts = (result: CallToolResult) => result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
const chars = (result: CallToolResult) => images(result).reduce((n, c) => n + c.data.length, 0);
const dims = async (block: Image) => {
  const m = await sharp(Buffer.from(block.data, "base64")).metadata();
  return { width: m.width, height: m.height, format: m.format };
};

describe("imageBudgetChars", () => {
  it("is the cap minus the text and a margin, in base64 characters", () => {
    // 25000 tokens, 1000 chars of text, 1500 tokens of margin, 3 chars per token.
    expect(imageBudgetChars(25_000, 1000)).toBe((25_000 - Math.ceil(1000 / 3) - 1500) * 3);
  });

  it("never goes below zero", () => {
    expect(imageBudgetChars(1000, 100_000)).toBe(0);
  });
});

describe("fitToBudget — encoding", () => {
  it("keeps a small flat result as PNG at full size, with no note", async () => {
    const result: CallToolResult = { content: [text("hi"), image(await flat())] };
    const fitted = await fitToBudget(result, { cap_tokens: 25_000 });
    expect(fitted.content).toHaveLength(2);
    expect(images(fitted)[0].mimeType).toBe("image/png");
    expect(images(fitted)[0].data.length).toBeLessThanOrEqual(images(result)[0].data.length);
    expect((await dims(images(fitted)[0])).width).toBe(800);
    expect(texts(fitted)).toEqual(["hi"]);
  });

  it("re-encodes a photo-like image as JPEG when that is smaller, with no note", async () => {
    const png = await noise();
    const result: CallToolResult = { content: [image(png)] };
    const fitted = await fitToBudget(result, { cap_tokens: 1_000_000 });
    const [only] = images(fitted);
    expect(only.mimeType).toBe("image/jpeg");
    expect(only.data.length).toBeLessThan(png.toString("base64").length / 2);
    expect((await dims(only)).width).toBe(800);
    expect(texts(fitted)).toEqual([]);
  });

  it("strips the framewatch marker from every image it returns", async () => {
    const result: CallToolResult = { content: [image(await flat(), { role: "frame", keep: true })] };
    const fitted = await fitToBudget(result, { cap_tokens: 25_000 });
    expect(images(fitted)[0]._meta).toBeUndefined();
  });
});

describe("fitToBudget — degradation order", () => {
  it("drops crops first and says so", async () => {
    const frame = await noise();
    const crop = await noise(400, 200);
    const result: CallToolResult = {
      content: [text("summary"), image(frame), text("Frame 1"), image(crop, { role: "crop" }), image(frame), text("Frame 2"), image(crop, { role: "crop" })],
    };
    // Room for the two frames as JPEG, not for the crops as well.
    const twoFrames = (await fitToBudget({ content: [image(frame), image(frame)] }, { cap_tokens: 1_000_000 }));
    const cap = Math.ceil((chars(twoFrames) + 400) / 3) + 1500 + 20;
    const fitted = await fitToBudget(result, { cap_tokens: cap });

    expect(images(fitted)).toHaveLength(2);
    expect(fitted.content.filter((c) => c.type === "text" && (c as { text: string }).text.includes("omitted"))).toHaveLength(2);
    const note = texts(fitted).at(-1)!;
    expect(note).toMatch(/^Image budget: 2 of 4 images kept — 2 crops dropped/);
    expect(note).toContain(`MAX_MCP_OUTPUT_TOKENS=${cap}`);
    expect(note).toContain("MAX_MCP_OUTPUT_TOKENS=100000");
  });

  it("shrinks frames before dropping any", async () => {
    const frame = await noise();
    const result: CallToolResult = { content: [image(frame), image(frame), image(frame)] };
    const full = await fitToBudget(result, { cap_tokens: 1_000_000 });
    const cap = Math.ceil(chars(full) / 3 / 2) + 1500; // half the room the full-size frames need
    const fitted = await fitToBudget(result, { cap_tokens: cap });

    expect(images(fitted)).toHaveLength(3);
    const sizes = await Promise.all(images(fitted).map(dims));
    expect(sizes.every((s) => s.width === 640 || s.width === 480)).toBe(true);
    expect(texts(fitted).at(-1)).toMatch(/^Image budget: 3 of 3 images kept — frames at (640|480)px/);
  });

  it("then drops middle frames, keeping the first, the last and anything marked keep", async () => {
    const frame = await noise();
    const result: CallToolResult = {
      content: [
        image(frame, { role: "frame" }),
        image(frame, { role: "frame" }),
        image(frame, { role: "frame", keep: true }),
        image(frame, { role: "frame" }),
        image(frame, { role: "frame" }),
      ],
    };
    // Room for 3.2 frames at 480px: the two unprotected middle frames must go,
    // the first, the last and the one marked keep must stay.
    const at480 = (await sharp(frame).resize(480).jpeg({ quality: 78, mozjpeg: true }).toBuffer()).length * (4 / 3);
    const cap = Math.ceil((at480 * 3.2 + 400) / 3) + 1500 + 20;
    const fitted = await fitToBudget(result, { cap_tokens: cap });

    const positions = fitted.content.map((c, i) => (c.type === "image" ? i : -1)).filter((i) => i >= 0);
    expect(positions).toEqual([0, 2, 4]);
    expect(texts(fitted).at(-1)).toMatch(/^Image budget: 3 of 5 images kept — 2 frames dropped, frames at 480px/);
  });

  it("always keeps at least one image, shrunk as far as needed", async () => {
    const frame = await noise();
    const result: CallToolResult = { content: [text("x"), image(frame), image(frame)] };
    const fitted = await fitToBudget(result, { cap_tokens: 2500 });
    expect(images(fitted)).toHaveLength(1);
    expect((await dims(images(fitted)[0])).width).toBeLessThanOrEqual(480);
    expect(texts(fitted).at(-1)).toMatch(/^Image budget: 1 of 2 images kept/);
  });

  it("never touches text blocks, and leaves a result with no images alone", async () => {
    const result: CallToolResult = { content: [text("a"), text("b")] };
    expect(await fitToBudget(result, { cap_tokens: 10 })).toEqual(result);
  });
});

describe("markImage", () => {
  it("stamps the role and keep flag under the framewatch key", () => {
    const block = markImage({ type: "image", data: "AA==", mimeType: "image/png" }, { role: "crop" });
    expect(block._meta).toEqual({ framewatch: { role: "crop" } });
  });
});

describe("describeBudget", () => {
  it("lists what was cut, the cap it fitted, and how to raise it", () => {
    expect(describeBudget({ total: 9, kept: 4, crops_dropped: 5, frames_dropped: 0, width: 640, cap_tokens: 25_000 })).toBe(
      "Image budget: 4 of 9 images kept — 5 crops dropped, frames at 640px — to fit MAX_MCP_OUTPUT_TOKENS=25000 " +
        "(~52 KB of images per result). Set MAX_MCP_OUTPUT_TOKENS=100000 in the shell that starts Claude Code for full results.",
    );
  });
});
