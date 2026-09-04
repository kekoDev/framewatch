import { afterAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser, closeSession, withSessionLock } from "../src/engine/browser.js";
import { computePixelMask } from "../src/engine/differ.js";
import { overlayMask } from "../src/utils/image.js";
import { OVERLAY_COLOUR } from "../src/constants.js";
import { comparePages, compareInputSchema, describeCompareFailure, CURRENT_PAGE } from "../src/tools/compare.js";
import { performInteraction } from "../src/tools/interact.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await closeSession();
  await fixtures.close();
  await closeBrowser();
});

beforeEach(async () => {
  await closeSession();
});

type Block = { type: string; data?: string; text?: string };
type Result = Awaited<ReturnType<typeof comparePages>>;

const images = (result: Result): Block[] => (result.content as Block[]).filter((c) => c.type === "image");
const texts = (result: Result): string[] => (result.content as Block[]).filter((c) => c.type === "text").map((c) => c.text!);
const allText = (result: Result): string => texts(result).join("\n");

const A = (): string => `${fixtures.url}/compare-a.html`;
const B = (): string => `${fixtures.url}/compare-b.html`;
const VIEWPORT = { width: 400, height: 300 };

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}

describe("comparePages", () => {
  it("reports two identical pages as pixel-identical, with no overlay", async () => {
    const result = await comparePages({ url_a: A(), url_b: A(), wait_ms: 0, viewport: VIEWPORT });

    expect(result.isError).toBeFalsy();
    expect(allText(result)).toContain("0.00% of pixels differ");
    expect(allText(result)).toContain("pixel-identical");
    // Both frames, and nothing else: there is no change to overlay.
    expect(images(result)).toHaveLength(2);
  });

  it("reports what changed, where, and returns an overlay as a third image", async () => {
    const result = await comparePages({ url_a: A(), url_b: B(), wait_ms: 0, viewport: VIEWPORT });

    expect(result.isError).toBeFalsy();
    expect(images(result)).toHaveLength(3);

    const text = allText(result);
    // The fixture's block is 100x60 in a 400x300 viewport: 6000/120000 = 5%.
    expect(text).toMatch(/5\.00% of pixels differ/);
    // Padded by CROP_PADDING_PX around the block at 40,30 100x60.
    expect(text).toContain("20,10 140x100");
    expect(text).toContain("Diff overlay");
    expect(text).toContain("6000 of 120000 pixels changed");
  });

  it("tints the changed pixels in the overlay and leaves the rest of the frame alone", async () => {
    const result = await comparePages({ url_a: A(), url_b: B(), wait_ms: 0, viewport: VIEWPORT });
    const overlay = Buffer.from(images(result)[2].data!, "base64");

    // Inside the block that changed colour: tinted.
    const [r, g, b] = await pixelAt(overlay, 90, 60);
    expect(r).toBeGreaterThan(150);
    expect(b).toBeGreaterThan(100);
    expect(g).toBeLessThan(120);

    // Outside it, the page's own white background survives.
    const outside = await pixelAt(overlay, 300, 250);
    for (const channel of outside) expect(channel).toBeGreaterThan(230);
  });

  it("names both sides, with their titles, in the summary and the frame labels", async () => {
    const result = await comparePages({ url_a: A(), url_b: B(), wait_ms: 0, viewport: VIEWPORT });
    const text = allText(result);

    expect(text).toContain('"Compare A"');
    expect(text).toContain('"Compare B"');
    expect(texts(result)[1]).toMatch(/^A — /);
    expect(texts(result)[2]).toMatch(/^B — /);
  });

  it("compares the page framewatch_interact has open, in the state it was left in", async () => {
    // Click the fixture's button, then compare that live state against the
    // untouched page: the difference is exactly what the click did.
    await performInteraction({
      url: `${fixtures.url}/interactive.html`,
      action: "click",
      selector: "#btn",
      wait_ms: 300,
      viewport: VIEWPORT,
    });

    const result = await comparePages({
      url_a: CURRENT_PAGE,
      url_b: `${fixtures.url}/interactive.html`,
      wait_ms: 200,
    });

    expect(result.isError).toBeFalsy();
    const text = allText(result);
    expect(text).toContain("the open page (");
    // Both were captured at the open page's size, so they are comparable.
    expect(text).toContain(`${VIEWPORT.width}x${VIEWPORT.height}`);
    expect(text).not.toContain("different sizes");
    expect(images(result).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the open page's size rather than resizing it, and says so", async () => {
    await performInteraction({
      url: `${fixtures.url}/compare-a.html`,
      action: "hover",
      selector: "#block",
      wait_ms: 0,
      viewport: VIEWPORT,
    });

    const result = await comparePages({
      url_a: CURRENT_PAGE,
      url_b: B(),
      wait_ms: 0,
      viewport: { width: 900, height: 600 },
    });

    const text = allText(result);
    expect(text).toContain("Ignored `viewport` 900x600");
    expect(text).toContain("400x300");
    expect(text).not.toContain("different sizes");
  });

  it('accepts the open page as the second side too, capturing both at its size', async () => {
    await performInteraction({
      url: `${fixtures.url}/compare-b.html`,
      action: "hover",
      selector: "#block",
      wait_ms: 0,
      viewport: VIEWPORT,
    });

    const result = await comparePages({ url_a: A(), url_b: CURRENT_PAGE, wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    const text = allText(result);
    expect(text).not.toContain("different sizes");
    expect(text).toContain(`${VIEWPORT.width}x${VIEWPORT.height}`);
    // Same two fixtures as the plain URL-vs-URL comparison, so the same 5%.
    expect(text).toMatch(/5\.00% of pixels differ/);
    expect(texts(result)[2]).toContain("the open page (");
  });

  it('errors helpfully when "current" is asked for and nothing is open', async () => {
    const result = await comparePages({ url_a: CURRENT_PAGE, url_b: B(), wait_ms: 0 });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("no page is open");
    expect(allText(result)).toContain("framewatch_interact");
  });

  it("names which of the two sides could not be opened", async () => {
    const result = await comparePages({ url_a: A(), url_b: "http://127.0.0.1:1/gone", wait_ms: 0, viewport: VIEWPORT });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("could not open url_b (http://127.0.0.1:1/gone)");
  });

  it("reports invalid input as an error result, explaining both accepted forms", async () => {
    const result = await comparePages({ url_a: "nonsense", url_b: B() });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("invalid input");
    expect(allText(result)).toContain('"current"');
  });
});

describe("session lock", () => {
  it("runs everything that touches the session page one at a time, in order", async () => {
    const order: string[] = [];
    const step = (name: string, ms: number): Promise<void> =>
      withSessionLock(async () => {
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name}:end`);
      });

    await Promise.all([step("a", 40), step("b", 5), step("c", 5)]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("keeps the chain alive when one of them fails", async () => {
    const failing = withSessionLock(async () => {
      throw new Error("nope");
    });
    const after = withSessionLock(async () => "still here");

    await expect(failing).rejects.toThrow("nope");
    await expect(after).resolves.toBe("still here");
  });

  it("does not read the open page while an interaction is half way through it", async () => {
    const order: string[] = [];
    const interaction = performInteraction({
      url: `${fixtures.url}/interactive.html`,
      action: "click",
      selector: "#btn",
      wait_ms: 400,
      viewport: VIEWPORT,
    }).then(() => order.push("interaction"));

    // Issued in parallel, as an MCP client is free to do.
    const comparison = comparePages({ url_a: CURRENT_PAGE, url_b: B(), wait_ms: 0 }).then((result) => {
      order.push("compare");
      return result;
    });

    const [, result] = await Promise.all([interaction, comparison]);
    expect(order).toEqual(["interaction", "compare"]);
    expect(result.isError).toBeFalsy();
  });
});

describe("compare input schema", () => {
  it('accepts a URL or the literal "current" on either side', () => {
    expect(compareInputSchema.safeParse({ url_a: "http://a.test", url_b: "http://b.test" }).success).toBe(true);
    expect(compareInputSchema.safeParse({ url_a: CURRENT_PAGE, url_b: "http://b.test" }).success).toBe(true);
    expect(compareInputSchema.safeParse({ url_a: "http://a.test", url_b: CURRENT_PAGE }).success).toBe(true);
  });

  it("rejects anything that is neither", () => {
    expect(compareInputSchema.safeParse({ url_a: "currently", url_b: "http://b.test" }).success).toBe(false);
    expect(compareInputSchema.safeParse({ url_a: "http://a.test", url_b: "/relative" }).success).toBe(false);
  });

  it("defaults the settle time to 2s", () => {
    expect(compareInputSchema.parse({ url_a: "http://a.test", url_b: "http://b.test" }).wait_ms).toBe(2000);
  });
});

describe("describeCompareFailure", () => {
  const input = { url_a: "http://a.test/", url_b: "http://b.test/", wait_for_timeout_ms: 1000 };

  it("names a missing browser install with the command that fixes it", () => {
    expect(describeCompareFailure(input, new Error("browserType.launch: Executable doesn't exist"))).toContain(
      "npx playwright install chromium",
    );
  });

  it("names the selector that never appeared, with the timeout it waited", () => {
    const withSelector = { ...input, wait_for: "#never" };
    const message = describeCompareFailure(
      withSelector,
      new Error("page.waitForSelector: Timeout 1000ms exceeded."),
    );
    expect(message).toContain('selector "#never" did not become visible within 1000ms');
  });

  it("attributes a navigation failure to the side whose URL it names", () => {
    expect(describeCompareFailure(input, new Error("page.goto: net::ERR_FAILED at http://a.test/"))).toContain("url_a");
    expect(describeCompareFailure(input, new Error("page.goto: net::ERR_FAILED at http://b.test/"))).toContain("url_b");
    expect(describeCompareFailure(input, new Error("page.goto: net::ERR_FAILED"))).toContain("one of the two pages");
  });
});

describe("computePixelMask", () => {
  it("marks exactly the pixels that differ by more than the threshold", () => {
    const prev = Buffer.from([0, 0, 0, 0]);
    const curr = Buffer.from([0, 255, 10, 0]);
    const result = computePixelMask(prev, curr, 2, 2);

    expect([...result.mask]).toEqual([0, 1, 0, 0]);
    expect(result.changedPixels).toBe(1);
    expect(result.changePercent).toBe(25);
    expect(result.bbox).toEqual({ x: 1, y: 0, width: 1, height: 1 });
  });

  it("agrees with computePixelDiff and reports nothing for identical buffers", () => {
    const same = Buffer.alloc(16, 128);
    const result = computePixelMask(same, same, 4, 4);
    expect(result.changedPixels).toBe(0);
    expect(result.bbox).toBeNull();
    expect([...result.mask].every((byte) => byte === 0)).toBe(true);
  });

  it("refuses buffers that are not the size it was told", () => {
    expect(() => computePixelMask(Buffer.alloc(3), Buffer.alloc(4), 2, 2)).toThrow(/buffer length mismatch/);
  });
});

describe("overlayMask", () => {
  it("paints the mask in the overlay colour and leaves unmasked pixels untouched", async () => {
    const white = await sharp({ create: { width: 4, height: 1, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer();
    const mask = new Uint8Array([0, 1, 0, 0]);

    const out = await overlayMask(white, mask, 4, 1);
    const [tinted, untouched] = [await pixelAt(out, 1, 0), await pixelAt(out, 0, 0)];

    expect(tinted[0]).toBeGreaterThan(200);
    expect(tinted[1]).toBeLessThan(OVERLAY_COLOUR.g + 80);
    expect(untouched).toEqual([255, 255, 255]);
  });

  it("refuses a mask that does not match the image size", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000000" } })
      .png()
      .toBuffer();
    await expect(overlayMask(png, new Uint8Array(3), 2, 2)).rejects.toThrow(/mask length mismatch/);
  });
});
