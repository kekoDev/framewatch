import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  contrastVerdict,
  describeAlignment,
  describeContrast,
  formatInspection,
  formatInventory,
  isLargeText,
  parseColour,
  toHex,
  type ElementMeasurement,
  type PageInventory,
} from "../src/utils/style-rules.js";

/**
 * Everything `framewatch_inspect` says about a measurement, without a browser.
 * The browser tests only have to prove the numbers reaching this file are
 * real; every verdict and every line of wording is decided here.
 */

describe("parseColour", () => {
  it("reads the rgb() and rgba() forms getComputedStyle produces", () => {
    expect(parseColour("rgb(59, 130, 246)")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColour("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColour("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("reads hex and the transparent keyword", () => {
    expect(parseColour("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour("#3b82f6")).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColour("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null for anything else", () => {
    expect(parseColour("")).toBeNull();
    expect(parseColour("var(--x)")).toBeNull();
  });
});

describe("compositeOver", () => {
  it("returns the top colour when it is opaque", () => {
    const top = { r: 10, g: 20, b: 30, a: 1 };
    expect(compositeOver(top, { r: 255, g: 255, b: 255, a: 1 })).toEqual(top);
  });

  it("blends a translucent colour over an opaque one", () => {
    const out = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(out).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it("returns the bottom colour when the top is fully transparent", () => {
    const bottom = { r: 1, g: 2, b: 3, a: 1 };
    expect(compositeOver({ r: 9, g: 9, b: 9, a: 0 }, bottom)).toEqual(bottom);
  });
});

describe("toHex", () => {
  it("prints an opaque colour as six hex digits", () => {
    expect(toHex({ r: 59, g: 130, b: 246, a: 1 })).toBe("#3b82f6");
  });

  it("appends the alpha when the colour is translucent", () => {
    expect(toHex({ r: 0, g: 0, b: 0, a: 0.5 })).toBe("#00000080");
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for a colour on itself", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBe(1);
  });

  it("is symmetric and matches the WCAG reference value for a known pair", () => {
    const blue = { r: 59, g: 130, b: 246, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    // White on Tailwind blue-500: 3.68:1 by the WCAG formula.
    expect(contrastRatio(white, blue)).toBeCloseTo(3.68, 2);
    expect(contrastRatio(blue, white)).toBeCloseTo(3.68, 2);
  });
});

describe("isLargeText", () => {
  it("counts 24px regular and 18.66px bold as large, and 18px bold as normal", () => {
    expect(isLargeText(24, 400)).toBe(true);
    expect(isLargeText(18.66, 700)).toBe(true);
    expect(isLargeText(18, 700)).toBe(false);
    expect(isLargeText(23, 400)).toBe(false);
  });
});

describe("contrastVerdict", () => {
  it("applies the 4.5 / 7 thresholds to normal text", () => {
    expect(contrastVerdict(3.68, false)).toBe("fail");
    expect(contrastVerdict(4.5, false)).toBe("AA");
    expect(contrastVerdict(7, false)).toBe("AAA");
  });

  it("applies the 3 / 4.5 thresholds to large text", () => {
    expect(contrastVerdict(2.9, true)).toBe("fail");
    expect(contrastVerdict(3.68, true)).toBe("AA");
    expect(contrastVerdict(4.5, true)).toBe("AAA");
  });
});

describe("describeContrast", () => {
  it("names the ratio, the verdict and what a failing pair needs", () => {
    expect(describeContrast(3.68, false)).toBe("contrast 3.68:1 — fails AA for normal text (needs 4.5:1)");
    expect(describeContrast(4.6, false)).toBe("contrast 4.60:1 — passes AA for normal text");
    expect(describeContrast(7.2, true)).toBe("contrast 7.20:1 — passes AAA for large text");
  });
});

describe("describeAlignment", () => {
  const parent = { x: 0, y: 0, width: 400, height: 300 };

  it("says when a box is flush with its parent's left edge", () => {
    const text = describeAlignment({ x: 0, y: 40, width: 100, height: 20 }, parent);
    expect(text).toContain("left edge flush with parent");
  });

  it("reports the inset from both sides when it is not flush", () => {
    const text = describeAlignment({ x: 20, y: 40, width: 100, height: 20 }, parent);
    expect(text).toContain("20px from parent's left");
    expect(text).toContain("280px from parent's right");
  });

  it("recognises a horizontally centred box, within a pixel", () => {
    const text = describeAlignment({ x: 150, y: 40, width: 101, height: 20 }, parent);
    expect(text).toContain("horizontally centred in parent");
  });

  it("reports the gap to the previous sibling, and an overlap", () => {
    const previous = { x: 20, y: 0, width: 100, height: 28 };
    expect(describeAlignment({ x: 20, y: 40, width: 100, height: 20 }, parent, previous)).toContain(
      "12px below previous sibling",
    );
    expect(describeAlignment({ x: 20, y: 20, width: 100, height: 20 }, parent, previous)).toContain(
      "overlaps previous sibling by 8px",
    );
  });

  it("says when the box shares its left edge with the previous sibling", () => {
    const previous = { x: 20, y: 0, width: 100, height: 28 };
    expect(describeAlignment({ x: 20, y: 40, width: 100, height: 20 }, parent, previous)).toContain(
      "left-aligned with it",
    );
    expect(describeAlignment({ x: 24, y: 40, width: 100, height: 20 }, parent, previous)).toContain(
      "4px right of its left edge",
    );
  });
});

/** A measurement with sensible defaults, so each test names only what it is about. */
const measure = (over: Partial<ElementMeasurement> = {}): ElementMeasurement => ({
  target: "e8",
  tag: "button",
  id: "go",
  classes: [],
  role: "button",
  name: "Sign in",
  text: "Sign in",
  box: { x: 20, y: 140, width: 96, height: 34 },
  visible: true,
  in_viewport: "fully",
  clipped: false,
  text_overflows: false,
  display: "inline-block",
  position: "static",
  opacity: 1,
  font: { family: "system-ui", size: 14, weight: 400, line_height: 20, style: "normal" },
  color: "rgb(255, 255, 255)",
  background: "rgb(59, 130, 246)",
  padding: [8, 16, 8, 16],
  margin: [0, 0, 0, 0],
  gap: null,
  border: "0px none rgb(0, 0, 0)",
  radius: "0px",
  parent: { tag: "form", box: { x: 20, y: 40, width: 400, height: 160 } },
  previous: { tag: "label", box: { x: 20, y: 100, width: 200, height: 28 } },
  ...over,
});

describe("formatInspection", () => {
  it("prints the identity, box, text style with contrast, spacing and layout, one line each", () => {
    const lines = formatInspection(measure(), 1);
    expect(lines[0]).toBe('1. e8 button "Sign in" — <button#go>');
    expect(lines).toContain("   box: 20,140 96x34 (viewport px; centre 68,157) — visible, fully in viewport");
    expect(lines).toContain(
      "   text: 14px/20px system-ui 400 — #ffffff on #3b82f6 — contrast 3.68:1 — fails AA for normal text (needs 4.5:1)",
    );
    expect(lines).toContain("   spacing: padding 8 16; margin 0");
    expect(lines).toContain("   border: none; radius 0px");
    expect(lines).toContain("   layout: inline-block; left edge flush with parent; 12px below previous sibling, left-aligned with it");
  });

  it("names the selector it was asked for when there is no ref", () => {
    const lines = formatInspection(measure({ target: "#go" }), 2);
    expect(lines[0]).toBe('2. #go button "Sign in" — <button#go>');
  });

  it("says when the element is off screen, clipped, or has overflowing text", () => {
    const lines = formatInspection(
      measure({ in_viewport: "none", clipped: true, text_overflows: true, visible: false, opacity: 0 }),
      1,
    );
    const box = lines.find((line) => line.startsWith("   box:"))!;
    expect(box).toContain("not visible (opacity 0)");
    expect(box).toContain("outside the viewport");
    expect(box).toContain("clipped by an ancestor");
    expect(box).toContain("text overflows its box");
  });

  it("omits the contrast when the element has no text and collapses uniform spacing", () => {
    const lines = formatInspection(
      measure({ text: "", name: undefined, padding: [8, 8, 8, 8], margin: [4, 8, 4, 8], gap: 12 }),
      1,
    );
    const text = lines.find((line) => line.startsWith("   text:"))!;
    expect(text).not.toContain("contrast");
    expect(text).toContain("#ffffff on #3b82f6");
    expect(lines).toContain("   spacing: padding 8; margin 4 8; gap 12");
  });

  it("prints a border and a radius when there are any", () => {
    const lines = formatInspection(measure({ border: "1px solid rgb(209, 213, 219)", radius: "6px" }), 1);
    expect(lines).toContain("   border: 1px solid #d1d5db; radius 6px");
  });
});

describe("formatInventory", () => {
  const inventory: PageInventory = {
    elements: 120,
    text_elements: 40,
    fonts: [
      { value: "Inter, sans-serif", count: 38 },
      { value: "ui-monospace", count: 2 },
    ],
    font_sizes: [
      { value: "16px", count: 30 },
      { value: "14px", count: 8 },
      { value: "32px", count: 1 },
      { value: "13px", count: 1 },
    ],
    font_weights: [
      { value: "400", count: 35 },
      { value: "600", count: 5 },
    ],
    text_colours: [
      { value: "#111827", count: 36 },
      { value: "#6b7280", count: 4 },
    ],
    backgrounds: [
      { value: "#ffffff", count: 100 },
      { value: "#3b82f6", count: 3 },
    ],
    spacing: [
      { value: "16px", count: 40 },
      { value: "8px", count: 22 },
      { value: "13px", count: 1 },
    ],
    radii: [{ value: "6px", count: 9 }],
  };

  it("lists each dimension with its values most-used first and the counts", () => {
    const text = formatInventory(inventory).join("\n");
    expect(text).toContain("Design inventory — 120 elements, 40 with text");
    expect(text).toContain("fonts (2): Inter, sans-serif ×38, ui-monospace ×2");
    expect(text).toContain("font sizes (4): 16px ×30, 14px ×8, 32px ×1, 13px ×1");
    expect(text).toContain("font weights (2): 400 ×35, 600 ×5");
    expect(text).toContain("text colours (2): #111827 ×36, #6b7280 ×4");
    expect(text).toContain("backgrounds (2): #ffffff ×100, #3b82f6 ×3");
    expect(text).toContain("spacing (3): 16px ×40, 8px ×22, 13px ×1");
    expect(text).toContain("radii (1): 6px ×9");
  });

  it("says when a dimension has nothing in it", () => {
    const text = formatInventory({ ...inventory, radii: [] }).join("\n");
    expect(text).toContain("radii: none");
  });
});

describe("formatInspection — translucent text", () => {
  it("prints the colour as rendered, with the declared one beside it, and rates that", () => {
    const lines = formatInspection(
      measure({ color: "rgba(0, 0, 0, 0.5)", background: "rgb(243, 244, 246)", font: { family: "Arial", size: 13, weight: 400, line_height: 20, style: "normal" } }),
      1,
    );
    const text = lines.find((line) => line.startsWith("   text:"))!;
    expect(text).toContain("#7a7a7b (#00000080 as declared) on #f3f4f6");
    expect(text).toContain("contrast 3.9");
  });
});

describe("describeAlignment — siblings side by side", () => {
  const parent = { x: 0, y: 0, width: 600, height: 100 };
  const previous = { x: 20, y: 40, width: 131, height: 43 };

  it("describes the gap to the left and the vertical offset when the box sits to the right", () => {
    expect(describeAlignment({ x: 163, y: 43, width: 84, height: 43 }, parent, previous)).toContain(
      "12px right of previous sibling, 3px lower than it",
    );
    expect(describeAlignment({ x: 163, y: 37, width: 84, height: 43 }, parent, previous)).toContain(
      "12px right of previous sibling, 3px higher than it",
    );
  });

  it("says top-aligned when the tops match", () => {
    expect(describeAlignment({ x: 163, y: 40, width: 84, height: 43 }, parent, previous)).toContain(
      "12px right of previous sibling, top-aligned with it",
    );
  });
});

describe("formatInspection — transparent border", () => {
  it("names a fully transparent border colour rather than printing #00000000", () => {
    const lines = formatInspection(measure({ border: "1px solid rgba(0, 0, 0, 0)" }), 1);
    expect(lines).toContain("   border: 1px solid transparent; radius 0px");
  });
});
