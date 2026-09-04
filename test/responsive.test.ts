import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser } from "../src/engine/browser.js";
import { captureResponsive, responsiveInputSchema, describeViewportFailure } from "../src/tools/responsive.js";
import { DEFAULT_RESPONSIVE_VIEWPORTS, MAX_RESPONSIVE_VIEWPORTS } from "../src/constants.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type Block = { type: string; data?: string; mimeType?: string; text?: string };
type Result = Awaited<ReturnType<typeof captureResponsive>>;

const images = (result: Result): Block[] => (result.content as Block[]).filter((c) => c.type === "image");
const texts = (result: Result): string[] => (result.content as Block[]).filter((c) => c.type === "text").map((c) => c.text!);
const allText = (result: Result): string => texts(result).join("\n");

const PAGE = (): string => `${fixtures.url}/responsive.html`;

describe("captureResponsive", () => {
  it("captures the three default viewports, labelled, one image each", async () => {
    const result = await captureResponsive({ url: PAGE(), wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    expect(images(result)).toHaveLength(3);

    const text = allText(result);
    for (const viewport of DEFAULT_RESPONSIVE_VIEWPORTS) {
      expect(text).toContain(`${viewport.name} ${viewport.width}x${viewport.height}`);
    }
    expect(texts(result)[0]).toContain("Captured");
    expect(texts(result)[0]).toContain("3 of 3 viewports");
  });

  it("waits `wait_ms` before measuring, so late-rendered overflow is still found", async () => {
    const url = `${fixtures.url}/responsive-late.html`;
    const viewports = [{ name: "mobile", width: 375, height: 500 }];

    const early = await captureResponsive({ url, wait_ms: 0, viewports });
    expect(allText(early)).not.toContain("horizontal overflow");

    const late = await captureResponsive({ url, wait_ms: 800, viewports });
    expect(allText(late)).toContain("horizontal overflow");
    expect(allText(late)).toContain("1200px wide in a 375px viewport");
  });

  it("captures exactly the viewports it is given, in order", async () => {
    const result = await captureResponsive({
      url: PAGE(),
      wait_ms: 0,
      viewports: [
        { name: "tiny", width: 320, height: 240 },
        { name: "huge", width: 1200, height: 400 },
      ],
    });

    expect(images(result)).toHaveLength(2);
    const labels = texts(result).slice(1);
    expect(labels[0]).toContain("tiny 320x240");
    expect(labels[1]).toContain("huge 1200x400");
  });

  it("renders each viewport at its own size (images differ in aspect, not just scale)", async () => {
    const result = await captureResponsive({
      url: PAGE(),
      wait_ms: 0,
      viewports: [
        { name: "narrow", width: 300, height: 600 },
        { name: "wide", width: 800, height: 300 },
      ],
    });

    const [narrow, wide] = await Promise.all(
      images(result).map(async (block) => sharp(Buffer.from(block.data!, "base64")).metadata()),
    );
    // 300x600 fits under the 800px output cap untouched; 800x300 is already at it.
    expect([narrow.width, narrow.height]).toEqual([300, 600]);
    expect([wide.width, wide.height]).toEqual([800, 300]);
  });

  it("reports horizontal overflow at a viewport narrower than the content, and not at a wider one", async () => {
    const result = await captureResponsive({
      url: PAGE(),
      wait_ms: 0,
      viewports: [
        { name: "phone", width: 375, height: 500 },
        { name: "desktop", width: 1200, height: 500 },
      ],
    });

    const [summary, phone, desktop] = texts(result);
    // The fixture holds a fixed 600px block.
    expect(phone).toMatch(/horizontal overflow: content is 6\d\dpx wide in a 375px viewport/);
    expect(desktop).not.toContain("horizontal overflow");
    expect(summary).toContain("Horizontal overflow at phone");
  });

  it("says nothing about overflow when everything fits", async () => {
    const result = await captureResponsive({
      url: `${fixtures.url}/basic.html`,
      wait_ms: 0,
      viewports: [{ name: "desktop", width: 900, height: 400 }],
    });

    expect(allText(result)).not.toContain("overflow");
  });

  it("reports how far a page scrolls when it is taller than the viewport", async () => {
    const result = await captureResponsive({
      url: PAGE(),
      wait_ms: 0,
      viewports: [{ name: "short", width: 800, height: 100 }],
    });

    expect(texts(result)[1]).toMatch(/page scrolls to \d+px \(\d\.\d screens\)/);
  });

  it("keeps the viewports that worked when one of them fails, and names the one that did not", async () => {
    // `.desktop-only` is display:none below 1000px, so waiting for it to become
    // visible succeeds on the wide viewport and times out on the narrow one.
    const result = await captureResponsive({
      url: PAGE(),
      wait_ms: 0,
      wait_for: ".desktop-only",
      wait_for_timeout_ms: 600,
      viewports: [
        { name: "phone", width: 375, height: 500 },
        { name: "desktop", width: 1200, height: 500 },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(images(result)).toHaveLength(1);

    const text = allText(result);
    expect(text).toContain("1 of 2 viewports");
    expect(text).toContain("Failed: phone");
    expect(text).toContain('selector ".desktop-only" did not become visible within 600ms');
    expect(text).toContain("desktop 1200x500");
  });

  it("is an error only when every viewport failed", async () => {
    const result = await captureResponsive({
      url: "http://127.0.0.1:1/nothing-here",
      wait_ms: 0,
      viewports: [
        { name: "a", width: 300, height: 300 },
        { name: "b", width: 400, height: 400 },
      ],
    });

    expect(result.isError).toBe(true);
    const text = allText(result);
    expect(text).toContain("failed at every viewport");
    expect(text).toContain("a:");
    expect(text).toContain("b:");
  });

  it("reports invalid input as an error result rather than throwing", async () => {
    const result = await captureResponsive({ url: "not-a-url" } as never);
    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("invalid input");
  });
});

describe("responsive input schema", () => {
  it("defaults to mobile, tablet and desktop", () => {
    const parsed = responsiveInputSchema.parse({ url: "http://localhost:3000" });
    expect(parsed.viewports).toEqual([...DEFAULT_RESPONSIVE_VIEWPORTS]);
    expect(parsed.wait_ms).toBe(2000);
  });

  it("rejects an empty viewport list and one that is too long", () => {
    expect(responsiveInputSchema.safeParse({ url: "http://a.test", viewports: [] }).success).toBe(false);

    const many = Array.from({ length: MAX_RESPONSIVE_VIEWPORTS + 1 }, (_, i) => ({
      name: `v${i}`,
      width: 100,
      height: 100,
    }));
    expect(responsiveInputSchema.safeParse({ url: "http://a.test", viewports: many }).success).toBe(false);
  });

  it("rejects a viewport with no name or a non-positive size", () => {
    const bad = [
      { name: "", width: 100, height: 100 },
      { name: "x", width: 0, height: 100 },
      { name: "x", width: 100, height: -1 },
    ];
    for (const viewport of bad) {
      expect(responsiveInputSchema.safeParse({ url: "http://a.test", viewports: [viewport] }).success).toBe(false);
    }
  });
});

describe("describeViewportFailure", () => {
  it("names a missing browser install with the command that fixes it", () => {
    const message = describeViewportFailure(
      { wait_for_timeout_ms: 1000 },
      new Error("browserType.launch: Executable doesn't exist at /nope"),
    );
    expect(message).toContain("npx playwright install chromium");
  });

  it("blames the selector only when a waitForSelector call is what failed", () => {
    const input = { wait_for: "#late", wait_for_timeout_ms: 500 };
    expect(describeViewportFailure(input, new Error("page.waitForSelector: Timeout 500ms exceeded"))).toContain(
      'selector "#late" did not become visible within 500ms',
    );
    // Same selector text, but the failing call is the navigation.
    expect(describeViewportFailure(input, new Error("page.goto: net::ERR_CONNECTION_REFUSED at #late"))).not.toContain(
      "did not become visible",
    );
  });
});
