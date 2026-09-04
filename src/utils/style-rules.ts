import type { BoundingBox } from "../types.js";

/**
 * What `framewatch_inspect` says about a measurement.
 *
 * One element's computed style and geometry in, lines of wording out. Nothing
 * here touches a browser: the colour maths (WCAG contrast), the alignment
 * descriptions and the formatting are all decided on plain numbers, so every
 * verdict can be tested in milliseconds and the browser tests only have to
 * prove the numbers are real.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

/** A colour as `getComputedStyle` prints it (`rgb()` / `rgba()`), or as a hex literal, or `transparent`. */
export function parseColour(css: string): Rgba | null {
  const value = css.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (fn) {
    return {
      r: Math.round(Number(fn[1])),
      g: Math.round(Number(fn[2])),
      b: Math.round(Number(fn[3])),
      a: fn[4] === undefined ? 1 : Number(fn[4]),
    };
  }
  // The space-separated modern syntax, which Chromium uses for colours outside sRGB.
  const modern = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(value);
  if (modern) {
    const alpha = modern[4] === undefined ? 1 : modern[4].endsWith("%") ? Number(modern[4].slice(0, -1)) / 100 : Number(modern[4]);
    return { r: Math.round(Number(modern[1])), g: Math.round(Number(modern[2])), b: Math.round(Number(modern[3])), a: alpha };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = digits.split("").map((d) => parseInt(d + d, 16));
      return { r, g, b, a: digits.length === 4 ? a / 255 : 1 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = parseInt(digits.slice(0, 2), 16);
      const g = parseInt(digits.slice(2, 4), 16);
      const b = parseInt(digits.slice(4, 6), 16);
      const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }
  return null;
}

/** `top` painted over `bottom`, the way the browser composites a translucent background. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  if (top.a >= 1) return { ...top };
  if (top.a <= 0) return { ...bottom };
  const a = top.a + bottom.a * (1 - top.a);
  const mix = (t: number, b: number): number => Math.round((t * top.a + b * bottom.a * (1 - top.a)) / a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

export function toHex(colour: Rgba): string {
  const part = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const rgb = `#${part(colour.r)}${part(colour.g)}${part(colour.b)}`;
  return colour.a >= 1 ? rgb : `${rgb}${part(colour.a * 255)}`;
}

/** WCAG 2 relative luminance of an opaque colour. */
export function relativeLuminance(colour: Rgba): number {
  const channel = (n: number): number => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
}

/** WCAG 2 contrast ratio, 1..21, whichever way round the colours are given. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG's "large text": 24px, or 18.66px (14pt) when bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  if (fontSizePx >= 24) return true;
  return fontWeight >= 700 && fontSizePx >= 18.66;
}

export type ContrastVerdict = "AAA" | "AA" | "fail";

export function contrastVerdict(ratio: number, large: boolean): ContrastVerdict {
  const aaa = large ? 4.5 : 7;
  const aa = large ? 3 : 4.5;
  if (ratio >= aaa) return "AAA";
  if (ratio >= aa) return "AA";
  return "fail";
}

export function describeContrast(ratio: number, large: boolean): string {
  const verdict = contrastVerdict(ratio, large);
  const size = large ? "large text" : "normal text";
  const shown = `contrast ${ratio.toFixed(2)}:1`;
  if (verdict === "fail") return `${shown} — fails AA for ${size} (needs ${large ? "3" : "4.5"}:1)`;
  return `${shown} — passes ${verdict} for ${size}`;
}

/** Positions within a pixel of each other count as the same: layout rounds, and so does the reader. */
const ALIGN_TOLERANCE_PX = 1;

/**
 * Where a box sits relative to its parent, and to the sibling before it.
 * Horizontal first (flush, centred, or the inset from each side), then the
 * vertical relationship to the previous sibling.
 */
export function describeAlignment(box: BoundingBox, parent: BoundingBox, previous?: BoundingBox): string {
  const parts: string[] = [];

  const left = box.x - parent.x;
  const right = parent.x + parent.width - (box.x + box.width);
  if (Math.abs(left) <= ALIGN_TOLERANCE_PX && Math.abs(right) <= ALIGN_TOLERANCE_PX) {
    parts.push("fills parent's width");
  } else if (Math.abs(left - right) <= ALIGN_TOLERANCE_PX) {
    parts.push("horizontally centred in parent");
  } else if (Math.abs(left) <= ALIGN_TOLERANCE_PX) {
    parts.push("left edge flush with parent");
  } else if (Math.abs(right) <= ALIGN_TOLERANCE_PX) {
    parts.push("right edge flush with parent");
  } else {
    parts.push(`${Math.round(left)}px from parent's left, ${Math.round(right)}px from parent's right`);
  }

  if (previous) {
    const sideGap = box.x - (previous.x + previous.width);
    if (sideGap >= -ALIGN_TOLERANCE_PX) {
      // Side by side (a row of buttons): the gap is horizontal and what can
      // be off is the vertical alignment.
      const drop = box.y - previous.y;
      const vertical =
        Math.abs(drop) <= ALIGN_TOLERANCE_PX
          ? "top-aligned with it"
          : `${Math.round(Math.abs(drop))}px ${drop > 0 ? "lower" : "higher"} than it`;
      parts.push(`${Math.round(Math.max(0, sideGap))}px right of previous sibling, ${vertical}`);
      return parts.join("; ");
    }
    const gap = box.y - (previous.y + previous.height);
    const vertical =
      gap >= 0 ? `${Math.round(gap)}px below previous sibling` : `overlaps previous sibling by ${Math.round(-gap)}px`;
    const shift = box.x - previous.x;
    const horizontal =
      Math.abs(shift) <= ALIGN_TOLERANCE_PX
        ? "left-aligned with it"
        : `${Math.round(Math.abs(shift))}px ${shift > 0 ? "right" : "left"} of its left edge`;
    parts.push(`${vertical}, ${horizontal}`);
  }

  return parts.join("; ");
}

/** One element, as measured inside the page. Colours are as `getComputedStyle` printed them. */
export interface ElementMeasurement {
  /** What the caller asked for: a ref (`e8`) or a selector. */
  target: string;
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  /** Accessible name, when the element has one. */
  name?: string;
  /** Own visible text, trimmed and elided. */
  text?: string;
  /** Viewport pixels. */
  box: BoundingBox;
  visible: boolean;
  in_viewport: "fully" | "partially" | "none";
  /** An ancestor with `overflow` other than visible cuts part of it off. */
  clipped: boolean;
  /** Its own content is wider or taller than the box it was given. */
  text_overflows: boolean;
  display: string;
  position: string;
  opacity: number;
  font: { family: string; size: number; weight: number; line_height: number | null; style: string };
  color: string;
  /** Effective background: its own, composited over its ancestors' until opaque. */
  background: string;
  /** top, right, bottom, left — pixels. */
  padding: [number, number, number, number];
  margin: [number, number, number, number];
  gap: number | null;
  /** Shorthand as computed, e.g. `1px solid rgb(0, 0, 0)` or `0px none rgb(0, 0, 0)`. */
  border: string;
  radius: string;
  parent?: { tag: string; box: BoundingBox };
  previous?: { tag: string; box: BoundingBox };
}

/** The lines `framewatch_inspect` prints for one element. */
export function formatInspection(m: ElementMeasurement, index: number): string[] {
  const lines: string[] = [];

  const identity = [m.target, m.role ?? m.tag, m.name !== undefined ? `"${m.name}"` : null].filter(Boolean).join(" ");
  lines.push(`${index}. ${identity} — <${describeElement(m)}>`);

  const { box } = m;
  const centre = `${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}`;
  const state: string[] = [];
  state.push(m.visible ? "visible" : `not visible${m.opacity === 0 ? " (opacity 0)" : ""}`);
  state.push(
    m.in_viewport === "fully"
      ? "fully in viewport"
      : m.in_viewport === "partially"
        ? "partly outside the viewport"
        : "outside the viewport",
  );
  if (m.clipped) state.push("clipped by an ancestor");
  if (m.text_overflows) state.push("text overflows its box");
  lines.push(`   box: ${box.x},${box.y} ${box.width}x${box.height} (viewport px; centre ${centre}) — ${state.join(", ")}`);

  lines.push(`   text: ${describeText(m)}`);

  const spacing = [`padding ${sides(m.padding)}`, `margin ${sides(m.margin)}`];
  if (m.gap !== null) spacing.push(`gap ${m.gap}`);
  lines.push(`   spacing: ${spacing.join("; ")}`);

  lines.push(`   border: ${describeBorder(m.border)}; radius ${m.radius}`);

  const layout = [m.display];
  if (m.position !== "static") layout.push(`position ${m.position}`);
  if (m.parent) layout.push(describeAlignment(m.box, m.parent.box, m.previous?.box));
  lines.push(`   layout: ${layout.join("; ")}`);

  return lines;
}

function describeElement(m: ElementMeasurement): string {
  let out = m.tag;
  if (m.id) out += `#${m.id}`;
  else if (m.classes.length > 0) out += `.${m.classes[0]}`;
  return out;
}

function describeText(m: ElementMeasurement): string {
  const font = m.font;
  const size = font.line_height !== null ? `${font.size}px/${font.line_height}px` : `${font.size}px`;
  const parts = [`${size} ${font.family} ${font.weight}${font.style !== "normal" ? ` ${font.style}` : ""}`];

  const fg = parseColour(m.color);
  const bg = parseColour(m.background);
  // A translucent text colour renders as a blend with what is behind it; that
  // blend is what the eye sees and what the contrast is rated on, so it is the
  // one printed, with the declared value beside it.
  const rendered = fg && bg && fg.a < 1 && bg.a >= 1 ? compositeOver(fg, bg) : fg;
  const shownFg = rendered ? (fg && fg.a < 1 && rendered !== fg ? `${toHex(rendered)} (${toHex(fg)} as declared)` : toHex(rendered)) : m.color;
  parts.push(`${shownFg} on ${bg ? toHex(bg) : m.background}`);

  const hasText = (m.text ?? "").length > 0 || (m.name ?? "").length > 0;
  if (hasText && rendered && bg && bg.a >= 1) {
    parts.push(describeContrast(contrastRatio(rendered, bg), isLargeText(font.size, font.weight)));
  }
  return parts.join(" — ");
}

/** `8 16 8 16` → `8 16`, `8 8 8 8` → `8`, the way a stylesheet would write it. */
function sides([top, right, bottom, left]: [number, number, number, number]): string {
  if (top === right && right === bottom && bottom === left) return String(top);
  if (top === bottom && right === left) return `${top} ${right}`;
  return `${top} ${right} ${bottom} ${left}`;
}

function describeBorder(border: string): string {
  const match = /^([\d.]+)px\s+(\w+)\s+(.+)$/.exec(border.trim());
  if (!match) return border || "none";
  const width = Number(match[1]);
  if (width === 0 || match[2] === "none") return "none";
  const colour = parseColour(match[3]);
  const shown = colour ? (colour.a === 0 ? "transparent" : toHex(colour)) : match[3];
  return `${match[1]}px ${match[2]} ${shown}`;
}

/* ── Page inventory ───────────────────────────────────────────────────── */

export interface Tally {
  value: string;
  count: number;
}

/** What the page is built from — every value in use, with how often. Most-used first. */
export interface PageInventory {
  elements: number;
  /** Elements with visible text of their own. */
  text_elements: number;
  fonts: Tally[];
  font_sizes: Tally[];
  font_weights: Tally[];
  text_colours: Tally[];
  backgrounds: Tally[];
  /** Non-zero padding, margin and gap values. */
  spacing: Tally[];
  radii: Tally[];
}

export function formatInventory(inventory: PageInventory): string[] {
  const lines = [`Design inventory — ${inventory.elements} elements, ${inventory.text_elements} with text`];
  const row = (label: string, tallies: Tally[]): void => {
    if (tallies.length === 0) {
      lines.push(`  ${label}: none`);
      return;
    }
    lines.push(`  ${label} (${tallies.length}): ${tallies.map((t) => `${t.value} ×${t.count}`).join(", ")}`);
  };
  row("fonts", inventory.fonts);
  row("font sizes", inventory.font_sizes);
  row("font weights", inventory.font_weights);
  row("text colours", inventory.text_colours);
  row("backgrounds", inventory.backgrounds);
  row("spacing", inventory.spacing);
  row("radii", inventory.radii);
  return lines;
}
