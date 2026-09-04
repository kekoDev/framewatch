import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { formTestInputSchema, testForms } from "../src/tools/form-test.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type Block = { type: string; data?: string; text?: string };
type Result = Awaited<ReturnType<typeof testForms>>;

const images = (result: Result): Block[] => (result.content as Block[]).filter((block) => block.type === "image");
const allText = (result: Result): string =>
  (result.content as Block[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

const url = (file: string): string => `${fixtures.url}/${file}`;

describe("testForms — what comes back", () => {
  it("fills the form and returns one frame for the one strategy it was given", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid"] });

    expect(result.isError).toBeFalsy();
    expect(images(result)).toHaveLength(1);
    const text = allText(result);
    expect(text).toContain("#signup");
    expect(text).toContain("11 fillable fields");
    expect(text).toContain("valid");
  });

  it("returns a frame after the fill and another after the submit when `submit` is on", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid"], submit: true, wait_ms: 500 });

    expect(images(result)).toHaveLength(2);
    expect(allText(result)).toContain("after submit");
  });

  it("does not submit unless it is asked to", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid"] });

    expect(allText(result)).not.toContain("after submit");
  });

  it("runs every strategy it is given and names each one", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid", "empty", "numbers_only"] });

    expect(images(result)).toHaveLength(3);
    const text = allText(result);
    for (const strategy of ["valid", "empty", "numbers_only"]) {
      expect(text).toContain(strategy);
    }
  });

  it("lists the fields it filled and the ones nothing could fill", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid"] });
    const text = allText(result);

    expect(text).toContain("#name");
    expect(text).toContain("#csrf");
    expect(text).toContain("hidden input");
    expect(text).toContain("#avatar");
  });
});

describe("testForms — what it finds", () => {
  it("reports the validation messages the page shows after an empty submit", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["empty"], submit: true, wait_ms: 800 });
    const text = allText(result);

    expect(text).toContain("Name is required");
    expect(text).toContain("Enter a valid email address");
    expect(text).toContain("Please fix");
  });

  it("reports the browser's own constraint validation, which a novalidate form never shows a user", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["empty"], submit: true, wait_ms: 500 });
    const text = allText(result);

    expect(text).toMatch(/browser validation/i);
    expect(text).toContain("#name");
  });

  it("reports the request the form made, so a submit that never left the page is obvious", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["valid"], submit: true, wait_ms: 800 });
    const text = allText(result);

    expect(text).toContain("POST");
    expect(text).toContain("/api/ok");
    expect(text).toContain("200");
  });

  it("reports the console errors the form caused", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["empty"], submit: true, wait_ms: 800 });

    expect(allText(result)).toContain("form validation failed");
  });

  it("reports a value the page silently cut down", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["maxlength"] });
    const text = allText(result);

    expect(text).toMatch(/truncat/i);
    expect(text).toContain("#code");
  });

  it("says nothing about truncation when every field kept what it was given", async () => {
    const result = await testForms({ url: url("form-plain.html"), strategies: ["valid"] });

    expect(allText(result)).not.toMatch(/truncat/i);
  });
});

describe("testForms — XSS", () => {
  it("flags a form that lets an injected payload run", async () => {
    const result = await testForms({ url: url("form-xss.html"), strategies: ["xss"], submit: true, wait_ms: 1000 });
    const text = allText(result);

    expect(text).toMatch(/executed/i);
    expect(text).toMatch(/xss/i);
  });

  it("stays quiet on a form that escapes what it echoes back", async () => {
    const result = await testForms({ url: url("form.html"), strategies: ["xss"], submit: true, wait_ms: 800 });

    expect(allText(result)).not.toMatch(/payload (ran|executed)/i);
  });

  it("gives every strategy its own page, so one strategy's finding is never another's", async () => {
    const result = await testForms({
      url: url("form-xss.html"),
      strategies: ["xss", "valid"],
      submit: true,
      wait_ms: 1000,
    });
    const text = allText(result);

    // The payload runs under `xss`. If both strategies shared a page, `valid`
    // would inherit the marker it set and be reported as vulnerable too.
    expect(text.match(/executed/gi) ?? []).toHaveLength(1);
  });
});

describe("testForms — finding the form", () => {
  it("tests one form when given a selector", async () => {
    const result = await testForms({ url: url("form-multi.html"), selector: "#newsletter", strategies: ["valid"] });
    const text = allText(result);

    expect(text).toContain("#news-email");
    expect(text).not.toContain("#q");
  });

  it("tests every form on a page that has more than one", async () => {
    const result = await testForms({ url: url("form-multi.html"), strategies: ["valid"] });
    const text = allText(result);

    expect(text).toContain("#q");
    expect(text).toContain("#news-email");
  });

  it("works on a page whose form is not a <form> at all", async () => {
    const result = await testForms({ url: url("form-plain.html"), strategies: ["valid"], submit: true, wait_ms: 500 });
    const text = allText(result);

    expect(result.isError).toBeFalsy();
    expect(text).toContain("#plain-name");
    expect(text).toContain("#save");
  });
});

describe("testForms — failures", () => {
  it("rejects input that cannot be acted on", async () => {
    const result = await testForms({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("invalid input");
  });

  it("says so when the page has no fields to fill", async () => {
    const result = await testForms({ url: url("basic.html"), strategies: ["valid"] });

    expect(result.isError).toBe(true);
    expect(allText(result)).toMatch(/no (fillable )?fields/i);
  });

  it("names the selector when nothing on the page matches it", async () => {
    const result = await testForms({ url: url("form.html"), selector: "#nope", strategies: ["valid"] });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("#nope");
  });

  it("reports a page it could not open", async () => {
    const result = await testForms({ url: `${fixtures.url}/missing.html`, wait_for: "#nothing", wait_for_timeout_ms: 800 });

    expect(result.isError).toBe(true);
    expect(allText(result)).toContain("#nothing");
  });
});

describe("formTestInputSchema", () => {
  it("defaults to the four strategies the roadmap names, filling without submitting", () => {
    const parsed = formTestInputSchema.parse({ url: "http://localhost:3000" });

    expect(parsed.strategies).toEqual(["valid", "empty", "special_chars", "rtl_arabic"]);
    expect(parsed.submit).toBe(false);
    expect(parsed.wait_ms).toBe(2000);
  });

  it("refuses a strategy it does not know", () => {
    expect(formTestInputSchema.safeParse({ url: "http://localhost:3000", strategies: ["sql"] }).success).toBe(false);
  });

  it("refuses an empty strategy list rather than silently testing nothing", () => {
    expect(formTestInputSchema.safeParse({ url: "http://localhost:3000", strategies: [] }).success).toBe(false);
  });
});
