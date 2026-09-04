import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORM_STRATEGIES,
  FORM_STRATEGIES,
  XSS_MARKER,
  checkedFor,
  describeStrategy,
  optionFor,
  valueFor,
  type FieldShape,
  type FormStrategy,
} from "../src/utils/test-data.js";
import { MAX_FORM_FILL_LENGTH } from "../src/constants.js";

/** A text field with nothing special about it. */
const text = (over: Partial<FieldShape> = {}): FieldShape => ({ type: "text", ...over });

describe("valueFor — valid", () => {
  it("gives an email field something with an @ in it", () => {
    expect(valueFor(text({ type: "email" }), "valid")).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/i);
  });

  it("gives a url field a parseable absolute URL", () => {
    const value = valueFor(text({ type: "url" }), "valid");
    expect(() => new URL(value)).not.toThrow();
  });

  it("gives a number field a value inside its min/max", () => {
    const value = Number(valueFor(text({ type: "number", min: "10", max: "20" }), "valid"));
    expect(value).toBeGreaterThanOrEqual(10);
    expect(value).toBeLessThanOrEqual(20);
  });

  it("gives a date field a value the browser will accept", () => {
    expect(valueFor(text({ type: "date" }), "valid")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reads the field name when the type says nothing — a text field called email still gets an email", () => {
    expect(valueFor(text({ name: "user_email" }), "valid")).toContain("@");
  });

  it("reads the label the same way when there is no name", () => {
    expect(valueFor(text({ label: "Phone number" }), "valid")).toMatch(/^[+\d]/);
  });
});

describe("valueFor — every strategy", () => {
  it("empties every kind of field", () => {
    for (const type of ["text", "email", "number", "date", "color", "textarea"]) {
      expect(valueFor(text({ type }), "empty")).toBe("");
    }
  });

  it("fills to the field's own maxlength when it has one", () => {
    expect(valueFor(text({ maxlength: 25 }), "maxlength")).toHaveLength(25);
  });

  it("fills to the default cap when the field has no maxlength", () => {
    expect(valueFor(text(), "maxlength")).toHaveLength(MAX_FORM_FILL_LENGTH);
  });

  it("puts quotes, angle brackets, unicode and an emoji in special_chars", () => {
    const value = valueFor(text(), "special_chars");
    expect(value).toContain("'");
    expect(value).toContain('"');
    expect(value).toContain("<");
    expect(value).toMatch(/\p{Extended_Pictographic}/u);
  });

  it("writes Arabic script for rtl_arabic", () => {
    expect(valueFor(text(), "rtl_arabic")).toMatch(/\p{Script=Arabic}/u);
  });

  it("writes only digits for numbers_only", () => {
    expect(valueFor(text(), "numbers_only")).toMatch(/^\d+$/);
  });

  it("writes only whitespace for spaces_only", () => {
    const value = valueFor(text(), "spaces_only");
    expect(value.length).toBeGreaterThan(0);
    expect(value.trim()).toBe("");
  });

  it("uses the max of a number field for boundary, and one character for text", () => {
    expect(valueFor(text({ type: "number", min: "5", max: "99" }), "boundary")).toBe("99");
    expect(valueFor(text(), "boundary")).toHaveLength(1);
  });

  it("builds xss payloads that set the marker, and varies them field by field", () => {
    const first = valueFor(text(), "xss", 0);
    const second = valueFor(text(), "xss", 1);
    expect(first).toContain(XSS_MARKER);
    expect(second).toContain(XSS_MARKER);
    expect(first).not.toBe(second);
  });

  it("cycles back to the first payload once the list runs out", () => {
    const values = new Set(Array.from({ length: 40 }, (_, i) => valueFor(text(), "xss", i)));
    expect(values.size).toBeGreaterThan(1);
    expect(values.size).toBeLessThan(40);
  });
});

describe("valueFor — type-constrained fields", () => {
  // Chromium refuses a value its input type cannot hold, and Playwright's fill
  // reports that as a malformed value rather than filling. A strategy that
  // wants Arabic text in a date field cannot have it, and the useful thing is
  // still to exercise the field.
  const constrained: Array<[string, RegExp]> = [
    ["number", /^-?\d+(\.\d+)?$/],
    ["range", /^-?\d+(\.\d+)?$/],
    ["date", /^\d{4}-\d{2}-\d{2}$/],
    ["month", /^\d{4}-\d{2}$/],
    ["week", /^\d{4}-W\d{2}$/],
    ["time", /^\d{2}:\d{2}$/],
    ["datetime-local", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/],
    ["color", /^#[0-9a-f]{6}$/i],
  ];

  for (const [type, shape] of constrained) {
    it(`keeps ${type} valid under every strategy that fills it`, () => {
      for (const strategy of FORM_STRATEGIES) {
        const value = valueFor(text({ type }), strategy);
        if (strategy === "empty") {
          expect(value).toBe("");
          continue;
        }
        expect(value, `${type} / ${strategy}`).toMatch(shape);
      }
    });
  }

  it("stays inside min and max for boundary and maxlength alike", () => {
    const field = text({ type: "number", min: "1", max: "10" });
    for (const strategy of FORM_STRATEGIES) {
      const value = valueFor(field, strategy);
      if (value === "") continue;
      expect(Number(value), `${strategy}`).toBeLessThanOrEqual(10);
      expect(Number(value), `${strategy}`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("optionFor", () => {
  const options = [
    { value: "", label: "Choose one", disabled: false },
    { value: "eur", label: "Euro", disabled: false },
    { value: "gbp", label: "Pound", disabled: true },
  ];

  it("picks the first real option for valid", () => {
    expect(optionFor({ ...text({ type: "select-one" }), options }, "valid")).toBe("eur");
  });

  it("picks the placeholder option for empty", () => {
    expect(optionFor({ ...text({ type: "select-one" }), options }, "empty")).toBe("");
  });

  it("leaves a select alone for empty when it has no placeholder option", () => {
    const noPlaceholder = options.slice(1);
    expect(optionFor({ ...text({ type: "select-one" }), options: noPlaceholder }, "empty")).toBeNull();
  });

  it("never picks a disabled option", () => {
    const onlyDisabled = [{ value: "gbp", label: "Pound", disabled: true }];
    expect(optionFor({ ...text({ type: "select-one" }), options: onlyDisabled }, "valid")).toBeNull();
  });

  it("picks the last option for boundary, so both ends of the list get exercised", () => {
    expect(optionFor({ ...text({ type: "select-one" }), options }, "boundary")).toBe("eur");
  });
});

describe("checkedFor", () => {
  it("leaves boxes unticked for empty", () => {
    expect(checkedFor("empty")).toBe(false);
  });

  it("ticks boxes for valid", () => {
    expect(checkedFor("valid")).toBe(true);
  });
});

describe("strategy metadata", () => {
  it("describes every strategy in one line", () => {
    for (const strategy of FORM_STRATEGIES) {
      const text = describeStrategy(strategy);
      expect(text.length, strategy).toBeGreaterThan(0);
      expect(text, strategy).not.toContain("\n");
    }
  });

  it("defaults to the four strategies the roadmap names, all of them real", () => {
    expect(DEFAULT_FORM_STRATEGIES).toEqual(["valid", "empty", "special_chars", "rtl_arabic"]);
    for (const strategy of DEFAULT_FORM_STRATEGIES) {
      expect(FORM_STRATEGIES).toContain(strategy as FormStrategy);
    }
  });
});
