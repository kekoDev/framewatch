import type { Page } from "playwright";
import { MAX_DOM_LINES_PER_CARD, MAX_DOM_RECORDS } from "../../constants.js";
import { installProbe, probeConfig, type InstallOptions, type ProbeConfig } from "./probe.js";

/**
 * DOM layer.
 *
 * A frame tells you *that* something changed; this tells you *what*. A
 * MutationObserver installed at document start records every structural
 * change, and the records that fall between two diff cards are grouped into a
 * few lines — "a div.modal appeared inside #app", "#app's style attribute
 * changed 24 times" — which is usually enough to name the element behind a
 * visual change without reading the app's source.
 *
 * Deliberately not recorded:
 *  - anything inside `<head>`. Stylesheet and meta churn is constant in modern
 *    apps (every CSS-in-JS library injects rules continuously) and its effect
 *    is already visible in the frames.
 *  - script/link/meta/title/template elements, comments and doctypes: not
 *    visual.
 *  - whitespace-only text nodes: markup indentation, not content.
 * Subframes are skipped too — the probe only runs in the main frame, so an ad
 * iframe cannot drown out the page under test.
 */

const BINDING = "__framewatch_dom";

/** What happened to a node. */
export type DomOp = "+" | "-" | "~" | "t";

/** One mutation, as pushed by the page. Timestamps are absolute (epoch ms). */
export interface RawDomRecord {
  /** Absolute time the mutation was observed. */
  t: number;
  op: DomOp;
  /** Short descriptor of the node — `div#id`, `span.class`, `p`. */
  target: string;
  /** Descriptor of the parent, for adds and removes. */
  parent?: string;
  /** Attribute name, for `~`. */
  detail?: string;
}

/** One mutation, rebased onto the recording clock. */
export interface DomRecord {
  timestamp_ms: number;
  op: DomOp;
  target: string;
  parent?: string;
  detail?: string;
}

/**
 * The page-side probe.
 *
 * Written against `globalThis` rather than the DOM globals because this file
 * is compiled with the Node lib only — and because everything it touches has
 * to be defensive anyway: it runs at document start in someone else's app,
 * where any of it may be missing, patched or about to be torn down.
 */
const DOM_PROBE = (config: ProbeConfig): void => {
  const g = globalThis as any;
  // Main frame only.
  if (g.top && g.top !== g) return;
  // The probe can be asked for twice on one document (installed on a page that
  // is already open, then re-run by the init script); a second MutationObserver
  // would report every mutation twice.
  const installed = config.binding + "_observing";
  if (g[installed]) return;
  g[installed] = true;
  const send = g[config.binding];
  const doc = g.document;
  if (typeof send !== "function" || !doc || typeof g.MutationObserver !== "function") return;

  const SKIP_TAGS = ["script", "link", "meta", "title", "base", "noscript", "template", "head"];
  const MAX_DESC = 48;

  let queue: unknown[] = [];
  let scheduled = false;
  let budget = config.max_records;

  const flush = (): void => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const result = send(batch);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // The page is being torn down; there is nowhere left to push to.
    }
  };

  const push = (record: unknown): void => {
    if (budget <= 0) return;
    budget--;
    if (queue.length >= config.max_batch) flush();
    queue.push(record);
    if (!scheduled) {
      scheduled = true;
      g.setTimeout(flush, config.flush_ms);
    }
  };

  try {
    g.addEventListener("pagehide", flush, true);
  } catch {
    // Not fatal: records wait for the timer instead.
  }

  const desc = (node: any): string => {
    if (!node) return "?";
    const type = node.nodeType;
    if (type === 9) return "#document";
    if (type === 11) return "#fragment";
    if (type === 3) return "#text";
    if (type !== 1) return "#node";
    let out = String(node.tagName || "?").toLowerCase();
    if (node.id) out += "#" + String(node.id);
    else if (node.classList && node.classList.length) out += "." + String(node.classList[0]);
    return out.length > MAX_DESC ? out.slice(0, MAX_DESC) + "…" : out;
  };

  /** Head content is noise (see the file comment); so is anything inside it. */
  const inHead = (node: any): boolean => {
    const head = doc.head;
    if (!head || !node) return false;
    if (node === head) return true;
    try {
      return head.contains(node) === true;
    } catch {
      return false;
    }
  };

  /** Nodes whose appearance or removal says nothing about what the page looks like. */
  const ignored = (node: any): boolean => {
    if (!node) return true;
    const type = node.nodeType;
    if (type === 3) return String(node.nodeValue || "").trim() === "";
    if (type !== 1) return true;
    return SKIP_TAGS.indexOf(String(node.tagName || "").toLowerCase()) !== -1;
  };

  /**
   * Containers whose *contents* are not worth reporting either. Without this,
   * parsing an inline <script> reports the arrival of its source text as a
   * change to the page.
   */
  const ignoredContainer = (node: any): boolean => {
    if (!node || node.nodeType !== 1) return false;
    return SKIP_TAGS.indexOf(String(node.tagName || "").toLowerCase()) !== -1;
  };

  const record = (op: string, target: string, extra?: Record<string, unknown>): void => {
    push({ t: Date.now(), op, target, ...extra });
  };

  /** A text node changing is really its parent element's text changing. */
  const noteChildren = (nodes: any, op: string, parent: any): void => {
    const count = nodes ? nodes.length : 0;
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      if (ignored(node)) continue;
      if (node.nodeType === 3) record("t", desc(parent));
      else record(op, desc(node), { parent: desc(parent) });
    }
  };

  try {
    new g.MutationObserver((records: any[]) => {
      for (const mutation of records) {
        const target = mutation.target;
        if (inHead(target) || ignoredContainer(target)) continue;
        if (mutation.type === "childList") {
          noteChildren(mutation.addedNodes, "+", target);
          noteChildren(mutation.removedNodes, "-", target);
        } else if (mutation.type === "attributes") {
          record("~", desc(target), { detail: String(mutation.attributeName || "") });
        } else {
          // characterData: the text of the node's parent element changed.
          // Whitespace edits are the parser reflowing indentation, not content.
          const parent = target ? target.parentNode : null;
          if (String(target && target.nodeValue ? target.nodeValue : "").trim() === "") continue;
          if (ignoredContainer(parent) || inHead(parent)) continue;
          record("t", desc(parent));
        }
      }
    }).observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    // No observer, no DOM layer. The capture is still worth having.
  }
};

export class DomCollector {
  readonly #page: Page;
  readonly #limit: number;
  readonly #records: RawDomRecord[] = [];
  #dropped = 0;

  constructor(page: Page, limit: number = MAX_DOM_RECORDS) {
    this.#page = page;
    this.#limit = Math.max(1, limit);
  }

  /**
   * Install the probe. Call before the page navigates, or pass
   * `{ runNow: true }` to also watch the document that is already loaded.
   */
  async attach(options: InstallOptions = {}): Promise<this> {
    const config = probeConfig(BINDING);
    await installProbe<RawDomRecord>(this.#page, config, DOM_PROBE, (batch) => this.#ingest(batch), options);
    return this;
  }

  /** Mutations the cap refused. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Forget everything collected so far. See `BoundedLog.clear`. */
  clear(): void {
    this.#records.length = 0;
    this.#dropped = 0;
  }

  /**
   * Collected mutations in time order, rebased onto the recording clock
   * (`origin` is the recording's start in epoch ms). Mutations from before the
   * recording started keep their negative timestamp — they are the page
   * building itself, and belong on the first card.
   */
  records(origin: number): DomRecord[] {
    return this.#records.map((record) => ({
      timestamp_ms: Math.round(record.t - origin),
      op: record.op,
      target: record.target,
      ...(record.parent !== undefined ? { parent: record.parent } : {}),
      ...(record.detail !== undefined ? { detail: record.detail } : {}),
    }));
  }

  #ingest(batch: RawDomRecord[]): void {
    for (const record of batch) {
      // The page pushes this, so nothing about it is trusted.
      if (!record || typeof record.t !== "number" || typeof record.target !== "string") continue;
      if (this.#records.length >= this.#limit) {
        this.#dropped++;
        continue;
      }
      this.#records.push(record);
    }
  }
}

/**
 * Turn one card's mutations into a few readable lines.
 *
 * Identical mutations are collapsed with a count, in first-seen order: an
 * animation driven by an inline style produces one `~ #logo [style] ×24` line
 * rather than 24 identical ones, and the order still tells the story of what
 * happened first. Returns undefined when there is nothing to say.
 */
export function renderDomChanges(records: DomRecord[], maxLines: number = MAX_DOM_LINES_PER_CARD): string | undefined {
  if (records.length === 0) return undefined;

  const groups = new Map<string, { line: string; count: number }>();
  for (const record of records) {
    const line = describeRecord(record);
    const existing = groups.get(line);
    if (existing) existing.count++;
    else groups.set(line, { line, count: 1 });
  }

  const all = [...groups.values()];
  const shown = all.slice(0, Math.max(1, maxLines));
  const lines = shown.map((group) => (group.count > 1 ? `  ${group.line} ×${group.count}` : `  ${group.line}`));
  if (all.length > shown.length) {
    const hidden = all.slice(shown.length).reduce((sum, group) => sum + group.count, 0);
    lines.push(`  … and ${hidden} more change${hidden === 1 ? "" : "s"} across ${all.length - shown.length} elements`);
  }
  return lines.join("\n");
}

function describeRecord(record: DomRecord): string {
  switch (record.op) {
    case "+":
      return record.parent ? `+ ${record.target} in ${record.parent}` : `+ ${record.target}`;
    case "-":
      return record.parent ? `- ${record.target} from ${record.parent}` : `- ${record.target}`;
    case "~":
      return `~ ${record.target} [${record.detail ?? "?"}]`;
    default:
      return `~ text in ${record.target}`;
  }
}
