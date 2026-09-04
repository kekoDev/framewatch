import type { ElementHandle, Page } from "playwright";
import {
  DEAD_CLICK_HOVER_SETTLE_MS,
  DEAD_CLICK_TIMEOUT_MS,
  MAX_DEAD_CLICK_CHANGES,
  MAX_DEAD_CLICK_CHANGE_SAMPLES,
  MAX_DEAD_CLICK_SCAN,
  MAX_DEAD_CLICK_TEXT_LENGTH,
} from "../constants.js";
import type { ConsoleEntry, NetworkEvent } from "../types.js";

/**
 * Click engine.
 *
 * Finds everything on a page that looks clickable, watches what a click
 * actually does, and decides whether anything happened at all. Nothing here
 * decides how to *report* it; that is `tools/dead-clicks.ts`.
 *
 * The hard part is not clicking — it is knowing that nothing happened. A
 * handler can navigate, mutate the DOM, fetch, open a dialog, toggle a
 * checkbox, scroll, move focus, write to localStorage or throw, and only some
 * of those are visible. So the answer is assembled from every channel at once:
 * the URL, an in-page MutationObserver, a signature of every field's value, of
 * storage and of scroll position, plus Playwright's own view of the console,
 * the network, dialogs, popups and downloads. "Dead" means every one of them
 * was silent.
 *
 * Pages are rarely silent on their own, though — a clock ticks, a carousel
 * advances, analytics beacons fire — so the same measurement is taken once
 * with nobody clicking, and whatever the page does by itself is subtracted
 * from every result (see `IdleNoise`). Without that, one `setInterval` makes
 * every element on the page look alive and the tool finds nothing.
 */

/** The `window` key the in-page watcher keeps its counters under. */
export const CLICK_WATCH_KEY = "__framewatch_clicks";

/** Why an element counts as clickable. */
export type ClickableKind = "link" | "button" | "role" | "handler" | "pointer";

/** Everything known about one candidate before it is clicked. */
export interface Clickable {
  /** 1-based position in document order, and the number the report uses. */
  index: number;
  /**
   * A CSS selector for the element, recomputed rather than remembered: the
   * page is reloaded whenever a click changes it, and an ElementHandle does
   * not survive that.
   */
  selector: string;
  /** Which match of `selector` this is, for the (common) case where it is not unique. */
  match_index: number;
  /** How the element is named in the report — `button "Save draft"`. */
  description: string;
  kind: ClickableKind;
  tag: string;
  text: string;
  href?: string;
  role?: string;
  /** The computed `cursor`. `pointer` on a dead element is the whole finding. */
  cursor: string;
  /** The element says it is disabled without being disabled — clicking it is the test. */
  aria_disabled: boolean;
  /** Set when the element must not be clicked, and why. */
  skip?: string;
}

export interface DiscoverClickablesOptions {
  /** Only look inside this. Defaults to the whole document. */
  selector?: string;
  /** Never click anything matching this, or inside it. */
  exclude?: string;
  /** Include elements that are only clickable-looking because of `cursor: pointer`. */
  include_pointer?: boolean;
}

/**
 * Find everything on the page a user could reasonably expect to click.
 *
 * Links, buttons, ARIA click roles and `onclick` attributes are the semantic
 * half. The other half is `cursor: pointer`, which is how a `<div>` announces
 * itself as a button — and which is where dead clicks actually live, because a
 * div has no default behaviour to fall back on when its handler never got
 * attached.
 *
 * `cursor` is an inherited property, so a pointer-styled card makes every one
 * of its descendants look clickable too. Only the outermost element of each
 * pointer subtree is kept, and a pointer element that wraps (or sits inside) a
 * real link or button is dropped entirely — that link is the thing being
 * clicked, and it is tested on its own.
 */
export async function discoverClickables(
  page: Page,
  options: DiscoverClickablesOptions = {},
): Promise<Clickable[]> {
  const raw = await page.evaluate(collectClickables, {
    root: options.selector ?? "",
    exclude: options.exclude ?? "",
    include_pointer: options.include_pointer !== false,
    max_scan: MAX_DEAD_CLICK_SCAN,
    max_text: MAX_DEAD_CLICK_TEXT_LENGTH,
  });

  return raw.map((item, index) => ({
    index: index + 1,
    selector: item.selector,
    match_index: item.match_index,
    description: describeClickable(item),
    kind: item.kind,
    tag: item.tag,
    text: item.text,
    ...(item.href ? { href: item.href } : {}),
    ...(item.role ? { role: item.role } : {}),
    cursor: item.cursor,
    aria_disabled: item.aria_disabled,
    ...(item.skip ? { skip: item.skip } : {}),
  }));
}

/**
 * How an element is named in the report: `button "Save draft"`, `a "Pricing"`.
 *
 * An icon-only control has no text at all, and a bare selector is the least
 * recognisable thing to call it by — so a link falls back to where it points,
 * and everything else to its selector.
 */
export function describeClickable(item: {
  tag: string;
  text: string;
  kind: ClickableKind;
  href?: string;
  selector: string;
}): string {
  if (item.text) return `${item.tag} "${item.text}"`;
  if (item.kind === "link" && item.href) return `${item.tag} → ${item.href}`;
  return `${item.tag} ${item.selector}`;
}

/** Re-find a candidate on the page as it is now. Null when it is no longer there. */
export async function resolveClickable(page: Page, clickable: Clickable): Promise<ElementHandle | null> {
  const handles = await page.$$(clickable.selector).catch(() => []);
  return handles[clickable.match_index] ?? handles[0] ?? null;
}

/* ── Watching what a click does ───────────────────────────────────────── */

/** Everything about the page that a click could change, read in one go. */
export interface PageState {
  /** From `page.url()`, not from the page — a document mid-navigation cannot be asked. */
  url: string;
  /** Identifies this document. A reload keeps the URL and changes this. */
  doc: string;
  /** False when the MutationObserver could not be installed; `elements` is then the fallback. */
  watching: boolean;
  mutations: number;
  /** The first few mutations, described — `+ div.modal in #app`. */
  changes: string[];
  elements: number;
  /** Hash of every field's value and checked state. */
  fields: number;
  /** Hash of localStorage and sessionStorage. */
  storage: number;
  scroll_x: number;
  scroll_y: number;
  title: string;
}

/** What Playwright saw while the click was settling, which the page cannot report on itself. */
export interface ClickEvidence {
  console: ConsoleEntry[];
  network: NetworkEvent[];
  dialogs: string[];
  popups: string[];
  downloads: string[];
  /**
   * True when focus stayed on the clicked element (or inside it), which is
   * what clicking anything focusable does and therefore says nothing. Focus
   * landing somewhere *else* — a label handing it to its input, a skip link —
   * is a real effect.
   */
  focus_self: boolean;
}

export const EMPTY_EVIDENCE: ClickEvidence = {
  console: [],
  network: [],
  dialogs: [],
  popups: [],
  downloads: [],
  focus_self: true,
};

/** What the page does with nobody clicking, so it can be subtracted from what it does when clicked. */
export interface IdleNoise {
  /** Mutations observed in one idle window. A click has to beat this to count. */
  mutations: number;
  /**
   * The mutations the page makes by itself, described. This, rather than the
   * count, is what a click is judged against: timer jitter means an idle
   * window and a click window never see the same *number* of ticks, but they
   * do see the same *kind* of change.
   */
  changes: string[];
  /** Requests the page makes by itself — polling, analytics, lazy loading. */
  network: string[];
  /** What it logs by itself. */
  console: string[];
  /** Signals that fired with nobody clicking, and are therefore worthless here. */
  unstable: EffectKind[];
}

export const NO_NOISE: IdleNoise = { mutations: 0, changes: [], network: [], console: [], unstable: [] };

export type EffectKind =
  | "error"
  | "navigated"
  | "reloaded"
  | "dialog"
  | "popup"
  | "download"
  | "dom"
  | "fields"
  | "storage"
  | "scroll"
  | "focus"
  | "title"
  | "network"
  | "console";

export interface ClickEffect {
  kind: EffectKind;
  detail: string;
}

/** The order effects are reported in: the loudest thing the click did comes first. */
const EFFECT_ORDER: readonly EffectKind[] = [
  "error",
  "navigated",
  "reloaded",
  "dialog",
  "popup",
  "download",
  "dom",
  "fields",
  "storage",
  "scroll",
  "focus",
  "title",
  "network",
  "console",
];

/** Signals a noisy page can never invalidate — none of them happen by accident. */
const ALWAYS_TRUSTED: ReadonlySet<EffectKind> = new Set<EffectKind>([
  "error",
  "navigated",
  "reloaded",
  "dialog",
  "popup",
  "download",
]);

/**
 * Signals judged by *what* happened rather than by whether the page is restless.
 *
 * A DOM change is compared against the changes the page makes on its own, a
 * request against the URLs it fetches on its own, a log line against what it
 * logs on its own. Declaring those channels unusable the moment a page has a
 * clock in it would throw away the three most common things a working button
 * does — so they are filtered by content instead, and only the signals with
 * nothing to compare (a hash, a scroll position) are ever declared unstable.
 */
const CONTENT_FILTERED: ReadonlySet<EffectKind> = new Set<EffectKind>(["dom", "network", "console"]);

/**
 * Everything the click did. An empty list is a dead click.
 *
 * Pure, so every verdict this tool reaches is unit-testable without a browser.
 *
 * When the URL changed, the two states describe two different documents and
 * comparing their innards would be meaningless — the navigation is the answer,
 * and only the out-of-page evidence is still read.
 */
export function diffPageState(
  before: PageState,
  after: PageState,
  evidence: ClickEvidence = EMPTY_EVIDENCE,
  idle: IdleNoise = NO_NOISE,
): ClickEffect[] {
  const effects: ClickEffect[] = [];
  const unstable = new Set(idle.unstable);
  const add = (kind: EffectKind, detail: string): void => {
    if (!ALWAYS_TRUSTED.has(kind) && unstable.has(kind)) return;
    effects.push({ kind, detail });
  };

  const navigated = !sameUrl(before.url, after.url);
  if (navigated) {
    effects.push({ kind: "navigated", detail: `went to ${after.url}` });
  } else if (before.doc !== "" && after.doc !== "" && before.doc !== after.doc) {
    // Same address, new document: the click reloaded the page. Worth saying
    // out loud — it is what an <a href=""> does, and it usually is not meant.
    effects.push({ kind: "reloaded", detail: "the page reloaded itself" });
  }

  for (const dialog of evidence.dialogs) {
    effects.push({ kind: "dialog", detail: `opened a dialog — ${dialog}` });
  }
  for (const popup of evidence.popups) {
    effects.push({ kind: "popup", detail: `opened a new tab — ${popup}` });
  }
  for (const download of evidence.downloads) {
    effects.push({ kind: "download", detail: `started a download — ${download}` });
  }

  if (!navigated) {
    // What the click changed, as opposed to what the page changes anyway. A
    // count alone cannot tell those apart on a page with a clock in it: two
    // windows of the same length never catch the same number of ticks.
    const fresh = after.changes.filter((change) => !idle.changes.includes(change));
    const extra = after.mutations - Math.max(0, idle.mutations);
    if (after.watching && (fresh.length > 0 || (after.changes.length === 0 && extra > 0))) {
      const many = Math.max(extra, fresh.length, 1);
      add("dom", `${count(many, "DOM change", "DOM changes")}${describeChanges(fresh)}`);
    } else if (!after.watching && after.elements !== before.elements) {
      // No observer (a page that blocked it, or one replaced mid-sweep): the
      // element count is the crude fallback that is left.
      add("dom", `the page has ${after.elements - before.elements > 0 ? "gained" : "lost"} ${Math.abs(after.elements - before.elements)} elements`);
    }
    if (after.fields !== before.fields) add("fields", "a form field's value or checked state changed");
    if (after.storage !== before.storage) add("storage", "it wrote to localStorage or sessionStorage");
    if (Math.abs(after.scroll_y - before.scroll_y) > 2 || Math.abs(after.scroll_x - before.scroll_x) > 2) {
      add("scroll", `the page scrolled to ${after.scroll_x},${after.scroll_y}`);
    }
    if (!evidence.focus_self) add("focus", "it moved focus somewhere else");
    if (after.title !== before.title) add("title", `the title became "${after.title}"`);
  }

  // Network and console are filtered by *content* rather than by
  // `unstable`: a page that polls one endpoint should not lose the whole
  // channel, because a request is often the only thing a working button does,
  // and calling that one dead would be the worse mistake.
  const requests = evidence.network.filter((event) => !idle.network.includes(event.url));
  if (requests.length > 0) {
    const first = requests[0];
    const outcome = first.status > 0 ? String(first.status) : (first.error ?? "no response");
    effects.push({
      kind: "network",
      detail:
        `${count(requests.length, "request", "requests")} — ${first.method} ${first.url} → ${outcome}` +
        (requests.length > 1 ? ", and others" : ""),
    });
  }

  const logged = evidence.console.filter((entry) => !idle.console.includes(entry.text));
  const errors = logged.filter((entry) => entry.level === "error");
  if (errors.length > 0) {
    effects.push({ kind: "error", detail: `the handler threw — ${errors[0].text}` });
  }
  const quiet = logged.filter((entry) => entry.level !== "error");
  if (quiet.length > 0) {
    effects.push({ kind: "console", detail: `wrote to the console — [${quiet[0].level}] ${quiet[0].text}` });
  }

  return effects.sort((a, b) => EFFECT_ORDER.indexOf(a.kind) - EFFECT_ORDER.indexOf(b.kind));
}

/**
 * What the page did to itself. Anything here fires without a click, so it
 * cannot be evidence that a click did something.
 */
export function measureNoise(before: PageState, after: PageState, evidence: ClickEvidence): IdleNoise {
  const effects = diffPageState(before, after, { ...evidence, focus_self: true }, NO_NOISE);
  return {
    mutations: Math.max(0, after.mutations - before.mutations),
    changes: after.changes,
    network: evidence.network.map((event) => event.url),
    console: evidence.console.map((entry) => entry.text),
    unstable: effects
      .map((effect) => effect.kind)
      .filter((kind) => !ALWAYS_TRUSTED.has(kind) && !CONTENT_FILTERED.has(kind)),
  };
}

/** One line describing what a page does on its own, or undefined when it does nothing. */
export function describeNoise(noise: IdleNoise): string | undefined {
  const parts: string[] = [];
  if (noise.mutations > 0) parts.push(count(noise.mutations, "DOM change", "DOM changes"));
  if (noise.network.length > 0) parts.push(count(noise.network.length, "request", "requests"));
  if (noise.console.length > 0) parts.push(count(noise.console.length, "console entry", "console entries"));
  if (noise.unstable.length > 0) parts.push(noise.unstable.join(", "));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/* ── The in-page watcher ──────────────────────────────────────────────── */

/**
 * Install the mutation counter, on this document and on every one after it.
 *
 * An init script alone would only reach the *next* document, and the page is
 * usually already open by the time the sweep starts; running it once by hand
 * covers the one that is there. The script refuses to install twice, so the
 * two paths cannot double-count.
 */
export async function installClickWatcher(page: Page): Promise<void> {
  const config = { key: CLICK_WATCH_KEY, max_changes: MAX_DEAD_CLICK_CHANGE_SAMPLES };
  await page.addInitScript(clickWatcher, config);
  await page.evaluate(clickWatcher, config).catch(() => {});
}

/** Zero the counters, so the next reading measures one click and nothing before it. */
export async function resetClickWatcher(page: Page): Promise<void> {
  await page
    .evaluate((key: string) => {
      const state = (globalThis as any)[key];
      if (state) {
        state.mutations = 0;
        state.changes = [];
      }
    }, CLICK_WATCH_KEY)
    .catch(() => {});
}

/**
 * Read everything the page can say about its own state.
 *
 * Returns null when the page cannot be asked at all — mid-navigation, closed,
 * crashed. A caller that gets null has still learned something (the URL, the
 * console, the network), so this is not an error.
 */
export async function readPageState(page: Page): Promise<PageState | null> {
  const url = safely(() => page.url()) ?? "";
  try {
    const state = await page.evaluate(readState, {
      key: CLICK_WATCH_KEY,
      max_changes: MAX_DEAD_CLICK_CHANGE_SAMPLES,
      max_text: MAX_DEAD_CLICK_TEXT_LENGTH,
    });
    return { url, ...state };
  } catch {
    return null;
  }
}

/* ── Hover ────────────────────────────────────────────────────────────── */

export interface HoverProbe {
  /** The computed cursor while hovered — `pointer` is the page inviting the click. */
  cursor: string;
  /** Which visual properties the page changes on hover, in words. */
  changed: string[];
  /** Why the probe could not run. */
  failed?: string;
}

/** Computed properties read before and after hovering, and what to call each one. */
const HOVER_PROPERTIES: ReadonlyArray<{ property: string; name: string }> = [
  { property: "backgroundColor", name: "background" },
  { property: "backgroundImage", name: "background image" },
  { property: "color", name: "text colour" },
  { property: "borderTopColor", name: "border" },
  { property: "borderTopWidth", name: "border width" },
  { property: "boxShadow", name: "shadow" },
  { property: "opacity", name: "opacity" },
  { property: "transform", name: "transform" },
  { property: "textDecorationLine", name: "underline" },
  { property: "outlineStyle", name: "outline" },
  { property: "filter", name: "filter" },
];

/**
 * Does the page react when the pointer is over this element?
 *
 * Asked only of elements that turned out dead, and for one reason: an element
 * that does nothing *and* lights up under the pointer is actively inviting the
 * click that will do nothing, which is the difference between a missing
 * feature and a broken one.
 *
 * Safe to run afterwards because a dead element, by definition, left the page
 * exactly as it was.
 */
export async function probeHover(
  page: Page,
  handle: ElementHandle,
  options: { timeout_ms?: number; settle_ms?: number } = {},
): Promise<HoverProbe> {
  const timeout = options.timeout_ms ?? DEAD_CLICK_TIMEOUT_MS;
  const settle = options.settle_ms ?? DEAD_CLICK_HOVER_SETTLE_MS;
  const properties = HOVER_PROPERTIES.map((entry) => entry.property);

  try {
    // Start from a known state: the pointer may be sitting on this very
    // element from the click that has just happened.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(settle);
    const before = await handle.evaluate(readComputed, properties);

    await handle.hover({ timeout });
    await page.waitForTimeout(settle);
    const after = await handle.evaluate(readComputed, properties);
    await page.mouse.move(0, 0);

    const changed = HOVER_PROPERTIES.filter((entry) => before[entry.property] !== after[entry.property]).map(
      (entry) => entry.name,
    );
    return { cursor: after.cursor ?? "", changed };
  } catch (error) {
    await page.mouse.move(0, 0).catch(() => {});
    return { cursor: "", changed: [], failed: firstLine(error) };
  }
}

/* ── In-page scripts ──────────────────────────────────────────────────────
 * Everything below runs inside Chromium, so it is written against
 * `globalThis` and untyped nodes: this package is compiled with the Node lib
 * only, and the page it lands in may be mid-teardown, using a framework that
 * has patched half of these properties, or both. Page scripts cannot import,
 * so the few shared helpers are inlined in each — the same trade the context
 * layers make (see engine/layers/probe.ts).
 */

interface RawClickable {
  selector: string;
  match_index: number;
  kind: ClickableKind;
  tag: string;
  text: string;
  href?: string;
  role?: string;
  cursor: string;
  aria_disabled: boolean;
  skip?: string;
}

interface CollectOptions {
  root: string;
  exclude: string;
  include_pointer: boolean;
  max_scan: number;
  max_text: number;
}

function collectClickables(options: CollectOptions): RawClickable[] {
  const g = globalThis as any;
  const doc = g.document;
  if (!doc || !doc.body) return [];

  const SEMANTIC =
    'a[href], button, summary, input[type="button"], input[type="submit"], input[type="reset"], ' +
    'input[type="image"], [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [onclick]';
  const CLICK_ROLES = [
    "button",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "checkbox",
    "radio",
    "option",
  ];
  const BUTTON_TYPES = ["button", "submit", "reset", "image"];
  // Not clickable, and nothing inside them is worth walking into.
  const SKIP_TAGS = ["script", "style", "head", "meta", "link", "title", "template", "noscript", "svg", "iframe"];
  // Schemes that hand the click to something that is not this page.
  const AWAY_SCHEMES = ["mailto:", "tel:", "sms:", "callto:", "ftp:"];

  const flatten = (text: unknown): string =>
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim();

  const escape = (value: string): string => {
    try {
      if (g.CSS && typeof g.CSS.escape === "function") return g.CSS.escape(value);
    } catch {
      // Fall through to the conservative test below.
    }
    return /^[A-Za-z][\w-]*$/.test(value) ? value : "";
  };

  /** A unique-enough CSS selector. Depth is capped; `match_index` settles the rest. */
  const selectorFor = (node: any): string => {
    const parts: string[] = [];
    let current = node;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth++) {
      const tag = String(current.tagName || "").toLowerCase();
      if (tag === "body" || tag === "html") {
        parts.unshift(tag);
        break;
      }
      const id = current.id ? escape(String(current.id)) : "";
      if (id !== "") {
        parts.unshift(`#${id}`);
        break;
      }
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        let position = 0;
        let total = 0;
        for (let i = 0; i < parent.children.length; i++) {
          const sibling = parent.children[i];
          if (sibling.tagName !== current.tagName) continue;
          total++;
          if (sibling === current) position = total;
        }
        if (total > 1 && position > 0) part += `:nth-of-type(${position})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };

  /** What the element says it is, for a report a human reads. */
  const labelFor = (node: any, tag: string): string => {
    let text = "";
    try {
      text = flatten(node.innerText) || flatten(node.textContent);
    } catch {
      text = "";
    }
    if (!text) text = flatten(node.getAttribute && node.getAttribute("aria-label"));
    if (!text) text = flatten(node.getAttribute && node.getAttribute("title"));
    if (!text && node.value !== undefined && tag === "input") text = flatten(node.value);
    if (!text) {
      try {
        const image = node.querySelector ? node.querySelector("img[alt], [aria-label]") : null;
        if (image) text = flatten(image.getAttribute("alt") || image.getAttribute("aria-label"));
      } catch {
        // No inner label to borrow.
      }
    }
    return text.length > options.max_text ? `${text.slice(0, options.max_text)}…` : text;
  };

  let roots: any[] = [doc.body];
  if (options.root !== "") {
    try {
      roots = Array.prototype.slice.call(doc.querySelectorAll(options.root));
    } catch {
      roots = [];
    }
  }

  const found: Array<{ node: any; raw: RawClickable }> = [];
  const seen: any[] = [];
  let scanned = 0;

  const consider = (node: any, tag: string, style: any, cursor: string, parentCursor: string): void => {
    const attribute = (name: string): string => {
      try {
        const value = node.getAttribute ? node.getAttribute(name) : null;
        return value === null || value === undefined ? "" : String(value);
      } catch {
        return "";
      }
    };
    const role = attribute("role").toLowerCase();
    const type = String(node.type ?? "").toLowerCase();

    let kind: ClickableKind | null = null;
    if (tag === "a" && node.hasAttribute && node.hasAttribute("href")) kind = "link";
    else if (tag === "button" || tag === "summary" || (tag === "input" && BUTTON_TYPES.indexOf(type) !== -1)) kind = "button";
    else if (CLICK_ROLES.indexOf(role) !== -1) kind = "role";
    else if (node.hasAttribute && node.hasAttribute("onclick")) kind = "handler";
    // `cursor` is inherited, so only the element the pointer style starts at
    // is a candidate — every descendant of a pointer-styled card would
    // otherwise be reported as its own button.
    else if (options.include_pointer && cursor === "pointer" && parentCursor !== "pointer") kind = "pointer";
    if (kind === null) return;

    if (seen.indexOf(node) !== -1) return;
    seen.push(node);

    if (kind === "pointer") {
      // A pointer wrapper around a real control is not the control; and a
      // pointer-styled span inside a button is part of the button.
      try {
        if (node.querySelector && node.querySelector(SEMANTIC)) return;
        if (node.closest && node.closest(SEMANTIC)) return;
      } catch {
        // A selector this browser will not parse; keep the candidate.
      }
    }

    let rect = { width: 0, height: 0 };
    try {
      rect = node.getBoundingClientRect();
    } catch {
      rect = { width: 0, height: 0 };
    }

    const href = tag === "a" ? String(node.href ?? "") : "";
    const raw: RawClickable = {
      selector: "",
      match_index: 0,
      kind,
      tag,
      text: labelFor(node, tag),
      ...(href ? { href } : {}),
      ...(role ? { role } : {}),
      cursor,
      aria_disabled: attribute("aria-disabled").toLowerCase() === "true",
    };

    const skip = ((): string | undefined => {
      if (node.disabled === true) return "disabled";
      if (style && (style.visibility === "hidden" || style.display === "none")) return "not visible";
      if (rect.width < 1 || rect.height < 1) return "has no size on screen";
      if (options.exclude !== "") {
        try {
          if (node.closest && node.closest(options.exclude)) return "excluded";
        } catch {
          // An `exclude` this browser will not parse excludes nothing; the
          // tool validates it separately and says so.
        }
      }
      if (tag === "a") {
        if (node.hasAttribute && node.hasAttribute("download")) return "downloads a file";
        const scheme = href.slice(0, href.indexOf(":") + 1).toLowerCase();
        if (AWAY_SCHEMES.indexOf(scheme) !== -1) return `hands the click to ${scheme.replace(":", "")}`;
        // A link to another site is alive by construction, and following it
        // would send a request to a third party this tool has no business
        // making on the user's behalf. Only an http(s) link can be off-site:
        // `javascript:void(0)` has no origin of its own, and it is exactly the
        // link most worth clicking here.
        try {
          const parsed = href === "" ? null : new g.URL(href);
          const scheme_ = parsed ? String(parsed.protocol) : "";
          if (parsed && (scheme_ === "http:" || scheme_ === "https:") && parsed.origin !== g.location.origin) {
            return `links to another site (${parsed.origin})`;
          }
        } catch {
          // An href that will not parse cannot be off-site.
        }
      }
      return undefined;
    })();
    if (skip !== undefined) raw.skip = skip;

    found.push({ node, raw });
  };

  const walk = (node: any, parentCursor: string): void => {
    if (scanned >= options.max_scan) return;
    scanned++;
    const tag = String(node.tagName || "").toLowerCase();
    if (SKIP_TAGS.indexOf(tag) !== -1) return;

    let style: any = null;
    try {
      style = g.getComputedStyle(node);
    } catch {
      style = null;
    }
    const cursor = style ? String(style.cursor || "") : parentCursor;

    consider(node, tag, style, cursor, parentCursor);

    // Nothing inside a `display: none` subtree can be seen, let alone clicked.
    if (style && style.display === "none") return;
    const children = node.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) walk(children[i], cursor);
  };

  for (const root of roots) {
    if (root) walk(root, "");
  }

  // Selectors are worked out last: they are only needed for the candidates
  // that survived, and each one costs a querySelectorAll to index.
  for (const entry of found) {
    const selector = selectorFor(entry.node);
    entry.raw.selector = selector;
    try {
      const matches = doc.querySelectorAll(selector);
      let index = -1;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i] === entry.node) index = i;
      }
      if (index === -1) {
        entry.raw.match_index = 0;
        if (entry.raw.skip === undefined) entry.raw.skip = "could not be addressed by a selector";
      } else {
        entry.raw.match_index = index;
      }
    } catch {
      if (entry.raw.skip === undefined) entry.raw.skip = "could not be addressed by a selector";
    }
  }

  return found.map((entry) => entry.raw);
}

/**
 * The page-side watcher: a per-document id and a mutation counter.
 *
 * Head churn is skipped for the same reason the DOM layer skips it — every
 * CSS-in-JS library rewrites `<style>` elements continuously, and a click is
 * not what caused that.
 */
const clickWatcher = (config: { key: string; max_changes: number }): void => {
  const g = globalThis as any;
  const key = config.key;
  if (g[key] && g[key].installed) return;
  const state = {
    installed: true,
    // Identifies this document: a reload keeps the URL and replaces this.
    doc: `${Math.random()}`.slice(2) + "-" + Date.now(),
    watching: false,
    mutations: 0,
    changes: [] as string[],
  };
  g[key] = state;

  const doc = g.document;
  if (!doc || typeof g.MutationObserver !== "function") return;

  const desc = (node: any): string => {
    if (!node) return "?";
    if (node.nodeType === 3) return "#text";
    if (node.nodeType !== 1) return "#node";
    let out = String(node.tagName || "?").toLowerCase();
    if (node.id) out += "#" + String(node.id);
    else if (node.classList && node.classList.length) out += "." + String(node.classList[0]);
    return out.length > 48 ? out.slice(0, 48) + "…" : out;
  };

  const inHead = (node: any): boolean => {
    try {
      return Boolean(doc.head) && (node === doc.head || doc.head.contains(node) === true);
    } catch {
      return false;
    }
  };

  const note = (line: string): void => {
    if (state.changes.length < config.max_changes && state.changes.indexOf(line) === -1) state.changes.push(line);
  };

  try {
    new g.MutationObserver((records: any[]) => {
      for (const record of records) {
        const target = record.target;
        if (inHead(target)) continue;
        state.mutations++;
        if (record.type === "childList") {
          const added = record.addedNodes;
          const removed = record.removedNodes;
          if (added && added.length) note("+ " + desc(added[0]) + " in " + desc(target));
          else if (removed && removed.length) note("- " + desc(removed[0]) + " from " + desc(target));
        } else if (record.type === "attributes") {
          note("~ " + desc(target) + " [" + String(record.attributeName || "") + "]");
        } else {
          note("~ text in " + desc(target.parentNode || target));
        }
      }
    }).observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    state.watching = true;
  } catch {
    // No observer: `elements` in the state reading is the fallback.
  }
};

function readState(options: { key: string; max_changes: number; max_text: number }): Omit<PageState, "url"> {
  const g = globalThis as any;
  const doc = g.document;
  const state = g[options.key] ?? {};

  // A 32-bit rolling hash. The values themselves are never wanted — only
  // whether they are the same as they were a moment ago — and a page can hold
  // megabytes of them.
  const hash = (text: string): number => {
    let value = 0;
    for (let i = 0; i < text.length; i++) value = (Math.imul(value, 31) + text.charCodeAt(i)) | 0;
    return value;
  };

  let fields = "";
  try {
    const nodes = doc.querySelectorAll("input, select, textarea");
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const type = String(node.type ?? "").toLowerCase();
      const value = type === "checkbox" || type === "radio" ? (node.checked ? "1" : "0") : String(node.value ?? "");
      fields += `${i}:${value};`;
    }
  } catch {
    fields = "?";
  }

  let storage = "";
  try {
    for (const store of [g.localStorage, g.sessionStorage]) {
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        const name = store.key(i);
        storage += `${name}=${store.getItem(name)};`;
      }
      storage += "|";
    }
  } catch {
    // Storage can be disabled outright (a sandboxed frame, a strict setting).
    // A constant stands in: the signal is lost, not corrupted.
    storage = "?";
  }

  return {
    doc: String(state.doc ?? ""),
    watching: state.watching === true,
    mutations: Number(state.mutations ?? 0),
    changes: Array.isArray(state.changes) ? state.changes.slice(0, options.max_changes).map(String) : [],
    elements: doc ? doc.getElementsByTagName("*").length : 0,
    fields: hash(fields),
    storage: hash(storage),
    scroll_x: Math.round(Number(g.scrollX ?? 0)),
    scroll_y: Math.round(Number(g.scrollY ?? 0)),
    title: String(doc?.title ?? "").slice(0, options.max_text),
  };
}

function readComputed(node: any, properties: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const style = (globalThis as any).getComputedStyle(node);
    for (const property of properties) out[property] = String(style[property] ?? "");
    out.cursor = String(style.cursor ?? "");
  } catch {
    // A detached node has no computed style; every property reads as empty,
    // which compares equal to itself and reports no hover feedback.
  }
  return out;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Two URLs that differ only by an empty fragment are the same place.
 *
 * `<a href="#">` is the canonical dead link, and clicking one appends a bare
 * `#` to the address bar. Counting that as a navigation would report every
 * dead link in the world as working.
 */
export function sameUrl(a: string, b: string): boolean {
  return stripEmptyHash(a) === stripEmptyHash(b);
}

function stripEmptyHash(url: string): string {
  return url.endsWith("#") ? url.slice(0, -1) : url;
}

function describeChanges(changes: string[]): string {
  if (changes.length === 0) return "";
  const shown = changes.slice(0, MAX_DEAD_CLICK_CHANGES);
  const rest = changes.length - shown.length;
  return ` (${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""})`;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
