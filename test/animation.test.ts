import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import { setAnimationSpeed } from "../src/engine/animation.js";
import { capturePage } from "../src/tools/capture.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

/** How far a 2000ms CSS animation has got after ~600ms of wall time. */
async function progressAfter600ms(speed: number | undefined): Promise<number> {
  return withPage({ viewport: { width: 400, height: 300 } }, async (page) => {
    if (speed !== undefined) await setAnimationSpeed(page, speed);
    await page.goto(`${fixtures.url}/wait.html?animate=2000`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const animation = document.getAnimations()[0] as Animation | undefined;
      return animation ? Number(animation.currentTime) : -1;
    });
  });
}

describe("setAnimationSpeed", () => {
  it("slows every CSS animation on the page by the given factor", async () => {
    const normal = await progressAfter600ms(undefined);
    const slowed = await progressAfter600ms(0.2);
    expect(normal).toBeGreaterThan(400);
    expect(slowed).toBeGreaterThan(40);
    expect(slowed).toBeLessThan(normal / 2.5);
  });
});

describe("framewatch_capture animation_speed", () => {
  it("records a slowed page and says so in the summary", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/wait.html?animate=800`,
      duration_ms: 1200,
      animation_speed: 0.25,
      watch_styles: [{ selector: "#box", properties: ["transform"], label: "box" }],
    });
    expect(result.isError).toBeFalsy();
    const texts = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
    expect(texts[0]).toContain("Animations at 0.25× speed (CSS animations and transitions; JavaScript timers run as normal)");
    // At a quarter speed the 800ms animation is still going when the 1200ms recording ends.
    const last = texts.filter((t) => /^Frame \d+ @/.test(t)).at(-1)!;
    expect(last).toMatch(/box: transform matrix/);
  });

  it("says nothing about speed at the default", async () => {
    const result = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 500 });
    expect((result.content[0] as { text: string }).text).not.toContain("Animations at");
  });

  it("rejects a speed outside 0.05 to 10", async () => {
    const result = await capturePage({ url: `${fixtures.url}/basic.html`, duration_ms: 500, animation_speed: 0 });
    expect(result.isError).toBe(true);
  });
});
