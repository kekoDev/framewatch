import type { Locator, Page } from "playwright";
import {
  MAX_INSPECT_TEXT_LENGTH,
  MAX_INVENTORY_ELEMENTS,
  MAX_INVENTORY_VALUES,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { isRef, refSelector } from "../utils/snapshot-rules.js";
import { parseColour, toHex, type ElementMeasurement, type PageInventory, type Tally } from "../utils/style-rules.js";
import type { ComponentInfo, ComponentUnavailable } from "../utils/vue-rules.js";
import { componentOf } from "./vue.js";

/**
 * How an element is built, measured inside the page.
 *
 * A screenshot shows what a button looks like; this says what it *is*: the
 * box in viewport pixels, the font, the colours it actually renders in (a
 * transparent background resolved through its ancestors), the spacing, and
 * where it sits against its parent and the sibling before it. That is what an
 * agent needs to check its own work against the design it meant to build.
 *
 * Every number is read in one `evaluate` per element and judged in
 * `style-rules.ts`, which never sees a browser.
 */

export interface InspectResult {
  target: string;
  measurement?: ElementMeasurement;
  /** Why there is no measurement: the target resolved to nothing. */
  error?: string;
  /** The Vue component behind the element, when asked for and present. */
  component?: ComponentInfo | ComponentUnavailable;
}

export interface MeasureOptions {
  /** Also read the Vue component that rendered each element. */
  components?: boolean;
}

/** Measure each target — a snapshot ref (`e8`) or a CSS selector — in order. */
export async function measureElements(page: Page, targets: readonly string[], options: MeasureOptions = {}): Promise<InspectResult[]> {
  const results: InspectResult[] = [];
  for (const target of targets) {
    const result = await measureOne(page, target);
    if (options.components && result.measurement) {
      const component = await componentOf(resolve(page, target));
      if (component) result.component = component;
    }
    results.push(result);
  }
  return results;
}

async function measureOne(page: Page, target: string): Promise<InspectResult> {
  const locator = resolve(page, target);
  let count: number;
  try {
    count = await locator.count();
  } catch (error) {
    return { target, error: `could not be resolved: ${firstLine(error)}` };
  }
  if (count === 0) {
    return {
      target,
      error: isRef(target)
        ? "did not resolve — the page has changed since that snapshot, or none was taken; run framewatch_snapshot again"
        : "matched nothing",
    };
  }
  try {
    const raw = await locator.evaluate(measureInPage, { max_text: MAX_INSPECT_TEXT_LENGTH }, { timeout: SELECTOR_TIMEOUT_MS });
    return { target, measurement: { target, ...raw } };
  } catch (error) {
    return { target, error: `could not be measured: ${firstLine(error)}` };
  }
}

function resolve(page: Page, target: string): Locator {
  return isRef(target) ? page.locator(refSelector(target)) : page.locator(target).first();
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}

/* ── Inventory ────────────────────────────────────────────────────────── */

/** Every font, size, weight, colour, spacing value and radius the page (or `selector`) uses. */
export async function inventoryPage(page: Page, selector?: string): Promise<PageInventory> {
  const raw = await page.evaluate(inventoryInPage, { selector: selector ?? null, max_elements: MAX_INVENTORY_ELEMENTS });
  const tally = (map: Record<string, number>, normalise: (value: string) => string | null = (v) => v): Tally[] => {
    const merged = new Map<string, number>();
    for (const [value, count] of Object.entries(map)) {
      const key = normalise(value);
      if (key === null) continue;
      merged.set(key, (merged.get(key) ?? 0) + count);
    }
    return [...merged.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
      .slice(0, MAX_INVENTORY_VALUES);
  };
  const hex = (value: string): string | null => {
    const colour = parseColour(value);
    if (!colour || colour.a === 0) return null;
    return toHex(colour);
  };
  return {
    elements: raw.elements,
    text_elements: raw.text_elements,
    fonts: tally(raw.fonts),
    font_sizes: tally(raw.font_sizes),
    font_weights: tally(raw.font_weights),
    text_colours: tally(raw.text_colours, hex),
    backgrounds: tally(raw.backgrounds, hex),
    spacing: tally(raw.spacing),
    radii: tally(raw.radii),
  };
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Everything below runs inside Chromium. Written against `globalThis` and
 * untyped nodes because this package is compiled with the Node lib only —
 * and nothing here may close over a module value: the function body is
 * serialised and run where the module does not exist.
 */

type RawMeasurement = Omit<ElementMeasurement, "target">;

function measureInPage(element: any, config: { max_text: number }): RawMeasurement {
  const g = globalThis as any;
  const win = g.window;
  const doc = g.document;

  const px = (value: string): number => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const rect = (node: any): { x: number; y: number; width: number; height: number } => {
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };

  const style = win.getComputedStyle(element);
  const box = rect(element);

  // Effective background: composite this element's own over each ancestor's
  // until one is opaque. Done here as a list of layers, blended in Node.
  const layers: string[] = [];
  let node: any = element;
  while (node && node.nodeType === 1) {
    const bg = win.getComputedStyle(node).backgroundColor;
    layers.push(bg);
    if (/^rgb\(/.test(bg)) break;
    node = node.parentElement;
  }
  const background = blend(layers);

  // Clipped by an ancestor whose overflow is not visible.
  let clipped = false;
  let ancestor: any = element.parentElement;
  while (ancestor && ancestor !== doc.documentElement) {
    const s = win.getComputedStyle(ancestor);
    if (s.overflow !== "visible" || s.overflowX !== "visible" || s.overflowY !== "visible") {
      const a = ancestor.getBoundingClientRect();
      const r = element.getBoundingClientRect();
      if (r.left < a.left - 0.5 || r.right > a.right + 0.5 || r.top < a.top - 0.5 || r.bottom > a.bottom + 0.5) {
        clipped = true;
        break;
      }
    }
    ancestor = ancestor.parentElement;
  }

  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const r = element.getBoundingClientRect();
  const inside = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
  const outside = r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh;
  const in_viewport: "fully" | "partially" | "none" = inside ? "fully" : outside ? "none" : "partially";

  const opacity = px(style.opacity);
  const visible =
    style.display !== "none" && style.visibility !== "hidden" && opacity > 0 && r.width > 0 && r.height > 0;

  const text_overflows = element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;

  const ownText = (): string => {
    let out = "";
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType === 3) out += children[i].nodeValue;
    }
    out = out.replace(/\s+/g, " ").trim();
    if (out === "" && typeof element.value === "string") out = element.value;
    if (out === "") out = String(element.textContent || "").replace(/\s+/g, " ").trim();
    return out.length > config.max_text ? out.slice(0, config.max_text) + "…" : out;
  };

  const accessibleName = (): string | undefined => {
    const label = element.getAttribute("aria-label");
    if (label) return String(label).trim();
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = String(labelledBy)
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n: any) => String(n.textContent || "").replace(/\s+/g, " ").trim());
      if (names.length > 0) return names.join(" ");
    }
    if (element.labels && element.labels.length > 0) {
      return String(element.labels[0].textContent || "").replace(/\s+/g, " ").trim();
    }
    const alt = element.getAttribute("alt");
    if (alt) return String(alt).trim();
    const title = element.getAttribute("title");
    if (title) return String(title).trim();
    const tag = String(element.tagName).toLowerCase();
    if (tag === "button" || tag === "a" || /^h[1-6]$/.test(tag) || element.getAttribute("role")) {
      const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
      return text === "" ? undefined : text.length > config.max_text ? text.slice(0, config.max_text) + "…" : text;
    }
    return undefined;
  };

  const implicitRole = (): string | undefined => {
    const explicit = element.getAttribute("role");
    if (explicit) return String(explicit);
    const tag = String(element.tagName).toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "button" || type === "submit" || type === "reset") return "button";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "p") return "paragraph";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "li") return "listitem";
    return undefined;
  };

  const neighbour = (node: any): { tag: string; box: { x: number; y: number; width: number; height: number } } | undefined =>
    node && node.nodeType === 1 ? { tag: String(node.tagName).toLowerCase(), box: rect(node) } : undefined;

  const lineHeight = style.lineHeight === "normal" ? null : px(style.lineHeight);
  const gap = style.display.indexOf("flex") !== -1 || style.display.indexOf("grid") !== -1 ? px(style.rowGap === "normal" ? "0" : style.rowGap) : null;

  const name = accessibleName();
  const classes: string[] = [];
  if (element.classList) for (let i = 0; i < element.classList.length && i < 4; i++) classes.push(String(element.classList[i]));

  const out: RawMeasurement = {
    tag: String(element.tagName).toLowerCase(),
    classes,
    box,
    visible,
    in_viewport,
    clipped,
    text_overflows,
    display: String(style.display),
    position: String(style.position),
    opacity,
    font: {
      family: String(style.fontFamily).split(",")[0].replace(/["']/g, "").trim(),
      size: px(style.fontSize),
      weight: px(style.fontWeight),
      line_height: lineHeight,
      style: String(style.fontStyle),
    },
    color: String(style.color),
    background,
    padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
    margin: [px(style.marginTop), px(style.marginRight), px(style.marginBottom), px(style.marginLeft)],
    gap,
    border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    radius: String(style.borderTopLeftRadius),
  };
  if (element.id) out.id = String(element.id);
  const role = implicitRole();
  if (role !== undefined) out.role = role;
  if (name !== undefined) out.name = name;
  const text = ownText();
  if (text !== "") out.text = text;
  const parent = neighbour(element.parentElement);
  if (parent) out.parent = parent;
  const previous = neighbour(element.previousElementSibling);
  if (previous) out.previous = previous;
  return out;

  /** Composite `layers[0]` over `layers[1]` over … ; returns an rgb()/rgba() string. */
  function blend(list: string[]): string {
    const parse = (value: string): [number, number, number, number] | null => {
      const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
      if (!m) return value === "transparent" ? [0, 0, 0, 0] : null;
      return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    };
    // Start from the deepest (last) layer and paint each one above it on top.
    let acc: [number, number, number, number] | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const top = parse(list[i]);
      if (!top) continue;
      if (!acc || top[3] >= 1) {
        acc = top;
        continue;
      }
      if (top[3] <= 0) continue;
      const below: [number, number, number, number] = acc;
      const a: number = top[3] + below[3] * (1 - top[3]);
      const mix = (t: number, b: number): number => Math.round((t * top[3] + b * below[3] * (1 - top[3])) / a);
      acc = [mix(top[0], below[0]), mix(top[1], below[1]), mix(top[2], below[2]), a];
    }
    if (!acc) return "rgba(0, 0, 0, 0)";
    // The page's canvas is white under everything that is still translucent.
    if (acc[3] < 1) {
      const a = acc[3];
      acc = [Math.round(acc[0] * a + 255 * (1 - a)), Math.round(acc[1] * a + 255 * (1 - a)), Math.round(acc[2] * a + 255 * (1 - a)), 1];
    }
    return `rgb(${acc[0]}, ${acc[1]}, ${acc[2]})`;
  }
}

interface RawInventory {
  elements: number;
  text_elements: number;
  fonts: Record<string, number>;
  font_sizes: Record<string, number>;
  font_weights: Record<string, number>;
  text_colours: Record<string, number>;
  backgrounds: Record<string, number>;
  spacing: Record<string, number>;
  radii: Record<string, number>;
}

function inventoryInPage(config: { selector: string | null; max_elements: number }): RawInventory {
  const g = globalThis as any;
  const win = g.window;
  const doc = g.document;
  const out: RawInventory = {
    elements: 0,
    text_elements: 0,
    fonts: {},
    font_sizes: {},
    font_weights: {},
    text_colours: {},
    backgrounds: {},
    spacing: {},
    radii: {},
  };
  const bump = (map: Record<string, number>, value: string): void => {
    map[value] = (map[value] || 0) + 1;
  };
  const SKIP = ["script", "style", "link", "meta", "title", "head", "noscript", "template", "br", "svg", "path"];

  const root = config.selector ? doc.querySelector(config.selector) : doc.body;
  if (!root) return out;
  const all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));

  for (const el of all) {
    if (out.elements >= config.max_elements) break;
    const tag = String(el.tagName || "").toLowerCase();
    if (SKIP.indexOf(tag) !== -1) continue;
    const s = win.getComputedStyle(el);
    if (s.display === "none") continue;
    out.elements++;

    let ownText = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) ownText += el.childNodes[i].nodeValue;
    }
    const hasText = ownText.trim() !== "" || (typeof el.value === "string" && el.value !== "" && tag !== "option");
    if (hasText) {
      out.text_elements++;
      bump(out.fonts, String(s.fontFamily).split(",")[0].replace(/["']/g, "").trim());
      bump(out.font_sizes, s.fontSize);
      bump(out.font_weights, s.fontWeight);
      bump(out.text_colours, s.color);
    }
    if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent") {
      bump(out.backgrounds, s.backgroundColor);
    }
    const spacing = [
      s.paddingTop,
      s.paddingRight,
      s.paddingBottom,
      s.paddingLeft,
      s.marginTop,
      s.marginRight,
      s.marginBottom,
      s.marginLeft,
    ];
    if (s.display.indexOf("flex") !== -1 || s.display.indexOf("grid") !== -1) {
      if (s.rowGap !== "normal") spacing.push(s.rowGap);
      if (s.columnGap !== "normal" && s.columnGap !== s.rowGap) spacing.push(s.columnGap);
    }
    for (const value of spacing) {
      if (value && value !== "0px" && parseFloat(value) > 0) bump(out.spacing, value);
    }
    const radius = s.borderTopLeftRadius;
    if (radius && radius !== "0px") bump(out.radii, radius);
  }
  return out;
}
