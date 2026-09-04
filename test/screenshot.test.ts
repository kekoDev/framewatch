import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser } from "../src/engine/browser.js";
import { describeFailure, screenshotInputSchema, takeScreenshot } from "../src/tools/screenshot.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

function imageBlocks(result: Awaited<ReturnType<typeof takeScreenshot>>) {
  return result.content.filter((c) => c.type === "image") as Array<{ type: "image"; data: string; mimeType: string }>;
}

async function decode(block: { data: string }) {
  const buffer = Buffer.from(block.data, "base64");
  const meta = await sharp(buffer).metadata();
  return { buffer, meta };
}

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const { width, channels } = await sharp(buffer).metadata();
  const idx = (y * (width ?? 0) + x) * (channels ?? 3);
  return [data[idx], data[idx + 1], data[idx + 2]];
}

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

describe("takeScreenshot", () => {
  it("returns a single PNG image block, resized to max 800px wide from the default 1280x720 viewport", async () => {
    const result = await takeScreenshot({ url: `${fixtures.url}/basic.html`, wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    const images = imageBlocks(result);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");

    const { meta } = await decode(images[0]);
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(450);
  });

  it("respects a custom viewport", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      viewport: { width: 600, height: 300 },
    });

    const { meta } = await decode(imageBlocks(result)[0]);
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(300);
  });

  it("screenshots only the element matching `selector`", async () => {
    const result = await takeScreenshot({ url: `${fixtures.url}/basic.html`, wait_ms: 0, selector: "#box" });

    const { buffer, meta } = await decode(imageBlocks(result)[0]);
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(100);
    // #box is dodgerblue (30,144,255)
    expectColour(await pixelAt(buffer, 100, 50), [30, 144, 255]);
  });

  it("waits for `wait_for` selector before screenshotting", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      wait_for: "#late",
      viewport: { width: 400, height: 300 },
    });

    expect(result.isError).toBeFalsy();
    const { buffer, meta } = await decode(imageBlocks(result)[0]);
    expect(meta.width).toBe(400);
    // #late (orangered) is appended after 600ms at left:300 top:30 size 120x60.
    // Without wait_for (wait_ms is 0) this pixel would still be white.
    expectColour(await pixelAt(buffer, 360, 60), [255, 69, 0]);
  });

  it("does not see late elements when neither wait_for nor wait_ms is used (control for the test above)", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      viewport: { width: 400, height: 300 },
    });
    const { buffer } = await decode(imageBlocks(result)[0]);
    expectColour(await pixelAt(buffer, 360, 60), [255, 255, 255]);
  });

  it("waits `wait_ms` after load before screenshotting", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 1200,
      viewport: { width: 400, height: 300 },
    });

    const { buffer } = await decode(imageBlocks(result)[0]);
    // Page background turns black after 600ms; bottom-right corner has no elements on top.
    expectColour(await pixelAt(buffer, 390, 290), [0, 0, 0]);
  });

  it("includes a short text summary alongside the image", async () => {
    const result = await takeScreenshot({ url: `${fixtures.url}/basic.html`, wait_ms: 0 });
    const texts = result.content.filter((c) => c.type === "text") as Array<{ type: "text"; text: string }>;
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toContain("FrameWatch Basic Fixture");
    expect(texts[0].text).toContain("800x450");
  });

  it("returns an MCP error result (not a thrown exception) for an unreachable URL", async () => {
    const closed = await startFixtureServer();
    await closed.close(); // port is now free → connection refused
    const result = await takeScreenshot({ url: `${closed.url}/`, wait_ms: 0 });

    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain(closed.url);
    expect(text).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("does not blame the element when navigation itself failed, even for a short selector", async () => {
    const closed = await startFixtureServer();
    await closed.close();
    const result = await takeScreenshot({ url: `${closed.url}/`, wait_ms: 0, selector: "a" });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toMatch(/element "a"/);
    expect(text).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("returns an MCP error result naming the element when `selector` matches nothing", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      selector: "#nope",
      wait_for_timeout_ms: 500,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('element "#nope"');
    expect(text).toMatch(/not found/i);
  });

  it("returns an MCP error result when `wait_for` never appears", async () => {
    const result = await takeScreenshot({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      wait_for: "#does-not-exist",
      wait_for_timeout_ms: 500,
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("#does-not-exist");
  });
  it("rejects wait_for_timeout_ms of 0 (Playwright would treat it as 'wait forever')", () => {
    const parsed = screenshotInputSchema.safeParse({ url: "http://localhost/", wait_for_timeout_ms: 0 });
    expect(parsed.success).toBe(false);
  });

  it("returns an MCP error result (not a thrown ZodError) for invalid input", async () => {
    const result = await takeScreenshot({ url: "not a url" });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/url/i);
  });

  it("surfaces the HTTP status in the summary when the page is an error page", async () => {
    const result = await takeScreenshot({ url: `${fixtures.url}/missing.html`, wait_ms: 0 });
    expect(result.isError).toBeFalsy(); // still a screenshot — the page rendered something
    const texts = result.content.filter((c) => c.type === "text") as Array<{ type: "text"; text: string }>;
    expect(texts[0].text).toContain("HTTP 404");
  });

  it("does not mention HTTP status for a successful page", async () => {
    const result = await takeScreenshot({ url: `${fixtures.url}/basic.html`, wait_ms: 0 });
    const texts = result.content.filter((c) => c.type === "text") as Array<{ type: "text"; text: string }>;
    expect(texts[0].text).not.toMatch(/HTTP \d+/);
  });
});

describe("describeFailure", () => {
  const base = { url: "http://localhost:3000/", wait_ms: 0, wait_for_timeout_ms: 5000 };

  it("turns Playwright's missing-browser error into an actionable install hint", () => {
    const err = new Error(
      "browserType.launch: Executable doesn't exist at /x/chromium_headless_shell-1234/chrome-headless-shell\n" +
        "╔════════════════════════════════════════════════════════════╗\n" +
        "║ Looks like Playwright Test or Playwright was just installed ║\n" +
        "║     npx playwright install                                  ║\n" +
        "╚════════════════════════════════════════════════════════════╝",
    );
    const text = describeFailure(base, err);
    expect(text).toContain("npx playwright install chromium");
  });

  it("identifies a wait_for timeout", () => {
    const err = new Error("page.waitForSelector: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#x') to be visible");
    const text = describeFailure({ ...base, wait_for: "#x" }, err);
    expect(text).toContain('"#x"');
    expect(text).toContain("5000ms");
  });

  it("identifies a selector screenshot timeout", () => {
    const err = new Error("locator.screenshot: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator('#x').first()");
    const text = describeFailure({ ...base, selector: "#x" }, err);
    expect(text).toContain('element "#x"');
  });
});
