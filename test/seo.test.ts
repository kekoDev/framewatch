import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { auditSeo, describeSeoFailure, seoInputSchema } from "../src/tools/seo.js";
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
type Result = Awaited<ReturnType<typeof auditSeo>>;

const report = (result: Result): string =>
  (result.content as Block[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
const images = (result: Result): Block[] => (result.content as Block[]).filter((block) => block.type === "image");
const url = (file: string): string => `${fixtures.url}/${file}`;

describe("auditSeo — a page with nothing wrong with it", () => {
  let clean: Result;

  beforeAll(async () => {
    clean = await auditSeo({ url: url("seo-good.html"), wait_ms: 0 });
  });

  it("finds no problems and says so", () => {
    expect(clean.isError).toBeFalsy();
    expect(report(clean)).toMatch(/^SEO audit of http\S+ — 0 problems, 0 warnings, \d+ checks passed\./m);
    expect(report(clean)).toContain("Nothing here would keep this page out of an index");
  });

  it("prints the checks that passed, not only the ones that failed", () => {
    const text = report(clean);
    expect(text).toContain('✓ Title — "Keko Food — Order Fresh Food Online" (35 characters)');
    expect(text).toContain("✓ Canonical");
    expect(text).toContain("✓ og:title");
    expect(text).toContain('✓ Organization "Keko Food"');
  });

  it("renders the heading outline as a tree", () => {
    const text = report(clean);
    expect(text).toContain("Outline:");
    expect(text).toMatch(/\n {4}h1 Welcome to Keko Food\n {6}h2 Menu\n {8}h3 Starters/);
  });

  it("counts a decorative alt=\"\" as described rather than missing", () => {
    expect(report(clean)).toContain("✓ Alt text — all 2 images have an alt attribute (1 decorative");
  });
});

describe("auditSeo — a page with everything wrong with it", () => {
  let broken: Result;

  beforeAll(async () => {
    broken = await auditSeo({ url: url("seo-bad.html"), wait_ms: 0 });
  });

  it("leads with the problems, before any of the detail", () => {
    const first = report(broken).split("\n").slice(0, 2).join("\n");
    expect(first).toMatch(/— \d+ problems, \d+ warnings/);
    expect(first).toContain("Problems:");
    expect(first).toContain("noindex");
  });

  it("catches the noindex that keeps a live page out of the index", () => {
    expect(report(broken)).toContain('✗ noindex — this page tells search engines not to index it (<meta name=robots>: "noindex, nofollow")');
  });

  it("reports the missing description, the over-long title and the missing canonical", () => {
    const text = report(broken);
    expect(text).toContain("✗ Meta description — missing");
    expect(text).toMatch(/! Title — .*\(81 characters\) — past about 60/);
    expect(text).toContain("! Canonical — no <link rel=canonical>");
    expect(text).toContain("! Language — <html> has no lang attribute");
    expect(text).toContain("! Viewport — no <meta name=viewport>");
  });

  it("reports the missing h1 and the skipped heading level", () => {
    const text = report(broken);
    expect(text).toContain("✗ H1 — no <h1>");
    expect(text).toContain('h2 → h4 ("And this jumps from h2 straight to h4")');
  });

  it("names the images that have no alt attribute", () => {
    const text = report(broken);
    expect(text).toContain("✗ Alt text — 2 of 3 images have no alt attribute");
    expect(text).toContain("#hero");
  });

  it("reports the JSON-LD that does not parse and the one missing its required properties", () => {
    const text = report(broken);
    expect(text).toContain("✗ JSON-LD block 1 — is not valid JSON");
    expect(text).toContain("✗ Product — missing required name, image");
  });

  it("says every share of this link renders as a bare URL", () => {
    expect(report(broken)).toContain("! Open Graph — no Open Graph tags at all");
  });

  it("returns no image, because there is no share image to look at", () => {
    expect(images(broken)).toHaveLength(0);
  });
});

describe("auditSeo — robots.txt", () => {
  it("finds a page that is perfect and still not crawlable", async () => {
    const result = await auditSeo({ url: url("seo-blocked.html"), wait_ms: 0 });
    const text = report(result);

    expect(text).toContain('✗ robots.txt — blocked for Googlebot by "Disallow: /seo-blocked.html"');
    expect(text).toContain("nothing on it (title, description, structured data) will ever be read");
    // The rest of the page is fine, and is still reported as fine.
    expect(text).toContain("✓ Title");
    expect(text).toContain("✓ H1");
  });

  it("answers for the crawler it was asked about — a named group beats the * group", async () => {
    // robots.txt disallows /private/ for everyone, then allows this one path
    // back for Googlebot alone.
    const google = await auditSeo({ url: url("private/briefing.html"), wait_ms: 0, check_og_image: false });
    expect(report(google)).toContain("✓ robots.txt — Googlebot may crawl this path");

    const bing = await auditSeo({
      url: url("private/briefing.html"),
      wait_ms: 0,
      check_og_image: false,
      robots_user_agent: "Bingbot",
    });
    expect(report(bing)).toContain('✗ robots.txt — blocked for Bingbot by "Disallow: /private/"');
  });

  it("reports the sitemap it found on the way past", async () => {
    const result = await auditSeo({ url: url("seo-good.html"), wait_ms: 0 });
    expect(report(result)).toMatch(/· Sitemap — http\S+\/sitemap\.xml/);
  });

  it("skips the fetch entirely when asked to", async () => {
    const result = await auditSeo({ url: url("seo-blocked.html"), wait_ms: 0, check_robots: false });
    expect(report(result)).not.toMatch(/[✓✗!·] robots\.txt/);
    expect(report(result)).toMatch(/— 0 problems/);
  });

  it("reports a page that answered with an error status", async () => {
    const result = await auditSeo({ url: url("no-such-page.html"), wait_ms: 0, check_og_image: false });
    expect(report(result)).toContain("✗ HTTP status — the page answered 404");
  });
});

describe("auditSeo — the share image", () => {
  const social = (result: Result): string => report(result).split("Social (Open Graph)")[1] ?? "";

  it("fetches it, measures it, and hands it back to be looked at", async () => {
    const result = await auditSeo({ url: url("seo-good.html"), wait_ms: 0 });

    expect(social(result)).toContain("✓ Share image — 1200x630");
    expect(images(result)).toHaveLength(1);
    expect(images(result)[0].data?.length).toBeGreaterThan(100);
    expect(report(result)).toContain("as it will appear when the page is shared");
  });

  it("calls one that 404s a problem — a blank card is invisible from the page itself", async () => {
    const result = await auditSeo({ url: url("seo-og.html?card=broken"), wait_ms: 0 });

    expect(social(result)).toContain("✗ Share image");
    expect(social(result)).toContain("could not be fetched (HTTP 404)");
    expect(images(result)).toHaveLength(0);
  });

  it("judges it by size: below the floor is a problem, below the card is a warning", async () => {
    const small = await auditSeo({ url: url("seo-og.html?card=small"), wait_ms: 0 });
    expect(social(small)).toContain("✗ Share image — 100x100");
    expect(social(small)).toContain("below the 200x200 floor");

    const thumb = await auditSeo({ url: url("seo-og.html?card=thumb"), wait_ms: 0 });
    expect(social(thumb)).toContain("! Share image — 600x315");
    expect(social(thumb)).toContain("small thumbnail");
  });

  it("warns when og:image is relative, and still fetches it", async () => {
    const result = await auditSeo({ url: url("seo-og.html?card=relative"), wait_ms: 0 });

    expect(social(result)).toContain("is not an absolute URL");
    expect(social(result)).toContain("✓ Share image — 1200x630");
  });

  it("leaves the image alone when asked to", async () => {
    const result = await auditSeo({ url: url("seo-good.html"), wait_ms: 0, check_og_image: false });

    expect(social(result)).not.toContain("Share image");
    expect(social(result)).toContain("✓ og:image");
    expect(images(result)).toHaveLength(0);
  });
});

describe("auditSeo — a client-rendered page", () => {
  it("reads the rendered DOM, not the HTML that was served", async () => {
    const late = await auditSeo({ url: url("seo-spa.html"), wait_ms: 800 });
    const text = report(late);

    // None of this is in the source: the app writes all of it after load.
    expect(text).toContain('✓ Title — "Keko Food — the menu, rendered by the client"');
    expect(text).toContain("✓ Meta description");
    expect(text).toContain("✓ Canonical");
    expect(text).toContain('✓ WebSite "Keko Food"');
    expect(text).toContain("✓ H1");
  });

  it("sees the empty shell when it does not wait for the app", async () => {
    const early = await auditSeo({ url: url("seo-spa.html"), wait_ms: 0 });
    const text = report(early);

    expect(text).toContain("✗ Meta description — missing");
    expect(text).toContain("✗ H1 — the page has no headings at all");
  });

  it("waits for a selector instead of a fixed time", async () => {
    const result = await auditSeo({ url: url("seo-spa.html"), wait_ms: 0, wait_for: "#app h1" });
    expect(report(result)).toContain("✓ H1 — \"The menu\"");
  });
});

describe("auditSeo — performance", () => {
  it("measures the load only when asked", async () => {
    const without = await auditSeo({ url: url("seo-good.html"), wait_ms: 0 });
    expect(report(without)).not.toContain("Performance (lab)");

    const with_ = await auditSeo({ url: url("seo-good.html"), include_performance: true });
    const text = report(with_);
    expect(text).toContain("Performance (lab)");
    expect(text).toMatch(/[✓!✗] LCP — \d+ms/);
    expect(text).toMatch(/[✓!✗] CLS — [\d.]+/);
    expect(text).toMatch(/· Page weight — \d+ requests/);
  });

  it("names the element that took longest to paint", async () => {
    const result = await auditSeo({ url: url("seo-good.html"), include_performance: true });
    expect(report(result)).toMatch(/LCP — \d+ms — largest element: \w+/);
  });
});

describe("auditSeo — failures", () => {
  it("reports a page it cannot open", async () => {
    const result = await auditSeo({ url: "http://127.0.0.1:1/nope", wait_ms: 0 });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("the page could not be opened");
  });

  it("reports a selector that never appears", async () => {
    const result = await auditSeo({
      url: url("seo-good.html"),
      wait_ms: 0,
      wait_for: "#never",
      wait_for_timeout_ms: 400,
    });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain('selector "#never" did not become visible within 400ms');
  });

  it("reports invalid input as an error result rather than throwing", async () => {
    const result = await auditSeo({ url: "not-a-url" } as never);

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("invalid input");
  });

  it("names a missing auth state file and the tool that writes one", async () => {
    const result = await auditSeo({ url: url("seo-good.html"), storage_state: "/tmp/framewatch-nope.json" });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("framewatch_save_auth");
  });
});

describe("seoInputSchema", () => {
  it("needs nothing but a URL", () => {
    const parsed = seoInputSchema.parse({ url: "http://localhost:3000" });

    expect(parsed.wait_ms).toBe(1000);
    expect(parsed.check_robots).toBe(true);
    expect(parsed.check_og_image).toBe(true);
    expect(parsed.include_performance).toBe(false);
    expect(parsed.robots_user_agent).toBe("Googlebot");
  });

  it("refuses a URL that is not one, and a timeout that would never wait", () => {
    expect(seoInputSchema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(seoInputSchema.safeParse({ url: "http://a.test", wait_for_timeout_ms: 0 }).success).toBe(false);
  });
});

describe("describeSeoFailure", () => {
  const input = { url: "http://localhost:3000", wait_for_timeout_ms: 1000 };

  it("names a missing browser install with the command that fixes it", () => {
    const message = describeSeoFailure(input, new Error("browserType.launch: Executable doesn't exist at /nope"));
    expect(message).toContain("npx playwright install chromium");
  });

  it("blames the selector only when a waitForSelector call is what failed", () => {
    const waiting = { ...input, wait_for: "#late" };
    expect(describeSeoFailure(waiting, new Error("page.waitForSelector: Timeout 1000ms exceeded"))).toContain(
      'selector "#late" did not become visible',
    );
    expect(describeSeoFailure(waiting, new Error("page.goto: net::ERR_CONNECTION_REFUSED at #late"))).toContain(
      "the page could not be opened",
    );
  });
});
