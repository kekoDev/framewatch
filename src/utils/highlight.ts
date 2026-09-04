import type { Page } from "playwright";
import { MAX_HIGHLIGHTS } from "../constants.js";
import type { BoundingBox } from "../types.js";

/**
 * Element highlight overlay.
 *
 * A selector like `.nav > button:nth-of-type(3)` says nothing about where the
 * problem is on screen. This draws a labelled box over each named element and
 * leaves it there until the screenshot has been taken, so a report about
 * elements comes with a picture of those elements.
 *
 * The boxes are drawn in *document* coordinates and appended to `<body>`, so
 * one full-page screenshot shows every highlight, including the ones below the
 * fold. They are `pointer-events: none` and are removed again by
 * `clearHighlights`, so nothing here changes what the page does — but the
 * overlay is still a DOM mutation, which is why callers that watch for
 * mutations (framewatch_dead_clicks) draw it only once everything has been
 * measured.
 *
 * Every style is set through the CSSOM rather than as a `style` attribute or a
 * `<style>` block: a page with a strict Content-Security-Policy blocks both of
 * those, and the pages most worth auditing are the ones that lock themselves
 * down.
 */

/** The id of the container every highlight lives in, so `clearHighlights` can find it. */
export const HIGHLIGHT_CONTAINER_ID = "__framewatch_highlights";

export interface Highlight {
  /**
   * CSS selector for the element to draw over — or, when `box` is given, just
   * the name this highlight is reported under in `drawn` / `missing`.
   */
  selector: string;
  /**
   * Draw here instead of looking `selector` up, in viewport pixels. For an
   * element that was resolved some other way (an aria ref, a handle) and has
   * already been measured.
   */
  box?: BoundingBox;
  /**
   * Which match of `selector` to draw over, when the selector is not unique.
   * Defaults to the first.
   */
  match_index?: number;
  /** Drawn in the corner of the box — a number, or a short phrase. */
  label?: string;
  /** Any CSS colour. The box is outlined in it, and the label badge is painted with it. */
  colour?: string;
  /**
   * The translucent fill inside the box. Give it a low alpha: what is under
   * the box is the thing being reported on, and it has to stay readable.
   */
  wash?: string;
}

export interface HighlightResult {
  /** Selectors that were drawn. */
  drawn: string[];
  /** Selectors that matched nothing, or matched something with no box to draw. */
  missing: string[];
}

/**
 * Draw a box over each element in `highlights` and return which ones landed.
 *
 * An element that is gone, or that has no size, is reported in `missing`
 * rather than being an error: by the time a report is drawn the page may have
 * re-rendered, and a screenshot missing one box is far better than no
 * screenshot at all.
 */
export async function highlightElements(
  page: Page,
  highlights: readonly Highlight[],
  max: number = MAX_HIGHLIGHTS,
): Promise<HighlightResult> {
  const wanted = highlights.slice(0, Math.max(0, max));
  if (wanted.length === 0) return { drawn: [], missing: [] };

  try {
    return await page.evaluate(drawHighlights, {
      container_id: HIGHLIGHT_CONTAINER_ID,
      items: wanted.map((item) => ({
        selector: item.selector,
        ...(item.box ? { box: item.box } : {}),
        match_index: item.match_index ?? 0,
        label: item.label ?? "",
        colour: item.colour ?? "#e5194b",
        wash: item.wash ?? "rgba(229, 25, 75, 0.16)",
      })),
    });
  } catch {
    // A page that will not run script (torn down, mid-navigation) simply gets
    // no overlay. The caller still has its screenshot.
    return { drawn: [], missing: wanted.map((item) => item.selector) };
  }
}

/** Remove every box this module drew. Safe to call when there are none. */
export async function clearHighlights(page: Page): Promise<void> {
  await page
    .evaluate((id: string) => {
      const node = (globalThis as any).document?.getElementById(id);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }, HIGHLIGHT_CONTAINER_ID)
    .catch(() => {});
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Everything below runs inside Chromium, so it is written against
 * `globalThis` and untyped nodes: this package is compiled with the Node lib
 * only, and the page it lands in may have patched half of these properties.
 */

interface DrawOptions {
  container_id: string;
  items: Array<{
    selector: string;
    box?: { x: number; y: number; width: number; height: number };
    match_index: number;
    label: string;
    colour: string;
    wash: string;
  }>;
}

function drawHighlights(options: DrawOptions): { drawn: string[]; missing: string[] } {
  const doc = (globalThis as any).document;
  const drawn: string[] = [];
  const missing: string[] = [];
  if (!doc || !doc.body) return { drawn, missing: options.items.map((item) => item.selector) };

  const existing = doc.getElementById(options.container_id);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const container = doc.createElement("div");
  container.id = options.container_id;
  const style = (node: any, rules: Record<string, string>): void => {
    for (const name in rules) {
      try {
        node.style.setProperty(name, rules[name], "important");
      } catch {
        // A patched CSSOM; the box may look wrong but the screenshot survives.
      }
    }
  };

  style(container, {
    position: "absolute",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    margin: "0",
    padding: "0",
    border: "0",
    "pointer-events": "none",
    // Above anything the page itself can stack.
    "z-index": "2147483647",
  });

  // The container goes in empty and is measured, so every box below can be
  // positioned relative to it. Absolute coordinates would be wrong the moment
  // the page gives <body> a `position` or a `transform` of its own, which is
  // exactly the kind of page worth auditing.
  doc.body.appendChild(container);
  let originLeft = 0;
  let originTop = 0;
  try {
    const origin = container.getBoundingClientRect();
    originLeft = origin.left;
    originTop = origin.top;
  } catch {
    // No rect to correct against; boxes land in document coordinates.
  }

  for (const item of options.items) {
    let rect: { left: number; top: number; width: number; height: number } | null = null;
    if (item.box) {
      // Already measured, in viewport pixels — the same space as
      // getBoundingClientRect, so it corrects against the origin the same way.
      rect = { left: item.box.x, top: item.box.y, width: item.box.width, height: item.box.height };
    } else {
      let element: any = null;
      try {
        const matches = doc.querySelectorAll(item.selector);
        element = matches[item.match_index] ?? matches[0] ?? null;
      } catch {
        element = null;
      }
      rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      missing.push(item.selector);
      continue;
    }

    const left = rect.left - originLeft;
    const top = rect.top - originTop;
    const box = doc.createElement("div");
    style(box, {
      position: "absolute",
      // Laid out against the container, which sits at the document origin —
      // so one full-page screenshot catches every box, including the ones
      // below the fold.
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(rect.width)}px`,
      height: `${Math.round(rect.height)}px`,
      "box-sizing": "border-box",
      border: `3px solid ${item.colour}`,
      "border-radius": "3px",
      // A wash rather than a fill: what is under the box is the thing being
      // reported on, and it has to stay readable.
      "background-color": item.wash,
      "box-shadow": "0 0 0 2px rgba(255, 255, 255, 0.85)",
      "pointer-events": "none",
    });

    if (item.label !== "") {
      const tag = doc.createElement("div");
      tag.textContent = item.label;
      style(tag, {
        position: "absolute",
        left: "-3px",
        // Above the box, unless that would fall off the top of the document.
        top: top >= 20 ? "-20px" : `${Math.round(rect.height)}px`,
        padding: "1px 6px",
        "background-color": item.colour,
        color: "#ffffff",
        font: "700 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
        "white-space": "nowrap",
        "border-radius": "3px",
        "pointer-events": "none",
      });
      box.appendChild(tag);
    }

    container.appendChild(box);
    drawn.push(item.selector);
  }

  return { drawn, missing };
}
