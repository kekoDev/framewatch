import { afterAll, beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { closeBrowser, closeSession, getSessionPage, withSessionLock } from "../src/engine/browser.js";
import { inventoryPage, measureElements } from "../src/engine/inspect.js";
import { inspectElements } from "../src/tools/inspect.js";
import { snapshotPage } from "../src/tools/snapshot.js";
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

type Result = Awaited<ReturnType<typeof inspectElements>>;
const texts = (result: Result): string[] => result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
const images = (result: Result) => result.content.filter((c) => c.type === "image") as Array<{ data: string }>;

const PAGE = () => `${fixtures.url}/inspect.html`;
const VIEWPORT = { width: 800, height: 600 };

/** Measure on a fresh session page, inside the lock like the tools do. */
async function measure(targets: string[]) {
  return withSessionLock(async () => {
    const { page } = await getSessionPage({ viewport: VIEWPORT });
    await page.goto(PAGE());
    return measureElements(page, targets);
  });
}

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe("measureElements", () => {
  it("reads the box, typography, colours, spacing and neighbours of a button", async () => {
    const [cta] = await measure(["#cta"]);
    expect(cta.error).toBeUndefined();
    const m = cta.measurement!;

    expect(m.target).toBe("#cta");
    expect(m.tag).toBe("button");
    expect(m.id).toBe("cta");
    expect(m.role).toBe("button");
    expect(m.name).toBe("Get started");
    expect(m.box.x).toBe(40);
    expect(m.box.y).toBe(80);
    expect(m.box.height).toBe(36);
    expect(m.box.width).toBeGreaterThan(32);
    expect(m.visible).toBe(true);
    expect(m.in_viewport).toBe("fully");
    expect(m.clipped).toBe(false);
    expect(m.text_overflows).toBe(false);
    // Absolute positioning blockifies inline-block; the computed value is what the page renders with.
    expect(m.display).toBe("block");
    expect(m.position).toBe("absolute");
    expect(m.font.size).toBe(14);
    expect(m.font.weight).toBe(400);
    expect(m.font.line_height).toBe(20);
    expect(m.font.family).toContain("Arial");
    expect(m.color).toBe("rgb(255, 255, 255)");
    expect(m.background).toBe("rgb(59, 130, 246)");
    expect(m.padding).toEqual([8, 16, 8, 16]);
    expect(m.margin).toEqual([0, 0, 0, 0]);
    expect(m.radius).toBe("6px");
    expect(m.parent).toEqual({ tag: "div", box: { x: 20, y: 20, width: 400, height: 300 } });
    expect(m.previous?.tag).toBe("h1");
    expect(m.previous?.box).toEqual({ x: 20, y: 20, width: 400, height: 40 });
  });

  it("resolves a transparent background through the ancestors", async () => {
    const [note] = await measure(["#note"]);
    const m = note.measurement!;
    expect(m.color).toBe("rgba(0, 0, 0, 0.5)");
    expect(m.background).toBe("rgb(243, 244, 246)");
    expect(m.font.size).toBe(13);
  });

  it("reads a flex container's gap and a bordered child", async () => {
    const [row, second] = await measure(["#row", "#row span:nth-child(2)"]);
    expect(row.measurement!.gap).toBe(12);
    expect(second.measurement!.border).toBe("1px solid rgb(156, 163, 175)");
    expect(second.measurement!.previous?.box.x).toBe(40);
    expect(second.measurement!.box.x).toBe(40 + 42 + 12);
  });

  it("notices clipping, overflowing text, invisibility and being off screen", async () => {
    const [clipped, narrow, ghost, far] = await measure(["#clipped", "#narrow", "#ghost", "#far"]);
    expect(clipped.measurement!.clipped).toBe(true);
    expect(narrow.measurement!.text_overflows).toBe(true);
    expect(ghost.measurement!.visible).toBe(false);
    expect(ghost.measurement!.opacity).toBe(0);
    expect(far.measurement!.in_viewport).toBe("none");
  });

  it("names a selector that matched nothing and a ref the page does not know", async () => {
    const [nope, ref] = await measure(["#nope", "e999"]);
    expect(nope.measurement).toBeUndefined();
    expect(nope.error).toContain("matched nothing");
    expect(ref.measurement).toBeUndefined();
    expect(ref.error).toContain("framewatch_snapshot");
  });
});

describe("inventoryPage", () => {
  it("tallies the fonts, sizes, colours, spacing and radii in use", async () => {
    const inventory = await withSessionLock(async () => {
      const { page } = await getSessionPage({ viewport: VIEWPORT });
      await page.goto(PAGE());
      return inventoryPage(page);
    });

    const values = (tallies: Array<{ value: string }>) => tallies.map((t) => t.value);
    expect(inventory.elements).toBeGreaterThan(10);
    expect(inventory.text_elements).toBeGreaterThanOrEqual(5);
    expect(values(inventory.fonts).some((f) => f.includes("Arial"))).toBe(true);
    expect(values(inventory.font_sizes)).toEqual(expect.arrayContaining(["16px", "24px", "14px", "13px"]));
    expect(values(inventory.font_weights)).toEqual(expect.arrayContaining(["400", "700"]));
    expect(values(inventory.text_colours)).toEqual(expect.arrayContaining(["#6b7280", "#ffffff"]));
    expect(values(inventory.backgrounds)).toEqual(expect.arrayContaining(["#3b82f6", "#f3f4f6"]));
    expect(values(inventory.spacing)).toEqual(expect.arrayContaining(["8px", "16px", "12px"]));
    expect(values(inventory.radii)).toEqual(["6px"]);
    // Most-used first.
    expect(inventory.font_sizes[0].value).toBe("16px");
  });

  it("can be limited to a container", async () => {
    const inventory = await withSessionLock(async () => {
      const { page } = await getSessionPage({ viewport: VIEWPORT });
      await page.goto(PAGE());
      return inventoryPage(page, "#row");
    });
    expect(inventory.elements).toBe(4);
    expect(inventory.radii).toEqual([]);
  });
});

describe("inspectElements", () => {
  it("prints one block per target and boxes them on a screenshot", async () => {
    const result = await inspectElements({ url: PAGE(), viewport: VIEWPORT, targets: ["#cta", "#nope"] });

    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toMatch(/^Inspected 1 of 2 targets on .*\/inspect\.html — viewport 800x600, images at full size/);
    expect(text).toContain('1. #cta button "Get started" — <button#cta>');
    expect(text).toContain("box: 40,80 ");
    expect(text).toContain("#ffffff on #3b82f6 — contrast 3.68:1 — fails AA for normal text (needs 4.5:1)");
    expect(text).toContain("2. #nope — matched nothing");

    const shots = images(result);
    expect(shots).toHaveLength(1);
    // The box is drawn on #cta's edge in the highlight red.
    const [r, g, b] = await pixelAt(Buffer.from(shots[0].data, "base64"), 41, 81);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(120);
  });

  it("accepts a ref from the snapshot on the same session", async () => {
    const snapshot = await snapshotPage({ url: PAGE(), viewport: VIEWPORT, mode: "interactive" });
    const ref = /button "Get started" \[ref=(e\d+)\]/.exec(
      (snapshot.content[0] as { text: string }).text,
    )![1];

    const result = await inspectElements({ targets: [ref] });
    expect(result.isError).toBeFalsy();
    expect(texts(result)[0]).toContain(`1. ${ref} button "Get started" — <button#cta>`);
  });

  it("returns the design inventory when no targets are given", async () => {
    const result = await inspectElements({ url: PAGE(), viewport: VIEWPORT });
    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toMatch(/^Design inventory — \d+ elements/);
    expect(text).toContain("radii (1): 6px");
    expect(images(result)).toHaveLength(0);
  });

  it("refuses when no page is open and no url was given", async () => {
    const result = await inspectElements({ targets: ["#cta"] });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("pass `url`");
  });
});

describe("inspectElements — Vue", () => {
  const APP = (query = "") => `${fixtures.url}/vue-app.html${query}`;

  it("adds a component line with props, state and ancestry", async () => {
    const result = await inspectElements({ url: APP("/login"), viewport: VIEWPORT, targets: ["#submit"], include_screenshot: false });
    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toContain(
      '   component: LoginForm (props: title="Welcome back", max=3; state: email="", password="", loading=false, items=[3], submit=fn) in RouterView > App',
    );
  });

  it("says when a production build has no component data", async () => {
    const result = await inspectElements({ url: APP("?prod=1"), viewport: VIEWPORT, targets: ["#banner"], include_screenshot: false });
    expect(texts(result)[0]).toContain("   component: production build — no component data on elements");
  });

  it("prints no component line on a page without Vue", async () => {
    const result = await inspectElements({ url: PAGE(), viewport: VIEWPORT, targets: ["#cta"], include_screenshot: false });
    expect(texts(result)[0]).not.toContain("component:");
  });
});
