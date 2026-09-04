import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import {
  A11Y_STANDARD_TAGS,
  accessibilityInputSchema,
  auditAccessibility,
  axeSource,
  describeAuditFailure,
} from "../src/tools/accessibility.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

type Block = { type: string; text?: string };
type Result = Awaited<ReturnType<typeof auditAccessibility>>;

const report = (result: Result): string =>
  (result.content as Block[])
    .filter((c) => c.type === "text")
    .map((c) => c.text!)
    .join("\n");

describe("auditAccessibility", () => {
  it("reports a clean page as having no violations, with the rules it did run", async () => {
    const result = await auditAccessibility({ url: `${fixtures.url}/a11y-good.html`, wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    const text = report(result);
    expect(text).toMatch(/^No WCAG2AA \(axe-core [\d.]+\) violations on http/m);
    expect(text).toMatch(/\d+ rules passed/);
    expect(text).toMatch(/\d+ need a human to check/);
  });

  it("finds the violations a broken page actually has, and says how to fix each", async () => {
    const result = await auditAccessibility({ url: `${fixtures.url}/a11y-bad.html`, wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    const text = report(result);

    // One per deliberate defect in the fixture.
    expect(text).toContain("image-alt");
    expect(text).toContain("label");
    expect(text).toContain("button-name");
    expect(text).toContain("html-has-lang");
    expect(text).toContain("color-contrast");

    expect(text).toMatch(/violation types on http/);
    expect(text).toContain("https://dequeuniversity.com/");
    // The offending element is named by selector and quoted.
    expect(text).toMatch(/•\s+\S+/);
  });

  it("reports violations worst impact first", async () => {
    const result = await auditAccessibility({ url: `${fixtures.url}/a11y-bad.html`, wait_ms: 0 });
    const impacts = [...report(result).matchAll(/^\d+\. \[(\w+)\]/gm)].map((match) => match[1]);

    expect(impacts.length).toBeGreaterThan(1);
    const order = ["critical", "serious", "moderate", "minor"];
    const ranks = impacts.map((impact) => order.indexOf(impact));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("runs only the rules of the standard it was asked for", async () => {
    const url = `${fixtures.url}/a11y-bad.html`;
    // colour-contrast is a WCAG 2.0 AA rule, so level A must not raise it...
    const levelA = report(await auditAccessibility({ url, wait_ms: 0, standard: "wcag2a" }));
    expect(levelA).not.toContain("color-contrast");
    expect(levelA).toContain("image-alt");
    expect(levelA).toContain("WCAG2A ");

    // ...while AA must.
    const levelAA = report(await auditAccessibility({ url, wait_ms: 0, standard: "wcag2aa" }));
    expect(levelAA).toContain("color-contrast");
  });

  it("caps the violations and the elements listed under each, and says what it left out", async () => {
    const result = await auditAccessibility({
      url: `${fixtures.url}/a11y-bad.html`,
      wait_ms: 0,
      max_violations: 2,
      max_elements: 1,
    });

    const text = report(result);
    expect([...text.matchAll(/^\d+\. \[/gm)]).toHaveLength(2);
    expect(text).toContain("more violation types not shown");
  });

  it("finds the violations inside an iframe, not only the ones on the host page", async () => {
    const result = await auditAccessibility({ url: `${fixtures.url}/a11y-frame.html`, wait_ms: 0 });

    const text = report(result);
    expect(result.isError).toBeFalsy();
    // The host page has none of these; they are all inside a11y-bad.html.
    expect(text).toContain("image-alt");
    // And the element is attributed to the frame it came from, not to the host.
    expect(text).toMatch(/iframe|a11y-bad\.html/);
  });

  it("waits `wait_ms` for a page that renders after first paint", async () => {
    const url = `${fixtures.url}/a11y-late.html`;

    const early = await auditAccessibility({ url, wait_ms: 0 });
    expect(report(early)).not.toContain("image-alt");

    const late = await auditAccessibility({ url, wait_ms: 800 });
    expect(report(late)).toContain("image-alt");
  });

  it("truncates the elements under one violation and says how many it left out", async () => {
    const result = await auditAccessibility({
      url: `${fixtures.url}/a11y-late.html`,
      wait_ms: 800,
      max_elements: 1,
    });

    const text = report(result);
    // One rule, three offending images, one of them listed.
    expect(text).toMatch(/image-alt\) — 3 elements/);
    expect(text).toContain("… and 2 more elements");
  });

  it("audits a page whose Content-Security-Policy forbids scripts outright", async () => {
    const result = await auditAccessibility({ url: `${fixtures.url}/csp.html`, wait_ms: 0 });

    expect(result.isError).toBeFalsy();
    // The audit ran (it found the fixture's missing alt) rather than failing to inject.
    expect(report(result)).toContain("image-alt");
  });

  it("waits for a selector before auditing", async () => {
    const result = await auditAccessibility({
      url: `${fixtures.url}/a11y-good.html`,
      wait_ms: 0,
      wait_for: "main h1",
    });
    expect(result.isError).toBeFalsy();
    expect(report(result)).toContain("violations on http");
  });

  it("returns an error result for a page it cannot open", async () => {
    const result = await auditAccessibility({ url: "http://127.0.0.1:1/nope", wait_ms: 0 });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("could not be opened");
  });

  it("returns an error result for a selector that never appears", async () => {
    const result = await auditAccessibility({
      url: `${fixtures.url}/a11y-good.html`,
      wait_ms: 0,
      wait_for: "#never",
      wait_for_timeout_ms: 400,
    });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain('selector "#never" did not become visible within 400ms');
  });

  it("reports invalid input as an error result rather than throwing", async () => {
    const result = await auditAccessibility({ url: "http://a.test", standard: "wcag3" } as never);
    expect(result.isError).toBe(true);
    expect(report(result)).toContain("invalid input");
  });
});

describe("accessibility input schema", () => {
  it("defaults to wcag2aa", () => {
    expect(accessibilityInputSchema.parse({ url: "http://localhost:3000" }).standard).toBe("wcag2aa");
  });

  it("maps each standard onto the axe tags that define it", () => {
    expect(A11Y_STANDARD_TAGS.wcag2a).toEqual(["wcag2a"]);
    expect(A11Y_STANDARD_TAGS.wcag2aa).toEqual(["wcag2a", "wcag2aa"]);
    expect(A11Y_STANDARD_TAGS.wcag21aa).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  });
});

describe("axeSource", () => {
  it("loads the axe-core bundle from the installed package and caches it", () => {
    const first = axeSource();
    expect(first.length).toBeGreaterThan(100_000);
    expect(first).toContain("axe");
    expect(axeSource()).toBe(first);
  });
});

describe("describeAuditFailure", () => {
  const input = { url: "http://localhost:3000", wait_for_timeout_ms: 1000 };

  it("names a missing browser install with the command that fixes it", () => {
    const message = describeAuditFailure(input, new Error("browserType.launch: Executable doesn't exist at /nope"));
    expect(message).toContain("npx playwright install chromium");
  });

  it("blames the selector only when a waitForSelector call is what failed", () => {
    const waiting = { ...input, wait_for: "#late" };
    expect(describeAuditFailure(waiting, new Error("page.waitForSelector: Timeout 1000ms exceeded"))).toContain(
      'selector "#late" did not become visible',
    );
    expect(describeAuditFailure(waiting, new Error("page.goto: net::ERR_CONNECTION_REFUSED at #late"))).toContain(
      "the page could not be opened",
    );
  });
});
