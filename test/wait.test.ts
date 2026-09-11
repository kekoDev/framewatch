import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import { waitUntil, type WaitCondition } from "../src/engine/wait.js";
import { capturePage } from "../src/tools/capture.js";
import { takeScreenshot } from "../src/tools/screenshot.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

const PAGE = (query = "") => `${fixtures.url}/wait.html${query}`;

/** Load the fixture and wait for `condition` on a fresh page. */
async function wait(query: string, condition: WaitCondition, timeout_ms = 5000) {
  return withPage({ viewport: { width: 600, height: 400 } }, async (page) => {
    await page.goto(PAGE(query), { waitUntil: "load" });
    return waitUntil(page, condition, { timeout_ms });
  });
}

describe("waitUntil", () => {
  it("images: waits for an image whose bytes arrive after load", async () => {
    const result = await wait("?image=600", "images");
    expect(result.met).toBe(true);
    expect(result.waited_ms).toBeGreaterThanOrEqual(400);
    expect(result.detail).toMatch(/1 image/);
  });

  it("images: returns at once when every image is already complete", async () => {
    const result = await wait("", "images");
    expect(result.met).toBe(true);
    expect(result.waited_ms).toBeLessThan(300);
  });

  it("images: gives up on an image that never loads, and says which", async () => {
    const result = await wait("?pending=1", "images", 800);
    expect(result.met).toBe(false);
    expect(result.waited_ms).toBeGreaterThanOrEqual(700);
    expect(result.detail).toMatch(/1 image still loading/);
  });

  it("animations: waits for a running animation to finish", async () => {
    const result = await wait("?animate=700", "animations");
    expect(result.met).toBe(true);
    expect(result.waited_ms).toBeGreaterThanOrEqual(500);
  });

  it("fonts: resolves once document.fonts is ready", async () => {
    const result = await wait("", "fonts");
    expect(result.met).toBe(true);
  });

  it("network_idle and load: resolve on a quiet page", async () => {
    expect((await wait("", "network_idle")).met).toBe(true);
    expect((await wait("", "load")).met).toBe(true);
  });

  it("vue_ready: reports no app on a page without Vue, within the timeout", async () => {
    const result = await wait("", "vue_ready", 600);
    expect(result.met).toBe(false);
    expect(result.detail).toMatch(/no Vue app/);
  });
});

describe("framewatch_screenshot wait_until", () => {
  it("waits for the condition and says how long it took", async () => {
    const result = await takeScreenshot({ url: PAGE("?image=500"), wait_until: "images", wait_ms: 0 });
    expect(result.isError).toBeFalsy();
    const text = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toMatch(/waited \d+ms for images/);
  });

  it("reports a condition that was not met, and still returns the frame", async () => {
    const result = await takeScreenshot({ url: PAGE("?pending=1"), wait_until: "images", wait_for_timeout_ms: 700, wait_ms: 0 });
    expect(result.isError).toBeFalsy();
    const text = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toMatch(/images not met after 7\d\dms \(1 image still loading of 1\)/);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("treats wait_ms as a ceiling on a Vue app, like the session tools", async () => {
    const started = Date.now();
    const result = await takeScreenshot({ url: `${fixtures.url}/vue-app.html/login?delay=300`, wait_ms: 3000 });
    expect(result.isError).toBeFalsy();
    expect(Date.now() - started).toBeLessThan(2500);
    const text = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toContain("Vue 3");
  });
});

describe("framewatch_capture wait_until", () => {
  it("starts recording only once the condition holds, and notes it", async () => {
    const result = await capturePage({ url: PAGE("?image=500"), duration_ms: 600, wait_until: "images" });
    expect(result.isError).toBeFalsy();
    const summary = (result.content[0] as { text: string }).text;
    expect(summary).toMatch(/Waited \d+ms for images \(1 image\) before recording/);
  });
});
