import {
  MAX_RTL_TEXT_LENGTH,
  RTL_ALIGN_TOLERANCE_PX,
  RTL_MIRROR_TOLERANCE_PX,
  RTL_OVERFLOW_TOLERANCE_PX,
} from "../constants.js";

/**
 * What counts as an RTL bug.
 *
 * Everything here is pure: it takes one element measured in both directions
 * and returns a verdict. Nothing in this file opens a browser or touches a
 * page, which is the point — "did this box mirror?", "is this alignment
 * deliberate or forgotten?" and "is that overflow new?" are all judgements
 * with edge cases, and judgements need unit tests that run in milliseconds.
 *
 * The bias throughout is against false alarms, and it is stronger here than
 * anywhere else in this codebase, because static RTL analysis is notorious for
 * crying wolf. `text-align: left` is *correct* on a code block, a number
 * column and a Latin brand name; `padding-left` is correct on anything that
 * should not mirror; `flex-direction: row` is correct wherever the order is
 * physical rather than semantic. A report that flags all of those is a report
 * whose real findings are never read.
 *
 * So nothing is judged from the RTL rendering alone. Every verdict is a
 * *comparison*: the element is measured in LTR and again in RTL, and the only
 * findings are the things that failed to change when the LTR measurement
 * proves they should have. An element that is left-aligned in both directions
 * has forgotten to mirror; one that is left in LTR and right in RTL is
 * working exactly as intended, and this file says nothing about it.
 */

/* ── The measurements ─────────────────────────────────────────────────── */

/**
 * One element as measured in one direction.
 *
 * Deliberately flat and JSON-ish: this is what crosses the boundary out of
 * `page.evaluate`, so it can hold nothing but structured-cloneable values.
 */
export interface ElementMeasurement {
  /** Stable identity across the two renders — see `keyFor` in engine/rtl.ts. */
  key: string;
  /** A CSS selector for the element, for the report and the highlight overlay. */
  selector: string;
  /** Which match of `selector` this is, when the selector is not unique. */
  match_index: number;
  tag: string;
  /** Visible text, elided. Named in the report so a finding is recognisable. */
  text: string;

  /** Border-box in document coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;

  /** The viewport this was measured in, so mirroring can be computed. */
  viewport_width: number;

  /** Computed `text-align`, already resolved from `start`/`end` by the browser. */
  text_align: string;
  /** Computed `direction` on the element itself. */
  direction: string;
  /** Computed `flex-direction`, or "" when the element is not a flex container. */
  flex_direction: string;
  /** Physical padding and margin, to spot asymmetry that never mirrored. */
  padding_left: number;
  padding_right: number;
  margin_left: number;
  margin_right: number;

  /** Overflow of this element past its own content box, and past the viewport. */
  scroll_width: number;
  client_width: number;
  /** How far the box sticks out past the right/left edge of the viewport, 0 when it fits. */
  overflow_right: number;
  overflow_left: number;

  /** A transform that already mirrors the element — `scaleX(-1)` on an icon. */
  transform: string;
  /** Set when this element is one an author would expect to mirror: an arrow, a chevron. */
  mirrorable?: boolean;
}

/** One element measured in both directions. */
export interface ElementPair {
  ltr: ElementMeasurement;
  rtl: ElementMeasurement;
}

/* ── The verdicts ─────────────────────────────────────────────────────── */

/**
 * What can be wrong with an element in RTL.
 *
 * Each of these is a *failure to change*, except `overflow`, which is a change
 * that should not have happened. That asymmetry is the whole design: RTL bugs
 * are things that stayed put.
 */
export type RtlIssueKind =
  | "not_mirrored"
  | "alignment"
  | "flex_not_reversed"
  | "padding_not_mirrored"
  | "overflow"
  | "icon_not_mirrored"
  | "direction_not_applied";

export interface RtlIssue {
  kind: RtlIssueKind;
  /** How bad it is. `problem` leads the report; `warning` follows it. */
  severity: "problem" | "warning";
  /** One line naming what is wrong, in the report's voice. */
  message: string;
  /** The measured evidence, quoted so the reader can check the verdict. */
  evidence: string;
}

/** Every issue found on one element, with the element itself. */
export interface ElementFinding {
  /** 1-based, and the number the highlight overlay is labelled with. */
  index: number;
  selector: string;
  match_index: number;
  /** `button "Add to cart"` — how the element is named in the report. */
  description: string;
  issues: RtlIssue[];
  /** The worst severity among `issues`, so the report can sort and colour. */
  severity: "problem" | "warning";
}

/**
 * Judge one element, having seen it in both directions.
 *
 * Returns every issue it has; an element with none is not a finding and is
 * never mentioned. The checks are deliberately independent — an element can
 * both fail to mirror and newly overflow, and those are two different bugs
 * with two different fixes.
 */
export function judgeElement(pair: ElementPair): RtlIssue[] {
  const issues: RtlIssue[] = [];
  const { ltr, rtl } = pair;

  const mirror = judgeMirror(ltr, rtl);
  if (mirror) issues.push(mirror);

  const align = judgeAlignment(ltr, rtl);
  if (align) issues.push(align);

  const flex = judgeFlex(ltr, rtl);
  if (flex) issues.push(flex);

  const padding = judgePadding(ltr, rtl);
  if (padding) issues.push(padding);

  const overflow = judgeOverflow(ltr, rtl);
  if (overflow) issues.push(overflow);

  const icon = judgeIcon(ltr, rtl);
  if (icon) issues.push(icon);

  return issues;
}

/**
 * Did the box move to where its mirror image should be?
 *
 * An element at x in an LTR viewport of width W belongs at
 * `W - x - width` in RTL. Anything that is off-centre in LTR and has not moved
 * in RTL never mirrored — the single most common RTL bug there is, and the one
 * that a screenshot makes obvious only once somebody knows to look.
 *
 * Two things are deliberately *not* findings. An element that is already
 * centred (or full-width) has a mirror position equal to its own, so it can
 * never fail this check — which is right: there is nothing to mirror. And an
 * element that moved somewhere other than its exact mirror is left alone,
 * because a page may legitimately reflow in RTL; only a box that did not move
 * *at all* is evidence of a forgotten direction.
 */
function judgeMirror(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  const expected = mirroredX(ltr);
  const offCentre = Math.abs(expected - ltr.x);

  // Symmetric in LTR: mirroring is a no-op, so staying put proves nothing.
  if (offCentre <= RTL_MIRROR_TOLERANCE_PX) return null;

  const moved = Math.abs(rtl.x - ltr.x);
  if (moved > RTL_MIRROR_TOLERANCE_PX) return null;

  return {
    kind: "not_mirrored",
    severity: "problem",
    message: "did not mirror — the box sits at the same place in both directions",
    evidence:
      `x=${round(ltr.x)} in LTR, x=${round(rtl.x)} in RTL; ` +
      `mirroring a ${round(ltr.width)}px box in a ${round(ltr.viewport_width)}px viewport should put it at ` +
      `x=${round(expected)}`,
  };
}

/** Where a box's mirror image starts, in the same coordinate space. */
export function mirroredX(m: ElementMeasurement): number {
  return m.viewport_width - m.x - m.width;
}

/**
 * Is the text still aligned to the physical left?
 *
 * Only a finding when the element has text of its own *and* the alignment did
 * not change between the two renders. `text-align: start` resolves to `left`
 * in LTR and `right` in RTL, so a correctly written page shows two different
 * values here and says nothing. Two identical `left`s mean the author wrote
 * `left` rather than `start`, and the Arabic will hug the wrong edge.
 *
 * `center` and `justify` are the same in both directions by definition and are
 * never reported.
 */
function judgeAlignment(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  if (ltr.text === "") return null;

  const align = normaliseAlign(rtl.text_align);
  if (align !== "left") return null;
  if (normaliseAlign(ltr.text_align) !== "left") return null;

  return {
    kind: "alignment",
    severity: "problem",
    message: "stayed left-aligned in an RTL context — the text hugs the wrong edge",
    evidence: `text-align is "${rtl.text_align}" in both directions; use \`start\` (or \`end\`) instead of \`left\``,
  };
}

/** `start`/`end` are resolved by the browser; everything else is compared as written. */
function normaliseAlign(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Did a row of flex items reverse?
 *
 * A `row` flex container follows `direction`, so its items reverse on their
 * own and the computed value stays `row` in both renders — meaning the
 * computed property tells us nothing. What tells us something is whether the
 * *children* actually swapped, which the caller measures and hands over as the
 * child order. Here we only catch the explicit case: a container hard-coded to
 * `row-reverse` in both directions is reversed twice and ends up
 * back-to-front in RTL.
 */
function judgeFlex(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  const rtlDir = String(rtl.flex_direction ?? "").trim().toLowerCase();
  if (rtlDir !== "row-reverse") return null;
  if (String(ltr.flex_direction ?? "").trim().toLowerCase() !== "row-reverse") return null;

  return {
    kind: "flex_not_reversed",
    severity: "warning",
    message: "is `row-reverse` in both directions — RTL reverses it again, so the items end up back to front",
    evidence: "flex-direction: row-reverse under `dir=rtl` lays the items out left to right",
  };
}

/**
 * Asymmetric physical padding that never swapped.
 *
 * A gap of 24px on the left and 0 on the right is a deliberate offset in LTR
 * and a mistake in RTL — unless it swapped, which is what `padding-inline`
 * does and what this checks. Only reported as a warning: plenty of asymmetric
 * padding is decorative and correct in both directions.
 */
function judgePadding(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  const gap = Math.abs(ltr.padding_left - ltr.padding_right);
  if (gap <= RTL_ALIGN_TOLERANCE_PX) return null;

  // Swapped correctly — `padding-inline-start` did its job.
  const swapped =
    Math.abs(rtl.padding_left - ltr.padding_right) <= RTL_ALIGN_TOLERANCE_PX &&
    Math.abs(rtl.padding_right - ltr.padding_left) <= RTL_ALIGN_TOLERANCE_PX;
  if (swapped) return null;

  // Unchanged is the finding; anything else is a reflow we do not judge.
  const unchanged =
    Math.abs(rtl.padding_left - ltr.padding_left) <= RTL_ALIGN_TOLERANCE_PX &&
    Math.abs(rtl.padding_right - ltr.padding_right) <= RTL_ALIGN_TOLERANCE_PX;
  if (!unchanged) return null;

  return {
    kind: "padding_not_mirrored",
    severity: "warning",
    message: "keeps the same physical padding in both directions",
    evidence:
      `padding-left ${round(rtl.padding_left)}px / padding-right ${round(rtl.padding_right)}px, unchanged from LTR; ` +
      "`padding-inline-start`/`padding-inline-end` would swap",
  };
}

/**
 * Content that fits in LTR and sticks out in RTL.
 *
 * This is the one check that reports a *change* rather than a failure to
 * change, and it is the one that catches the bug nobody sees coming: a layout
 * that is pinned with `left`/`right` offsets, or one whose text got longer,
 * pushing content off the edge of the screen — where it is silently cropped
 * and therefore invisible in the screenshot.
 *
 * Overflow that is present in LTR too is not an RTL bug; it is a layout bug,
 * and `framewatch_responsive` is the tool that reports it.
 */
function judgeOverflow(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  const before = Math.max(ltr.overflow_left, ltr.overflow_right);
  const after = Math.max(rtl.overflow_left, rtl.overflow_right);
  if (after <= RTL_OVERFLOW_TOLERANCE_PX) return null;
  if (after <= before + RTL_OVERFLOW_TOLERANCE_PX) return null;

  const edge = rtl.overflow_left > rtl.overflow_right ? "left" : "right";
  const amount = Math.max(rtl.overflow_left, rtl.overflow_right);
  return {
    kind: "overflow",
    severity: "problem",
    message: `overflows the ${edge} edge of the viewport in RTL — the part that sticks out is cropped, not visible`,
    evidence:
      `sticks out ${round(amount)}px past the ${edge} edge in RTL` +
      (before > RTL_OVERFLOW_TOLERANCE_PX ? ` (it already overflowed ${round(before)}px in LTR)` : ", and none in LTR"),
  };
}

/**
 * An arrow or chevron that points the same way in both directions.
 *
 * Directional icons have to flip: a "next" chevron pointing right in Arabic
 * points backwards. The caller decides what counts as directional (by name,
 * by class, by aria-label); this only asks whether the thing that was supposed
 * to flip actually did — via a `scaleX(-1)` transform, or by having a
 * different box shape after the swap.
 */
function judgeIcon(ltr: ElementMeasurement, rtl: ElementMeasurement): RtlIssue | null {
  if (rtl.mirrorable !== true) return null;
  if (isMirroredTransform(rtl.transform) !== isMirroredTransform(ltr.transform)) return null;

  return {
    kind: "icon_not_mirrored",
    severity: "warning",
    message: "looks directional but is drawn the same way in both directions — a 'next' arrow points backwards in RTL",
    evidence:
      rtl.transform === "none" || rtl.transform === ""
        ? "no mirroring transform in either direction; `transform: scaleX(-1)` under `[dir=rtl]` flips it"
        : `transform is "${rtl.transform}" in both directions`,
  };
}

/**
 * Does this transform flip the element horizontally?
 *
 * A computed transform is always a matrix, so the sign of `a` (the horizontal
 * scale) is the answer. `scaleX(-1)` computes to `matrix(-1, 0, 0, 1, 0, 0)`.
 */
export function isMirroredTransform(transform: string): boolean {
  const value = String(transform ?? "").trim();
  if (value === "" || value === "none") return false;
  const match = /^matrix(?:3d)?\(\s*(-?[\d.eE+-]+)/.exec(value);
  if (!match) return /scalex\(\s*-/i.test(value);
  return Number(match[1]) < 0;
}

/* ── Naming and rendering ─────────────────────────────────────────────── */

/**
 * How an element is named in the report: `button "Add to cart"`, `div .card`.
 *
 * An icon-only control has no text at all, and a bare selector is the least
 * recognisable thing to call it by — so text wins when there is any, and the
 * selector is the fallback.
 */
export function describeElement(m: Pick<ElementMeasurement, "tag" | "text" | "selector">): string {
  const text = elide(m.text, MAX_RTL_TEXT_LENGTH);
  return text === "" ? `${m.tag} ${m.selector}` : `${m.tag} "${text}"`;
}

/**
 * Turn judged elements into the findings the report prints, numbered and
 * ordered worst-first.
 *
 * Order is by severity, then by how many things are wrong with the element,
 * then down the page. The numbering happens *after* that sort, so the numbers
 * in the report count from the top of the list and match the labels drawn on
 * the screenshot.
 */
export function buildFindings(pairs: readonly ElementPair[]): ElementFinding[] {
  const judged = pairs
    .map((pair) => ({ pair, issues: judgeElement(pair) }))
    .filter((entry) => entry.issues.length > 0);

  judged.sort((a, b) => {
    const severity = rank(worst(a.issues)) - rank(worst(b.issues));
    if (severity !== 0) return severity;
    if (a.issues.length !== b.issues.length) return b.issues.length - a.issues.length;
    return a.pair.rtl.y - b.pair.rtl.y || a.pair.rtl.x - b.pair.rtl.x;
  });

  return judged.map((entry, index) => ({
    index: index + 1,
    selector: entry.pair.rtl.selector,
    match_index: entry.pair.rtl.match_index,
    description: describeElement(entry.pair.rtl),
    issues: entry.issues,
    severity: worst(entry.issues),
  }));
}

function worst(issues: readonly RtlIssue[]): "problem" | "warning" {
  return issues.some((issue) => issue.severity === "problem") ? "problem" : "warning";
}

function rank(severity: "problem" | "warning"): number {
  return severity === "problem" ? 0 : 1;
}

/** What each kind of issue is called as a section heading, and how it is explained. */
export function describeIssueKind(kind: RtlIssueKind): string {
  switch (kind) {
    case "not_mirrored":
      return "did not mirror";
    case "alignment":
      return "text stayed left-aligned";
    case "flex_not_reversed":
      return "flex row reversed twice";
    case "padding_not_mirrored":
      return "physical padding did not swap";
    case "overflow":
      return "new overflow in RTL";
    case "icon_not_mirrored":
      return "directional icon did not flip";
    case "direction_not_applied":
      return "RTL was never applied";
  }
}

export function elide(value: string, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function round(value: number): number {
  return Math.round(value);
}
