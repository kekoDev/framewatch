import { describe, expect, it } from "vitest";
import {
  countSnapshot,
  interactiveOnly,
  isRef,
  refSelector,
  truncateSnapshot,
} from "../src/utils/snapshot-rules.js";

/**
 * What `framewatch_snapshot` does with the tree Playwright hands it, without
 * a browser. The tree below is the real shape of an AI-mode aria snapshot.
 */
const TREE = [
  "- generic [active] [ref=e1]:",
  '  - heading "Sign in" [level=1] [ref=e2]',
  "  - generic [ref=e3]:",
  "    - generic [ref=e4]:",
  "      - text: Email",
  '      - textbox "Email" [ref=e5]',
  '    - button "Sign in" [ref=e8]',
  "  - navigation [ref=e9]:",
  '    - link "Pricing" [ref=e10] [cursor=pointer]:',
  "      - /url: /x",
  "  - generic [ref=e12] [cursor=pointer]: Card",
  "  - paragraph [ref=e13]: Some text",
  '  - checkbox "Remember me" [checked] [ref=e14]',
].join("\n");

describe("countSnapshot", () => {
  it("counts every element with a ref, and the ones a person can act on", () => {
    expect(countSnapshot(TREE)).toEqual({ elements: 11, interactive: 5 });
  });

  it("counts nothing in an empty tree", () => {
    expect(countSnapshot("")).toEqual({ elements: 0, interactive: 0 });
  });
});

describe("interactiveOnly", () => {
  it("keeps only the actionable lines, flattened, with a link's url folded in", () => {
    expect(interactiveOnly(TREE)).toBe(
      [
        '- textbox "Email" [ref=e5]',
        '- button "Sign in" [ref=e8]',
        '- link "Pricing" [ref=e10] [cursor=pointer] → /x',
        "- generic [ref=e12] [cursor=pointer]: Card",
        '- checkbox "Remember me" [checked] [ref=e14]',
      ].join("\n"),
    );
  });

  it("drops the trailing colon a parent line carries", () => {
    expect(interactiveOnly('- button "Menu" [ref=e2]:\n  - text: Menu')).toBe('- button "Menu" [ref=e2]');
  });
});

describe("truncateSnapshot", () => {
  it("returns the tree untouched when it fits", () => {
    expect(truncateSnapshot(TREE, TREE.length)).toEqual({ text: TREE, cut_lines: 0 });
  });

  it("cuts on a line boundary and counts the lines it dropped", () => {
    const { text, cut_lines } = truncateSnapshot(TREE, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith("\n")).toBe(false);
    expect(TREE.startsWith(text)).toBe(true);
    expect(cut_lines).toBe(TREE.split("\n").length - text.split("\n").length);
  });
});

describe("refs", () => {
  it("recognises a ref and nothing else", () => {
    expect(isRef("e8")).toBe(true);
    expect(isRef("e123")).toBe(true);
    expect(isRef("#e8")).toBe(false);
    expect(isRef("button")).toBe(false);
    expect(isRef("")).toBe(false);
  });

  it("turns a ref into the locator Playwright resolves", () => {
    expect(refSelector("e8")).toBe("aria-ref=e8");
  });
});

describe("refs after a navigation", () => {
  // Once the page has had more than one document, Playwright prefixes refs
  // with the frame ordinal: `f1e3`. They are refs all the same.
  const TREE_F1 = ['- generic [ref=f1e1]:', '  - button "Go" [ref=f1e2]', "  - paragraph [ref=f1e3]: text"].join("\n");

  it("counts and filters prefixed refs like plain ones", () => {
    expect(countSnapshot(TREE_F1)).toEqual({ elements: 3, interactive: 1 });
    expect(interactiveOnly(TREE_F1)).toBe('- button "Go" [ref=f1e2]');
  });

  it("recognises a prefixed ref and resolves it", () => {
    expect(isRef("f1e2")).toBe(true);
    expect(isRef("f12e34")).toBe(true);
    expect(isRef("fe2")).toBe(false);
    expect(refSelector("f1e2")).toBe("aria-ref=f1e2");
  });
});
