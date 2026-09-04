import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import { HIGHLIGHT_CONTAINER_ID, clearHighlights, highlightElements } from "../src/utils/highlight.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

async function onPage<T>(file: string, fn: (page: Page) => Promise<T>): Promise<T> {
  return withPage({ viewport: { width: 900, height: 700 } }, async (page) => {
    await page.goto(`${fixtures.url}/${file}`, { waitUntil: "load" });
    return fn(page);
  });
}

/** Where a drawn box ended up, and where the element it is meant to cover is. */
const rects = (page: Page, index: number, selector: string, targetIndex = 0) =>
  page.evaluate(
    (options: { id: string; index: number; selector: string; target_index: number }) => {
      const box = document.getElementById(options.id)?.children[options.index];
      const target = document.querySelectorAll(options.selector)[options.target_index];
      const read = (node: Element | null | undefined) => {
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      return { box: read(box), target: read(target) };
    },
    { id: HIGHLIGHT_CONTAINER_ID, index, selector, target_index: targetIndex },
  );

const boxCount = (page: Page): Promise<number> =>
  page.evaluate((id: string) => document.getElementById(id)?.children.length ?? 0, HIGHLIGHT_CONTAINER_ID);

describe("highlightElements", () => {
  it("draws a box exactly over the element it names", async () => {
    const measured = await onPage("highlight.html", async (page) => {
      await highlightElements(page, [{ selector: "#target", label: "1" }]);
      return rects(page, 0, "#target");
    });

    // <body> here is positioned and has a margin: a box laid out in plain
    // document coordinates would be 40px out in both directions.
    expect(measured.box).toEqual(measured.target);
  });

  it("draws over an element far below the fold, in document coordinates", async () => {
    const measured = await onPage("highlight.html", async (page) => {
      await highlightElements(page, [{ selector: "#below" }]);
      return rects(page, 0, "#below");
    });

    expect(measured.box).toEqual(measured.target);
  });

  it("picks the match it was asked for when a selector is not unique", async () => {
    const measured = await onPage("highlight.html", async (page) => {
      await highlightElements(page, [{ selector: ".row", match_index: 1 }]);
      return rects(page, 0, ".row", 1);
    });

    expect(measured.box).toEqual(measured.target);
  });

  it("reports what it could not draw instead of failing", async () => {
    const result = await onPage("highlight.html", (page) =>
      highlightElements(page, [{ selector: "#target" }, { selector: "#gone" }, { selector: "#sizeless" }]),
    );

    expect(result.drawn).toEqual(["#target"]);
    // An element with no size on screen has no box to draw, exactly like one
    // that is not there at all.
    expect(result.missing).toEqual(["#gone", "#sizeless"]);
  });

  it("survives a selector the browser will not parse", async () => {
    const result = await onPage("highlight.html", (page) => highlightElements(page, [{ selector: "#a b[" }]));

    expect(result.drawn).toEqual([]);
    expect(result.missing).toEqual(["#a b["]);
  });

  it("draws no more boxes than it is allowed to", async () => {
    const drawn = await onPage("highlight.html", async (page) => {
      const result = await highlightElements(page, [{ selector: "#target" }, { selector: "#below" }], 1);
      return { result, boxes: await boxCount(page) };
    });

    expect(drawn.result.drawn).toEqual(["#target"]);
    expect(drawn.boxes).toBe(1);
  });

  it("replaces the previous overlay rather than stacking another one on top", async () => {
    const boxes = await onPage("highlight.html", async (page) => {
      await highlightElements(page, [{ selector: "#target" }, { selector: "#below" }]);
      await highlightElements(page, [{ selector: "#target" }]);
      return boxCount(page);
    });

    expect(boxes).toBe(1);
  });

  it("works on a page with a Content-Security-Policy, which is the kind worth auditing", async () => {
    // Styles go in through the CSSOM, which a CSP does not police; a <style>
    // block or a style attribute would be refused here.
    const drawn = await onPage("csp.html", async (page) => {
      const result = await highlightElements(page, [{ selector: "h1" }]);
      return { result, boxes: await boxCount(page) };
    });

    expect(drawn.result.drawn).toEqual(["h1"]);
    expect(drawn.boxes).toBe(1);
  });

  it("does nothing at all when given nothing to draw", async () => {
    const result = await onPage("highlight.html", (page) => highlightElements(page, []));

    expect(result).toEqual({ drawn: [], missing: [] });
  });
});

describe("clearHighlights", () => {
  it("takes the whole overlay back off the page", async () => {
    const present = await onPage("highlight.html", async (page) => {
      await highlightElements(page, [{ selector: "#target" }]);
      const before = await page.$(`#${HIGHLIGHT_CONTAINER_ID}`);
      await clearHighlights(page);
      return { before: before !== null, after: (await page.$(`#${HIGHLIGHT_CONTAINER_ID}`)) !== null };
    });

    expect(present).toEqual({ before: true, after: false });
  });

  it("is safe to call when there is no overlay to remove", async () => {
    await expect(onPage("highlight.html", (page) => clearHighlights(page))).resolves.toBeUndefined();
  });
});

describe("highlightElements — from a box", () => {
  it("draws where the box says, without looking the selector up", async () => {
    const result = await onPage("highlight.html", async (page) => {
      const drawn = await highlightElements(page, [
        { selector: "e8", box: { x: 100, y: 50, width: 80, height: 30 }, label: "1" },
      ]);
      const rect = await page.evaluate((id: string) => {
        const box = document.getElementById(id)!.children[0] as HTMLElement;
        const r = box.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, HIGHLIGHT_CONTAINER_ID);
      return { drawn, rect };
    });
    expect(result.drawn).toEqual({ drawn: ["e8"], missing: [] });
    expect(result.rect).toEqual({ x: 100, y: 50, width: 80, height: 30 });
  });
});
