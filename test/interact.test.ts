import { afterAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser, closeSession, getBrowser } from "../src/engine/browser.js";
import { describeInteractFailure, interactInputSchema, performInteraction } from "../src/tools/interact.js";
import { LOGIN_PASSWORD, startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await closeSession();
  await fixtures.close();
  await closeBrowser();
});

// Every test starts from a blank slate unless it is explicitly about the
// session surviving between calls.
beforeEach(async () => {
  await closeSession();
});

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };
type Result = Awaited<ReturnType<typeof performInteraction>>;

function imageBlocks(result: Result): ImageBlock[] {
  return result.content.filter((c) => c.type === "image") as ImageBlock[];
}

function textBlocks(result: Result): TextBlock[] {
  return result.content.filter((c) => c.type === "text") as TextBlock[];
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

/** Output images are palette-quantised, so compare colours with a small tolerance. */
function expectColour(actual: [number, number, number], expected: [number, number, number], tolerance = 6): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
  }
}

const VIEWPORT = { width: 400, height: 300 };
const PAGE = () => `${fixtures.url}/interactive.html`;

describe("performInteraction", () => {
  it("returns a before frame, an after frame and a diff card describing the change", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#btn",
      wait_ms: 300,
      viewport: VIEWPORT,
    });

    expect(result.isError).toBeFalsy();
    const texts = textBlocks(result);
    expect(texts[0].text).toContain('click "#btn"');
    expect(texts[0].text).toContain(PAGE());
    expect(texts[0].text).toMatch(/[\d.]+% of the frame changed/);

    expect(texts[1].text).toMatch(/^Before — Frame 1 @ 0ms \[initial\]/);
    expect(texts[2].text).toMatch(/^After — Frame 2 @ \d+ms \[interaction\]/);
    expect(texts[2].text).toMatch(/Changed: [1-9][\d.]*% — region: \d+,\d+ \d+x\d+/);

    // #btn (20,20 120x40) goes blue → green and #panel (20,210 200x60) appears.
    const images = imageBlocks(result);
    expect(images.length).toBeGreaterThanOrEqual(2);
    expectColour(await pixelAt(Buffer.from(images[0].data, "base64"), 80, 40), [30, 144, 255]);
    expectColour(await pixelAt(Buffer.from(images[1].data, "base64"), 80, 40), [0, 160, 0]);
    expectColour(await pixelAt(Buffer.from(images[1].data, "base64"), 120, 240), [139, 0, 0]);
  });

  it("orders the blocks summary → before image → before meta → after image → after meta → crop", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#btn",
      wait_ms: 300,
      viewport: VIEWPORT,
    });
    expect(result.content.map((c) => c.type)).toEqual(["text", "image", "text", "image", "text", "image"]);
  });

  it("keeps the same page between calls, so state built up by earlier calls is still there", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#btn", wait_ms: 300, viewport: VIEWPORT });

    const second = await performInteraction({ action: "type", selector: "#text", value: "hi", wait_ms: 300 });
    expect(second.isError).toBeFalsy();

    // The before frame of the second call still shows the green button from the first.
    const before = Buffer.from(imageBlocks(second)[0].data, "base64");
    expectColour(await pixelAt(before, 80, 40), [0, 160, 0]);
  });

  it("navigates the current page when a later call passes a different url", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#btn", wait_ms: 300, viewport: VIEWPORT });

    const second = await performInteraction({
      url: `${fixtures.url}/recorder-target.html`,
      action: "scroll",
      delta_y: 10,
      wait_ms: 200,
    });
    expect(second.isError).toBeFalsy();
    expect(textBlocks(second)[0].text).toContain("recorder-target.html");
    // recorder-target.html is solid green.
    expectColour(await pixelAt(Buffer.from(imageBlocks(second)[0].data, "base64"), 200, 150), [0, 160, 0]);
  });

  it("asks for a url when nothing is open yet", async () => {
    const result = await performInteraction({ action: "click", selector: "#btn" });
    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    expect(textBlocks(result)[0].text).toMatch(/url/);
  });

  it("says so when the action changed nothing on screen", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "hover",
      selector: "#echo",
      wait_ms: 300,
      viewport: VIEWPORT,
    });

    expect(result.isError).toBeFalsy();
    expect(textBlocks(result)[0].text).toContain("no visual change");
    expect(textBlocks(result)[2].text).toContain("no visual change since previous frame");
  });

  it("enables touch on demand so a tap reaches a touch-only handler", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "tap",
      selector: "#touch",
      wait_ms: 300,
      viewport: VIEWPORT,
    });

    expect(result.isError).toBeFalsy();
    // #touch (220,120 120x40) turns orange only on a real touchstart.
    const images = imageBlocks(result);
    expectColour(await pixelAt(Buffer.from(images[1].data, "base64"), 280, 140), [255, 140, 0]);
  });

  it("warns that the page was reopened when a tap needs touch on a page opened without it", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#btn", wait_ms: 300, viewport: VIEWPORT });

    const tapped = await performInteraction({ action: "tap", selector: "#touch", wait_ms: 300 });
    expect(tapped.isError).toBeFalsy();
    expect(textBlocks(tapped)[0].text).toMatch(/reopened/i);
    // Reopening resets the page: the button is blue again in the before frame.
    expectColour(await pixelAt(Buffer.from(imageBlocks(tapped)[0].data, "base64"), 80, 40), [30, 144, 255]);
  });

  it("runs concurrent calls one at a time, leaving exactly one page open", async () => {
    // Unserialised, three calls all find no session and each open their own
    // context: two are orphaned (nothing can ever close them) and only the last
    // is the session. The tap also needs touch, so it reopens a page another
    // call may still be using.
    const browser = await getBrowser();
    const before = browser.contexts().length;

    const results = await Promise.all([
      performInteraction({ url: PAGE(), action: "click", selector: "#btn", wait_ms: 100, viewport: VIEWPORT }),
      performInteraction({ url: PAGE(), action: "type", selector: "#text", value: "hi", wait_ms: 100, viewport: VIEWPORT }),
      performInteraction({ url: PAGE(), action: "tap", selector: "#touch", wait_ms: 100, viewport: VIEWPORT }),
    ]);

    for (const result of results) {
      expect(result.isError, textBlocks(result)[0].text).toBeFalsy();
    }
    expect(browser.contexts().length).toBe(before + 1);
  });

  it("reports a failing interaction as an error result naming the selector", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#nope",
      timeout_ms: 400,
      viewport: VIEWPORT,
    });

    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0].text).toContain("#nope");
    expect(textBlocks(result)[0].text).toContain("400ms");
  });

  it("reports an unreachable url as an error result", async () => {
    const dead = await startFixtureServer();
    await dead.close();
    const result = await performInteraction({ url: `${dead.url}/`, action: "click", selector: "#btn" });
    expect(result.isError).toBe(true);
    expect(textBlocks(result)[0].text).toMatch(/ERR_CONNECTION_REFUSED/);
  });

  it("honours the viewport", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#btn",
      wait_ms: 200,
      viewport: { width: 320, height: 240 },
    });
    const meta = await sharp(Buffer.from(imageBlocks(result)[0].data, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
  });

  it("resizes the open page rather than reopening it when a later call asks for a different viewport", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#btn", wait_ms: 300, viewport: VIEWPORT });

    const resized = await performInteraction({
      action: "hover",
      selector: "#hover",
      wait_ms: 300,
      viewport: { width: 320, height: 240 },
    });

    const before = Buffer.from(imageBlocks(resized)[0].data, "base64");
    const meta = await sharp(before).metadata();
    expect([meta.width, meta.height]).toEqual([320, 240]);
    // #btn is green only because the previous call clicked it: the resize
    // changed the viewport without throwing the page's state away.
    expectColour(await pixelAt(before, 30, 30), [0, 160, 0]);
  });

  it("rejects an unusable step as invalid input", async () => {
    const result = await performInteraction({ url: PAGE(), action: "click" });
    expect(result.isError).toBe(true);
    expect(imageBlocks(result)).toHaveLength(0);
    expect(textBlocks(result)[0].text).toMatch(/selector/);
  });
});

describe("interactInputSchema", () => {
  it("applies the documented defaults", () => {
    const parsed = interactInputSchema.parse({ action: "click", selector: "#a" });
    expect(parsed.wait_ms).toBe(500);
    expect(parsed.timeout_ms).toBe(10_000);
    expect(parsed.url).toBeUndefined();
    expect(parsed.viewport).toBeUndefined();
  });

  it("accepts every documented interact action", () => {
    const ok = (step: Record<string, unknown>) => interactInputSchema.safeParse(step).success;
    expect(ok({ action: "click", selector: "#a" })).toBe(true);
    expect(ok({ action: "tap", x: 1, y: 2 })).toBe(true);
    expect(ok({ action: "type", selector: "#a", value: "x" })).toBe(true);
    expect(ok({ action: "scroll", delta_y: 100 })).toBe(true);
    expect(ok({ action: "swipe", x: 1, y: 2, delta_y: 50 })).toBe(true);
    expect(ok({ action: "navigate", value: "http://x/" })).toBe(true);
    expect(ok({ action: "select", selector: "#a", value: "b" })).toBe(true);
    expect(ok({ action: "hover", selector: "#a" })).toBe(true);
    expect(ok({ action: "key", value: "Enter" })).toBe(true);
    expect(ok({ action: "key", selector: "#a", value: "Control+a" })).toBe(true);
  });

  it("rejects a `key` step with no key to press", () => {
    expect(interactInputSchema.safeParse({ action: "key" }).success).toBe(false);
    expect(interactInputSchema.safeParse({ action: "key", value: "" }).success).toBe(false);
  });

  it("rejects `wait`, which belongs to framewatch_capture scripts", () => {
    expect(interactInputSchema.safeParse({ action: "wait" }).success).toBe(false);
  });
});

describe("describeInteractFailure", () => {
  it("names a missing browser install with the command that fixes it", () => {
    const message = describeInteractFailure({}, new Error("browserType.launch: Executable doesn't exist at /x/chrome"));
    expect(message).toContain("npx playwright install chromium");
  });

  it("keeps the first line of an unrecognised error rather than swallowing it", () => {
    const message = describeInteractFailure({ url: "http://a.test/" }, new Error("something odd\nstack frame\nmore"));
    expect(message).toContain("something odd");
    expect(message).not.toContain("stack frame");
  });
});

describe("interactInputSchema — refs", () => {
  const ok = (step: Record<string, unknown>) => interactInputSchema.safeParse(step).success;

  it("accepts a ref in place of a selector wherever a target is needed", () => {
    expect(ok({ action: "click", ref: "e8" })).toBe(true);
    expect(ok({ action: "type", ref: "e5", value: "x" })).toBe(true);
    expect(ok({ action: "hover", ref: "e2" })).toBe(true);
    expect(ok({ action: "select", ref: "e3", value: "b" })).toBe(true);
    expect(ok({ action: "key", ref: "e5", value: "Enter" })).toBe(true);
  });

  it("rejects a ref that is not of the form eN, and a step naming both a ref and a selector", () => {
    expect(ok({ action: "click", ref: "#btn" })).toBe(false);
    expect(ok({ action: "click", ref: "e8", selector: "#btn" })).toBe(false);
  });

  it("defaults include_snapshot to off", () => {
    expect(interactInputSchema.parse({ action: "click", ref: "e8" }).include_snapshot).toBe(false);
  });
});

describe("performInteraction — viewport line", () => {
  it("states the viewport and image scale in the headline", async () => {
    const result = await performInteraction({ url: PAGE(), action: "hover", selector: "#hover", viewport: VIEWPORT });
    expect(textBlocks(result)[0].text).toContain("viewport 400x300, images at full size");
  });
});

describe("performInteraction — Vue", () => {
  const APP = (query = "") => `${fixtures.url}/vue-app.html${query}`;

  it("navigates through vue-router without reloading, and reports the route change", async () => {
    const opened = await performInteraction({ url: APP(), action: "hover", selector: "#banner", viewport: VIEWPORT });
    expect(textBlocks(opened)[0].text).toContain("Vue 3");
    expect(textBlocks(opened)[0].text).toContain("route /vue-app.html (home)");

    // A marker that only survives if the document is not reloaded.
    const result = await performInteraction({ action: "navigate", value: "/vue-app.html/settings", wait_ms: 100 });
    expect(result.isError).toBeFalsy();
    const headline = textBlocks(result)[0].text;
    expect(headline).toContain("navigate to /vue-app.html/settings (vue-router)");
    expect(headline).toContain("route /vue-app.html (home) → /vue-app.html/settings (settings)");
  });

  it("falls back to a full load for another origin", async () => {
    await performInteraction({ url: APP(), action: "hover", selector: "#banner", viewport: VIEWPORT });
    const result = await performInteraction({ action: "navigate", value: `${fixtures.url}/basic.html`, wait_ms: 100 });
    expect(result.isError).toBeFalsy();
    expect(textBlocks(result)[0].text).toContain("navigate to ");
    expect(textBlocks(result)[0].text).not.toContain("(vue-router)");
  });

  it("acts on a late-mounting app as soon as it is up", async () => {
    const result = await performInteraction({ url: APP("/login?delay=400"), action: "click", selector: "#submit", viewport: VIEWPORT, timeout_ms: 2000 });
    expect(result.isError).toBeFalsy();
    expect(textBlocks(result)[0].text).toContain('click "#submit"');
  });
});

describe("performInteraction — login hint", () => {

  it("suggests saving the session the moment a login succeeds", async () => {
    const login = `${fixtures.url}/login.html`;
    await performInteraction({ url: login, action: "type", selector: "#email", value: "a@b.test", viewport: VIEWPORT });
    await performInteraction({ action: "type", selector: "#password", value: LOGIN_PASSWORD });
    const result = await performInteraction({ action: "click", selector: "#submit", wait_ms: 800 });
    expect(result.isError).toBeFalsy();
    expect(textBlocks(result)[0].text).toContain("Signed in? Save this session with framewatch_save_auth");
  });

  it("stays quiet when a login fails, and on pages with no login at all", async () => {
    const login = `${fixtures.url}/login.html`;
    await performInteraction({ url: login, action: "type", selector: "#email", value: "a@b.test", viewport: VIEWPORT });
    await performInteraction({ action: "type", selector: "#password", value: "wrong" });
    const failed = await performInteraction({ action: "click", selector: "#submit", wait_ms: 800 });
    expect(textBlocks(failed)[0].text).not.toContain("framewatch_save_auth");

    const plain = await performInteraction({ url: PAGE(), action: "click", selector: "#btn", viewport: VIEWPORT });
    expect(textBlocks(plain)[0].text).not.toContain("framewatch_save_auth");
  });
});
