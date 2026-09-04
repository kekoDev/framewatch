import type { ElementHandle, Page } from "playwright";
import { MAX_FORM_FIELDS, MAX_FORM_MESSAGE_LENGTH, MAX_FORM_MESSAGES, MAX_FORM_TEXT_LENGTH, SELECTOR_TIMEOUT_MS } from "../constants.js";
import {
  XSS_MARKER,
  checkedFor,
  optionFor,
  valueFor,
  type FieldShape,
  type FormStrategy,
  type OptionInfo,
} from "../utils/test-data.js";

/**
 * Form engine.
 *
 * Finds the forms on a page, fills them according to a strategy, submits them,
 * and reads back what the page said about it. Everything here works on real
 * input — Playwright's `fill`, `check` and `selectOption` dispatch the same
 * events a person's typing does — because the bugs this is looking for live in
 * the handlers those events run. Setting `.value` from inside the page would
 * skip every one of them, and a React-controlled input would not even keep the
 * value.
 *
 * Nothing here decides *what* to type; that is `utils/test-data.ts`. This
 * module is about the page: which fields exist, which of them can be filled,
 * what landed in them, and what came back.
 */

/** Elements that can hold a value. */
const FIELD_SELECTOR = "input, select, textarea";

/** Elements that might submit a form. `[role=button]` catches the div-with-a-handler school of markup. */
const SUBMIT_SELECTOR = 'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"]';

/** Words on a button that mean "this one sends the form", when nothing declares it. */
const SUBMIT_WORDS =
  /\b(submit|send|save|sign\s?in|sign\s?up|log\s?in|register|create|continue|next|confirm|apply|search|subscribe|order|pay|checkout|update|post|add)\b/i;

/**
 * Elements that carry a validation message. Class-name matching is deliberately
 * broad — every framework spells it differently — and the noise it lets in is
 * dealt with afterwards: only visible elements with short text count, only the
 * innermost of a nest, and only messages that were not already on the page
 * before the form was touched.
 */
const MESSAGE_SELECTOR = [
  '[role="alert"]',
  '[role="status"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[class*="error" i]',
  '[class*="invalid" i]',
  '[class*="warning" i]',
  '[class*="danger" i]',
  '[class*="toast" i]',
  '[class*="notice" i]',
  '[id*="error" i]',
].join(", ");

/** How a field is filled. */
export type FieldKind = "text" | "choice" | "toggle";

export interface FieldInfo extends FieldShape {
  tag: string;
  kind: FieldKind;
  required: boolean;
  options?: OptionInfo[];
  /** How the field is named in the report — `#email`, `[name="plan"]`, `input[type=text]`. */
  description: string;
}

export interface DiscoveredField {
  info: FieldInfo;
  handle: ElementHandle;
}

/** A field that was not filled, and why. */
export interface FieldProblem {
  description: string;
  reason: string;
}

export interface DiscoveredForm {
  /** 1-based position among the forms found on the page. */
  index: number;
  description: string;
  /** False when this is not a real `<form>` — see `discoverForms`. */
  is_form: boolean;
  /** Fillable fields found, before `max_fields` trimmed the list. */
  total_fields: number;
  fields: DiscoveredField[];
  /** Fields that exist but cannot be filled (hidden, disabled, read-only, file). */
  skipped: FieldProblem[];
  root: ElementHandle;
  page: Page;
}

export interface DiscoverOptions {
  /** CSS selector for one form, or for a container to treat as one. Defaults to every `<form>` on the page. */
  selector?: string;
  max_fields?: number;
}

/**
 * Find the forms on a page.
 *
 * With a `selector`, whatever it matches is the form — a `<form>` element or
 * any container, since the fields are looked for underneath it either way.
 * Without one, every `<form>` on the page is returned in document order.
 *
 * A page with no `<form>` element at all is not a page without a form: React,
 * Vue and Svelte apps routinely put inputs and a button in a `<div>` and wire
 * the submit up in JavaScript. So when there is no form, the page itself is
 * treated as one (`is_form: false`), and everything works as it does for a
 * real form except that Enter cannot be used to submit it.
 */
export async function discoverForms(page: Page, options: DiscoverOptions = {}): Promise<DiscoveredForm[]> {
  const maxFields = options.max_fields ?? MAX_FORM_FIELDS;
  const roots = await findRoots(page, options.selector);

  const forms: DiscoveredForm[] = [];
  for (const root of roots) {
    const handles = await root.handle.$$(FIELD_SELECTOR);
    const described = await Promise.all(handles.map((handle) => handle.evaluate(describeField)));

    const fields: DiscoveredField[] = [];
    const skipped: FieldProblem[] = [];
    let fillable = 0;

    for (let i = 0; i < handles.length; i++) {
      const raw = described[i];
      if (raw.skip !== undefined) {
        skipped.push({ description: raw.description, reason: raw.skip });
        continue;
      }
      fillable++;
      if (fields.length >= maxFields) continue;
      fields.push({ handle: handles[i], info: toFieldInfo(raw) });
    }

    forms.push({
      index: forms.length + 1,
      description: root.description,
      is_form: root.is_form,
      total_fields: fillable,
      fields,
      skipped,
      root: root.handle,
      page,
    });
  }

  return forms;
}

interface Root {
  handle: ElementHandle;
  description: string;
  is_form: boolean;
}

async function findRoots(page: Page, selector?: string): Promise<Root[]> {
  if (selector !== undefined) {
    const handles = await page.$$(selector);
    if (handles.length === 0) {
      throw new Error(`no element on the page matches \`${selector}\``);
    }
    return Promise.all(handles.map(async (handle) => ({ handle, ...(await handle.evaluate(describeRoot)) })));
  }

  const forms = await page.$$("form");
  if (forms.length > 0) {
    return Promise.all(forms.map(async (handle) => ({ handle, ...(await handle.evaluate(describeRoot)) })));
  }

  const body = await page.$("body");
  if (!body) return [];
  return [{ handle: body, description: "the page (it has no <form> element)", is_form: false }];
}

/**
 * Fill every field of `form` according to `strategy`.
 *
 * A field that will not take its value is recorded and the rest are still
 * filled: a form where one field is locked is a finding about that field, and
 * abandoning the other twenty would throw away the run that found it.
 */
export async function fillForm(
  form: DiscoveredForm,
  strategy: FormStrategy,
  options: { timeout_ms?: number } = {},
): Promise<FillResult> {
  const timeout = options.timeout_ms ?? SELECTOR_TIMEOUT_MS;
  const result: FillResult = { filled: [], failed: [], skipped: [] };
  /** Radio groups already answered — one choice per group, not one per button. */
  const groups = new Set<string>();

  for (let i = 0; i < form.fields.length; i++) {
    const { info, handle } = form.fields[i];
    try {
      const outcome = await fillField(handle, info, strategy, i, timeout, groups);
      if ("reason" in outcome) result.skipped.push({ description: info.description, reason: outcome.reason });
      else result.filled.push(outcome);
    } catch (error) {
      result.failed.push({ description: info.description, reason: firstLine(error) });
    }
  }

  return result;
}

export interface FilledField {
  description: string;
  kind: FieldKind;
  /** What the strategy asked for, elided for the report. */
  requested: string;
  requested_length: number;
  /** What the field actually holds now, elided for the report. */
  landed: string;
  landed_length: number;
  /** True when the page kept less than it was given — a limit nothing declared. */
  truncated: boolean;
  /** For checkboxes and radios. */
  checked?: boolean;
}

export interface FillResult {
  filled: FilledField[];
  failed: FieldProblem[];
  /** Fields this strategy deliberately left alone, with the reason. */
  skipped: FieldProblem[];
}

async function fillField(
  handle: ElementHandle,
  info: FieldInfo,
  strategy: FormStrategy,
  variant: number,
  timeout: number,
  groups: Set<string>,
): Promise<FilledField | { reason: string }> {
  if (info.kind === "toggle") {
    const want = checkedFor(strategy);
    if (info.type === "radio") {
      // Clicking a radio cannot clear it, only move the choice elsewhere.
      if (!want) return { reason: "a radio button cannot be cleared, only replaced" };
      const group = info.name ?? info.description;
      if (groups.has(group)) return { reason: `another option in the "${group}" group was chosen` };
      groups.add(group);
      await handle.check({ timeout });
    } else {
      await handle.setChecked(want, { timeout });
    }
    const state = await readBack(handle);
    return {
      description: info.description,
      kind: info.kind,
      requested: want ? "checked" : "unchecked",
      requested_length: 0,
      landed: state.checked ? "checked" : "unchecked",
      landed_length: 0,
      truncated: false,
      checked: state.checked,
    };
  }

  if (info.kind === "choice") {
    const option = optionFor({ ...info, options: info.options ?? [] }, strategy);
    if (option === null) return { reason: "no option to choose — every option is disabled" };
    await handle.selectOption(option, { timeout });
    const state = await readBack(handle);
    return {
      description: info.description,
      kind: info.kind,
      requested: elide(option),
      requested_length: option.length,
      landed: elide(state.value),
      landed_length: state.value.length,
      truncated: false,
    };
  }

  const requested = valueFor(info, strategy, variant);
  await handle.fill(requested, { timeout });
  const state = await readBack(handle);
  return {
    description: info.description,
    kind: info.kind,
    requested: elide(requested),
    requested_length: requested.length,
    landed: elide(state.value),
    landed_length: state.value.length,
    // Only ever shorter: a page that appends to what was typed (a formatter
    // adding separators) is not truncating it.
    truncated: state.value.length < requested.length,
  };
}

function readBack(handle: ElementHandle): Promise<{ value: string; checked: boolean }> {
  return handle.evaluate((node: any) => ({
    value: typeof node.value === "string" ? node.value : "",
    checked: node.checked === true,
  }));
}

export interface SubmitResult {
  ok: boolean;
  /** What was done — `clicked "#submit"`, `pressed Enter in "#q"`. */
  how: string;
  /** Why nothing was done, when `ok` is false. */
  reason?: string;
}

/**
 * Send the form the way a person would.
 *
 * A real submit control comes first, then a button whose text says what it
 * does, then Enter in a text field — which is how a search box with no button
 * is submitted, and the only route left when the markup names nothing. A form
 * that offers none of those is reported rather than forced: calling
 * `form.submit()` from script would skip the page's own submit handler and
 * validation, which is the thing under test.
 */
export async function submitForm(form: DiscoveredForm, options: { timeout_ms?: number } = {}): Promise<SubmitResult> {
  const timeout = options.timeout_ms ?? SELECTOR_TIMEOUT_MS;
  const control = await findSubmitControl(form);

  if (control) {
    try {
      await control.handle.click({ timeout });
      return { ok: true, how: `clicked "${control.description}"` };
    } catch (error) {
      // A click that navigates can detach the button underneath Playwright;
      // the submit happened either way, which the URL proves.
      if (form.page.url() !== control.url_before) {
        return { ok: true, how: `clicked "${control.description}"` };
      }
      return { ok: false, how: `tried to click "${control.description}"`, reason: firstLine(error) };
    }
  }

  const typed = form.fields.find((field) => field.info.kind === "text");
  if (form.is_form && typed) {
    try {
      await typed.handle.press("Enter", { timeout });
      return { ok: true, how: `pressed Enter in "${typed.info.description}"` };
    } catch (error) {
      return { ok: false, how: `tried to press Enter in "${typed.info.description}"`, reason: firstLine(error) };
    }
  }

  return {
    ok: false,
    how: "nothing",
    reason: form.is_form
      ? "no submit control found — no button, and no text field to press Enter in"
      : "no submit control found — no button, and this is not a <form>, so Enter has nothing to submit",
  };
}

interface SubmitControl {
  handle: ElementHandle;
  description: string;
  url_before: string;
}

async function findSubmitControl(form: DiscoveredForm): Promise<SubmitControl | null> {
  const handles = await form.root.$$(SUBMIT_SELECTOR);
  if (handles.length === 0) return null;

  const described = await Promise.all(handles.map((handle) => handle.evaluate(describeButton)));
  const usable = described
    .map((button, index) => ({ button, index }))
    .filter(({ button }) => button.usable);
  if (usable.length === 0) return null;

  const declared = usable.find(({ button }) => button.type === "submit" || button.type === "image");
  const worded = usable.find(({ button }) => SUBMIT_WORDS.test(button.text));
  const chosen = declared ?? worded ?? usable[0];

  return {
    handle: handles[chosen.index],
    description: chosen.button.description,
    url_before: form.page.url(),
  };
}

export interface ValidationSnapshot {
  /** The browser's own constraint validation, per field that fails it. */
  browser: Array<{ field: string; message: string }>;
  /** Messages visible on the page — the app's own validation, plus any alert or toast. */
  messages: string[];
  /** Fields the page marked `aria-invalid`. */
  invalid: string[];
}

/**
 * What the page says about the state it is in.
 *
 * Two independent sources, because apps use one, the other or both: the
 * browser's constraint validation (`required`, `type=email`, `min`), which is
 * true whether or not the app ever shows it, and the text actually visible on
 * screen, which is what a user would see. Neither is meaningful alone —
 * constraint validation on a form with `novalidate` never reaches the user,
 * and visible text tells you nothing about which field it belongs to.
 */
export async function readValidation(page: Page, form: DiscoveredForm): Promise<ValidationSnapshot> {
  const states = await Promise.all(
    form.fields.map(async (field) => ({
      field: field.info.description,
      ...(await field.handle.evaluate(readFieldValidity).catch(() => ({ valid: true, message: "", invalid: false }))),
    })),
  );

  const messages = await page
    .evaluate(scanMessages, { selector: MESSAGE_SELECTOR, max: MAX_FORM_MESSAGES, max_length: MAX_FORM_MESSAGE_LENGTH })
    .catch(() => [] as string[]);

  return {
    browser: states
      .filter((state) => !state.valid && state.message !== "")
      .map((state) => ({ field: state.field, message: state.message })),
    messages,
    invalid: states.filter((state) => state.invalid).map((state) => state.field),
  };
}

/** Messages that were not on the page before — the ones this strategy caused. */
export function newMessages(before: ValidationSnapshot, after: ValidationSnapshot): string[] {
  return after.messages.filter((message) => !before.messages.includes(message));
}

/**
 * Whether an XSS payload has executed on this page (see `XSS_MARKER`).
 *
 * Reading a marker the payload itself sets is the only honest answer to "did
 * my input run as code". Looking for the payload in the DOM afterwards is not:
 * an input's `value` serialises with its angle brackets intact, so a page that
 * escaped everything perfectly would still look like a hit.
 */
export async function readXssMarker(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((name: string) => Boolean((globalThis as any)[name]), XSS_MARKER);
  } catch {
    return false;
  }
}

/* ── In-page readers ──────────────────────────────────────────────────────
 * Everything below runs inside Chromium, so it is written against
 * `globalThis` and untyped nodes: this package is compiled with the Node lib
 * only, and the page it lands in may be mid-teardown, using a framework that
 * has patched half of these properties, or both.
 */

interface RawField {
  tag: string;
  type: string;
  description: string;
  name?: string;
  label?: string;
  placeholder?: string;
  maxlength?: number;
  min?: string;
  max?: string;
  step?: string;
  required: boolean;
  options?: OptionInfo[];
  /** Why this field cannot be filled. Absent when it can. */
  skip?: string;
}

function describeField(node: any): RawField {
  const tag = String(node.tagName ?? "").toLowerCase();
  const type = tag === "textarea" ? "textarea" : String(node.type ?? "text").toLowerCase();
  const attr = (name: string): string | undefined => {
    const value = node.getAttribute ? node.getAttribute(name) : null;
    return value === null || value === undefined ? undefined : String(value);
  };

  const flatten = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim();
  const id = node.id ? String(node.id) : "";
  const name = node.name ? String(node.name) : "";
  const description = id ? `#${id}` : name ? `[name="${name}"]` : tag === "input" ? `input[type=${type}]` : tag;

  let label = "";
  try {
    const labels = node.labels;
    if (labels && labels.length > 0) label = flatten(labels[0].textContent);
    if (!label) label = flatten(attr("aria-label"));
    if (!label) {
      const by = attr("aria-labelledby");
      const target = by ? (globalThis as any).document?.getElementById(by.split(/\s+/)[0]) : null;
      if (target) label = flatten(target.textContent);
    }
    if (!label && node.closest) label = flatten(node.closest("label")?.textContent);
  } catch {
    label = "";
  }

  const visible = (() => {
    try {
      return node.getClientRects ? node.getClientRects().length > 0 : true;
    } catch {
      return true;
    }
  })();

  const skip = ((): string | undefined => {
    if (type === "hidden") return "hidden input";
    if (node.disabled === true) return "disabled";
    if (node.readOnly === true) return "read-only";
    if (type === "file") return "file input — a file cannot be chosen from a script";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "not an input field";
    if (!visible) return "not visible";
    return undefined;
  })();

  const maxLength = typeof node.maxLength === "number" && node.maxLength > 0 ? node.maxLength : undefined;
  const options =
    tag === "select" && node.options
      ? Array.from(node.options as any[]).map((option: any) => ({
          value: String(option.value ?? ""),
          label: flatten(option.textContent),
          disabled: option.disabled === true,
        }))
      : undefined;

  return {
    tag,
    type,
    description,
    ...(name ? { name } : {}),
    ...(label ? { label: label.slice(0, 80) } : {}),
    ...(attr("placeholder") ? { placeholder: attr("placeholder") } : {}),
    ...(maxLength !== undefined ? { maxlength: maxLength } : {}),
    ...(attr("min") !== undefined ? { min: attr("min") } : {}),
    ...(attr("max") !== undefined ? { max: attr("max") } : {}),
    ...(attr("step") !== undefined ? { step: attr("step") } : {}),
    required: node.required === true,
    ...(options ? { options } : {}),
    ...(skip !== undefined ? { skip } : {}),
  };
}

function describeRoot(node: any): { description: string; is_form: boolean } {
  const tag = String(node.tagName ?? "").toLowerCase();
  const id = node.id ? `#${String(node.id)}` : "";
  const name = node.name ? `[name="${String(node.name)}"]` : "";
  const action = node.getAttribute && node.getAttribute("action") ? `[action="${node.getAttribute("action")}"]` : "";
  return { description: id || name || `${tag}${action}`, is_form: tag === "form" };
}

function describeButton(node: any): { usable: boolean; type: string; text: string; description: string } {
  const tag = String(node.tagName ?? "").toLowerCase();
  const type = String(node.type ?? "").toLowerCase();
  const flatten = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim();
  const id = node.id ? String(node.id) : "";
  const name = node.name ? String(node.name) : "";
  const text = flatten(node.textContent) || flatten(node.value) || flatten(node.getAttribute?.("aria-label"));

  let visible = true;
  try {
    visible = node.getClientRects ? node.getClientRects().length > 0 : true;
  } catch {
    visible = true;
  }

  return {
    usable: visible && node.disabled !== true,
    type,
    text,
    description: id ? `#${id}` : name ? `[name="${name}"]` : text ? `${tag} "${text.slice(0, 40)}"` : tag,
  };
}

function readFieldValidity(node: any): { valid: boolean; message: string; invalid: boolean } {
  // `validity`, never `checkValidity()`: the call fires an `invalid` event the
  // page can see and act on, and reading the state must not change it.
  const validity = node.validity;
  return {
    valid: validity ? validity.valid === true : true,
    message: String(node.validationMessage ?? ""),
    invalid: node.getAttribute ? node.getAttribute("aria-invalid") === "true" : false,
  };
}

function scanMessages(options: { selector: string; max: number; max_length: number }): string[] {
  const doc = (globalThis as any).document;
  if (!doc) return [];

  let nodes: any[] = [];
  try {
    nodes = Array.from(doc.querySelectorAll(options.selector) as any[]);
  } catch {
    return [];
  }

  const visible = nodes.filter((node) => {
    try {
      return node.getClientRects && node.getClientRects().length > 0;
    } catch {
      return false;
    }
  });
  // Keep the innermost of a nest: a wrapper element matching on its class name
  // would otherwise contribute the whole panel's text as one "message".
  const innermost = visible.filter((node) => !visible.some((other) => other !== node && node.contains(other)));

  const messages: string[] = [];
  for (const node of innermost) {
    const text = String(node.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "" || text.length > options.max_length) continue;
    if (!messages.includes(text)) messages.push(text);
    if (messages.length >= options.max) break;
  }
  return messages;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

function toFieldInfo(raw: RawField): FieldInfo {
  const kind: FieldKind =
    raw.tag === "select" ? "choice" : raw.type === "checkbox" || raw.type === "radio" ? "toggle" : "text";
  const { skip: _skip, ...rest } = raw;
  return { ...rest, kind };
}

function elide(value: string, max: number = MAX_FORM_TEXT_LENGTH): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
