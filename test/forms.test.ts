import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import {
  discoverForms,
  fillForm,
  newMessages,
  readValidation,
  readXssMarker,
  submitForm,
  type DiscoveredForm,
} from "../src/engine/forms.js";
import { MAX_FORM_FILL_LENGTH } from "../src/constants.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

const VIEWPORT = { width: 700, height: 900 };

/** Open one fixture page and run `fn` against it. */
async function onPage<T>(file: string, fn: (page: Page) => Promise<T>): Promise<T> {
  return withPage({ viewport: VIEWPORT }, async (page) => {
    await page.goto(`${fixtures.url}/${file}`, { waitUntil: "load" });
    return fn(page);
  });
}

const descriptions = (form: DiscoveredForm): string[] => form.fields.map((field) => field.info.description);
const value = (page: Page, selector: string): Promise<string> =>
  page.$eval(selector, (el) => (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value);
const checked = (page: Page, selector: string): Promise<boolean> =>
  page.$eval(selector, (el) => (el as HTMLInputElement).checked);

describe("discoverForms", () => {
  it("finds every field the form has that can be filled", async () => {
    const found = await onPage("form.html", (page) => discoverForms(page));

    expect(found).toHaveLength(1);
    expect(found[0].is_form).toBe(true);
    expect(descriptions(found[0])).toEqual([
      "#name",
      "#email",
      "#password",
      "#age",
      "#website",
      "#code",
      "#country",
      "#bio",
      "#plan-basic",
      "#plan-pro",
      "#terms",
    ]);
  });

  it("leaves out the fields nothing can fill, and says why for each", async () => {
    const [form] = await onPage("form.html", (page) => discoverForms(page));
    const reasons = new Map(form.skipped.map((skip) => [skip.description, skip.reason]));

    expect(reasons.get("#csrf")).toMatch(/hidden/i);
    expect(reasons.get("#disabled-field")).toMatch(/disabled/i);
    expect(reasons.get("#readonly-field")).toMatch(/read-?only/i);
    expect(reasons.get("#invisible-field")).toMatch(/not visible/i);
    expect(reasons.get("#avatar")).toMatch(/file/i);
  });

  it("reads each field's type, constraints and label", async () => {
    const [form] = await onPage("form.html", (page) => discoverForms(page));
    const byId = new Map(form.fields.map((field) => [field.info.description, field.info]));

    expect(byId.get("#name")).toMatchObject({ type: "text", maxlength: 20, required: true, label: "Full name" });
    expect(byId.get("#age")).toMatchObject({ type: "number", min: "18", max: "120", required: false });
    expect(byId.get("#bio")).toMatchObject({ tag: "textarea", type: "textarea" });
    expect(byId.get("#terms")).toMatchObject({ type: "checkbox", required: true });
    expect(byId.get("#country")?.options).toEqual([
      { value: "", label: "Choose a country", disabled: false },
      { value: "us", label: "United States", disabled: false },
      { value: "de", label: "Germany", disabled: false },
      { value: "jp", label: "Japan", disabled: false },
    ]);
  });

  it("names a field by its name attribute when it has no id", async () => {
    const [form] = await onPage("form.html", async (page) => {
      await page.$eval("#website", (el) => el.removeAttribute("id"));
      return discoverForms(page);
    });

    expect(descriptions(form)).toContain('[name="website"]');
  });

  it("finds every form on a page that has more than one, in document order", async () => {
    const found = await onPage("form-multi.html", (page) => discoverForms(page));

    expect(found.map((form) => form.description)).toEqual(["#search", "#newsletter"]);
    expect(descriptions(found[1])).toEqual(["#news-email"]);
  });

  it("targets one form when given a selector", async () => {
    const found = await onPage("form-multi.html", (page) => discoverForms(page, { selector: "#newsletter" }));

    expect(found).toHaveLength(1);
    expect(descriptions(found[0])).toEqual(["#news-email"]);
  });

  it("treats the whole page as one form when the page has no <form> element", async () => {
    const found = await onPage("form-plain.html", (page) => discoverForms(page));

    expect(found).toHaveLength(1);
    expect(found[0].is_form).toBe(false);
    expect(descriptions(found[0])).toEqual(["#plain-name", "#plain-note"]);
  });

  it("stops at max_fields and reports how many the form really has", async () => {
    const [form] = await onPage("form.html", (page) => discoverForms(page, { max_fields: 3 }));

    expect(form.fields).toHaveLength(3);
    expect(form.total_fields).toBe(11);
  });

  it("fails with a message naming the selector when nothing matches it", async () => {
    await expect(onPage("form.html", (page) => discoverForms(page, { selector: "#nope" }))).rejects.toThrow(/#nope/);
  });
});

describe("fillForm", () => {
  it("puts something each field accepts in every field, for the valid strategy", async () => {
    const state = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      const result = await fillForm(form, "valid");
      return {
        result,
        name: await value(page, "#name"),
        email: await value(page, "#email"),
        age: await value(page, "#age"),
        website: await value(page, "#website"),
        country: await value(page, "#country"),
        terms: await checked(page, "#terms"),
        basic: await checked(page, "#plan-basic"),
      };
    });

    expect(state.result.failed).toEqual([]);
    expect(state.name).toBe("Ada Lovelace");
    expect(state.email).toContain("@");
    expect(Number(state.age)).toBeGreaterThanOrEqual(18);
    expect(Number(state.age)).toBeLessThanOrEqual(120);
    expect(() => new URL(state.website)).not.toThrow();
    expect(state.country).toBe("us");
    expect(state.terms).toBe(true);
    expect(state.basic).toBe(true);
  });

  it("clears every field it can for the empty strategy", async () => {
    const state = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      await fillForm(form, "valid");
      await fillForm(form, "empty");
      return {
        name: await value(page, "#name"),
        email: await value(page, "#email"),
        bio: await value(page, "#bio"),
        country: await value(page, "#country"),
        terms: await checked(page, "#terms"),
      };
    });

    expect(state).toEqual({ name: "", email: "", bio: "", country: "", terms: false });
  });

  it("reports a value the page cut down after it was typed", async () => {
    const result = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      return fillForm(form, "maxlength");
    });

    // #code has no maxlength attribute; the page truncates it to 5 in JavaScript.
    const code = result.filled.find((field) => field.description === "#code");
    expect(code?.requested_length).toBe(MAX_FORM_FILL_LENGTH);
    expect(code?.landed_length).toBe(5);
    expect(code?.truncated).toBe(true);

    // #name declares maxlength=20, so 20 characters is what was asked for and what landed.
    const name = result.filled.find((field) => field.description === "#name");
    expect(name?.landed_length).toBe(20);
    expect(name?.truncated).toBe(false);
  });

  it("chooses one option out of a radio group and says why it left the others", async () => {
    const result = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      return fillForm(form, "valid");
    });

    expect(result.filled.map((field) => field.description)).toContain("#plan-basic");
    const other = result.skipped.find((skip) => skip.description === "#plan-pro");
    expect(other?.reason).toMatch(/group/i);
  });

  it("records the field it could not fill and fills the rest anyway", async () => {
    const state = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      // Locked after discovery: exactly the race a page with live validation runs.
      await page.$eval("#email", (el) => el.setAttribute("readonly", "readonly"));
      const result = await fillForm(form, "valid", { timeout_ms: 500 });
      return { result, name: await value(page, "#name") };
    });

    expect(state.result.failed.map((problem) => problem.description)).toEqual(["#email"]);
    expect(state.result.failed[0].reason.length).toBeGreaterThan(0);
    expect(state.name).toBe("Ada Lovelace");
  });
});

describe("submitForm", () => {
  it("clicks the form's submit button", async () => {
    const outcome = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      const result = await submitForm(form);
      await page.waitForSelector("#form-error.on", { timeout: 5000 });
      return result;
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.how).toContain("#submit");
  });

  it("presses Enter in a text field when the form has no submit control", async () => {
    const outcome = await onPage("form-multi.html", async (page) => {
      const [search] = await discoverForms(page, { selector: "#search" });
      await fillForm(search, "valid");
      const result = await submitForm(search);
      await page.waitForSelector("#search-result.on", { timeout: 5000 });
      return result;
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.how).toMatch(/enter/i);
  });

  it("says there is nothing to submit when a formless group has no button", async () => {
    const outcome = await onPage("form-plain.html", async (page) => {
      await page.$eval("#save", (el) => el.remove());
      const [form] = await discoverForms(page);
      return submitForm(form);
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/no submit/i);
  });

  it("finds a button that only looks like a submit button", async () => {
    const outcome = await onPage("form-plain.html", async (page) => {
      const [form] = await discoverForms(page);
      const result = await submitForm(form);
      await page.waitForSelector("#saved.on", { timeout: 5000 });
      return result;
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.how).toContain("#save");
  });
});

describe("readValidation", () => {
  it("reports the browser's own constraint messages for the fields that break them", async () => {
    const snapshot = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      return readValidation(page, form);
    });

    const fields = snapshot.browser.map((entry) => entry.field);
    expect(fields).toContain("#name");
    expect(fields).toContain("#email");
    expect(snapshot.browser[0].message.length).toBeGreaterThan(0);
  });

  it("reports only the messages that appeared since the page loaded", async () => {
    const found = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      const before = await readValidation(page, form);
      await submitForm(form);
      await page.waitForSelector("#form-error.on", { timeout: 5000 });
      const after = await readValidation(page, form);
      return { before, appeared: newMessages(before, after) };
    });

    expect(found.before.messages).toEqual([]);
    expect(found.appeared).toContain("Name is required");
    expect(found.appeared).toContain("Enter a valid email address");
    expect(found.appeared.some((message) => message.includes("Please fix"))).toBe(true);
  });

  it("reports the fields the page itself marked invalid", async () => {
    const snapshot = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      await submitForm(form);
      await page.waitForSelector("#form-error.on", { timeout: 5000 });
      return readValidation(page, form);
    });

    expect(snapshot.invalid).toContain("#name");
  });
});

describe("readXssMarker", () => {
  it("stays false on a page that escapes what it echoes back", async () => {
    const marked = await onPage("form.html", async (page) => {
      const [form] = await discoverForms(page);
      await fillForm(form, "xss");
      await submitForm(form);
      await page.waitForTimeout(500);
      return readXssMarker(page);
    });

    expect(marked).toBe(false);
  });

  it("turns true when a payload runs on a page that writes input back as markup", async () => {
    const marked = await onPage("form-xss.html", async (page) => {
      const [form] = await discoverForms(page);
      await fillForm(form, "xss");
      await submitForm(form);
      await page.waitForTimeout(1000);
      return readXssMarker(page);
    });

    expect(marked).toBe(true);
  });
});
