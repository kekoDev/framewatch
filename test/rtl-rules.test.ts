import { describe, expect, it } from "vitest";
import {
  buildFindings,
  describeElement,
  describeIssueKind,
  isMirroredTransform,
  judgeElement,
  mirroredX,
  type ElementMeasurement,
  type RtlIssueKind,
} from "../src/utils/rtl-rules.js";

/**
 * Every RTL verdict, without a browser.
 *
 * The whole point of `rtl-rules.ts` being pure is that these run in
 * milliseconds and cover the edge cases a fixture page cannot reach — a box
 * that is exactly centred, a padding that swapped correctly, a transform
 * expressed as a matrix. The browser tests then only have to prove that the
 * measurements reaching this file are real.
 */

/** A measurement with sensible defaults, so each test names only what it is about. */
const measure = (over: Partial<ElementMeasurement> = {}): ElementMeasurement => ({
  key: "div[1]",
  selector: "#el",
  match_index: 0,
  tag: "div",
  text: "Some text",
  x: 100,
  y: 50,
  width: 200,
  height: 40,
  viewport_width: 1000,
  text_align: "start",
  direction: "ltr",
  flex_direction: "",
  padding_left: 0,
  padding_right: 0,
  margin_left: 0,
  margin_right: 0,
  scroll_width: 200,
  client_width: 200,
  overflow_right: 0,
  overflow_left: 0,
  transform: "none",
  ...over,
});

const kinds = (ltr: Partial<ElementMeasurement>, rtl: Partial<ElementMeasurement>): RtlIssueKind[] =>
  judgeElement({ ltr: measure(ltr), rtl: measure(rtl) }).map((issue) => issue.kind);

describe("mirroring — did the box move to where its mirror image belongs", () => {
  it("reports a box that sits at the same x in both directions", () => {
    // x=100, width=200, viewport=1000 → the mirror is at 700. Staying at 100
    // is the single most common RTL bug there is.
    expect(kinds({ x: 100 }, { x: 100 })).toContain("not_mirrored");
  });

  it("says nothing about a box that did mirror", () => {
    expect(kinds({ x: 100 }, { x: 700 })).not.toContain("not_mirrored");
  });

  it("says nothing about a centred box, where mirroring is a no-op", () => {
    // x=400, width=200, viewport=1000 → the mirror is also 400. An element
    // that cannot move must never be reported for not moving.
    expect(kinds({ x: 400, width: 200 }, { x: 400, width: 200 })).not.toContain("not_mirrored");
  });

  it("says nothing about a full-width box", () => {
    expect(kinds({ x: 0, width: 1000 }, { x: 0, width: 1000 })).not.toContain("not_mirrored");
  });

  it("tolerates sub-pixel drift rather than calling it a bug", () => {
    // Two renders of the same page routinely disagree by a fraction of a
    // pixel; a tolerance that ignored that would flag every element.
    expect(kinds({ x: 100 }, { x: 701.4 })).not.toContain("not_mirrored");
  });

  it("computes the mirror position from the viewport, not the document", () => {
    expect(mirroredX(measure({ x: 100, width: 200, viewport_width: 1000 }))).toBe(700);
  });
});

describe("alignment — is the text still hugging the left edge", () => {
  it("reports text that is left-aligned in both directions", () => {
    expect(kinds({ text_align: "left" }, { text_align: "left" })).toContain("alignment");
  });

  it("says nothing when `start` resolved to left then right", () => {
    // This is a correctly written page: the browser resolves `start`
    // differently per direction, which is exactly what should happen.
    expect(kinds({ text_align: "left" }, { text_align: "right" })).not.toContain("alignment");
  });

  it("says nothing about centred or justified text", () => {
    expect(kinds({ text_align: "center" }, { text_align: "center" })).not.toContain("alignment");
    expect(kinds({ text_align: "justify" }, { text_align: "justify" })).not.toContain("alignment");
  });

  it("says nothing about an element with no text of its own", () => {
    // A layout wrapper inherits `text-align` but has no text to misalign.
    expect(kinds({ text: "", text_align: "left" }, { text: "", text_align: "left" })).not.toContain("alignment");
  });
});

describe("flex — a row that gets reversed twice", () => {
  it("reports row-reverse left hard-coded in both directions", () => {
    expect(kinds({ flex_direction: "row-reverse" }, { flex_direction: "row-reverse" })).toContain(
      "flex_not_reversed",
    );
  });

  it("says nothing about a plain row, which the direction reverses on its own", () => {
    expect(kinds({ flex_direction: "row" }, { flex_direction: "row" })).not.toContain("flex_not_reversed");
  });

  it("says nothing about a column, which has no horizontal order to get wrong", () => {
    expect(kinds({ flex_direction: "column" }, { flex_direction: "column" })).not.toContain("flex_not_reversed");
  });
});

describe("padding — physical values that never swapped", () => {
  it("reports asymmetric padding that is identical in both directions", () => {
    expect(kinds({ padding_left: 48, padding_right: 0 }, { padding_left: 48, padding_right: 0 })).toContain(
      "padding_not_mirrored",
    );
  });

  it("says nothing when the padding swapped, which is what logical properties do", () => {
    expect(kinds({ padding_left: 48, padding_right: 0 }, { padding_left: 0, padding_right: 48 })).not.toContain(
      "padding_not_mirrored",
    );
  });

  it("says nothing about symmetric padding, which cannot swap wrongly", () => {
    expect(kinds({ padding_left: 24, padding_right: 24 }, { padding_left: 24, padding_right: 24 })).not.toContain(
      "padding_not_mirrored",
    );
  });
});

describe("overflow — content that fits in LTR and hangs off the edge in RTL", () => {
  it("reports overflow that is new in RTL", () => {
    expect(kinds({ overflow_right: 0 }, { overflow_left: 120 })).toContain("overflow");
  });

  it("says nothing about overflow that was already there in LTR", () => {
    // That is a layout bug, not an RTL bug — framewatch_responsive reports it.
    expect(kinds({ overflow_right: 100 }, { overflow_right: 100 })).not.toContain("overflow");
  });

  it("names the edge the content sticks out past", () => {
    const [issue] = judgeElement({ ltr: measure(), rtl: measure({ overflow_left: 90 }) }).filter(
      (i) => i.kind === "overflow",
    );
    expect(issue.message).toContain("left edge");
    expect(issue.evidence).toContain("90px");
  });
});

describe("icons — a directional glyph that points the wrong way", () => {
  it("reports an arrow that is drawn identically in both directions", () => {
    expect(kinds({ mirrorable: true }, { mirrorable: true })).toContain("icon_not_mirrored");
  });

  it("says nothing when the icon flips itself with scaleX(-1)", () => {
    expect(
      kinds({ mirrorable: true, transform: "none" }, { mirrorable: true, transform: "matrix(-1, 0, 0, 1, 0, 0)" }),
    ).not.toContain("icon_not_mirrored");
  });

  it("says nothing about an element that is not directional", () => {
    expect(kinds({}, {})).not.toContain("icon_not_mirrored");
  });

  it("reads a horizontal flip out of a computed matrix", () => {
    expect(isMirroredTransform("matrix(-1, 0, 0, 1, 0, 0)")).toBe(true);
    expect(isMirroredTransform("matrix(1, 0, 0, 1, 0, 0)")).toBe(false);
    expect(isMirroredTransform("none")).toBe(false);
    expect(isMirroredTransform("")).toBe(false);
    // A vertical flip is not a mirroring: `scaleY(-1)` leaves `a` positive.
    expect(isMirroredTransform("matrix(1, 0, 0, -1, 0, 0)")).toBe(false);
  });
});

describe("a correct page produces no findings at all", () => {
  it("finds nothing when everything mirrored properly", () => {
    const pairs = [
      {
        ltr: measure({ key: "a", x: 100, text_align: "left", padding_left: 48, padding_right: 0 }),
        rtl: measure({ key: "a", x: 700, text_align: "right", padding_left: 0, padding_right: 48 }),
      },
      { ltr: measure({ key: "b", x: 400, width: 200 }), rtl: measure({ key: "b", x: 400, width: 200 }) },
    ];
    expect(buildFindings(pairs)).toEqual([]);
  });
});

describe("findings — ordering and numbering", () => {
  it("puts problems before warnings and numbers them in that order", () => {
    const warningOnly = {
      ltr: measure({ key: "w", x: 400, width: 200, padding_left: 48 }),
      rtl: measure({ key: "w", x: 400, width: 200, padding_left: 48 }),
    };
    const problem = { ltr: measure({ key: "p", x: 100 }), rtl: measure({ key: "p", x: 100 }) };

    // Passed in warning-first, to prove the sort is doing the work.
    const findings = buildFindings([warningOnly, problem]);

    expect(findings.map((f) => f.severity)).toEqual(["problem", "warning"]);
    // Numbering runs after the sort, so the labels drawn on the screenshot
    // count down the printed list.
    expect(findings.map((f) => f.index)).toEqual([1, 2]);
  });

  it("carries the selector and match index through for the overlay", () => {
    const findings = buildFindings([
      { ltr: measure({ x: 100, selector: "#promo" }), rtl: measure({ x: 100, selector: "#promo", match_index: 2 }) },
    ]);
    expect(findings[0]).toMatchObject({ selector: "#promo", match_index: 2 });
  });
});

describe("naming an element", () => {
  it("prefers the visible text", () => {
    expect(describeElement({ tag: "button", text: "Add to cart", selector: "#buy" })).toBe('button "Add to cart"');
  });

  it("falls back to the selector when there is no text", () => {
    expect(describeElement({ tag: "div", text: "", selector: ".card > div:nth-child(2)" })).toBe(
      "div .card > div:nth-child(2)",
    );
  });
});

describe("every issue kind has a heading", () => {
  it("names all of them", () => {
    const all: RtlIssueKind[] = [
      "not_mirrored",
      "alignment",
      "flex_not_reversed",
      "padding_not_mirrored",
      "overflow",
      "icon_not_mirrored",
      "direction_not_applied",
    ];
    for (const kind of all) {
      expect(describeIssueKind(kind)).toBeTruthy();
    }
  });
});
