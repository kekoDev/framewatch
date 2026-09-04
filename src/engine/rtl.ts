import type { Page } from "playwright";
import {
  MAX_ARABIC_INJECTION_NODES,
  MAX_RTL_ELEMENTS,
  MAX_RTL_SCAN,
  MAX_RTL_SELECTOR_LENGTH,
  MAX_RTL_TEXT_LENGTH,
} from "../constants.js";
import { arabicFor } from "../utils/arabic-text.js";
import type { ElementMeasurement, ElementPair } from "../utils/rtl-rules.js";

/**
 * RTL engine.
 *
 * Puts a page into RTL, optionally replaces its text with Arabic, and measures
 * every laid-out element. Nothing here decides what is *wrong*; that is
 * `utils/rtl-rules.ts`, which is pure and unit-tested without a browser.
 *
 * The whole design rests on one idea: an RTL bug is something that failed to
 * change. So the same page is measured twice — once as it ships, once flipped
 * — and the two measurements are paired element by element. That pairing is
 * the hard part, because the two renders are two separate page loads: element
 * identity has to survive a reload, and it cannot be an ElementHandle, an
 * index, or a position (position is precisely the thing under test).
 *
 * `keyFor` solves that with a structural key — tag, id, class, and the
 * element's path among its siblings — computed identically in both passes.
 * Anything that does not appear in both is simply dropped: an element that
 * exists in only one direction is a page that renders differently, which is
 * interesting but is not a mirroring bug, and guessing at a pairing would
 * invent findings.
 */

/* ── How the page is put into RTL ─────────────────────────────────────── */

/**
 * How to make the page render right-to-left.
 *
 * Four triggers, because apps do this four different ways and picking the
 * wrong one silently measures the page twice in LTR — which reports no
 * findings at all and looks exactly like a page with no RTL bugs. That failure
 * is why `verifyDirection` exists.
 */
export type RtlTrigger =
  | { type: "attribute"; attr: string; value: string; target: string }
  | { type: "class"; class: string; target: string }
  | { type: "locale"; locale: string }
  | { type: "url"; rtl_url: string };

/** The trigger used when the caller names none: the way the platform itself defines RTL. */
export const DEFAULT_RTL_TRIGGER: RtlTrigger = {
  type: "attribute",
  attr: "dir",
  value: "rtl",
  target: "html",
};

/**
 * Apply the trigger to an already-loaded page.
 *
 * `url` is not applied here — it is a different page and is navigated to by
 * the caller before this is reached. `locale` likewise is a context option,
 * fixed when the browser context is created; what this does for it is set
 * `dir` as well, because a locale alone changes number and date formatting but
 * does not flip the layout: `Accept-Language: ar` does not put a page in RTL,
 * and a tool that assumed it did would report a clean bill of health on a
 * completely broken page.
 */
export async function applyRtlTrigger(page: Page, trigger: RtlTrigger): Promise<void> {
  if (trigger.type === "url") return;

  const request =
    trigger.type === "attribute"
      ? { target: trigger.target, attr: trigger.attr, value: trigger.value, class_name: "" }
      : trigger.type === "class"
        ? { target: trigger.target, attr: "", value: "", class_name: trigger.class }
        : // A locale is carried by the context; the layout still has to be flipped.
          { target: "html", attr: "dir", value: "rtl", class_name: "" };

  await page.evaluate(applyTrigger, request);
}

/**
 * Check that the page really is rendering right-to-left.
 *
 * The single most damaging way this tool can fail is quietly: a trigger that
 * does not match the app under test measures LTR twice, finds every element
 * identical, and reports that the page has no RTL problems. That is worse than
 * an error, because it is a confident wrong answer. So the direction that
 * actually took effect is read back off the document and the body, and the
 * caller refuses to report anything if it is still `ltr`.
 */
export async function readDirection(page: Page): Promise<{ html: string; body: string }> {
  try {
    return await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const view = doc?.defaultView;
      const read = (node: any): string => {
        if (!node || !view?.getComputedStyle) return "";
        try {
          return String(view.getComputedStyle(node).direction ?? "");
        } catch {
          return "";
        }
      };
      return { html: read(doc?.documentElement), body: read(doc?.body) };
    });
  } catch {
    return { html: "", body: "" };
  }
}

/* ── Arabic injection ─────────────────────────────────────────────────── */

/**
 * Replace every visible text node with Arabic of about the same length.
 *
 * Run in *both* passes, not just the RTL one. That is not obvious and it is
 * essential: the two passes are compared to each other, so they have to differ
 * in exactly one variable. If only the RTL pass got Arabic, every box on the
 * page would change width for reasons of text metrics rather than direction,
 * and the mirroring comparison — which asks whether a box moved — would be
 * measuring the font, not the layout.
 *
 * Text inside `<script>`, `<style>` and friends is left alone, as is anything
 * inside an element the caller excluded. Input `value`s and `placeholder`s are
 * replaced too, since a form is where RTL text is most likely to be mishandled.
 */
export async function injectArabic(page: Page, exclude?: string): Promise<InjectionResult> {
  try {
    const replaced = await page.evaluate(replaceWithArabic, {
      exclude: exclude ?? "",
      max_nodes: MAX_ARABIC_INJECTION_NODES,
      // The generator is pure and lives in Node, so the vocabulary has to be
      // carried into the page. Passing the built strings instead of the
      // function keeps one implementation of "what Arabic looks like".
      words: buildVocabulary(),
    });
    return { replaced };
  } catch (error) {
    // Never swallowed into a plausible-looking zero. "0 strings replaced"
    // reads as "this page had no text", and a caller that believed it would
    // report a page tested with Arabic that never saw any — so the reason
    // comes back and the tool says which of the two happened.
    return { replaced: 0, error: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
  }
}

/** What an injection did, or why it did nothing. */
export interface InjectionResult {
  replaced: number;
  /** Set when the injection could not run at all — never confused with "no text to replace". */
  error?: string;
}

/**
 * Pre-build the replacement strings the page will choose from.
 *
 * The in-page code cannot call `arabicFor` (it lives in Node and would have to
 * be serialised along with its imports), so instead the Node side builds one
 * replacement per length bucket and the page picks the bucket that fits the
 * string it is replacing. Same vocabulary, same determinism, one implementation.
 */
function buildVocabulary(): string[] {
  // One entry per length from 1 to the longest string worth matching. Index
  // `n` holds Arabic text of about `n` characters, so the page's lookup is a
  // single array access on the original's length.
  const lengths: string[] = [];
  for (let length = 0; length <= 160; length += 1) {
    lengths.push(arabicFor("x".repeat(Math.max(1, length)), length));
  }
  return lengths;
}

/* ── Measuring ────────────────────────────────────────────────────────── */

export interface MeasureOptions {
  /** Only measure inside this. Defaults to the whole document. */
  selector?: string;
  /** Never measure this, or anything inside it. */
  exclude?: string;
  /** Stop after this many elements. */
  max_elements?: number;
}

/**
 * Measure every laid-out element on the page.
 *
 * "Laid out" is doing a lot of work: elements with no box, no size, or no
 * visibility are skipped, because an element that is not rendered cannot have
 * mirrored and reporting it would be noise. So are the structural wrappers
 * that carry no text and exactly one child — a `<div>` whose only job is to
 * hold another `<div>` has no independent layout to get wrong, and including
 * them would multiply every real finding by the depth of the tree it sits in.
 */
export async function measureElements(page: Page, options: MeasureOptions = {}): Promise<ElementMeasurement[]> {
  const raw = await page.evaluate(collectMeasurements, {
    root: options.selector ?? "",
    exclude: options.exclude ?? "",
    max_scan: MAX_RTL_SCAN,
    max_elements: Math.min(options.max_elements ?? MAX_RTL_ELEMENTS, MAX_RTL_ELEMENTS),
    max_text: MAX_RTL_TEXT_LENGTH,
    max_selector: MAX_RTL_SELECTOR_LENGTH,
  });
  return raw;
}

/**
 * Pair up two measurements of the same page.
 *
 * An element is only paired when its structural key appears exactly once in
 * each pass. A key that appears twice in either pass is ambiguous — pairing it
 * by order would be a guess, and a wrong guess invents a mirroring bug out of
 * two different elements — so it is dropped along with anything that appears
 * in only one direction. `unpaired` counts what was dropped so the report can
 * say so rather than silently measuring less than it claims.
 */
export function pairMeasurements(
  ltr: readonly ElementMeasurement[],
  rtl: readonly ElementMeasurement[],
): { pairs: ElementPair[]; unpaired: number } {
  const ltrByKey = indexUnique(ltr);
  const rtlByKey = indexUnique(rtl);

  const pairs: ElementPair[] = [];
  for (const [key, left] of ltrByKey) {
    const right = rtlByKey.get(key);
    if (right) pairs.push({ ltr: left, rtl: right });
  }

  const unpaired = ltr.length + rtl.length - pairs.length * 2;
  return { pairs, unpaired: Math.max(0, unpaired) };
}

/** Keys seen more than once are removed entirely — an ambiguous pairing is worse than none. */
function indexUnique(items: readonly ElementMeasurement[]): Map<string, ElementMeasurement> {
  const byKey = new Map<string, ElementMeasurement>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (byKey.has(item.key)) {
      duplicates.add(item.key);
      continue;
    }
    byKey.set(item.key, item);
  }
  for (const key of duplicates) byKey.delete(key);
  return byKey;
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Everything below runs inside Chromium, so it is written against
 * `globalThis` and untyped nodes: this package is compiled with the Node lib
 * only, and the page it lands in may have patched half of these properties.
 */

interface TriggerRequest {
  target: string;
  attr: string;
  value: string;
  class_name: string;
}

function applyTrigger(request: TriggerRequest): void {
  const doc = (globalThis as any).document;
  if (!doc) return;
  let node: any = null;
  try {
    node = request.target === "html" ? doc.documentElement : doc.querySelector(request.target);
  } catch {
    node = null;
  }
  if (!node) node = doc.documentElement;
  if (!node) return;

  if (request.attr !== "") {
    try {
      node.setAttribute(request.attr, request.value);
    } catch {
      // A frozen attribute map; the caller's direction check will catch it.
    }
  }
  if (request.class_name !== "") {
    try {
      node.classList.add(request.class_name);
    } catch {
      // Same.
    }
  }
}

interface InjectRequest {
  exclude: string;
  max_nodes: number;
  words: string[];
}

function replaceWithArabic(request: InjectRequest): number {
  const doc = (globalThis as any).document;
  if (!doc || !doc.body) return 0;

  // Declared inside the function, not at module scope: this body is
  // serialised and evaluated inside Chromium, where nothing from this module
  // exists. A reference to an outer constant here is a ReferenceError in the
  // page — and one that `injectArabic`'s catch would turn into a silent "0
  // strings replaced", which is the worst kind of failure this tool can have.
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "SVG"]);
  let excluded: any[] = [];
  if (request.exclude !== "") {
    try {
      excluded = Array.prototype.slice.call(doc.querySelectorAll(request.exclude));
    } catch {
      excluded = [];
    }
  }

  const isExcluded = (node: any): boolean => {
    for (const root of excluded) {
      try {
        if (root === node || root.contains(node)) return true;
      } catch {
        // A node from another document; not excluded.
      }
    }
    return false;
  };

  // Same string, same replacement, wherever it appears — so a nav label that
  // occurs twice does not become two different words and change the layout.
  const pick = (original: string): string => {
    const trimmed = original.trim();
    if (trimmed === "") return original;
    if (!/\p{L}/u.test(trimmed)) {
      const digits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
      return original.replace(/[0-9]/g, (d: string) => digits[Number(d)]);
    }
    const index = Math.min(trimmed.length, request.words.length - 1);
    const built = request.words[index] ?? request.words[request.words.length - 1];
    const leading = original.slice(0, original.length - original.trimStart().length);
    const trailing = original.slice(original.trimEnd().length);
    return `${leading}${built}${trailing}`;
  };

  let replaced = 0;

  // Text nodes.
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: any[] = [];
  let current = walker.nextNode();
  while (current && nodes.length < request.max_nodes) {
    nodes.push(current);
    current = walker.nextNode();
  }

  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent) continue;
    if (skip.has(String(parent.tagName ?? "").toUpperCase())) continue;
    if (isExcluded(parent)) continue;
    const text = String(node.nodeValue ?? "");
    if (text.trim() === "") continue;
    try {
      node.nodeValue = pick(text);
      replaced += 1;
    } catch {
      // Read-only node; skip it.
    }
  }

  // Form fields: a placeholder and a value are text the user reads too, and a
  // form is where RTL text most often goes wrong.
  let fields: any[] = [];
  try {
    fields = Array.prototype.slice.call(doc.querySelectorAll("input,textarea,[placeholder]"));
  } catch {
    fields = [];
  }
  for (const field of fields) {
    if (isExcluded(field)) continue;
    const type = String(field.type ?? "").toLowerCase();
    // Only free text. A date, a number or a colour has a syntax, and Arabic
    // is not it — the browser would simply reject the value.
    if (type !== "" && type !== "text" && type !== "search" && type !== "textarea") continue;
    try {
      const placeholder = String(field.placeholder ?? "");
      if (placeholder.trim() !== "") {
        field.placeholder = pick(placeholder);
        replaced += 1;
      }
      const value = String(field.value ?? "");
      if (value.trim() !== "") {
        field.value = pick(value);
        replaced += 1;
      }
    } catch {
      // A controlled component that refuses the write; skip it.
    }
  }

  return replaced;
}

interface CollectRequest {
  root: string;
  exclude: string;
  max_scan: number;
  max_elements: number;
  max_text: number;
  max_selector: number;
}

function collectMeasurements(request: CollectRequest): ElementMeasurement[] {
  const doc = (globalThis as any).document;
  const view = doc?.defaultView;
  if (!doc || !doc.body || !view) return [];

  let root: any = doc.body;
  if (request.root !== "") {
    try {
      root = doc.querySelector(request.root) ?? doc.body;
    } catch {
      root = doc.body;
    }
  }

  let excluded: any[] = [];
  if (request.exclude !== "") {
    try {
      excluded = Array.prototype.slice.call(doc.querySelectorAll(request.exclude));
    } catch {
      excluded = [];
    }
  }

  const viewportWidth = Math.round(doc.documentElement?.clientWidth ?? view.innerWidth ?? 0);
  const scrollX = view.scrollX ?? 0;
  const scrollY = view.scrollY ?? 0;

  const elide = (value: string, max: number): string => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
  };

  /**
   * A CSS selector for the element.
   *
   * An id wins outright; otherwise the path is walked up to the nearest
   * identified ancestor with `:nth-child` at each step. This is for the
   * *report* and the highlight overlay — the pairing uses `keyFor` instead,
   * because a selector is not stable across a reload when the page renders a
   * different number of siblings.
   */
  const selectorFor = (node: any): string => {
    const id = String(node.id ?? "");
    if (id !== "" && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;

    const parts: string[] = [];
    let current: any = node;
    let depth = 0;
    while (current && current.nodeType === 1 && depth < 6) {
      const tag = String(current.tagName ?? "").toLowerCase();
      const currentId = String(current.id ?? "");
      if (currentId !== "" && /^[A-Za-z][\w-]*$/.test(currentId)) {
        parts.unshift(`#${currentId}`);
        break;
      }
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-child(${index})`);
      current = parent;
      depth += 1;
    }
    return elide(parts.join(" > "), request.max_selector);
  };

  /**
   * The identity that survives a reload.
   *
   * Tag, id, classes and sibling path — everything about *what* the element
   * is, and nothing about where it ended up, since where it ended up is the
   * measurement under test. Classes are sorted so a framework that reorders
   * them between renders does not break the pairing.
   */
  const keyFor = (node: any): string => {
    const parts: string[] = [];
    let current: any = node;
    let depth = 0;
    while (current && current.nodeType === 1 && depth < 12) {
      const tag = String(current.tagName ?? "").toLowerCase();
      const id = String(current.id ?? "");
      if (id !== "") {
        parts.unshift(`#${id}`);
        break;
      }
      let classes = "";
      try {
        classes = Array.prototype.slice
          .call(current.classList ?? [])
          .map((c: any) => String(c))
          // A class that carries the direction is not part of the element's
          // identity — it is the thing being toggled between the two passes.
          .filter((c: string) => !/^(rtl|ltr|dir-rtl|dir-ltr)$/i.test(c))
          .sort()
          .join(".");
      } catch {
        classes = "";
      }
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${tag}${classes === "" ? "" : `.${classes}`}[${index}]`);
      current = current.parentElement;
      depth += 1;
    }
    return parts.join("/");
  };

  /** Text belonging to this element itself, not to its descendants. */
  const ownText = (node: any): string => {
    let text = "";
    for (const child of Array.prototype.slice.call(node.childNodes ?? [])) {
      if (child.nodeType === 3) text += String(child.nodeValue ?? "");
    }
    return text;
  };

  /**
   * Would an author expect this to be mirrored?
   *
   * Named by what it is — an arrow, a chevron, a "next" control — rather than
   * by what it looks like, because deciding from pixels whether a glyph is
   * directional is not something worth guessing at. A false positive here is
   * only a warning, and the evidence is printed next to it.
   */
  const looksDirectional = (node: any): boolean => {
    const haystack = [
      String(node.className ?? ""),
      String(node.id ?? ""),
      String(node.getAttribute?.("aria-label") ?? ""),
      String(node.getAttribute?.("data-icon") ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    if (haystack === "") return false;
    return /(^|[\s_-])(arrow|chevron|caret|next|prev|previous|back|forward|angle)([\s_-]|$)|arrow-|chevron-/.test(
      haystack,
    );
  };

  const out: ElementMeasurement[] = [];
  const walker = doc.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
  let node: any = root.nodeType === 1 ? root : walker.nextNode();
  let scanned = 0;

  while (node && scanned < request.max_scan && out.length < request.max_elements) {
    scanned += 1;
    const element = node;
    node = walker.nextNode();

    const tag = String(element.tagName ?? "").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;

    let skip = false;
    for (const root2 of excluded) {
      try {
        if (root2 === element || root2.contains(element)) {
          skip = true;
          break;
        }
      } catch {
        // Not excluded.
      }
    }
    if (skip) continue;

    let rect: any;
    let style: any;
    try {
      rect = element.getBoundingClientRect();
      style = view.getComputedStyle(element);
    } catch {
      continue;
    }
    if (!rect || !style) continue;
    // Not rendered: nothing to mirror, and reporting it would be noise.
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;

    const text = ownText(element);
    const childCount = element.childElementCount ?? 0;
    // A wrapper with one child and no text of its own has no independent
    // layout to get wrong; its child is measured instead.
    if (text.trim() === "" && childCount === 1 && tag !== "img" && tag !== "svg") continue;

    const x = rect.left + scrollX;
    const y = rect.top + scrollY;
    const right = rect.left + rect.width;

    out.push({
      key: keyFor(element),
      selector: selectorFor(element),
      match_index: 0,
      tag,
      text: elide(text, request.max_text),
      x,
      y,
      width: rect.width,
      height: rect.height,
      viewport_width: viewportWidth,
      text_align: String(style.textAlign ?? ""),
      direction: String(style.direction ?? ""),
      flex_direction: String(style.display ?? "").includes("flex") ? String(style.flexDirection ?? "") : "",
      padding_left: parseFloat(style.paddingLeft) || 0,
      padding_right: parseFloat(style.paddingRight) || 0,
      margin_left: parseFloat(style.marginLeft) || 0,
      margin_right: parseFloat(style.marginRight) || 0,
      scroll_width: Math.round(element.scrollWidth ?? 0),
      client_width: Math.round(element.clientWidth ?? 0),
      overflow_right: Math.max(0, Math.round(right - viewportWidth)),
      overflow_left: Math.max(0, Math.round(-rect.left)),
      transform: String(style.transform ?? "none"),
      ...(looksDirectional(element) ? { mirrorable: true } : {}),
    });
  }

  return out;
}
