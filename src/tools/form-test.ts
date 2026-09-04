import { z } from "zod";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_FORM_WAIT_MS,
  DEFAULT_VIEWPORT,
  FORM_FILL_SETTLE_MS,
  FORM_SCREENSHOT_TIMEOUT_MS,
  MAX_FORM_CONSOLE_ENTRIES,
  MAX_FORM_ERRORS,
  MAX_FORM_FIELDS,
  MAX_FORM_FIELDS_LISTED,
  MAX_FORM_NETWORK_EVENTS,
  MAX_VIEWPORT_HEIGHT,
  MAX_VIEWPORT_WIDTH,
  NAVIGATION_TIMEOUT_MS,
  SELECTOR_TIMEOUT_MS,
} from "../constants.js";
import { withPage } from "../engine/browser.js";
import {
  discoverForms,
  fillForm,
  newMessages,
  readValidation,
  readXssMarker,
  submitForm,
  type DiscoveredForm,
  type FieldProblem,
  type FillResult,
  type SubmitResult,
} from "../engine/forms.js";
import { ConsoleCollector, NetworkCollector } from "../engine/layers/index.js";
import type { ConsoleEntry, NetworkEvent, Viewport } from "../types.js";
import { resizeForOutput, toBase64 } from "../utils/image.js";
import { resolveStorageState, storageStateField, withAuthNote, type StorageState } from "../utils/storage-state.js";
import {
  DEFAULT_FORM_STRATEGIES,
  FORM_STRATEGIES,
  describeStrategy,
  type FormStrategy,
} from "../utils/test-data.js";

export const FORM_TEST_TOOL_NAME = "framewatch_form_test";

export const formTestInputShape = {
  url: z
    .string()
    .url()
    .describe("URL of the page with the form, e.g. http://localhost:3000/signup"),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector for one form, or for the container holding the fields. Omit to test every <form> on the " +
        "page — or, on a page with no <form> element, every field on it.",
    ),
  strategies: z
    .array(z.enum(FORM_STRATEGIES))
    .min(1)
    .max(FORM_STRATEGIES.length)
    .default([...DEFAULT_FORM_STRATEGIES])
    .describe(
      "Which kinds of data to try. Each one runs in its own fresh page: valid, empty, maxlength, " +
        "special_chars, rtl_arabic, numbers_only, spaces_only, boundary, xss.",
    ),
  submit: z
    .boolean()
    .default(false)
    .describe(
      "Submit the form after filling it. Off by default because a submit writes to the app under test — turn " +
        "it on to find out what validation, requests and errors the submit produces.",
    ),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .default(DEFAULT_FORM_WAIT_MS)
    .describe("Wait time (ms) after the submit before the result is read and photographed"),
  wait_for: z.string().optional().describe("CSS selector to wait for (visible) before the form is looked for"),
  wait_for_timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) to wait for `wait_for` to appear (must be > 0)"),
  timeout_ms: z
    .number()
    .int()
    .min(1)
    .default(SELECTOR_TIMEOUT_MS)
    .describe("Max time (ms) one field may take to accept its value, and the submit control to be clickable"),
  max_fields: z
    .number()
    .int()
    .min(1)
    .max(MAX_FORM_FIELDS)
    .default(MAX_FORM_FIELDS)
    .describe("Maximum fields to fill per form"),
  full_page: z
    .boolean()
    .default(false)
    .describe("Photograph the whole document instead of the viewport — for a form taller than the screen"),
  viewport: z
    .object({
      width: z.number().int().min(1).max(MAX_VIEWPORT_WIDTH).default(DEFAULT_VIEWPORT.width),
      height: z.number().int().min(1).max(MAX_VIEWPORT_HEIGHT).default(DEFAULT_VIEWPORT.height),
    })
    .optional()
    .describe("Viewport size (defaults to 1280x720)"),
  storage_state: storageStateField,
};

export const formTestInputSchema = z.object(formTestInputShape);
export type FormTestInput = z.input<typeof formTestInputSchema>;
type ParsedFormTestInput = z.output<typeof formTestInputSchema>;

/** What one form looked like before anything was typed into it. */
interface FormSummary {
  description: string;
  is_form: boolean;
  total_fields: number;
  filled_fields: number;
  fields: string[];
  skipped: FieldProblem[];
}

/** Everything one strategy produced. */
interface StrategyRun {
  strategy: FormStrategy;
  /** Why this strategy produced nothing. Present instead of everything below. */
  error?: string;
  forms?: FormSummary[];
  fills: FillResult[];
  fill_png?: Buffer;
  submit?: SubmitResult;
  submit_png?: Buffer;
  /** Validation text that was not on the page before the form was touched. */
  appeared: string[];
  browser: Array<{ field: string; message: string }>;
  invalid: string[];
  console: ConsoleEntry[];
  network: NetworkEvent[];
  dialogs: string[];
  /** An XSS payload from this strategy ran as code (see engine/forms.ts). */
  xss_executed: boolean;
  final_url?: string;
  navigated: boolean;
}

/**
 * Fill a page's forms with deliberately awkward data and report what breaks.
 *
 * Every strategy gets its own fresh page. That costs a page load each, and it
 * is the whole point: a form filled with valid data and then emptied is not
 * the same test as a form that was empty from the start (the app has seen an
 * input event on every field, live validation has run, and half the frameworks
 * in use will have marked the form "dirty"), and an XSS payload that executed
 * under one strategy would be reported under every later one if they shared a
 * page.
 *
 * Strategies that only fill run concurrently, since filling a form changes
 * nothing outside the browser. With `submit: true` they run one after another
 * instead: submitting is a write to the app under test, and nine of them at
 * once is not a test, it is a load spike.
 *
 * Console and network are cleared once the page has loaded, so everything
 * reported here was caused by the form rather than by the page it lives on.
 */
export async function testForms(rawInput: FormTestInput): Promise<CallToolResult> {
  const parsed = formTestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return errorResult(`Form test failed: invalid input — ${issues}`);
  }
  const input = parsed.data;
  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };

  // Read the auth state once, before any context exists: a missing or stale
  // file is one problem with the call, not one problem per strategy.
  let storageState: StorageState | undefined;
  let auth = null;
  try {
    auth = await resolveStorageState(input.storage_state);
    storageState = auth?.state;
  } catch (error) {
    return errorResult(`Form test of ${input.url} failed: ${firstLine(error)}`);
  }

  const runs: StrategyRun[] = input.submit
    ? await runInOrder(input, viewport, storageState)
    : await Promise.all(input.strategies.map((strategy) => runStrategy(input, viewport, strategy, storageState)));

  const done = runs.filter((run) => run.error === undefined);
  if (done.length === 0) {
    // Every strategy sees the same page, so they all fail the same way — the
    // first reason is the reason.
    return errorResult(`Form test of ${input.url} failed: ${runs[0]?.error ?? "nothing ran"}`);
  }

  return withAuthNote(await render(input, runs, done), auth);
}

async function runInOrder(
  input: ParsedFormTestInput,
  viewport: Viewport,
  storageState?: StorageState,
): Promise<StrategyRun[]> {
  const runs: StrategyRun[] = [];
  for (const strategy of input.strategies) {
    runs.push(await runStrategy(input, viewport, strategy, storageState));
  }
  return runs;
}

/**
 * One strategy, start to finish, in a page of its own.
 *
 * Never throws: a strategy that cannot run carries its reason back so the
 * others are still reported. Only a run where every strategy failed becomes an
 * error result.
 */
async function runStrategy(
  input: ParsedFormTestInput,
  viewport: Viewport,
  strategy: FormStrategy,
  storageState?: StorageState,
): Promise<StrategyRun> {
  const run: StrategyRun = {
    strategy,
    fills: [],
    appeared: [],
    browser: [],
    invalid: [],
    console: [],
    network: [],
    dialogs: [],
    xss_executed: false,
    navigated: false,
  };

  try {
    await withPage({ viewport, contextOptions: storageState ? { storageState } : {} }, async (page) => {
      const consoleLog = new ConsoleCollector(page).attach();
      const network = new NetworkCollector(page).attach();
      // A form that opens an alert would otherwise be dismissed silently by
      // Playwright, taking the reason for a stalled submit with it.
      page.on("dialog", (dialog) => {
        run.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
        void dialog.dismiss().catch(() => {});
      });

      try {
        await page.goto(input.url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
        if (input.wait_for) {
          await page.waitForSelector(input.wait_for, { state: "visible", timeout: input.wait_for_timeout_ms });
        }

        const forms = (await discoverForms(page, { selector: input.selector, max_fields: input.max_fields })).filter(
          (form) => form.fields.length > 0,
        );
        if (forms.length === 0) {
          throw new Error(
            input.selector
              ? `\`${input.selector}\` matched something, but there are no fillable fields inside it`
              : "the page has no fillable fields — no visible, enabled input, select or textarea",
          );
        }
        run.forms = forms.map(summariseForm);

        const openedAt = Date.now();
        consoleLog.clear();
        network.clear();

        const before = await Promise.all(forms.map((form) => readValidation(page, form)));
        for (const form of forms) {
          run.fills.push(await fillForm(form, strategy, { timeout_ms: input.timeout_ms }));
        }
        run.forms = forms.map((form, index) => ({
          ...summariseForm(form),
          filled_fields: run.fills[index].filled.length,
        }));

        await page.waitForTimeout(FORM_FILL_SETTLE_MS);
        run.fill_png = await safeScreenshot(page, input.full_page);

        if (input.submit) {
          // The first form is the one that gets sent: a submit is a navigation
          // or a state change, and the second form's submit would be measuring
          // whatever the first one left behind.
          run.submit = await submitForm(forms[0], { timeout_ms: input.timeout_ms });
          if (input.wait_ms > 0) await page.waitForTimeout(input.wait_ms);
          run.submit_png = await safeScreenshot(page, input.full_page);
        }

        const after = await Promise.all(forms.map((form) => readValidation(page, form)));
        run.appeared = dedupe(after.flatMap((snapshot, index) => newMessages(before[index], snapshot)));
        run.browser = after.flatMap((snapshot) => snapshot.browser);
        run.invalid = dedupe(after.flatMap((snapshot) => snapshot.invalid));
        if (strategy === "xss") run.xss_executed = await readXssMarker(page);

        run.console = consoleLog.entries(openedAt);
        run.network = network.events(openedAt);
        run.final_url = safely(() => page.url());
        run.navigated = run.final_url !== undefined && !sameUrl(run.final_url, input.url);
      } finally {
        consoleLog.detach();
        network.detach();
      }
    });
  } catch (error) {
    run.error = describeFormTestFailure(input, error);
  }

  return run;
}

function summariseForm(form: DiscoveredForm): FormSummary {
  return {
    description: form.description,
    is_form: form.is_form,
    total_fields: form.total_fields,
    filled_fields: 0,
    fields: form.fields.map((field) => describeField(field.info)),
    skipped: form.skipped,
  };
}

/** `#email (email, required, max 20)` — what the field is, in the terms that decide what goes in it. */
function describeField(info: { description: string; type: string; required: boolean; maxlength?: number }): string {
  const parts = [info.type];
  if (info.required) parts.push("required");
  if (info.maxlength !== undefined) parts.push(`max ${info.maxlength}`);
  return `${info.description} (${parts.join(", ")})`;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

async function render(input: ParsedFormTestInput, runs: StrategyRun[], done: StrategyRun[]): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: summarise(input, runs, done) }];

  for (const run of runs) {
    if (run.error !== undefined) {
      content.push({ type: "text", text: `${run.strategy} — did not run: ${run.error}` });
      continue;
    }
    if (run.fill_png) {
      content.push({ type: "image", data: toBase64(await resizeForOutput(run.fill_png)), mimeType: "image/png" });
    }
    content.push({ type: "text", text: describeFill(run) });

    if (run.submit) {
      if (run.submit_png) {
        content.push({ type: "image", data: toBase64(await resizeForOutput(run.submit_png)), mimeType: "image/png" });
      }
      content.push({ type: "text", text: describeSubmit(input, run) });
    }
  }

  return { content };
}

/** The opening block: what was found, what was run, and anything alarming. */
function summarise(input: ParsedFormTestInput, runs: StrategyRun[], done: StrategyRun[]): string {
  const forms = done[0].forms ?? [];
  const lines: string[] = [];

  const shape = forms
    .map(
      (form) =>
        `${form.description}: ${form.total_fields} fillable field${form.total_fields === 1 ? "" : "s"}` +
        (form.skipped.length > 0 ? `, ${form.skipped.length} not fillable` : ""),
    )
    .join("; ");
  lines.push(
    `Form test of ${input.url} — ${shape}. Ran ${count(done.length, "strategy", "strategies")}, ` +
      `${input.submit ? "filling and submitting the form" : "filling the form only (`submit: false`)"}, ` +
      "each in a page of its own.",
  );

  for (const form of forms) {
    if (!form.is_form) {
      lines.push(`${form.description} — there is no <form> element, so the fields were treated as one form.`);
    }
    lines.push(`Fields: ${list(form.fields, MAX_FORM_FIELDS_LISTED)}`);
    if (form.skipped.length > 0) {
      lines.push(
        `Not filled: ${list(
          form.skipped.map((skip) => `${skip.description} (${skip.reason})`),
          MAX_FORM_FIELDS_LISTED,
        )}`,
      );
    }
    if (form.total_fields > form.filled_fields && form.filled_fields > 0 && form.total_fields > input.max_fields) {
      lines.push(`Only the first ${input.max_fields} fields of ${form.description} were filled (\`max_fields\`).`);
    }
  }

  if (forms.length > 1 && input.submit) {
    lines.push(
      `All ${forms.length} forms were filled, but only ${forms[0].description} was submitted — a submit changes ` +
        "the page underneath the others. Pass `selector` to test one of the rest.",
    );
  }

  for (const line of warnings(runs)) lines.push(line);

  return lines.join("\n");
}

/**
 * The findings that should not wait until the reader reaches the right
 * strategy block. Deliberately few — a warning that fires on every form is
 * one nobody reads.
 */
function warnings(runs: StrategyRun[]): string[] {
  const lines: string[] = [];

  if (runs.some((run) => run.xss_executed)) {
    lines.push(
      "Warning — an injected payload executed on this page: input is being written back into the document as " +
        "markup. That is a reflected XSS. The payloads only set a marker; a real one would not be so polite.",
    );
  }

  const failed = runs.flatMap((run) => run.fills.flatMap((fill) => fill.failed));
  if (failed.length > 0) {
    lines.push(
      `Warning — ${count(failed.length, "field", "fields")} would not take a value: ` +
        `${list(dedupe(failed.map((problem) => `${problem.description} (${problem.reason})`)), 3)}`,
    );
  }

  const dialogs = dedupe(runs.flatMap((run) => run.dialogs));
  if (dialogs.length > 0) {
    lines.push(`The page opened ${count(dialogs.length, "dialog", "dialogs")}, dismissed: ${list(dialogs, 3)}`);
  }

  return lines;
}

/** The block under the "after fill" frame. */
function describeFill(run: StrategyRun): string {
  const filled = run.fills.flatMap((fill) => fill.filled);
  const total = (run.forms ?? []).reduce((sum, form) => sum + form.total_fields, 0);
  const lines = [`${run.strategy} — after fill: ${describeStrategy(run.strategy)}`];

  lines.push(
    `${filled.length} of ${total} field${total === 1 ? "" : "s"} filled` +
      (filled.length > 0
        ? `: ${list(
            filled.map((field) => `${field.description}=${quote(field)}`),
            MAX_FORM_FIELDS_LISTED,
          )}`
        : ""),
  );

  const truncated = filled.filter((field) => field.truncated);
  if (truncated.length > 0) {
    lines.push(
      "Truncated by the page: " +
        list(
          truncated.map((field) => `${field.description} kept ${field.landed_length} of ${field.requested_length} characters`),
          MAX_FORM_FIELDS_LISTED,
        ),
    );
  }

  const skipped = run.fills.flatMap((fill) => fill.skipped);
  if (skipped.length > 0) {
    lines.push(
      "Left alone: " +
        list(
          skipped.map((problem) => `${problem.description} (${problem.reason})`),
          MAX_FORM_FIELDS_LISTED,
        ),
    );
  }

  const failed = run.fills.flatMap((fill) => fill.failed);
  if (failed.length > 0) {
    lines.push(
      "Would not take a value: " +
        list(
          failed.map((problem) => `${problem.description} (${problem.reason})`),
          MAX_FORM_FIELDS_LISTED,
        ),
    );
  }

  // Without a submit, whatever the page said it said while being typed into —
  // live validation, and worth reporting on its own.
  if (!run.submit) appendReaction(lines, run, false);

  return lines.join("\n");
}

/** The block under the "after submit" frame. */
function describeSubmit(input: ParsedFormTestInput, run: StrategyRun): string {
  const submitted = run.submit!;
  const lines = [
    `${run.strategy} — after submit: ${submitted.ok ? submitted.how : `not submitted (${submitted.reason})`}` +
      (submitted.ok && input.wait_ms > 0 ? `, waited ${input.wait_ms}ms` : ""),
  ];

  if (run.navigated && run.final_url) lines.push(`The page went to ${run.final_url}`);
  appendReaction(lines, run, submitted.ok);

  return lines.join("\n");
}

/**
 * What the page did about it: its own messages, the browser's constraint
 * validation, the requests, the console.
 *
 * After a submit the empty cases are printed too. "No request was made" and
 * "nothing was shown" are the two findings this tool exists to produce — a
 * form that silently does nothing looks exactly like a form that worked.
 */
function appendReaction(lines: string[], run: StrategyRun, submitted: boolean): void {
  if (run.appeared.length > 0) {
    lines.push(`Page validation: ${list(run.appeared, MAX_FORM_ERRORS)}`);
  } else if (submitted) {
    lines.push("Page validation: nothing new was shown");
  }

  if (run.invalid.length > 0) {
    lines.push(`Fields the page marked invalid: ${list(run.invalid, MAX_FORM_FIELDS_LISTED)}`);
  }

  if (run.browser.length > 0) {
    lines.push(
      `Browser validation: ${list(
        run.browser.map((entry) => `${entry.field} — ${entry.message}`),
        MAX_FORM_ERRORS,
      )}`,
    );
  }

  if (run.network.length > 0) {
    lines.push("Network:");
    for (const event of run.network.slice(0, MAX_FORM_NETWORK_EVENTS)) {
      const outcome = event.status > 0 ? String(event.status) : (event.error ?? "no response");
      lines.push(`  ${event.method} ${event.url} → ${outcome} (${event.duration_ms}ms)`);
    }
    if (run.network.length > MAX_FORM_NETWORK_EVENTS) {
      lines.push(`  … and ${run.network.length - MAX_FORM_NETWORK_EVENTS} more requests`);
    }
  } else if (submitted) {
    lines.push("Network: no request was made — the submit never left the page");
  }

  if (run.console.length > 0) {
    lines.push("Console:");
    for (const entry of run.console.slice(0, MAX_FORM_CONSOLE_ENTRIES)) {
      lines.push(`  [${entry.level}] ${entry.text}`);
    }
    if (run.console.length > MAX_FORM_CONSOLE_ENTRIES) {
      lines.push(`  … and ${run.console.length - MAX_FORM_CONSOLE_ENTRIES} more entries`);
    }
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** A screenshot is always worth having and never worth failing the strategy over. */
async function safeScreenshot(page: Page, fullPage: boolean): Promise<Buffer | undefined> {
  try {
    if (page.isClosed()) return undefined;
    return await page.screenshot({ type: "png", fullPage, timeout: FORM_SCREENSHOT_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

function quote(field: { landed: string; kind: string }): string {
  return field.kind === "toggle" ? field.landed : `"${field.landed}"`;
}

function list(items: string[], max: number): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, … and ${items.length - max} more`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
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
 * One actionable line for a strategy that could not run. Mirrors
 * `describeFailure` in screenshot.ts: match on the failing Playwright call,
 * never on substrings of a user-supplied selector.
 */
export function describeFormTestFailure(
  input: Pick<ParsedFormTestInput, "url" | "wait_for" | "wait_for_timeout_ms">,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = firstLine(message);

  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return (
      "Playwright's Chromium browser is not installed. " +
      `Run \`npx playwright install chromium\` and try again. (${line})`
    );
  }
  if (input.wait_for && /^page\.waitForSelector:/.test(message)) {
    return `selector "${input.wait_for}" did not become visible within ${input.wait_for_timeout_ms}ms`;
  }
  if (/^page\.goto:/.test(message)) {
    return `the page could not be opened — ${line}`;
  }
  return line;
}

export function registerFormTestTool(server: McpServer): void {
  server.registerTool(
    FORM_TEST_TOOL_NAME,
    {
      title: "Form test",
      description:
        "Fill a page's forms with awkward data and report what breaks. Each strategy — valid data, everything " +
        "empty, maxlength, special characters, Arabic (RTL), digits, whitespace, boundary values, and harmless " +
        "XSS payloads — runs in its own fresh page and comes back as a screenshot plus what the page did: the " +
        "validation messages it showed, the browser's own constraint validation, the requests it made, its " +
        "console output, and any value it silently truncated. Set `submit: true` to send the form as well, " +
        "which is what surfaces the two findings that matter most: a submit that shows no error and a submit " +
        "that never makes a request. Works on a page with no <form> element too.",
      inputSchema: formTestInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => testForms(args),
  );
}
