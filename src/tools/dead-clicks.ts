import { z } from "zod";
import type { ElementHandle, Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEAD_CLICK_TIMEOUT_MS,
  DEFAULT_DEAD_CLICK_ELEMENTS,
  DEFAULT_DEAD_CLICK_SETTLE_MS,
  DEFAULT_DEAD_CLICK_WAIT_MS,
  DEFAULT_VIEWPORT,
  HIGHLIGHT_BROKEN_COLOUR,
  HIGHLIGHT_DEAD_COLOUR,
  MAX_DEAD_CLICK_EFFECTS,
  MAX_DEAD_CLICK_ELEMENTS,
  MAX_DEAD_CLICK_LISTED,
  MAX_DEAD_CLICK_SELECTOR_LENGTH,
  MAX_HIGHLIGHTS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  NO_NOISE,
  describeNoise,
  diffPageState,
  discoverClickables,
  installClickWatcher,
  measureNoise,
  probeHover,
  readPageState,
  resetClickWatcher,
  resolveClickable,
  sameUrl,
  type ClickEffect,
  type ClickEvidence,
  type Clickable,
  type HoverProbe,
  type IdleNoise,
} from "../engine/clicks.js";
import { ConsoleCollector, NetworkCollector } from "../engine/layers/index.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { highlightElements, type Highlight } from "../utils/highlight.js";
import { resolveStorageState, storageStateField, withAuthNote } from "../utils/storage-state.js";

export const DEAD_CLICKS_TOOL_NAME = "framewatch_dead_clicks";

export const deadClicksInputShape = {
  url: z
    .string()
    .url()
    .describe("URL to sweep, e.g. http://localhost:3000 (http, https and file URLs are accepted)"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_DEAD_CLICK_WAIT_MS)
    .describe(
      "Wait time (ms) after each page load before anything is clicked. The page is reloaded whenever a click " +
        "changes it, so this is paid once per element that does something — lower it on a fast app.",
    ),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) after each load"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  settle_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_DEAD_CLICK_SETTLE_MS)
    .describe(
      "How long to watch the page after each click before deciding nothing happened. Raise it for an app whose " +
        "handlers are slow; every element costs this much time.",
    ),
  selector: z
    .string()
    .optional()
    .describe("Only sweep inside this container, e.g. 'nav' or '#app main'. Omit to sweep the whole page."),
  exclude: z
    .string()
    .optional()
    .describe(
      "CSS selector for controls that must never be clicked, and nothing inside them either — 'Delete', " +
        "'Place order', anything that spends money. This tool presses every button it finds.",
    ),
  include_pointer: z
    .boolean()
    .default(true)
    .describe(
      "Also test elements that are only clickable-looking because their CSS cursor is a pointer. That is where " +
        "dead clicks actually live (a <div> has no default behaviour to fall back on), so leave it on unless the " +
        "page is full of decorative pointer styling.",
    ),
  include_hover: z
    .boolean()
    .default(true)
    .describe(
      "For each dead element, also check whether the page reacts to hovering it. A dead control that lights up " +
        "under the pointer is actively inviting the click that does nothing.",
    ),
  max_elements: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEAD_CLICK_ELEMENTS)
    .default(DEFAULT_DEAD_CLICK_ELEMENTS)
    .describe("Maximum elements to click. They are clicked in document order; the rest are counted and named."),
  full_page: z
    .boolean()
    .default(false)
    .describe("Photograph the whole document instead of the viewport, so dead elements below the fold are visible too"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  storage_state: storageStateField,
};

export const deadClicksInputSchema = z.object(deadClicksInputShape);
export type DeadClicksInput = z.input<typeof deadClicksInputSchema>;
type ParsedDeadClicksInput = z.output<typeof deadClicksInputSchema>;

/** What one element did — or did not do — when it was clicked. */
export interface Verdict {
  clickable: Clickable;
  /** Everything the click caused. Empty means the click did nothing at all. */
  effects: ClickEffect[];
  /** Set when the element was never clicked, and why. */
  skipped?: string;
  /** How the page reacts to the pointer, asked only of dead elements. */
  hover?: HoverProbe;
}

/** Everything one sweep produced. */
interface Sweep {
  verdicts: Verdict[];
  /** Candidates found before `max_elements` trimmed the list. */
  found: number;
  /** Candidates past `max_elements`, which were never clicked. */
  untested: Clickable[];
  noise: IdleNoise;
  png?: Buffer;
  /** Dead/broken elements the overlay could not draw a box for. */
  unhighlighted: number;
}

/**
 * Find the elements on a page that look clickable and do nothing.
 *
 * Every candidate is clicked for real, and the page is then interrogated from
 * every angle at once — URL, DOM mutations, form state, storage, scroll,
 * focus, console, network, dialogs, popups, downloads. An element is only
 * called dead when all of them stayed silent (see engine/clicks.ts).
 *
 * Two things make the answer trustworthy rather than merely plausible. The
 * page is measured once with nobody clicking, so a ticking clock or a polling
 * fetch cannot make every element look alive. And the page is reloaded after
 * any click that changed it, so element five is judged on the page as it
 * shipped rather than on whatever elements one to four left behind — a click
 * that changed nothing needs no reload, which is exactly the case this tool is
 * looking for, so a page full of dead controls is also the fastest to sweep.
 *
 * This is the one read-only-looking tool that is not read-only: it presses
 * every button on the page, including the one that deletes the account. Use
 * `exclude` (or `selector`) on anything that matters.
 */
export async function findDeadClicks(rawInput: DeadClicksInput): Promise<CallToolResult> {
  const parsed = deadClicksInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Dead-click sweep failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  let contextOptions = {};
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    if (auth) contextOptions = { storageState: auth.state };
  } catch (error) {
    return errorResult(`Dead-click sweep of ${input.url} failed: ${firstLine(error)}`);
  }

  let sweep: Sweep;
  try {
    sweep = await withPage({ viewport, contextOptions }, (page) => runSweep(input, page));
  } catch (error) {
    return errorResult(describeDeadClicksFailure(input, error));
  }

  return withAuthNote(await render(input, sweep), auth);
}

/* ── The sweep ────────────────────────────────────────────────────────── */

async function runSweep(input: ParsedDeadClicksInput, page: Page): Promise<Sweep> {
  const consoleLog = new ConsoleCollector(page).attach();
  const network = new NetworkCollector(page).attach();
  const dialogs: string[] = [];
  const popups: string[] = [];
  const downloads: string[] = [];

  // A page that opens an alert would otherwise be dismissed silently by
  // Playwright, and "it opened a dialog" is the whole answer for that element.
  page.on("dialog", (dialog) => {
    dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => {});
  });
  page.on("popup", (popup) => {
    popups.push(safely(() => popup.url()) ?? "a new tab");
    void popup.close().catch(() => {});
  });
  page.on("download", (download) => {
    downloads.push(download.suggestedFilename());
    void download.cancel().catch(() => {});
  });

  // Before the navigation: the watcher has to be installed at the start of
  // every document, including the first one and every reload after it.
  await installClickWatcher(page);

  try {
    await load(input, page);

    const candidates = await discoverClickables(page, {
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.exclude !== undefined ? { exclude: input.exclude } : {}),
      include_pointer: input.include_pointer,
    });
    if (candidates.length === 0) {
      throw new Error(
        input.selector
          ? `nothing inside \`${input.selector}\` looks clickable — no link, button, click role, onclick or pointer cursor`
          : "nothing on this page looks clickable — no link, button, click role, onclick or pointer cursor",
      );
    }

    const clear = (): void => {
      consoleLog.clear();
      network.clear();
      dialogs.length = 0;
      popups.length = 0;
      downloads.length = 0;
    };
    const evidence = (focusSelf: boolean, since: number): ClickEvidence => ({
      console: consoleLog.entries(since),
      network: network.events(since),
      dialogs: [...dialogs],
      popups: [...popups],
      downloads: [...downloads],
      focus_self: focusSelf,
    });

    const noise = await measureIdle(page, input, clear, evidence);

    const skipped = candidates.filter((candidate) => candidate.skip !== undefined);
    const testable = candidates.filter((candidate) => candidate.skip === undefined);
    const tested = testable.slice(0, input.max_elements);
    const untested = testable.slice(input.max_elements);

    const verdicts: Verdict[] = skipped.map((candidate) => ({
      clickable: candidate,
      effects: [],
      skipped: candidate.skip,
    }));

    let dirty = false;
    for (const candidate of tested) {
      if (dirty) {
        await load(input, page);
        dirty = false;
      }
      const verdict = await testOne(page, input, candidate, clear, evidence, noise);
      verdicts.push(verdict);
      // A click that changed nothing left the page exactly as it was, so there
      // is nothing to restore — which is why a page full of dead controls is
      // the fastest kind to sweep.
      if (verdict.effects.some((effect) => DISTURBING.has(effect.kind))) dirty = true;
    }

    // The overlay is drawn on a page nobody has touched: the boxes are a DOM
    // mutation of their own, and the report is about a page in its shipped state.
    await load(input, page);
    const marked = verdicts.filter(isFlagged);
    const highlights: Highlight[] = marked.slice(0, MAX_HIGHLIGHTS).map((verdict, index) => ({
      selector: verdict.clickable.selector,
      match_index: verdict.clickable.match_index,
      label: String(index + 1),
      colour: isBroken(verdict) ? HIGHLIGHT_BROKEN_COLOUR : HIGHLIGHT_DEAD_COLOUR,
      wash: isBroken(verdict) ? "rgba(240, 140, 0, 0.16)" : "rgba(229, 25, 75, 0.16)",
    }));
    const drawn = await highlightElements(page, highlights);
    const png = await safeScreenshot(page, input.full_page);

    return {
      verdicts,
      found: candidates.length,
      untested,
      noise,
      ...(png ? { png } : {}),
      unhighlighted: marked.length - drawn.drawn.length,
    };
  } finally {
    consoleLog.detach();
    network.detach();
  }
}

/** Effects that leave the page in a state the next element must not be judged against. */
const DISTURBING = new Set(["navigated", "reloaded", "dom", "fields", "storage", "scroll", "title", "dialog"]);

/** Open the page (or put it back the way it started). */
async function load(input: ParsedDeadClicksInput, page: Page): Promise<void> {
  await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
  if (input.wait_for) {
    await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
  }
  if (input.wait_ms > 0) {
    await page.waitForTimeout(input.wait_ms);
  }
}

/**
 * Watch the page for one settle window with nobody clicking.
 *
 * Whatever it does in that window it does by itself, and none of it can be
 * evidence that a click did something. Without this one measurement, a page
 * with a clock in the corner has no dead elements at all.
 */
async function measureIdle(
  page: Page,
  input: ParsedDeadClicksInput,
  clear: () => void,
  evidence: (focusSelf: boolean, since: number) => ClickEvidence,
): Promise<IdleNoise> {
  await resetClickWatcher(page);
  clear();
  const since = Date.now();
  const before = await readPageState(page);
  if (!before) return NO_NOISE;
  if (input.settle_ms > 0) await page.waitForTimeout(input.settle_ms);
  const after = await readPageState(page);
  if (!after) return NO_NOISE;
  return measureNoise(before, after, evidence(true, since));
}

/** Click one element and work out what it did. Never throws. */
async function testOne(
  page: Page,
  input: ParsedDeadClicksInput,
  candidate: Clickable,
  clear: () => void,
  evidence: (focusSelf: boolean, since: number) => ClickEvidence,
  noise: IdleNoise,
): Promise<Verdict> {
  const handle = await resolveClickable(page, candidate);
  if (handle === null) {
    return { clickable: candidate, effects: [], skipped: "it was not on the page any more" };
  }

  // Scroll first, then measure: Playwright would scroll to reach the element
  // anyway, and a scroll it caused must not be read back as something the
  // click did.
  await handle.scrollIntoViewIfNeeded({ timeout: DEAD_CLICK_TIMEOUT_MS }).catch(() => {});

  await resetClickWatcher(page);
  clear();
  const since = Date.now();
  const before = await readPageState(page);
  if (before === null) {
    return { clickable: candidate, effects: [], skipped: "the page could not be read before the click" };
  }

  try {
    // Playwright will not click an `aria-disabled` element: it waits for it to
    // become "enabled" and times out. But whether such an element still works
    // is precisely the question — an aria-disabled control with a live handler
    // tells a screen-reader user it is unavailable and everyone else that it
    // is not — so those are clicked with the actionability checks off.
    await handle.click({ timeout: DEAD_CLICK_TIMEOUT_MS, ...(candidate.aria_disabled ? { force: true } : {}) });
  } catch (error) {
    // A click that navigates can detach the element underneath Playwright.
    // The navigation proves the click landed, whatever the error says.
    if (sameUrl(safely(() => page.url()) ?? before.url, before.url)) {
      return { clickable: candidate, effects: [], skipped: `could not be clicked — ${firstLine(error)}` };
    }
  }

  if (input.settle_ms > 0) await page.waitForTimeout(input.settle_ms);

  const focusSelf = await focusStayedPut(handle);
  // A page mid-navigation cannot be read; its URL and everything Playwright
  // saw still can, so the comparison falls back to those.
  const after = (await readPageState(page)) ?? { ...before, url: safely(() => page.url()) ?? before.url };
  const effects = diffPageState(before, after, evidence(focusSelf, since), noise);

  const verdict: Verdict = { clickable: candidate, effects };
  if (effects.length === 0 && input.include_hover) {
    verdict.hover = await probeHover(page, handle, { timeout_ms: DEAD_CLICK_TIMEOUT_MS });
  }
  return verdict;
}

/**
 * Did focus stay on the element that was clicked?
 *
 * Clicking anything focusable focuses it, so that says nothing. Focus landing
 * somewhere else — a `<label>` handing it to its input, a skip link — is a
 * real effect, and for some controls it is the only one.
 */
async function focusStayedPut(handle: ElementHandle): Promise<boolean> {
  return handle
    .evaluate((node: any) => {
      const doc = (globalThis as any).document;
      const active = doc?.activeElement;
      // Focus falling back to <body> is a blur, not a destination.
      if (!active || active === doc?.body || active === doc?.documentElement) return true;
      return active === node || (node.contains ? node.contains(active) === true : false);
    })
    .catch(() => true);
}

/* ── Verdict shape ────────────────────────────────────────────────────── */

function isDead(verdict: Verdict): boolean {
  return verdict.skipped === undefined && verdict.effects.length === 0;
}

function isBroken(verdict: Verdict): boolean {
  return verdict.skipped === undefined && verdict.effects.some((effect) => effect.kind === "error");
}

/** Dead or broken — the two kinds the overlay paints and the report leads with. */
function isFlagged(verdict: Verdict): boolean {
  return isDead(verdict) || isBroken(verdict);
}

/* ── Rendering ────────────────────────────────────────────────────────── */

async function render(input: ParsedDeadClicksInput, sweep: Sweep): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: formatSweep(input, sweep) }];

  if (sweep.png) {
    try {
      content.push({ type: "image", data: toBase64(await resizeForOutput(sweep.png)), mimeType: "image/png" });
      const marked = sweep.verdicts.filter(isFlagged).length;
      content.push({
        type: "text",
        text:
          marked > 0
            ? `${input.url}, with every dead element boxed in red and every broken one in orange, numbered as above.` +
              (sweep.unhighlighted > 0
                ? ` ${sweep.unhighlighted} of them could not be boxed — the page had re-rendered by the time the overlay was drawn.`
                : "")
            : `${input.url} — nothing to mark up.`,
      });
    } catch {
      // Measured already; failing to re-encode the frame is not worth failing
      // the sweep for.
    }
  }

  return { content };
}

function formatSweep(input: ParsedDeadClicksInput, sweep: Sweep): string {
  const dead = sweep.verdicts.filter(isDead);
  const broken = sweep.verdicts.filter(isBroken);
  const alive = sweep.verdicts.filter(
    (verdict) => verdict.skipped === undefined && verdict.effects.length > 0 && !isBroken(verdict),
  );
  const skipped = sweep.verdicts.filter((verdict) => verdict.skipped !== undefined);
  const clicked = dead.length + broken.length + alive.length;
  const lines: string[] = [];

  lines.push(
    `Dead-click sweep of ${input.url} — ${count(sweep.found, "clickable element", "clickable elements")} found, ` +
      `${clicked} clicked, ${dead.length} dead, ${broken.length} broken, ` +
      `${skipped.length + sweep.untested.length} not clicked.`,
  );

  const noise = describeNoise(sweep.noise);
  if (noise !== undefined) {
    lines.push(
      `This page changes on its own — ${noise} in a ${input.settle_ms}ms window with nobody clicking. That much ` +
        "was subtracted from every element below, so a click has to do more than the page already does.",
    );
  }

  if (clicked === 0) {
    lines.push("Nothing was clicked: every element found was one this tool will not press.");
  } else if (dead.length === 0 && broken.length === 0) {
    lines.push(`Every one of the ${clicked} elements that was clicked did something.`);
  }

  const numbered = sweep.verdicts.filter(isFlagged);
  const badge = (verdict: Verdict): number => numbered.indexOf(verdict) + 1;

  if (dead.length > 0) {
    lines.push("");
    lines.push("Dead — nothing at all happened when these were clicked:");
    for (const verdict of dead.slice(0, MAX_DEAD_CLICK_LISTED)) {
      lines.push(`  ${badge(verdict)}. ${nameOf(verdict)}`);
      for (const note of deadNotes(verdict)) lines.push(`     ${note}`);
    }
    if (dead.length > MAX_DEAD_CLICK_LISTED) {
      lines.push(`  … and ${dead.length - MAX_DEAD_CLICK_LISTED} more dead elements`);
    }
  }

  if (broken.length > 0) {
    lines.push("");
    lines.push("Broken — the handler ran and threw:");
    for (const verdict of broken.slice(0, MAX_DEAD_CLICK_LISTED)) {
      lines.push(`  ${badge(verdict)}. ${nameOf(verdict)}`);
      for (const effect of verdict.effects.slice(0, MAX_DEAD_CLICK_EFFECTS)) {
        lines.push(`     ${effect.detail}`);
      }
    }
    if (broken.length > MAX_DEAD_CLICK_LISTED) {
      lines.push(`  … and ${broken.length - MAX_DEAD_CLICK_LISTED} more`);
    }
  }

  const lying = alive.filter((verdict) => verdict.clickable.aria_disabled);
  if (lying.length > 0) {
    lines.push("");
    lines.push(
      "Marked aria-disabled, but they still work — a screen reader is told these are unavailable, and everyone " +
        "else can use them (they are clicked with Playwright's actionability checks off, which is the only way " +
        "to reach one):",
    );
    for (const verdict of lying.slice(0, MAX_DEAD_CLICK_LISTED)) {
      lines.push(`  ${nameOf(verdict)} — ${verdict.effects[0].detail}`);
    }
  }

  // Everything else that worked. The aria-disabled ones have just had their
  // own section and are not repeated here.
  const ordinary = alive.filter((verdict) => !verdict.clickable.aria_disabled);
  if (ordinary.length > 0) {
    lines.push("");
    lines.push(`Alive — ${count(ordinary.length, "element", "elements")} did something:`);
    for (const verdict of ordinary.slice(0, MAX_DEAD_CLICK_LISTED)) {
      const what = verdict.effects
        .slice(0, MAX_DEAD_CLICK_EFFECTS)
        .map((effect) => effect.detail)
        .join("; ");
      lines.push(`  ${nameOf(verdict)} — ${what}`);
    }
    if (ordinary.length > MAX_DEAD_CLICK_LISTED) {
      lines.push(`  … and ${ordinary.length - MAX_DEAD_CLICK_LISTED} more`);
    }
  }

  if (skipped.length > 0 || sweep.untested.length > 0) {
    lines.push("");
    lines.push(`Not clicked (${skipped.length + sweep.untested.length}):`);
    for (const verdict of skipped.slice(0, MAX_DEAD_CLICK_LISTED)) {
      lines.push(`  ${nameOf(verdict)} — ${verdict.skipped}`);
    }
    if (skipped.length > MAX_DEAD_CLICK_LISTED) {
      lines.push(`  … and ${skipped.length - MAX_DEAD_CLICK_LISTED} more`);
    }
    if (sweep.untested.length > 0) {
      lines.push(
        `  ${count(sweep.untested.length, "element", "elements")} past \`max_elements\` (${input.max_elements}), ` +
          `starting at ${describe(sweep.untested[0])} — raise it, or narrow the sweep with \`selector\`.`,
      );
    }
  }

  return lines.join("\n");
}

/** `1. a "Pricing" (#nav-pricing)` — what it is and how to find it in the source. */
function nameOf(verdict: Verdict): string {
  return describe(verdict.clickable);
}

function describe(clickable: Clickable): string {
  return `${clickable.description} (${elide(clickable.selector, MAX_DEAD_CLICK_SELECTOR_LENGTH)})`;
}

/**
 * The lines under a dead element: why it looked clickable in the first place.
 *
 * A dead control that also lights up under the pointer is the worst case —
 * the page is actively inviting a click it will not answer — and one whose
 * only claim to being a button is a `cursor: pointer` is the classic
 * handler-never-attached bug. Both are the difference between "this is
 * missing" and "this is broken".
 */
function deadNotes(verdict: Verdict): string[] {
  const notes: string[] = [];
  const { clickable, hover } = verdict;

  const looks: string[] = [];
  if (clickable.kind === "pointer") looks.push("it is a plain element styled with a pointer cursor — nothing else says it is a control");
  else if (clickable.cursor === "pointer") looks.push("the cursor is a pointer");
  if (clickable.kind === "link" && clickable.href) {
    const href = clickable.href;
    if (href.endsWith("#")) looks.push('its href is "#", so it relies entirely on a handler');
    else if (href.toLowerCase().startsWith("javascript:")) looks.push(`its href is "${elide(href, 40)}", so it relies entirely on a handler`);
    else looks.push(`it links to ${elide(href, 60)}, and going there was prevented`);
  }
  if (clickable.role) looks.push(`it is marked role="${clickable.role}"`);
  if (hover) {
    if (hover.failed !== undefined) looks.push(`hover could not be checked (${hover.failed})`);
    else if (hover.changed.length > 0) looks.push(`hovering it changes ${hover.changed.join(", ")}`);
    else looks.push("hovering it changes nothing");
  }
  if (looks.length > 0) notes.push(`Looks clickable: ${looks.join("; ")}.`);

  if (clickable.aria_disabled) {
    notes.push('It is marked aria-disabled="true", so doing nothing may well be deliberate.');
  }
  return notes;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** A screenshot is always worth having and never worth failing the sweep over. */
async function safeScreenshot(page: Page, fullPage: boolean): Promise<Buffer | undefined> {
  try {
    if (page.isClosed()) return undefined;
    return await page.screenshot({ type: "png", fullPage });
  } catch {
    return undefined;
  }
}

function elide(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
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

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * One actionable line for a sweep that could not run. Mirrors `describeFailure`
 * in screenshot.ts: match on the failing Playwright call, never on substrings
 * of a user-supplied selector.
 */
export function describeDeadClicksFailure(
  input: Pick<ParsedDeadClicksInput, "url" | "wait_for" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = firstLine(message);
  const prefix = `Dead-click sweep of ${input.url} failed:`;

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      `${prefix} Playwright's Chromium browser is not installed. ` +
      `Run \`npx playwright install chromium\` and try again. (${line})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `${prefix} selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms.`;
  }
  if (/^page\.goto:/.test(message)) {
    return `${prefix} the page could not be opened — ${line}`;
  }
  return `${prefix} ${line}`;
}

export function registerDeadClicksTool(server: McpServer): void {
  server.registerTool(
    DEAD_CLICKS_TOOL_NAME,
    {
      title: "Dead clicks",
      description:
        "Find the elements on a page that look clickable and do nothing — a button whose handler never got " +
        "attached, a link to '#', a <div> with a pointer cursor and no listener. Every candidate (links, " +
        "buttons, ARIA click roles, onclick attributes, pointer-cursor elements) is really clicked, and the " +
        "page is then checked from every angle at once: URL, DOM mutations, form state, storage, scroll, focus, " +
        "console, network, dialogs, popups and downloads. Only silence on all of them counts as dead. What the " +
        "page does on its own is measured first and subtracted, so a clock or a polling fetch cannot hide the " +
        "findings. Returns the list plus a screenshot with the dead elements boxed in red and any that threw in " +
        "orange. NOTE: this presses every button it finds, which is a real write to the app under test — pass " +
        "`exclude` (or `selector`) to keep it away from anything destructive. A sweep costs roughly " +
        "`settle_ms` per element, plus a page reload after each element that did something.",
      inputSchema: deadClicksInputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => findDeadClicks(args),
  );
}
