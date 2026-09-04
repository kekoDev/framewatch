import type { Page } from "playwright";
import { countSnapshot, interactiveOnly, truncateSnapshot } from "../utils/snapshot-rules.js";

/**
 * The page as a tree of named elements.
 *
 * Playwright's AI-mode aria snapshot gives every visible element a `[ref=eN]`
 * that `aria-ref=eN` resolves back to, so an agent that has read the tree
 * can act on `e8` instead of guessing a selector from a screenshot. The refs
 * belong to the page: they are assigned when the snapshot is taken and stay
 * valid until the DOM changes, which is why this runs on the long-lived
 * interact session rather than on a throwaway page.
 */

export interface SnapshotOptions {
  /** Only this container. Omit for the whole document. */
  selector?: string;
  /** `full` keeps the tree; `interactive` flattens it to what a person can act on. */
  mode: "full" | "interactive";
  /** Cut the text past this many characters, on a line boundary. */
  max_chars: number;
}

export interface PageSnapshot {
  text: string;
  /** Elements with a ref, before any cut. */
  elements: number;
  /** Of those, the ones a person can act on. */
  interactive: number;
  /** Lines dropped to fit `max_chars`. */
  cut_lines: number;
}

export async function takeSnapshot(page: Page, options: SnapshotOptions): Promise<PageSnapshot> {
  const root = options.selector ? page.locator(options.selector).first() : page.locator(":root");
  const tree = await root.ariaSnapshot({ mode: "ai" });
  const counts = countSnapshot(tree);
  const text = options.mode === "interactive" ? interactiveOnly(tree) : tree;
  const cut = truncateSnapshot(text, options.max_chars);
  return { text: cut.text, elements: counts.elements, interactive: counts.interactive, cut_lines: cut.cut_lines };
}
