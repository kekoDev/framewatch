import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { checkLinks, describeLinksFailure, linksInputSchema } from "../src/tools/links.js";
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
type Result = Awaited<ReturnType<typeof checkLinks>>;

const report = (result: Result): string =>
  (result.content as Block[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
const images = (result: Result): Block[] => (result.content as Block[]).filter((block) => block.type === "image");
const url = (file: string): string => `${fixtures.url}/${file}`;

/** The block of lines under one heading, so a URL can be tested against the right section. */
const section = (text: string, heading: RegExp): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line === "");
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

describe("checkLinks — a page with one of every kind of link on it", () => {
  let checked: Result;
  let text: string;

  beforeAll(async () => {
    checked = await checkLinks({ url: url("links.html"), wait_ms: 200, timeout_ms: 1500 });
    text = report(checked);
  });

  it("opens with a count of what it found and what was wrong with it", () => {
    expect(checked.isError).toBeFalsy();
    expect(text).toMatch(/^Link check of http\S+links\.html — \d+ links found/m);
    expect(text).toMatch(/\d+ broken/);
  });

  it("reports a 404 and a 500 as broken, and names the status", () => {
    const broken = section(text, /^Broken \(/);
    expect(broken).toContain("missing-page.html");
    expect(broken).toContain("404 Not Found");
    expect(broken).toMatch(/code=500[^\n]*500 Internal Server Error/);
  });

  it("says which element a broken link is, so it can be found in the source", () => {
    expect(text).toMatch(/missing-page\.html[\s\S]{0,200}#broken-404/);
  });

  it("does not call a link broken just because the server refuses HEAD", () => {
    // /api/nohead answers 405 to a HEAD and 200 to a GET. A checker that
    // trusts HEAD reports this — and a great many real links — as broken.
    expect(section(text, /^Broken \(/)).not.toContain("/api/nohead");
    expect(section(text, /^Working \(/)).toContain("/api/nohead");
  });

  it("reports a redirect that lands somewhere real as a redirect, not a failure", () => {
    const redirected = section(text, /^Redirected \(/);
    expect(redirected).toMatch(/api\/redirect/);
    expect(redirected).toContain("basic.html");
    expect(section(text, /^Broken \(/)).not.toMatch(/redirect\?to=%2Fbasic\.html\b/);
  });

  it("counts the hops in a chain rather than reporting one redirect", () => {
    expect(text).toMatch(/3 hops/);
  });

  it("calls a redirect that ends on a 404 broken, and says it redirected first", () => {
    const broken = section(text, /^Broken \(/);
    expect(broken).toMatch(/redirect\?to=%2Fmissing-page\.html[^\n]*404/);
    expect(broken).toMatch(/404[^\n]*redirect/);
  });

  it("reports a redirect loop as unreachable rather than following it forever", () => {
    expect(text).toMatch(/api\/loop[^\n]*loop/);
  });

  it("separates a link that never answered from one that answered badly", () => {
    expect(section(text, /^Timed out \(/)).toContain("/api/pending");
    expect(section(text, /^Broken \(/)).not.toContain("/api/pending");
  });

  it("does not call a link the server refused to check broken", () => {
    const blocked = section(text, /^Blocked/);
    expect(blocked).toMatch(/code=401/);
    expect(blocked).toMatch(/code=403/);
    expect(section(text, /^Broken \(/)).not.toMatch(/code=40[13]/);
  });

  it("lists the hrefs that are not requests, and says what each one is", () => {
    const skipped = section(text, /^Not checked \(/);
    expect(skipped).toContain("mailto:hi@example.com");
    expect(skipped).toContain("tel:+15551234567");
    expect(skipped).toContain("javascript:void(0)");
    expect(skipped).toContain("ftp://files.example.com/manual.pdf");
  });

  it("flags the hrefs that are broken without ever being fetched", () => {
    expect(text).toMatch(/mailto:[^\n]*no address/);
    expect(text).toMatch(/#empty|empty href/);
    expect(text).toMatch(/http:\/\/[^\n]*not a URL|malformed/i);
  });

  it("checks that a same-page fragment actually points at something", () => {
    const fragments = section(text, /^Fragments/);
    expect(fragments).toContain("#does-not-exist");
    expect(fragments).not.toContain("#section-two");
    expect(fragments).not.toContain("#old-anchor");
    expect(fragments).not.toContain("#top");
  });

  it("requests a URL once however many links point at it", () => {
    expect(text).toMatch(/\(\d+ unique\)/);
    const [, found, unique] = /(\d+) links found[^(]*\((\d+) unique\)/.exec(text) ?? [];
    expect(Number(unique)).toBeLessThan(Number(found));
    expect(section(text, /^Working \(/).match(/basic\.html\b/g)?.length ?? 0).toBe(1);
  });

  it("reports the resources the page itself failed to load, without asking for them again", () => {
    const broken = section(text, /^Broken \(/);
    expect(broken).toContain("/missing.png");
    expect(broken).toContain("/missing.js");
    expect(broken).toContain("/missing.css");
    expect(text).toMatch(/the page loaded|loaded by the page/i);
  });

  it("comes back with the page, broken links boxed on it", () => {
    expect(images(checked).length).toBeGreaterThan(0);
    expect(text).toMatch(/boxed|marked/i);
  });

  it("does not report a failure to box the elements that never had a box", () => {
    // A broken stylesheet lives in <head> and has no geometry at all. Asking
    // for an outline over one is a question with no answer, not a near miss.
    expect(text).not.toMatch(/could not be boxed/);
  });

  it("counts in English", () => {
    expect(text).not.toMatch(/\d+ brokens/);
    expect(text).toMatch(/, \d+ broken,/);
  });
});

describe("checkLinks — what the caller can turn off", () => {
  it("leaves another origin alone when asked to", async () => {
    const checked = await checkLinks({
      url: url("links.html"),
      wait_ms: 200,
      timeout_ms: 1500,
      check_external: false,
    });
    const text = report(checked);

    expect(section(text, /^Not checked \(/)).toContain("127.0.0.1:1");
    expect(text).toMatch(/external/i);
  });

  it("checks another origin when allowed to, and reports what happened", async () => {
    const checked = await checkLinks({
      url: url("links-crawl.html"),
      wait_ms: 100,
      timeout_ms: 1500,
      check_external: true,
      include_resources: false,
    });

    expect(report(checked)).toMatch(/127\.0\.0\.1:1[^\n]*(refused|listening)/);
  });

  it("skips the things the page loads when only links are wanted", async () => {
    const checked = await checkLinks({
      url: url("links.html"),
      wait_ms: 200,
      timeout_ms: 1500,
      include_resources: false,
    });
    const text = report(checked);

    expect(text).not.toContain("/missing.png");
    expect(text).not.toContain("/missing.js");
    expect(section(text, /^Broken \(/)).toContain("missing-page.html");
  });

  it("does not claim to have checked the fragments it was told to leave alone", async () => {
    const checked = await checkLinks({
      url: url("links.html"),
      wait_ms: 200,
      timeout_ms: 1500,
      check_fragments: false,
    });
    const text = report(checked);

    expect(text).not.toMatch(/resolved against the document/);
    expect(text).not.toMatch(/^Fragments/m);
    expect(section(text, /^Not checked \(/)).toContain("#does-not-exist");
  });

  it("counts a fragment once however many links point at it", async () => {
    const checked = await checkLinks({ url: url("links.html"), wait_ms: 200, timeout_ms: 1500 });

    // #section-two, #old-anchor and #top resolve; # is the top of the page.
    expect(report(checked)).toMatch(/4 same-page fragments resolved/);
  });

  it("stops at max_links and says what it did not get to", async () => {
    const checked = await checkLinks({ url: url("links.html"), wait_ms: 200, timeout_ms: 1500, max_links: 4 });
    const text = report(checked);

    expect(text).toMatch(/max_links/);
    expect(text).toMatch(/not checked/i);
  });
});

describe("checkLinks — following the site one level down", () => {
  it("checks only the entry page's links at depth 0", async () => {
    const checked = await checkLinks({ url: url("links-crawl.html"), wait_ms: 100, timeout_ms: 1500 });
    const broken = section(report(checked), /^Broken \(/);

    expect(broken).toContain("crawl-missing-a.html");
    expect(broken).not.toContain("crawl-missing-b.html");
  });

  it("finds a link that is only broken one page in, at depth 1", async () => {
    const checked = await checkLinks({ url: url("links-crawl.html"), wait_ms: 100, timeout_ms: 1500, depth: 1 });
    const text = report(checked);
    const broken = section(text, /^Broken \(/);

    expect(broken).toContain("crawl-missing-a.html");
    expect(broken).toContain("crawl-missing-b.html");
    expect(text).toMatch(/on 2 pages/);
  });

  it("says which page a broken link was found on once there is more than one", async () => {
    const checked = await checkLinks({ url: url("links-crawl.html"), wait_ms: 100, timeout_ms: 1500, depth: 1 });

    expect(report(checked)).toMatch(/crawl-missing-b\.html[\s\S]{0,200}links-crawl-b\.html/);
  });

  it("does not open a page it has already been to", async () => {
    // links-crawl-b.html links back to links-crawl.html; following that is a
    // crawl that never ends.
    const checked = await checkLinks({ url: url("links-crawl.html"), wait_ms: 100, timeout_ms: 1500, depth: 3 });

    expect(report(checked)).toMatch(/on 2 pages/);
  });
});

describe("checkLinks — links that are not in the HTML source", () => {
  it("reads the rendered document, so a client-rendered page is checked properly", async () => {
    const checked = await checkLinks({ url: url("links-spa.html"), wait_ms: 400, timeout_ms: 1500 });
    const text = report(checked);

    expect(section(text, /^Broken \(/)).toContain("rendered-missing.html");
    expect(section(text, /^Working \(/)).toContain("basic.html");
  });
});

describe("checkLinks — a page with nothing wrong with it", () => {
  it("says so rather than printing an empty report", async () => {
    const checked = await checkLinks({ url: url("basic.html"), wait_ms: 0, timeout_ms: 1500 });

    expect(checked.isError).toBeFalsy();
    expect(report(checked)).toMatch(/no links|nothing to check|0 links/i);
  });
});

describe("checkLinks — failures", () => {
  it("rejects input the schema will not take", async () => {
    const bad = await checkLinks({ url: "not-a-url" } as never);

    expect(bad.isError).toBe(true);
    expect(report(bad)).toMatch(/invalid input/i);
  });

  it("says the page could not be opened, not what Playwright called it", async () => {
    const missing = await checkLinks({ url: "http://127.0.0.1:1/nope", wait_ms: 0 });

    expect(missing.isError).toBe(true);
    expect(report(missing)).toMatch(/could not be opened/i);
  });

  it("names the selector that never appeared", () => {
    const message = describeLinksFailure(
      { url: "http://example.com", wait_for: ".feed", wait_for_timeout_ms: 1000 },
      new Error("page.waitForSelector: Timeout 1000ms exceeded."),
    );

    expect(message).toContain('".feed"');
    expect(message).toContain("1000ms");
  });

  it("says how to install the browser when it is missing", () => {
    const message = describeLinksFailure(
      { url: "http://example.com", wait_for_timeout_ms: 1000 },
      new Error("browserType.launch: Executable doesn't exist at /nope"),
    );

    expect(message).toContain("npx playwright install chromium");
  });
});

describe("linksInputSchema", () => {
  it("needs only a URL", () => {
    const parsed = linksInputSchema.parse({ url: "http://localhost:3000" });

    expect(parsed.depth).toBe(0);
    expect(parsed.check_external).toBe(true);
    expect(parsed.include_resources).toBe(true);
    expect(parsed.concurrency).toBe(5);
    expect(parsed.timeout_ms).toBe(5000);
  });

  it("keeps the caller inside bounds that a single tool call can honour", () => {
    expect(linksInputSchema.safeParse({ url: "http://a.test", depth: 4 }).success).toBe(false);
    expect(linksInputSchema.safeParse({ url: "http://a.test", concurrency: 0 }).success).toBe(false);
    expect(linksInputSchema.safeParse({ url: "http://a.test", concurrency: 99 }).success).toBe(false);
    expect(linksInputSchema.safeParse({ url: "http://a.test", timeout_ms: 1 }).success).toBe(false);
  });
});
