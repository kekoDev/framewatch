import { describe, expect, it } from "vitest";
import type { PageSeo } from "../src/engine/seo.js";
import {
  SCHEMA_EXPECTATIONS,
  evaluateRobots,
  expectationsFor,
  judgeSeo,
  matchesRobotsPath,
  metaValues,
  parseJsonLd,
  sameAddress,
  type SeoAuditInput,
  type SeoLevel,
} from "../src/utils/seo-rules.js";

/* A page with nothing wrong and nothing on it, to be spoiled one field at a time. */
function page(over: Partial<PageSeo> = {}): PageSeo {
  return {
    url: "https://example.com/page",
    title: "A title of exactly the right sort of length for this",
    title_count: 1,
    lang: "en",
    dir: "",
    charset: "utf-8",
    named: { description: ["A description long enough to fill the snippet without being cut off in the middle of it."], viewport: ["width=device-width"] },
    properties: {},
    http_equiv: {},
    links: { canonical: [{ href: "https://example.com/page", resolved: "https://example.com/page" }] },
    headings: [{ level: 1, text: "The one h1", hidden: false, empty: false }],
    heading_total: 1,
    heading_counts: { h1: 1, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    images: { total: 0, missing_alt: [], missing_alt_total: 0, empty_alt: 0, no_dimensions: 0, lazy: 0 },
    jsonld: [],
    jsonld_total: 0,
    microdata: 0,
    word_count: 400,
    anchors: { total: 3, internal: 2, external: 1, nofollow: 0, empty: 0 },
    dom_nodes: 200,
    ...over,
  };
}

function audit(over: Partial<PageSeo> = {}, input: Partial<SeoAuditInput> = {}) {
  return judgeSeo({ requested_url: "https://example.com/page", page: page(over), robots_user_agent: "Googlebot", ...input });
}

/** The finding for one label, so a test can assert on the level and the words. */
function finding(report: ReturnType<typeof audit>, label: string) {
  return report.findings.find((f) => f.label === label);
}

function levelOf(report: ReturnType<typeof audit>, label: string): SeoLevel | undefined {
  return finding(report, label)?.level;
}

describe("judgeSeo — indexing", () => {
  it("passes a page with nothing wrong with it", () => {
    const report = audit();
    expect(report.problems).toBe(0);
    expect(report.passes).toBeGreaterThan(4);
  });

  it("treats a noindex as a problem, whether it came from a meta tag or a header", () => {
    const fromMeta = audit({ named: { ...page().named, robots: ["noindex, follow"] } });
    expect(levelOf(fromMeta, "noindex")).toBe("problem");

    const fromHeader = audit({}, { response: { status: 200, headers: { "x-robots-tag": "noindex" } } });
    expect(levelOf(fromHeader, "noindex")).toBe("problem");
    expect(finding(fromHeader, "noindex")?.detail).toContain("X-Robots-Tag");
  });

  it("reads googlebot-specific directives too, and calls a bare nofollow a warning", () => {
    expect(levelOf(audit({ named: { ...page().named, googlebot: ["noindex"] } }), "noindex")).toBe("problem");
    expect(levelOf(audit({ named: { ...page().named, robots: ["nofollow"] } }), "nofollow")).toBe("warning");
  });

  it("reports an error status, because an error page is not indexed whatever it renders", () => {
    const report = audit({}, { response: { status: 404, headers: {} } });
    expect(levelOf(report, "HTTP status")).toBe("problem");
  });

  it("says so when the URL asked for is not the URL that answered", () => {
    const report = audit({ url: "https://example.com/moved" }, { requested_url: "https://example.com/page" });
    expect(finding(report, "Final URL")?.detail).toContain("redirected to");
  });

  it("wants a canonical, exactly one of them, absolute, pointing here", () => {
    expect(levelOf(audit({ links: {} }), "Canonical")).toBe("warning");

    const two = audit({ links: { canonical: [{ href: "https://example.com/a" }, { href: "https://example.com/b" }] } });
    expect(levelOf(two, "Canonical")).toBe("problem");

    const relative = audit({ links: { canonical: [{ href: "/page", resolved: "https://example.com/page" }] } });
    expect(levelOf(relative, "Canonical")).toBe("warning");
    expect(finding(relative, "Canonical")?.detail).toContain("relative");

    const elsewhere = audit({ links: { canonical: [{ href: "https://example.com/other", resolved: "https://example.com/other" }] } });
    expect(levelOf(elsewhere, "Canonical")).toBe("warning");
    expect(finding(elsewhere, "Canonical")?.detail).toContain("not at this page");
  });

  it("asks for lang, a viewport and a charset", () => {
    expect(levelOf(audit({ lang: "" }), "Language")).toBe("warning");
    expect(levelOf(audit({ named: { description: page().named.description } }), "Viewport")).toBe("warning");
    expect(levelOf(audit({ charset: "" }), "Charset")).toBe("warning");
  });

  it("notes hreflang alternates and whether they have an x-default", () => {
    const withDefault = audit({
      links: {
        ...page().links,
        alternate: [
          { href: "/ar", hreflang: "ar" },
          { href: "/", hreflang: "x-default" },
        ],
      },
    });
    expect(levelOf(withDefault, "hreflang")).toBe("pass");

    const without = audit({ links: { ...page().links, alternate: [{ href: "/ar", hreflang: "ar" }] } });
    expect(finding(without, "hreflang")?.detail).toContain("x-default");
  });
});

describe("judgeSeo — title and description", () => {
  it("reports a missing title, an empty one, and more than one", () => {
    expect(levelOf(audit({ title: null, title_count: 0 }), "Title")).toBe("problem");
    expect(levelOf(audit({ title: "" }), "Title")).toBe("problem");
    expect(levelOf(audit({ title_count: 2 }), "Title")).toBe("warning");
  });

  it("warns on a title that is too long to survive the results page, and one too short to say anything", () => {
    const long = audit({ title: "x".repeat(90) });
    expect(levelOf(long, "Title")).toBe("warning");
    expect(finding(long, "Title")?.detail).toContain("90 characters");
    expect(levelOf(audit({ title: "Home" }), "Title")).toBe("warning");
  });

  it("counts characters, not code units, so an Arabic or emoji title is measured as it reads", () => {
    // 40 astral-plane characters: 80 UTF-16 code units, but 40 characters.
    const report = audit({ title: "🍔".repeat(40) });
    expect(finding(report, "Title")?.detail).toContain("40 characters");
  });

  it("treats a missing description as a problem and a short one as a warning", () => {
    expect(levelOf(audit({ named: { viewport: ["width=device-width"] } }), "Meta description")).toBe("problem");
    expect(levelOf(audit({ named: { ...page().named, description: [""] } }), "Meta description")).toBe("problem");
    expect(levelOf(audit({ named: { ...page().named, description: ["Too short."] } }), "Meta description")).toBe("warning");
    expect(levelOf(audit({ named: { ...page().named, description: ["x".repeat(300)] } }), "Meta description")).toBe("warning");
  });

  it("flags links with no text at all", () => {
    const report = audit({ anchors: { total: 3, internal: 2, external: 1, nofollow: 0, empty: 2 } });
    expect(levelOf(report, "Link text")).toBe("warning");
  });
});

describe("judgeSeo — headings", () => {
  it("wants exactly one h1", () => {
    const none = audit({ headings: [], heading_total: 0, heading_counts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 } });
    expect(levelOf(none, "H1")).toBe("problem");

    const two = audit({
      headings: [
        { level: 1, text: "One", hidden: false, empty: false },
        { level: 1, text: "Two", hidden: false, empty: false },
      ],
      heading_total: 2,
      heading_counts: { h1: 2, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
    });
    expect(levelOf(two, "H1")).toBe("warning");
    expect(finding(two, "H1")?.detail).toContain('"Two"');
  });

  it("reports an h1 that is present but empty, and one that is present but not visible", () => {
    const empty = audit({ headings: [{ level: 1, text: "", hidden: false, empty: true }] });
    expect(levelOf(empty, "H1")).toBe("problem");

    const hidden = audit({ headings: [{ level: 1, text: "Still crawled", hidden: true, empty: false }] });
    expect(levelOf(hidden, "H1")).toBe("pass");
    expect(finding(hidden, "H1")?.detail).toContain("not visible");
  });

  it("finds a skipped heading level", () => {
    const report = audit({
      headings: [
        { level: 1, text: "Top", hidden: false, empty: false },
        { level: 4, text: "Jumped", hidden: false, empty: false },
      ],
      heading_total: 2,
      heading_counts: { h1: 1, h2: 0, h3: 0, h4: 1, h5: 0, h6: 0 },
    });
    expect(levelOf(report, "Outline")).toBe("warning");
    expect(finding(report, "Outline")?.detail).toContain("h1 → h4");
  });
});

describe("judgeSeo — social", () => {
  const og = (over: Record<string, string[]>) => ({ properties: over });

  it("reports each missing Open Graph tag, and that there are none at all", () => {
    const report = audit();
    expect(levelOf(report, "og:title")).toBe("warning");
    expect(levelOf(report, "og:image")).toBe("warning");
    expect(levelOf(report, "Open Graph")).toBe("warning");
  });

  it("does not complain about Open Graph as a whole once some of it is there", () => {
    const report = audit(og({ "og:title": ["A title"], "og:image": ["https://example.com/a.png"] }));
    expect(levelOf(report, "og:title")).toBe("pass");
    expect(finding(report, "Open Graph")).toBeUndefined();
  });

  it("calls a share image that cannot be fetched a problem", () => {
    const report = audit(og({ "og:image": ["https://example.com/a.png"] }), {
      og_image: { url: "https://example.com/a.png", ok: false, status: 404 },
    });
    expect(levelOf(report, "Share image")).toBe("problem");
    expect(finding(report, "Share image")?.detail).toContain("blank");
  });

  it("judges the share image by its size: below the floor, below the card, or right", () => {
    const probe = (width: number, height: number) => ({
      og_image: { url: "https://example.com/a.png", ok: true, status: 200, width, height, bytes: 40_000 },
    });
    const tag = og({ "og:image": ["https://example.com/a.png"] });

    expect(levelOf(audit(tag, probe(100, 100)), "Share image")).toBe("problem");
    expect(levelOf(audit(tag, probe(600, 315)), "Share image")).toBe("warning");
    expect(levelOf(audit(tag, probe(1200, 630)), "Share image")).toBe("pass");
  });

  it("warns when og:image is relative, which most networks will not resolve", () => {
    const report = audit(og({ "og:image": ["/share.png"] }), {
      og_image: { url: "https://example.com/share.png", ok: true, status: 200, width: 1200, height: 630 },
    });
    expect(report.findings.filter((f) => f.label === "Share image" && f.level === "warning")[0]?.detail).toContain("absolute");
  });
});

describe("judgeSeo — images and structured data", () => {
  it("reports images with no alt attribute and names them", () => {
    const report = audit({
      images: {
        total: 4,
        missing_alt: [{ src: "/a.png", description: "#hero" }],
        missing_alt_total: 2,
        empty_alt: 1,
        no_dimensions: 3,
        lazy: 0,
      },
    });
    expect(levelOf(report, "Alt text")).toBe("problem");
    expect(finding(report, "Alt text")?.detail).toContain("#hero");
    expect(finding(report, "Alt text")?.detail).toContain("1 more");
    expect(levelOf(report, "Dimensions")).toBe("info");
  });

  it("counts a decorative alt=\"\" as correct, not as missing", () => {
    const report = audit({
      images: { total: 3, missing_alt: [], missing_alt_total: 0, empty_alt: 3, no_dimensions: 0, lazy: 0 },
    });
    expect(levelOf(report, "Alt text")).toBe("pass");
    expect(finding(report, "Alt text")?.detail).toContain("decorative");
  });

  it("asks for JSON-LD when there is none, and says when there is microdata instead", () => {
    expect(levelOf(audit(), "JSON-LD")).toBe("warning");
    expect(finding(audit({ microdata: 12 }), "JSON-LD")?.detail).toContain("microdata");
  });

  it("reports a JSON-LD block that does not parse, and one missing a required property", () => {
    const broken = audit({ jsonld: [{ text: "{ nope }", truncated: false }], jsonld_total: 1 });
    expect(levelOf(broken, "JSON-LD block 1")).toBe("problem");

    const incomplete = audit({
      jsonld: [{ text: JSON.stringify({ "@type": "Product", description: "x" }), truncated: false }],
      jsonld_total: 1,
    });
    expect(incomplete.findings.some((f) => f.level === "problem" && f.detail.includes("missing required name, image"))).toBe(true);
  });
});

describe("judgeSeo — performance", () => {
  const perf = (over: Record<string, unknown> = {}) => ({
    performance: {
      long_tasks: 0,
      requests: 10,
      transfer_bytes: 500_000,
      transfer_incomplete: false,
      resources: [{ type: "script", count: 4, bytes: 300_000 }],
      ...over,
    } as never,
  });

  it("says nothing at all unless it was asked to measure", () => {
    expect(audit().findings.some((f) => f.area === "performance")).toBe(false);
  });

  it("grades LCP and CLS against Google's own boundaries", () => {
    expect(levelOf(audit({}, perf({ lcp_ms: 1200 })), "LCP")).toBe("pass");
    expect(levelOf(audit({}, perf({ lcp_ms: 3000 })), "LCP")).toBe("warning");
    expect(levelOf(audit({}, perf({ lcp_ms: 6000 })), "LCP")).toBe("problem");

    expect(levelOf(audit({}, perf({ cls: 0.02 })), "CLS")).toBe("pass");
    expect(levelOf(audit({}, perf({ cls: 0.2 })), "CLS")).toBe("warning");
    expect(levelOf(audit({}, perf({ cls: 0.6 })), "CLS")).toBe("problem");
  });

  it("names the element that took longest to paint", () => {
    const report = audit({}, perf({ lcp_ms: 900, lcp_element: "img.hero" }));
    expect(finding(report, "LCP")?.detail).toContain("img.hero");
  });

  it("says when the transferred total is only a floor", () => {
    const report = audit({}, perf({ transfer_incomplete: true }));
    expect(finding(report, "Page weight")?.detail).toContain("floor");
  });

  it("flags a DOM big enough to slow the page down", () => {
    expect(levelOf(audit({ dom_nodes: 5000 }, perf()), "DOM size")).toBe("warning");
    expect(levelOf(audit({ dom_nodes: 2000 }, perf()), "DOM size")).toBe("info");
    expect(finding(audit({ dom_nodes: 300 }, perf()), "DOM size")).toBeUndefined();
  });
});

describe("evaluateRobots", () => {
  const RULES = `
    # a comment
    User-agent: *
    Disallow: /admin/
    Disallow: /search?q=

    User-agent: Googlebot
    Disallow: /
    Allow: /public/

    Sitemap: https://example.com/sitemap.xml
  `;

  it("allows anything when no group matches and when the file is empty", () => {
    expect(evaluateRobots("", "https://example.com/x", "Googlebot").allowed).toBe(true);
    expect(evaluateRobots("User-agent: Bingbot\nDisallow: /", "https://example.com/x", "Googlebot").allowed).toBe(true);
  });

  it("uses the group named for the crawler in preference to the * group", () => {
    // Googlebot's own group disallows everything but /public/; the * group does not.
    expect(evaluateRobots(RULES, "https://example.com/admin/", "Bingbot").allowed).toBe(false);
    expect(evaluateRobots(RULES, "https://example.com/anything", "Bingbot").allowed).toBe(true);
    expect(evaluateRobots(RULES, "https://example.com/anything", "Googlebot").allowed).toBe(false);
    expect(evaluateRobots(RULES, "https://example.com/public/page", "Googlebot").allowed).toBe(true);
  });

  it("lets the longest matching rule win regardless of the order it appears in", () => {
    const verdict = evaluateRobots(RULES, "https://example.com/public/deep/page", "Googlebot");
    expect(verdict.allowed).toBe(true);
    expect(verdict.rule).toBe("Allow: /public/");
  });

  it("lets Allow win a tie with Disallow", () => {
    const text = "User-agent: *\nDisallow: /page\nAllow: /page";
    expect(evaluateRobots(text, "https://example.com/page", "Googlebot").allowed).toBe(true);
  });

  it("treats an empty Disallow as no rule at all", () => {
    expect(evaluateRobots("User-agent: *\nDisallow:", "https://example.com/anything", "Googlebot").allowed).toBe(true);
  });

  it("matches the query string, not only the path", () => {
    expect(evaluateRobots(RULES, "https://example.com/search?q=shoes", "Bingbot").allowed).toBe(false);
    expect(evaluateRobots(RULES, "https://example.com/search", "Bingbot").allowed).toBe(true);
  });

  it("collects the sitemaps, which belong to no group", () => {
    expect(evaluateRobots(RULES, "https://example.com/", "Googlebot").sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("names the rule and the group that decided it", () => {
    const verdict = evaluateRobots(RULES, "https://example.com/admin/x", "Bingbot");
    expect(verdict.rule).toBe("Disallow: /admin/");
    expect(verdict.group).toBe("*");
    expect(verdict.reason).toContain("Disallow: /admin/");
  });

  it("merges two groups that name the same crawler, however far apart they are", () => {
    const text = "User-agent: *\nDisallow: /a\n\nUser-agent: *\nDisallow: /b";
    expect(evaluateRobots(text, "https://example.com/a", "Googlebot").allowed).toBe(false);
    expect(evaluateRobots(text, "https://example.com/b", "Googlebot").allowed).toBe(false);
  });

  it("keeps consecutive user-agent lines in one group and starts a new one after a rule", () => {
    const text = "User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow: /y";
    expect(evaluateRobots(text, "https://example.com/x", "a").allowed).toBe(false);
    expect(evaluateRobots(text, "https://example.com/x", "b").allowed).toBe(false);
    expect(evaluateRobots(text, "https://example.com/x", "c").allowed).toBe(true);
    expect(evaluateRobots(text, "https://example.com/y", "c").allowed).toBe(false);
  });
});

describe("matchesRobotsPath", () => {
  it("matches on prefix", () => {
    expect(matchesRobotsPath("/admin", "/admin/users")).toBe(true);
    expect(matchesRobotsPath("/admin", "/administrator")).toBe(true);
    expect(matchesRobotsPath("/admin", "/user/admin")).toBe(false);
  });

  it("treats * as any run of characters and a trailing $ as the end", () => {
    expect(matchesRobotsPath("/*.pdf$", "/files/report.pdf")).toBe(true);
    expect(matchesRobotsPath("/*.pdf$", "/files/report.pdf.html")).toBe(false);
    expect(matchesRobotsPath("/a/*/c", "/a/b/c")).toBe(true);
  });

  it("does not let a regular expression in the pattern escape into the matcher", () => {
    expect(matchesRobotsPath("/a+b", "/aaab")).toBe(false);
    expect(matchesRobotsPath("/a+b", "/a+b/c")).toBe(true);
  });
});

describe("parseJsonLd", () => {
  const block = (value: unknown) => [{ text: JSON.stringify(value), truncated: false }];

  it("reports a syntax error rather than dropping the block silently", () => {
    const [parsed] = parseJsonLd([{ text: "{ 'single': 'quotes' }", truncated: false }]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
    expect(parsed.index).toBe(1);
  });

  it("says when a block was too large to read in full, so the error is not blamed on the page", () => {
    const [parsed] = parseJsonLd([{ text: '{"@type": "Product", "name": "A very long', truncated: true }]);
    expect(parsed.error).toContain("too large");
  });

  it("flattens @graph and a top-level array", () => {
    const graph = parseJsonLd(block({ "@context": "https://schema.org", "@graph": [{ "@type": "Person", name: "A" }, { "@type": "Person", name: "B" }] }));
    expect(graph[0].nodes.map((n) => n.name)).toEqual(["A", "B"]);

    const array = parseJsonLd(block([{ "@type": "Person", name: "A" }, { "@type": "Organization", name: "B", url: "u", logo: "l" }]));
    expect(array[0].nodes).toHaveLength(2);
  });

  it("handles a node with several types, and a type spelled as a schema.org URL", () => {
    const several = parseJsonLd(block({ "@type": ["LocalBusiness", "Restaurant"], name: "A", address: "B" }));
    expect(several[0].nodes.map((n) => n.type)).toEqual(["LocalBusiness", "Restaurant"]);

    const url = parseJsonLd(block({ "@type": "https://schema.org/Person", name: "A" }));
    expect(url[0].nodes[0].type).toBe("Person");
  });

  it("separates the properties a rich result requires from the ones it merely likes", () => {
    const [parsed] = parseJsonLd(block({ "@type": "Article", headline: "A", image: "i", datePublished: "2024-01-01" }));
    expect(parsed.nodes[0].missing_required).toEqual([]);
    expect(parsed.nodes[0].missing_recommended).toEqual(["author", "dateModified"]);
  });

  it("counts an empty value as absent, because it is", () => {
    const [parsed] = parseJsonLd(block({ "@type": "Person", name: "  " }));
    expect(parsed.nodes[0].missing_required).toEqual(["name"]);

    const [withArray] = parseJsonLd(block({ "@type": "FAQPage", mainEntity: [] }));
    expect(withArray.nodes[0].missing_required).toEqual(["mainEntity"]);
  });

  it("reports a type it has no expectations for without judging it", () => {
    const [parsed] = parseJsonLd(block({ "@type": "Sculpture", name: "A", material: "bronze" }));
    expect(parsed.nodes[0].known).toBe(false);
    expect(parsed.nodes[0].missing_required).toEqual([]);
    expect(parsed.nodes[0].keys).toEqual(["name", "material"]);
  });

  it("returns no nodes for a block with no @type", () => {
    expect(parseJsonLd(block({ name: "A" }))[0].nodes).toEqual([]);
  });
});

describe("expectationsFor", () => {
  it("gives a subtype the expectations of the type it is one of", () => {
    expect(expectationsFor("Restaurant")).toEqual(SCHEMA_EXPECTATIONS.LocalBusiness);
    expect(expectationsFor("BlogPosting")).toEqual(SCHEMA_EXPECTATIONS.Article);
  });

  it("has nothing to say about a type it does not know", () => {
    expect(expectationsFor("Sculpture")).toBeUndefined();
  });
});

describe("metaValues and sameAddress", () => {
  it("finds a meta tag however the page spelled it", () => {
    const both = page({ properties: { "og:title": ["from property"] }, named: { "og:title": ["from name"] } });
    expect(metaValues(both, "og:title")).toEqual(["from property", "from name"]);
    expect(metaValues(both, "OG:TITLE")[0]).toBe("from property");
    expect(metaValues(both, "nothing")).toEqual([]);
  });

  it("ignores the fragment and a trailing slash when comparing addresses", () => {
    expect(sameAddress("https://example.com/a", "https://example.com/a#top")).toBe(true);
    expect(sameAddress("https://example.com/", "https://example.com")).toBe(true);
    expect(sameAddress("https://example.com/a", "https://example.com/b")).toBe(false);
    expect(sameAddress("not a url", "also not")).toBe(false);
  });
});
