import { MAX_FORM_FILL_LENGTH } from "../constants.js";

/**
 * Test data generators.
 *
 * One job: given a field and a strategy, say what should go in it. Nothing
 * here touches a browser, so the interesting decisions — what "valid" means
 * for a field called `user_email`, what happens when Arabic text meets
 * `<input type="date">` — are testable on their own.
 *
 * Two rules run through all of it:
 *
 *   - A value must be one the field can actually hold. Chromium refuses a
 *     malformed value outright for the constrained input types (number, date,
 *     color and friends), so a strategy that cannot be expressed in one of
 *     them falls back to a valid value rather than producing a fill error that
 *     says nothing about the app.
 *   - A value never exceeds the field's own `maxlength`. Otherwise every
 *     strategy would report the same truncation on the same short field, and
 *     the one report that matters — an app truncating input in JavaScript,
 *     with no maxlength anywhere — would be lost in it.
 */

export const FORM_STRATEGIES = [
  "valid",
  "empty",
  "maxlength",
  "special_chars",
  "rtl_arabic",
  "numbers_only",
  "spaces_only",
  "boundary",
  "xss",
] as const;

export type FormStrategy = (typeof FORM_STRATEGIES)[number];

/**
 * What `framewatch_form_test` runs when the caller names no strategies: the
 * happy path, the empty submit, the characters that break naive escaping, and
 * RTL text. Between them they catch most of what a form gets wrong.
 */
export const DEFAULT_FORM_STRATEGIES: FormStrategy[] = ["valid", "empty", "special_chars", "rtl_arabic"];

/**
 * The global an XSS payload sets when it executes.
 *
 * Payloads are written to assign this rather than to do anything: whether the
 * marker is set after a submit is a yes/no answer to "did my input run as
 * code", where looking for the payload in the DOM afterwards is guesswork —
 * an input's own `value` serialises with its angle brackets intact and would
 * read as an injection on a page that escaped everything correctly.
 */
export const XSS_MARKER = "__framewatch_xss";

export interface OptionInfo {
  value: string;
  label: string;
  disabled: boolean;
}

/** What the generators need to know about a field. A subset of `FieldInfo` in engine/forms.ts. */
export interface FieldShape {
  /** Input type lowercased ("text", "email", …), "textarea", or "select-one" / "select-multiple". */
  type: string;
  name?: string;
  label?: string;
  placeholder?: string;
  maxlength?: number;
  min?: string;
  max?: string;
  step?: string;
}

/** Input types whose value Chromium validates syntactically, and will not hold arbitrary text. */
const CONSTRAINED = new Set(["number", "range", "date", "month", "week", "time", "datetime-local", "color"]);

/** A number field's value is a syntax, not a length — a thousand digits is not a longer number, it is Infinity. */
const MAX_NUMBER_DIGITS = 15;

export function describeStrategy(strategy: FormStrategy): string {
  switch (strategy) {
    case "valid":
      return "realistic data of the right shape for each field — the happy path";
    case "empty":
      return "every field cleared, then submitted — does validation catch it";
    case "maxlength":
      return `every field filled to its maxlength, or ${MAX_FORM_FILL_LENGTH} characters when it has none`;
    case "special_chars":
      return "quotes, angle brackets, backslashes, an SQL fragment, CJK, Arabic and an emoji";
    case "rtl_arabic":
      return "Arabic text in every field — catches RTL layout and bidirectional text bugs";
    case "numbers_only":
      return "digits in every field, including the ones that expect words";
    case "spaces_only":
      return "whitespace only — input that looks filled in but is empty once trimmed";
    case "boundary":
      return "the edges: one character for text, min/max for numbers and dates";
    case "xss":
      return "harmless XSS payloads that set a marker instead of doing damage — reported if any of them runs";
  }
}

/**
 * The value to put in a text-like field.
 *
 * `variant` is the field's position in the form. It is used to walk through
 * the XSS payload list, so a form with five fields tries five different
 * injections in one pass instead of the same one five times.
 */
export function valueFor(field: FieldShape, strategy: FormStrategy, variant = 0): string {
  if (strategy === "empty") return "";
  if (CONSTRAINED.has(field.type)) return clampToRange(field, constrainedValue(field, strategy));
  return clampLength(field, textValue(field, strategy, variant));
}

/**
 * Which option a `<select>` should end up on, or null to leave it alone.
 *
 * Disabled options are never chosen — picking one fails, and a form that
 * offers nothing else has a bug worth reporting on its own.
 */
export function optionFor(field: FieldShape & { options: OptionInfo[] }, strategy: FormStrategy): string | null {
  const enabled = field.options.filter((option) => !option.disabled);
  // The blank option is a placeholder ("Choose one…"), which is what "empty"
  // means for a select — and the only way to clear one from the outside.
  const placeholder = enabled.find((option) => option.value === "");
  const real = enabled.filter((option) => option.value !== "");

  if (strategy === "empty") return placeholder ? placeholder.value : null;
  if (strategy === "boundary") return real.at(-1)?.value ?? placeholder?.value ?? null;
  return real[0]?.value ?? placeholder?.value ?? null;
}

/** Whether a checkbox or radio should end up ticked. */
export function checkedFor(strategy: FormStrategy): boolean {
  return strategy !== "empty";
}

/* ── Text fields ──────────────────────────────────────────────────────── */

const SPECIAL_CHARS = `O'Brien "quoted" <tag> & 100% \\ / ; -- ' OR '1'='1 — 你好 مرحبا ñ 🎉`;
const ARABIC = "مرحبا بالعالم — اختبار فريم ووتش";
const ARABIC_SHORT = "اختبار";

/** Payloads that announce themselves instead of doing damage. See XSS_MARKER. */
const XSS_PAYLOADS = [
  `<img src=x onerror="window.${XSS_MARKER}=1">`,
  `"><svg onload="window.${XSS_MARKER}=1">`,
  `<script>window.${XSS_MARKER}=1</script>`,
  `javascript:window.${XSS_MARKER}=1`,
  `'><img src=x onerror=window.${XSS_MARKER}=1>`,
];

/** Repeated to fill a field to its limit. Not all one character, so a truncation point is visible in a screenshot. */
const FILLER = "FrameWatch0123456789 ";

function textValue(field: FieldShape, strategy: FormStrategy, variant: number): string {
  switch (strategy) {
    case "valid":
      return validText(field);
    case "maxlength":
      return repeatTo(FILLER, field.maxlength ?? MAX_FORM_FILL_LENGTH);
    case "special_chars":
      return field.type === "email" ? `"${SPECIAL_CHARS}"@example.com` : SPECIAL_CHARS;
    case "rtl_arabic":
      return field.type === "email" ? `${ARABIC_SHORT}@example.com` : ARABIC;
    case "numbers_only":
      return "1234567890";
    case "spaces_only":
      return "   ";
    case "boundary":
      // The shortest thing a field of this kind can hold: the classic
      // off-by-one, and for the typed fields the shortest *valid* value.
      return field.type === "email" ? "a@b.co" : field.type === "url" ? "http://a.co" : "a";
    case "xss":
      return XSS_PAYLOADS[variant % XSS_PAYLOADS.length];
    case "empty":
      return "";
  }
}

/**
 * Realistic data for one field.
 *
 * The input type is the strongest signal and is read first. Beyond that a
 * field is only ever `type="text"`, so the name, label and placeholder are
 * matched for the handful of shapes that have a wrong answer — an address in
 * a phone field tells you nothing about the app.
 */
function validText(field: FieldShape): string {
  switch (field.type) {
    case "email":
      return "framewatch@example.com";
    case "tel":
      return "+15550101234";
    case "url":
      return "https://example.com/framewatch";
    case "password":
      return "FrameWatch!2024";
    case "search":
      return "framewatch";
  }

  const hint = `${field.name ?? ""} ${field.label ?? ""} ${field.placeholder ?? ""}`.toLowerCase();
  for (const [pattern, value] of HINTS) {
    if (pattern.test(hint)) return value;
  }
  return field.type === "textarea" ? "FrameWatch test message. Nothing here is real data." : "FrameWatch test";
}

/**
 * Name/label patterns worth answering specifically, most specific first —
 * "email address" must not be read as an address.
 */
const HINTS: Array<[RegExp, string]> = [
  [/e-?mail/, "framewatch@example.com"],
  [/phone|mobile|\btel\b/, "+15550101234"],
  [/first.?name|given.?name|forename/, "Ada"],
  [/last.?name|surname|family.?name/, "Lovelace"],
  [/full.?name|^\s*name|user.?name|\blogin\b|nickname/, "Ada Lovelace"],
  [/company|organi[sz]ation|business/, "FrameWatch Ltd"],
  [/street|address(?!.*e-?mail)/, "123 Test Street"],
  [/\bcity\b|town/, "Springfield"],
  [/\bstate\b|province|region/, "California"],
  [/post.?code|\bzip\b|postal/, "94103"],
  [/country/, "Testland"],
  [/card.?number|\bcc.?num/, "4111111111111111"],
  [/\bcvv\b|\bcvc\b|security.?code/, "123"],
  [/\bage\b|quantity|\bqty\b|amount|\bcount\b/, "30"],
  [/message|comment|feedback|notes?\b|bio\b|description|about/, "FrameWatch test message. Nothing here is real data."],
  [/subject|title|headline/, "FrameWatch test"],
  [/\burl\b|website|\blink\b/, "https://example.com/framewatch"],
  [/password|passphrase|\bpin\b/, "FrameWatch!2024"],
  [/coupon|promo|voucher|referral/, "TESTCODE"],
];

/** Cut a value to the field's own maxlength. See the second rule at the top of this file. */
function clampLength(field: FieldShape, value: string): string {
  const limit = field.maxlength;
  if (limit === undefined || limit < 0 || value.length <= limit) return value;
  return value.slice(0, limit);
}

function repeatTo(pattern: string, length: number): string {
  if (length <= 0) return "";
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

/* ── Constrained fields ───────────────────────────────────────────────── */

/**
 * A value a constrained input will accept, varied by strategy as far as the
 * type allows. Arabic text cannot go in a date field; what a date field can
 * still say is what happens at its declared minimum, so the strategies that
 * have no expression here collapse onto the valid value.
 */
function constrainedValue(field: FieldShape, strategy: FormStrategy): string {
  const extreme = strategy === "boundary" || strategy === "maxlength";

  switch (field.type) {
    case "number":
    case "range":
      return numberValue(field, strategy, extreme);
    case "date":
      return extreme ? (field.max ?? field.min ?? "9999-12-31") : "2024-06-15";
    case "month":
      return extreme ? (field.max ?? field.min ?? "9999-12") : "2024-06";
    case "week":
      return extreme ? (field.max ?? field.min ?? "9999-W52") : "2024-W24";
    case "time":
      return extreme ? (field.max ?? field.min ?? "23:59") : "14:30";
    case "datetime-local":
      return extreme ? (field.max ?? field.min ?? "9999-12-31T23:59") : "2024-06-15T14:30";
    case "color":
      return extreme ? "#000000" : strategy === "numbers_only" ? "#123456" : "#3366ff";
    default:
      return "";
  }
}

function numberValue(field: FieldShape, strategy: FormStrategy, extreme: boolean): string {
  const min = toNumber(field.min);
  const max = toNumber(field.max);

  if (extreme) {
    if (max !== undefined) return field.max!;
    if (min !== undefined) return field.min!;
    return strategy === "maxlength" ? "9".repeat(MAX_NUMBER_DIGITS) : "0";
  }
  if (min !== undefined && max !== undefined) return String(Math.round((min + max) / 2));
  if (min !== undefined) return field.min!;
  if (max !== undefined) return field.max!;
  return strategy === "numbers_only" ? "1234567890" : "42";
}

/**
 * Keep a value inside the field's declared range. Every constrained type
 * except colour orders lexicographically in its own syntax (ISO dates, times,
 * weeks), so the same comparison works for all of them once numbers are
 * handled numerically.
 */
function clampToRange(field: FieldShape, value: string): string {
  if (value === "" || field.type === "color") return value;

  if (field.type === "number" || field.type === "range") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return value;
    const min = toNumber(field.min);
    const max = toNumber(field.max);
    if (min !== undefined && parsed < min) return field.min!;
    if (max !== undefined && parsed > max) return field.max!;
    return value;
  }

  if (field.min !== undefined && value < field.min) return field.min;
  if (field.max !== undefined && value > field.max) return field.max;
  return value;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
