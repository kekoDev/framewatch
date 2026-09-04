import { z } from "zod";
import type { Page } from "playwright";
import { NAVIGATION_TIMEOUT_MS, SELECTOR_TIMEOUT_MS, SWIPE_STEPS, SWIPE_STEP_DELAY_MS } from "../constants.js";
import { classifyNavigate } from "../utils/vue-rules.js";
import { detectVue, routerNavigate } from "./vue.js";

/**
 * Interaction executor.
 *
 * Turns one declarative interaction step (see the README, "Replaying an interaction
 * script") into real input on a Playwright page. Every step is validated
 * before anything touches the page, and every Playwright failure is reduced to
 * a single actionable line naming the step that failed — a recording is a bad
 * place to surface a 30-line call log.
 */

/** Actions a replayable script (`framewatch_capture`, `framewatch_save_auth`) can perform. */
export const CAPTURE_ACTIONS = [
  "click",
  "tap",
  "type",
  "key",
  "scroll",
  "swipe",
  "hover",
  "select",
  "wait",
  "navigate",
] as const;

/** Actions `framewatch_interact` can perform as a one-off — everything but `wait`, which needs a script to sit in. */
export const INTERACT_ACTIONS = [
  "click",
  "tap",
  "type",
  "key",
  "scroll",
  "swipe",
  "navigate",
  "select",
  "hover",
] as const;

export type InteractionAction = (typeof CAPTURE_ACTIONS)[number] | (typeof INTERACT_ACTIONS)[number];

export interface Interaction {
  action: InteractionAction;
  /** CSS selector for click/tap/type/select/hover, the field to focus for `key`, or the scroll container. */
  selector?: string;
  /** Text to type, key to press, option value to select, or URL to navigate to. */
  value?: string;
  x?: number;
  y?: number;
  delta_x?: number;
  delta_y?: number;
  /** Wait this long *before* performing the action. */
  delay_ms?: number;
}

export interface ExecuteOptions {
  /** Timeout for selector-based actions. Default SELECTOR_TIMEOUT_MS. */
  timeout_ms?: number;
}

/** What a step has to add to its own description once it has run. */
export interface InteractionOutcome {
  /** Appended to `describeInteraction(step)`, e.g. ` (vue-router)`. */
  note?: string;
}

/** Steps that need a touch-capable browser context (`hasTouch: true`). */
const TOUCH_ACTIONS = new Set<InteractionAction>(["tap", "swipe"]);

/** True when any step needs a touch-enabled browser context. */
export function needsTouch(interactions: readonly Interaction[]): boolean {
  return interactions.some((i) => TOUCH_ACTIONS.has(i.action));
}

/**
 * Check that a step carries the fields its action needs. Returns a message
 * naming what is missing, or null when the step is executable. Used both by
 * the tools (at input-validation time, before a browser is even launched) and
 * by `executeInteraction` itself.
 */
export function validateInteraction(interaction: Interaction): string | null {
  const { action, selector, value, x, y, delta_x, delta_y } = interaction;
  const hasPoint = typeof x === "number" && typeof y === "number";
  const hasPartialPoint = typeof x === "number" || typeof y === "number";

  switch (action) {
    case "click":
    case "tap":
    case "hover":
      if (selector) return null;
      if (hasPoint) return null;
      return hasPartialPoint
        ? `${action} needs both \`x\` and \`y\` (or a \`selector\`)`
        : `${action} needs a \`selector\`, or \`x\` and \`y\``;

    case "type":
      return typeof value === "string"
        ? null
        : "type needs a `value` (the text to type; `\n` presses Enter and `\t` presses Tab)";

    case "key":
      return typeof value === "string" && value.length > 0
        ? null
        : "key needs a `value` (the key to press, e.g. `Enter`, `Escape`, `ArrowDown` or `Control+a`)";

    case "select":
      if (!selector) return "select needs a `selector` naming the <select> element";
      return typeof value === "string" ? null : "select needs a `value` (the option to choose)";

    case "scroll":
      return typeof delta_x === "number" || typeof delta_y === "number"
        ? null
        : "scroll needs `delta_y` (and/or `delta_x`) — the distance to scroll";

    case "swipe":
      if (!hasPoint) return "swipe needs `x` and `y` — where the finger goes down";
      return typeof delta_x === "number" || typeof delta_y === "number"
        ? null
        : "swipe needs `delta_x` and/or `delta_y` — how far the finger travels";

    case "navigate":
      return typeof value === "string" && value.length > 0 ? null : "navigate needs a `value` (the URL to go to)";

    case "wait":
      return null;

    default:
      return `unknown action "${String(action)}"`;
  }
}

/** Longest `value` printed in a step description before it is elided. */
const DESCRIBE_VALUE_MAX = 60;

/**
 * One-line, human-readable summary of a step, used in error messages and in
 * the capture summary. Long values (a pasted token, a password) are elided
 * rather than echoed in full.
 */
export function describeInteraction(interaction: Interaction): string {
  const { action, selector, value, x, y, delta_x = 0, delta_y = 0, delay_ms } = interaction;
  const target = selector ? ` "${selector}"` : typeof x === "number" && typeof y === "number" ? ` at ${x},${y}` : "";

  switch (action) {
    case "click":
    case "tap":
    case "hover":
      return `${action}${target}`;
    case "type":
      return `type "${elide(value)}"${selector ? ` into "${selector}"` : ""}`;
    case "select":
      return `select "${elide(value)}"${selector ? ` in "${selector}"` : ""}`;
    case "key":
      return `press "${elide(value)}"${selector ? ` in "${selector}"` : ""}`;
    case "scroll":
      return `scroll${selector ? ` "${selector}"` : ""} by ${delta_x},${delta_y}`;
    case "swipe":
      return `swipe${target} by ${delta_x},${delta_y}`;
    case "navigate":
      return `navigate to ${elide(value)}`;
    case "wait":
      return `wait ${delay_ms ?? 0}ms`;
    default:
      return String(action);
  }
}

function elide(value: string | undefined): string {
  if (value === undefined) return "";
  return value.length > DESCRIBE_VALUE_MAX ? `${value.slice(0, DESCRIBE_VALUE_MAX)}…` : value;
}

/**
 * Perform one interaction on `page`.
 *
 * Waits `delay_ms` first (that is what `delay_ms` means: "wait before this
 * action"), so a `wait` step is simply a step with no action of its own.
 * Throws a single-line Error naming the step on any failure; the page is never
 * touched when the step is invalid.
 */
export async function executeInteraction(
  page: Page,
  interaction: Interaction,
  options: ExecuteOptions = {},
): Promise<InteractionOutcome> {
  const problem = validateInteraction(interaction);
  if (problem) throw new Error(problem);

  const delay = interaction.delay_ms;
  if (typeof delay === "number" && delay > 0) await sleep(delay);

  const timeout = options.timeout_ms ?? SELECTOR_TIMEOUT_MS;
  try {
    return (await perform(page, interaction, timeout)) ?? {};
  } catch (error) {
    throw new Error(describeFailure(interaction, error), { cause: error });
  }
}

async function perform(page: Page, interaction: Interaction, timeout: number): Promise<InteractionOutcome | void> {
  const { action, selector, value, x, y, delta_x = 0, delta_y = 0 } = interaction;

  switch (action) {
    case "click":
      if (selector) await page.locator(selector).first().click({ timeout });
      else await page.mouse.click(x!, y!);
      return;

    case "hover":
      if (selector) await page.locator(selector).first().hover({ timeout });
      else await page.mouse.move(x!, y!);
      return;

    case "tap":
      if (selector) await page.locator(selector).first().tap({ timeout });
      else await page.touchscreen.tap(x!, y!);
      return;

    case "type":
      await typeValue(page, selector, value!, timeout);
      return;

    case "key":
      // A key goes wherever focus is; `selector` is the way to say where that
      // should be without spending a separate click step on it.
      if (selector) await page.locator(selector).first().focus({ timeout });
      await page.keyboard.press(value!);
      return;

    case "select":
      await page.locator(selector!).first().selectOption(value!, { timeout });
      return;

    case "scroll":
      // With a selector, put the pointer over that element first so the wheel
      // scrolls it rather than the page behind it.
      if (selector) await page.locator(selector).first().hover({ timeout });
      await page.mouse.wheel(delta_x, delta_y);
      return;

    case "swipe":
      await swipe(page, x!, y!, delta_x, delta_y);
      return;

    case "navigate": {
      // A path on a page with vue-router goes through the router — same
      // document, state kept, no reload — which is what a person clicking a
      // link in the app gets. Anything else, or a path the router does not
      // know, is a full load. Playwright only resolves relative URLs against
      // a context `baseURL`; resolve against the current page instead, which
      // is what a script author means by "navigate to /login".
      const vue = await detectVue(page);
      const plan = classifyNavigate(value!, page.url(), vue?.router === true);
      if (plan.via === "router") {
        const outcome = await routerNavigate(page, plan.target);
        if (outcome.ok) return { note: " (vue-router)" };
        await page.goto(resolveUrl(value!, page.url()), { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS });
        return { note: ` (full load — vue-router: ${outcome.error})` };
      }
      await page.goto(plan.target, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS });
      return;
    }

    case "wait":
      return;
  }
}

/** Characters a `type` value may carry inline to mean a key press. */
const TYPE_KEYS: Record<string, string> = { "\n": "Enter", "\t": "Tab" };

/**
 * Type `value`, pressing Enter for each `\n` in it and Tab for each `\t`.
 *
 * Typing a newline is what ends most forms, and splitting "duo\n" into a type
 * step and a key step is a step the caller should not have to think about.
 * The first text run still goes in with `fill` — it clears the field, so
 * replaying a script twice does not append to what is already there — and
 * everything after a key press is typed on top of wherever focus ended up,
 * which is what a person continuing to type would produce.
 */
async function typeValue(page: Page, selector: string | undefined, value: string, timeout: number): Promise<void> {
  // Keep the separators: split(/([\n\t])/) yields text, key, text, key, …
  const segments = value.split(/([\n\t])/).filter((segment) => segment !== "");
  // An empty value still means "empty the field", which is `fill("")`.
  if (segments.length === 0) segments.push("");

  let focused = false;
  for (const segment of segments) {
    const key = TYPE_KEYS[segment];
    if (key === undefined) {
      // The first run replaces the field's contents; later runs are typed at
      // the caret, since a key press may well have moved focus elsewhere.
      if (selector && !focused) await page.locator(selector).first().fill(segment, { timeout });
      else await page.keyboard.type(segment);
      focused = true;
      continue;
    }
    // A value that opens with a key ("\n" alone, meaning "press Enter in this
    // field") still has to land on the element the caller named.
    if (selector && !focused) await page.locator(selector).first().focus({ timeout });
    focused = true;
    await page.keyboard.press(key);
  }
}

/**
 * A real finger drag: touchStart, several touchMoves, touchEnd.
 *
 * Playwright's Touchscreen can only tap, so the drag goes through CDP (we are
 * Chromium-only). Intermediate moves matter — a carousel or pull-to-refresh
 * needs the travel and its velocity, not a teleport — and each one is spaced
 * about a frame apart so the page's own velocity maths sees a plausible gesture.
 */
async function swipe(page: Page, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= SWIPE_STEPS; step++) {
      await sleep(SWIPE_STEP_DELAY_MS);
      await cdp.send("Input.dispatchTouchEvent", {
        // Interpolate from the origin (not from the previous point) so the last
        // move lands exactly on x + deltaX, y + deltaY.
        type: "touchMove",
        touchPoints: [{ x: x + (deltaX * step) / SWIPE_STEPS, y: y + (deltaY * step) / SWIPE_STEPS }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * Reduce a Playwright error to one actionable line naming the step. Touch
 * failures get their own wording: the fix is a context option the caller
 * controls, not anything about the page.
 */
function describeFailure(interaction: Interaction, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n")[0];
  const step = describeInteraction(interaction);

  if (/hasTouch|does not support tap/i.test(message)) {
    return `${step} failed: this page is not touch-enabled. Touch is turned on automatically for tap/swipe steps — if you see this, the page was opened without it.`;
  }
  return `${step} failed: ${firstLine}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The shared zod fields every interaction step accepts. Both tools build their
 * own object around these (the action enums differ, and `framewatch_capture`
 * adds `delay_ms` where `framewatch_interact` adds `wait_ms`).
 */
export const interactionFieldShape = {
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector for click/tap/type/select/hover targets, the field to focus first for `key`, or the scroll container",
    ),
  value: z
    .string()
    .optional()
    .describe(
      "Text to type (`\n` in it presses Enter, `\t` presses Tab), key to press for `key` " +
        "(e.g. `Enter`, `Escape`, `ArrowDown`, `Control+a`), option value to select, or URL to navigate to",
    ),
  x: z.number().optional().describe("X coordinate for click/tap/swipe (used when no selector is given)"),
  y: z.number().optional().describe("Y coordinate for click/tap/swipe (used when no selector is given)"),
  delta_x: z.number().optional().describe("Horizontal distance for scroll/swipe"),
  delta_y: z.number().optional().describe("Vertical distance for scroll/swipe"),
};

/**
 * zod `superRefine` hook that rejects a step missing the fields its action
 * needs, so an unusable script is reported as invalid input instead of failing
 * half way through a recording.
 */
export function refineInteraction(value: Interaction, ctx: z.RefinementCtx): void {
  const problem = validateInteraction(value);
  if (problem !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["action"] });
  }
}
