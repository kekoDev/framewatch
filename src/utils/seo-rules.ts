import {
  MAX_SEO_TEXT_LENGTH,
  SEO_CLS_GOOD,
  SEO_CLS_POOR,
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  SEO_DOM_NODES_POOR,
  SEO_DOM_NODES_WARN,
  SEO_LCP_GOOD_MS,
  SEO_LCP_POOR_MS,
  SEO_OG_IMAGE_IDEAL,
  SEO_OG_IMAGE_MIN,
  SEO_TITLE_MAX,
  SEO_TITLE_MIN,
  SEO_TTFB_GOOD_MS,
  SEO_TTFB_POOR_MS,
} from "../constants.js";
import type { ImageProbe, JsonLdBlock, PageSeo, PerfMetrics, RobotsFetch } from "../engine/seo.js";

/**
 * What counts as an SEO problem.
 *
 * Everything here is pure: it takes what `engine/seo.ts` read off the page and
 * returns findings. Nothing in this file opens a browser, which is the point —
 * "is this canonical wrong?", "does this robots.txt block that path?" and
 * "which properties is this Product missing?" are all judgements with edge
 * cases, and judgements need unit tests that run in milliseconds.
 *
 * The type import above is type-only, so there is no runtime dependency on the
 * engine and no cycle: the engine reads, this judges, the tool prints.
 */

/* ── Findings ─────────────────────────────────────────────────────────── */

export const SEO_AREAS = ["indexing", "content", "headings", "social", "images", "structured_data", "performance"] as const;
export type SeoArea = (typeof SEO_AREAS)[number];

/**
 * `problem` will cost traffic, `warning` should be fixed, `info` is a
 * measurement with no verdict attached, `pass` is a check that ran and was
 * happy. Passes are reported rather than dropped for the same reason the
 * accessibility tool counts the rules that passed: without them, a short
 * report is indistinguishable from an audit that never ran.
 */
export type SeoLevel = "problem" | "warning" | "info" | "pass";

export interface SeoFinding {
  area: SeoArea;
  level: SeoLevel;
  /** What was checked — "Title", "og:image", "robots.txt". */
  label: string;
  /** What was found, including the value itself where it is short enough to be worth seeing. */
  detail: string;
  /** What to do about it. Only on problems and warnings. */
  fix?: string;
}

export interface SeoReport {
  findings: SeoFinding[];
  problems: number;
  warnings: number;
  passes: number;
}

export interface SeoResponseInfo {
  status: number;
  headers: Record<string, string>;
}

export interface SeoAuditInput {
  /** The URL the caller asked for, which is not necessarily the one that answered. */
  requested_url: string;
  page: PageSeo;
  response?: SeoResponseInfo;
  robots?: RobotsFetch;
  robots_user_agent: string;
  og_image?: ImageProbe;
  performance?: PerfMetrics;
}

/* ── The audit ────────────────────────────────────────────────────────── */

/**
 * Judge a page. The order of the checks is the order they are printed in, and
 * it runs from "will this page be in the index at all" down to "how fast is
 * it" — a `noindex` makes every other finding academic, so it goes first.
 */
export function judgeSeo(input: SeoAuditInput): SeoReport {
  const findings: SeoFinding[] = [];
  const add = (area: SeoArea, level: SeoLevel, label: string, detail: string, fix?: string): void => {
    findings.push({ area, level, label, detail, ...(fix ? { fix } : {}) });
  };

  auditIndexing(input, add);
  auditContent(input, add);
  auditHeadings(input, add);
  auditSocial(input, add);
  auditImages(input, add);
  auditStructuredData(input, add);
  auditPerformance(input, add);

  return {
    findings,
    problems: findings.filter((f) => f.level === "problem").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    passes: findings.filter((f) => f.level === "pass").length,
  };
}

type Add = (area: SeoArea, level: SeoLevel, label: string, detail: string, fix?: string) => void;

/** Can this page be crawled and indexed, and under which address? */
function auditIndexing(input: SeoAuditInput, add: Add): void {
  const { page, response } = input;

  if (response && response.status >= 400) {
    add(
      "indexing",
      "problem",
      "HTTP status",
      `the page answered ${response.status} — an error page is not indexed, whatever is rendered on it`,
      "Serve a 200 for pages that should be in the index.",
    );
  } else if (response && response.status >= 300) {
    add("indexing", "info", "HTTP status", `${response.status}`);
  }

  if (!sameAddress(input.requested_url, page.url)) {
    add(
      "indexing",
      "info",
      "Final URL",
      `${input.requested_url} redirected to ${page.url} — everything below describes the page that answered`,
    );
  }

  // The single most expensive one-line mistake there is: a staging noindex
  // that shipped. Checked before anything else about the page's content.
  const robotsMeta = [...metaValues(page, "robots"), ...metaValues(page, "googlebot")].join(", ");
  const headerRobots = response ? (response.headers["x-robots-tag"] ?? "") : "";
  const directives = `${robotsMeta} ${headerRobots}`.toLowerCase();
  if (/\bnoindex\b|\bnone\b/.test(directives)) {
    const source = /\bnoindex\b|\bnone\b/.test(headerRobots.toLowerCase()) ? "X-Robots-Tag header" : "<meta name=robots>";
    add(
      "indexing",
      "problem",
      "noindex",
      `this page tells search engines not to index it (${source}: "${(headerRobots || robotsMeta).trim()}")`,
      "Remove the noindex if this page is meant to be found — it is the usual reason a live site has no search presence.",
    );
  } else if (/\bnofollow\b/.test(directives)) {
    add("indexing", "warning", "nofollow", `robots directives say "${(robotsMeta || headerRobots).trim()}" — links on this page pass no signal`);
  } else {
    add("indexing", "pass", "Robots directives", robotsMeta ? `"${robotsMeta}" — indexable` : "none — indexable by default");
  }

  auditRobotsTxt(input, add);
  auditCanonical(input, add);

  if (page.lang) {
    add("indexing", "pass", "Language", `<html lang="${page.lang}">${page.dir ? ` dir="${page.dir}"` : ""}`);
  } else {
    add(
      "indexing",
      "warning",
      "Language",
      "<html> has no lang attribute",
      'Add lang (e.g. <html lang="en"> or lang="ar" dir="rtl") — it drives translation offers, hyphenation and screen-reader pronunciation.',
    );
  }

  const viewport = metaValues(page, "viewport")[0];
  if (viewport) {
    add("indexing", "pass", "Viewport", `"${viewport}"`);
  } else {
    add(
      "indexing",
      "warning",
      "Viewport",
      "no <meta name=viewport>",
      'Add <meta name="viewport" content="width=device-width, initial-scale=1"> — indexing is mobile-first, and without it a phone renders the page at 980px wide.',
    );
  }

  if (!page.charset) {
    add(
      "indexing",
      "warning",
      "Charset",
      "the document declares no character encoding",
      'Add <meta charset="utf-8"> as the first thing in <head>.',
    );
  }

  const alternates = page.links.alternate ?? [];
  const hreflangs = alternates.filter((link) => link.hreflang);
  if (hreflangs.length > 0) {
    const missingDefault = !hreflangs.some((link) => link.hreflang?.toLowerCase() === "x-default");
    const detail = `${hreflangs.length} alternate${hreflangs.length === 1 ? "" : "s"}: ${hreflangs
      .map((link) => link.hreflang)
      .join(", ")}`;
    if (missingDefault) {
      add("indexing", "info", "hreflang", `${detail} — no x-default, so unmatched locales fall back to nothing in particular`);
    } else {
      add("indexing", "pass", "hreflang", detail);
    }
  }
}

function auditRobotsTxt(input: SeoAuditInput, add: Add): void {
  const robots = input.robots;
  if (!robots) return;

  if (robots.error !== undefined) {
    add("indexing", "info", "robots.txt", `not checked — ${robots.error}`);
    return;
  }
  if (robots.text === undefined) {
    add(
      "indexing",
      "pass",
      "robots.txt",
      `${robots.url} answered ${robots.status ?? "no content"} — no rules, so everything is crawlable`,
    );
    return;
  }

  const verdict = evaluateRobots(robots.text, input.page.url, input.robots_user_agent);
  if (!verdict.allowed) {
    add(
      "indexing",
      "problem",
      "robots.txt",
      `blocked for ${input.robots_user_agent} by "${verdict.rule}"${verdict.group ? ` in the "${verdict.group}" group` : ""} — ` +
        "the page will not be crawled, and nothing on it (title, description, structured data) will ever be read",
      `Remove or narrow that rule in ${robots.url}.`,
    );
  } else {
    add("indexing", "pass", "robots.txt", `${input.robots_user_agent} may crawl this path — ${verdict.reason}`);
  }
  if (verdict.sitemaps.length > 0) {
    add("indexing", "info", "Sitemap", verdict.sitemaps.join(", "));
  }
}

function auditCanonical(input: SeoAuditInput, add: Add): void {
  const { page } = input;
  const canonicals = page.links.canonical ?? [];

  if (canonicals.length === 0) {
    add(
      "indexing",
      "warning",
      "Canonical",
      "no <link rel=canonical>",
      "Add a self-referencing canonical — without one, the same page reached with a query string or a trailing " +
        "slash is a separate, competing URL.",
    );
    return;
  }
  if (canonicals.length > 1) {
    add(
      "indexing",
      "problem",
      "Canonical",
      `${canonicals.length} canonical links (${canonicals.map((link) => link.href).join(", ")}) — ` +
        "search engines ignore all of them when they disagree",
      "Leave exactly one.",
    );
    return;
  }

  const canonical = canonicals[0];
  if (!canonical.href) {
    add("indexing", "problem", "Canonical", "the canonical link has an empty href", "Point it at this page's own URL.");
    return;
  }
  if (!/^https?:\/\//i.test(canonical.href)) {
    add(
      "indexing",
      "warning",
      "Canonical",
      `"${canonical.href}" is relative (resolves to ${canonical.resolved ?? "?"})`,
      "Use the absolute URL — relative canonicals are honoured inconsistently.",
    );
    return;
  }
  if (canonical.resolved && !sameAddress(canonical.resolved, page.url)) {
    add(
      "indexing",
      "warning",
      "Canonical",
      `points at ${canonical.resolved}, not at this page (${page.url}) — this URL will not be indexed on its own`,
      "Deliberate for a duplicate; a mistake if this page is meant to rank.",
    );
    return;
  }
  add("indexing", "pass", "Canonical", canonical.resolved ?? canonical.href);
}

/** The two strings that are the page in a search result. */
function auditContent(input: SeoAuditInput, add: Add): void {
  const { page } = input;

  const title = page.title ?? "";
  if (page.title_count === 0 || title === "") {
    add(
      "content",
      "problem",
      "Title",
      page.title_count === 0 ? "no <title> element" : "the <title> is empty",
      "Write one — it is the headline of every search result and browser tab, and the strongest on-page signal there is.",
    );
  } else {
    if (page.title_count > 1) {
      add("content", "warning", "Title", `${page.title_count} <title> elements — only the first counts`);
    }
    const length = [...title].length;
    if (length > SEO_TITLE_MAX) {
      add(
        "content",
        "warning",
        "Title",
        `"${title}" (${length} characters) — past about ${SEO_TITLE_MAX} the end is cut off in results`,
        "Put the distinguishing words first.",
      );
    } else if (length < SEO_TITLE_MIN) {
      add(
        "content",
        "warning",
        "Title",
        `"${title}" (${length} characters) — short; there is room for about ${SEO_TITLE_MAX}`,
        "Say what the page is for, not only what it is called.",
      );
    } else {
      add("content", "pass", "Title", `"${title}" (${length} characters)`);
    }
  }

  const descriptions = metaValues(page, "description");
  const description = descriptions[0] ?? "";
  if (descriptions.length === 0) {
    add(
      "content",
      "problem",
      "Meta description",
      "missing",
      'Add <meta name="description" content="…"> — without one the snippet is whatever text the engine scrapes off the page.',
    );
  } else if (description === "") {
    add("content", "problem", "Meta description", "present but empty", "Write the snippet, or drop the tag.");
  } else {
    if (descriptions.length > 1) {
      add("content", "warning", "Meta description", `${descriptions.length} description tags — only the first counts`);
    }
    const length = [...description].length;
    if (length > SEO_DESCRIPTION_MAX) {
      add(
        "content",
        "warning",
        "Meta description",
        `${length} characters — cut off around ${SEO_DESCRIPTION_MAX}: "${elide(description, MAX_SEO_TEXT_LENGTH)}"`,
      );
    } else if (length < SEO_DESCRIPTION_MIN) {
      add("content", "warning", "Meta description", `${length} characters — short: "${description}"`, `About ${SEO_DESCRIPTION_MIN}–${SEO_DESCRIPTION_MAX} characters uses the whole snippet.`);
    } else {
      add("content", "pass", "Meta description", `"${elide(description, MAX_SEO_TEXT_LENGTH)}" (${length} characters)`);
    }
  }

  add(
    "content",
    "info",
    "Body",
    `${plural(page.word_count, "word")}, ${plural(page.anchors.total, "link")} ` +
      `(${page.anchors.internal} internal, ${page.anchors.external} external` +
      `${page.anchors.nofollow > 0 ? `, ${page.anchors.nofollow} nofollow` : ""})`,
  );
  if (page.anchors.empty > 0) {
    add(
      "content",
      "warning",
      "Link text",
      `${page.anchors.empty} link${page.anchors.empty === 1 ? "" : "s"} with no text and no accessible name`,
      "A crawler follows the link but learns nothing about what is on the other side.",
    );
  }
}

/** The outline: one h1, and no levels skipped on the way down. */
function auditHeadings(input: SeoAuditInput, add: Add): void {
  const { page } = input;
  const h1s = page.headings.filter((heading) => heading.level === 1);
  const h1Count = page.heading_counts.h1 ?? 0;

  if (h1Count === 0) {
    add(
      "headings",
      "problem",
      "H1",
      page.heading_total === 0 ? "the page has no headings at all" : "no <h1>",
      "Give the page one h1 that says what it is about.",
    );
  } else if (h1Count > 1) {
    add(
      "headings",
      "warning",
      "H1",
      `${h1Count} h1 elements: ${h1s.map((heading) => `"${heading.text}"`).join(", ")}`,
      "One h1 per page; the rest are h2s.",
    );
  } else if (h1s[0]?.empty) {
    add("headings", "problem", "H1", "the h1 is empty", "An h1 containing only an image or an icon says nothing to a crawler.");
  } else {
    const only = h1s[0];
    add(
      "headings",
      "pass",
      "H1",
      only ? `"${only.text}"${only.hidden ? " (not visible, but still crawled)" : ""}` : "one, further down the page than the outline below reaches",
    );
  }

  const first = page.headings[0];
  if (first && first.level !== 1 && h1Count > 0) {
    add("headings", "info", "Outline", `the first heading is an h${first.level}, not the h1`);
  }

  const skips: string[] = [];
  let previous = 0;
  for (const heading of page.headings) {
    if (previous > 0 && heading.level > previous + 1) {
      skips.push(`h${previous} → h${heading.level} ("${heading.text}")`);
    }
    previous = heading.level;
  }
  if (skips.length > 0) {
    add(
      "headings",
      "warning",
      "Outline",
      `${skips.length} skipped level${skips.length === 1 ? "" : "s"}: ${skips.slice(0, 3).join("; ")}` +
        (skips.length > 3 ? `; … and ${skips.length - 3} more` : ""),
      "Headings are the page's table of contents; a jumped level breaks it for crawlers and screen readers alike.",
    );
  } else if (page.heading_total > 1) {
    add("headings", "pass", "Outline", `${describeCounts(page.heading_counts)} — no skipped levels`);
  }

  const empties = page.headings.filter((heading) => heading.empty && heading.level > 1).length;
  if (empties > 0) {
    add("headings", "warning", "Empty headings", `${empties} heading${empties === 1 ? "" : "s"} with no text`);
  }
}

/** What the link looks like when someone shares it. */
function auditSocial(input: SeoAuditInput, add: Add): void {
  const { page } = input;
  const og = (key: string): string => metaValues(page, key)[0] ?? "";

  const required: Array<[string, SeoLevel, string]> = [
    ["og:title", "warning", "the headline on the share card"],
    ["og:description", "warning", "the text under it"],
    ["og:image", "warning", "the picture — a card without one is a grey box"],
    ["og:url", "info", "the canonical address of the shared page"],
    ["og:type", "info", 'usually "website" or "article"'],
  ];

  const missing: string[] = [];
  for (const [key, level, why] of required) {
    const value = og(key);
    if (value) {
      add("social", "pass", key, elide(value, MAX_SEO_TEXT_LENGTH));
    } else {
      missing.push(key);
      add("social", level, key, `missing — ${why}`);
    }
  }

  if (missing.length === required.length) {
    add(
      "social",
      "warning",
      "Open Graph",
      "no Open Graph tags at all — every share of this link renders as a bare URL",
      "Add og:title, og:description, og:image and og:url.",
    );
  }

  const card = og("twitter:card");
  if (card) {
    add("social", "pass", "twitter:card", card);
  } else if (og("og:image")) {
    add("social", "info", "twitter:card", 'absent — X falls back to Open Graph, but "summary_large_image" is what makes the image full width');
  }

  auditOgImage(input, add);
}

function auditOgImage(input: SeoAuditInput, add: Add): void {
  const probe = input.og_image;
  if (!probe) return;

  const raw = metaValues(input.page, "og:image")[0] ?? "";
  if (raw && !/^https?:\/\//i.test(raw)) {
    add(
      "social",
      "warning",
      "Share image",
      `"${raw}" is not an absolute URL (fetched as ${probe.url})`,
      "Open Graph requires an absolute URL — most networks will not resolve a relative one.",
    );
  }

  if (!probe.ok) {
    add(
      "social",
      "problem",
      "Share image",
      `${probe.url} could not be fetched${probe.status ? ` (HTTP ${probe.status})` : ` — ${probe.error ?? "no response"}`} — ` +
        "the share card will be blank",
      "Point og:image at an image that resolves publicly, with no auth in front of it.",
    );
    return;
  }

  if (probe.width === undefined || probe.height === undefined) {
    add(
      "social",
      "warning",
      "Share image",
      `${probe.url} answered ${probe.status ?? 200}${probe.content_type ? ` as ${probe.content_type}` : ""} but could not be ` +
        `read as an image${probe.error ? ` (${probe.error})` : ""}`,
    );
    return;
  }

  const size = `${probe.width}x${probe.height}${probe.bytes ? `, ${kb(probe.bytes)}` : ""}`;
  if (probe.width < SEO_OG_IMAGE_MIN.width || probe.height < SEO_OG_IMAGE_MIN.height) {
    add(
      "social",
      "problem",
      "Share image",
      `${size} — below the ${SEO_OG_IMAGE_MIN.width}x${SEO_OG_IMAGE_MIN.height} floor, so the networks will not render a card at all`,
      `Use ${SEO_OG_IMAGE_IDEAL.width}x${SEO_OG_IMAGE_IDEAL.height}.`,
    );
  } else if (probe.width < SEO_OG_IMAGE_IDEAL.width || probe.height < SEO_OG_IMAGE_IDEAL.height) {
    add(
      "social",
      "warning",
      "Share image",
      `${size} — smaller than the ${SEO_OG_IMAGE_IDEAL.width}x${SEO_OG_IMAGE_IDEAL.height} card, so it renders as a small thumbnail beside the text`,
    );
  } else {
    add("social", "pass", "Share image", `${size} — fetched and readable`);
  }
}

/** Alt text: what a crawler and a screen reader read instead of the picture. */
function auditImages(input: SeoAuditInput, add: Add): void {
  const { images } = input.page;

  if (images.total === 0) {
    add("images", "info", "Images", "no <img> elements on the page");
    return;
  }

  if (images.missing_alt_total > 0) {
    const listed = images.missing_alt.map((image) => image.description || image.src || "?");
    add(
      "images",
      "problem",
      "Alt text",
      `${images.missing_alt_total} of ${images.total} images have no alt attribute: ${listed.join(", ")}` +
        (images.missing_alt_total > listed.length ? `, … and ${images.missing_alt_total - listed.length} more` : ""),
      'Describe what the image shows, or mark it decorative with alt="" — a missing attribute says neither.',
    );
  } else {
    add(
      "images",
      "pass",
      "Alt text",
      `all ${images.total} images have an alt attribute` + (images.empty_alt > 0 ? ` (${images.empty_alt} decorative, alt="")` : ""),
    );
  }

  if (images.no_dimensions > 0) {
    add(
      "images",
      "info",
      "Dimensions",
      `${images.no_dimensions} of ${images.total} images have no width/height attributes — the browser cannot reserve space, which is where layout shift comes from`,
    );
  }
}

/** JSON-LD: the difference between a blue link and a rich result. */
function auditStructuredData(input: SeoAuditInput, add: Add): void {
  const { page } = input;

  if (page.jsonld_total === 0) {
    const elsewhere =
      page.microdata > 0
        ? ` (there are ${page.microdata} microdata elements — Google reads those too, but JSON-LD is what it recommends)`
        : "";
    add(
      "structured_data",
      "warning",
      "JSON-LD",
      `none on the page${elsewhere}`,
      "Add a <script type=\"application/ld+json\"> block — it is what makes a page eligible for rich results.",
    );
    return;
  }

  const parsed = parseJsonLd(page.jsonld);
  for (const block of parsed) {
    if (!block.ok) {
      add(
        "structured_data",
        "problem",
        `JSON-LD block ${block.index}`,
        `is not valid JSON — ${block.error}`,
        "A block that does not parse is ignored entirely, so the page has that much less structured data than it looks like.",
      );
      continue;
    }
    if (block.nodes.length === 0) {
      add("structured_data", "warning", `JSON-LD block ${block.index}`, "parses, but declares no @type", "Without @type there is nothing to match against.");
      continue;
    }
    for (const node of block.nodes) {
      const label = `${node.type}${node.name ? ` "${elide(node.name, 60)}"` : ""}`;
      if (node.missing_required.length > 0) {
        add(
          "structured_data",
          "problem",
          label,
          `missing required ${node.missing_required.join(", ")} (has ${node.keys.join(", ")})`,
          "Google drops the whole item when a required property is absent.",
        );
      } else if (node.missing_recommended.length > 0) {
        add("structured_data", "warning", label, `missing recommended ${node.missing_recommended.join(", ")}`);
      } else if (node.known) {
        add("structured_data", "pass", label, `has ${node.keys.join(", ")}`);
      } else {
        add("structured_data", "info", label, `${node.keys.length} properties: ${node.keys.slice(0, 8).join(", ")}`);
      }
    }
  }

  const truncated = page.jsonld.filter((block) => block.truncated).length;
  if (truncated > 0) {
    add("structured_data", "info", "JSON-LD", `${truncated} block${truncated === 1 ? "" : "s"} too large to read in full — only the start was parsed`);
  }
  if (page.jsonld_total > page.jsonld.length) {
    add("structured_data", "info", "JSON-LD", `${page.jsonld_total} blocks on the page, ${page.jsonld.length} read`);
  }
}

/**
 * Speed, measured rather than scored.
 *
 * These are lab numbers from one load of a headless browser on this machine:
 * useful for "the LCP element is a 4MB hero image", worthless as a prediction
 * of what Chrome will report from real visitors. The wording says so.
 */
function auditPerformance(input: SeoAuditInput, add: Add): void {
  const perf = input.performance;
  if (!perf) return;

  if (perf.lcp_ms !== undefined) {
    const level = perf.lcp_ms <= SEO_LCP_GOOD_MS ? "pass" : perf.lcp_ms > SEO_LCP_POOR_MS ? "problem" : "warning";
    add(
      "performance",
      level,
      "LCP",
      `${perf.lcp_ms}ms${perf.lcp_element ? ` — largest element: ${perf.lcp_element}` : ""} ` +
        `(good ≤ ${SEO_LCP_GOOD_MS}ms, poor > ${SEO_LCP_POOR_MS}ms)`,
      level === "pass" ? undefined : "Largest Contentful Paint is a ranking signal; the named element is what to make faster.",
    );
  }

  if (perf.cls !== undefined) {
    const level = perf.cls <= SEO_CLS_GOOD ? "pass" : perf.cls > SEO_CLS_POOR ? "problem" : "warning";
    add(
      "performance",
      level,
      "CLS",
      `${perf.cls} (good ≤ ${SEO_CLS_GOOD}, poor > ${SEO_CLS_POOR})`,
      level === "pass" ? undefined : "Reserve space for images, ads and late-loading fonts.",
    );
  }

  if (perf.ttfb_ms !== undefined) {
    const level = perf.ttfb_ms <= SEO_TTFB_GOOD_MS ? "pass" : perf.ttfb_ms > SEO_TTFB_POOR_MS ? "warning" : "info";
    add("performance", level, "TTFB", `${perf.ttfb_ms}ms to the first byte (good ≤ ${SEO_TTFB_GOOD_MS}ms)`);
  }
  if (perf.fcp_ms !== undefined) add("performance", "info", "FCP", `${perf.fcp_ms}ms to the first paint`);
  if (perf.load_ms !== undefined) add("performance", "info", "Load", `${perf.load_ms}ms to the load event`);

  const weight =
    `${perf.requests} requests, ${kb(perf.transfer_bytes)} transferred` +
    (perf.transfer_incomplete ? " (a floor: cross-origin resources without Timing-Allow-Origin report 0)" : "");
  const top = perf.resources
    .slice(0, 3)
    .map((group) => `${group.type} ${group.count}×${group.bytes > 0 ? ` ${kb(group.bytes)}` : ""}`)
    .join(", ");
  add("performance", "info", "Page weight", top ? `${weight} — ${top}` : weight);

  if (perf.long_tasks > 0) {
    add("performance", "info", "Long tasks", `${perf.long_tasks} tasks over 50ms blocked the main thread during load`);
  }

  const nodes = input.page.dom_nodes;
  if (nodes > SEO_DOM_NODES_POOR) {
    add("performance", "warning", "DOM size", `${nodes} elements — past ${SEO_DOM_NODES_POOR} the page costs memory and style recalculation on every interaction`);
  } else if (nodes > SEO_DOM_NODES_WARN) {
    add("performance", "info", "DOM size", `${nodes} elements (Lighthouse starts warning at ${SEO_DOM_NODES_WARN})`);
  }
}

/* ── robots.txt ───────────────────────────────────────────────────────── */

export interface RobotsVerdict {
  allowed: boolean;
  /** The directive that decided it, e.g. `Disallow: /admin/`. */
  rule?: string;
  /** The user-agent group it came from. */
  group?: string;
  sitemaps: string[];
  reason: string;
}

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

/**
 * Decide whether `userAgent` may crawl `url`, per RFC 9309.
 *
 * Two rules do the work. Group selection: the most specific user-agent line
 * that matches wins, and `*` is the fallback — so a `Disallow: /` under
 * `User-agent: *` does not apply to Googlebot if Googlebot has a group of its
 * own. Rule selection: the *longest* matching path wins regardless of order,
 * and Allow beats Disallow on a tie. That is why `Disallow: /` followed by
 * `Allow: /public/` permits `/public/page` — reading top to bottom would get
 * it exactly wrong.
 *
 * `*` matches any run of characters and a trailing `$` anchors to the end.
 */
export function evaluateRobots(text: string, url: string, userAgent: string): RobotsVerdict {
  const { groups, sitemaps } = parseRobots(text);
  const path = pathOf(url);
  const agent = userAgent.toLowerCase();

  let best: RobotsGroup | undefined;
  let bestToken = "";
  for (const group of groups) {
    for (const candidate of group.agents) {
      const matches = candidate === "*" ? true : agent === candidate || agent.startsWith(candidate);
      if (!matches) continue;
      // A named group always beats "*", and a longer name beats a shorter one.
      const better = candidate !== "*" && (bestToken === "*" || candidate.length > bestToken.length);
      if (best === undefined || better) {
        best = group;
        bestToken = candidate;
      }
    }
  }

  if (!best) {
    return { allowed: true, sitemaps, reason: `no group matches ${userAgent}` };
  }

  // Groups naming the same crawler are one group, however many times the file
  // repeats the header — two `User-agent: *` blocks is what a concatenated
  // config produces, and honouring only the first would call a disallowed path
  // crawlable.
  const rules = groups.filter((group) => group.agents.includes(bestToken)).flatMap((group) => group.rules);

  let winner: { allow: boolean; path: string } | undefined;
  for (const rule of rules) {
    if (!matchesRobotsPath(rule.path, path)) continue;
    if (
      winner === undefined ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }

  if (!winner) {
    return { allowed: true, sitemaps, group: bestToken, reason: `no rule in the "${bestToken}" group matches ${path}` };
  }
  return {
    allowed: winner.allow,
    rule: `${winner.allow ? "Allow" : "Disallow"}: ${winner.path}`,
    group: bestToken,
    sitemaps,
    reason: `"${winner.allow ? "Allow" : "Disallow"}: ${winner.path}" in the "${bestToken}" group`,
  };
}

function parseRobots(text: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  // Consecutive user-agent lines head the same group; the first rule line
  // closes the header, so the next user-agent starts a new group.
  let heading = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === "user-agent") {
      if (!current || !heading) {
        current = { agents: [], rules: [] };
        groups.push(current);
        heading = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    if (!current) continue;
    heading = false;
    // `Disallow:` with nothing after it means "nothing is disallowed" — it is
    // the absence of a rule, not a rule matching everything.
    if (value === "") continue;
    current.rules.push({ allow: field === "allow", path: value });
  }

  return { groups, sitemaps };
}

/** A robots path pattern against a request path. `*` is any run, `$` anchors the end. */
export function matchesRobotsPath(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

/* ── Structured data ──────────────────────────────────────────────────── */

export interface SchemaExpectation {
  required: string[];
  recommended: string[];
}

/**
 * What Google's rich-result documentation asks for, per type.
 *
 * Deliberately short. Only types worth a rich result are listed, and only the
 * properties whose absence actually costs one — a validator that reports every
 * optional property of every schema.org type produces noise nobody reads, and
 * schema.org itself requires almost nothing.
 */
export const SCHEMA_EXPECTATIONS: Readonly<Record<string, SchemaExpectation>> = {
  Organization: { required: ["name", "url"], recommended: ["logo"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "openingHours", "image"] },
  Product: { required: ["name", "image"], recommended: ["offers", "description", "brand"] },
  Offer: { required: ["price", "priceCurrency"], recommended: ["availability"] },
  Article: { required: ["headline", "image", "datePublished"], recommended: ["author", "dateModified"] },
  BreadcrumbList: { required: ["itemListElement"], recommended: [] },
  WebSite: { required: ["name", "url"], recommended: ["potentialAction"] },
  WebPage: { required: ["name"], recommended: ["description"] },
  Event: { required: ["name", "startDate", "location"], recommended: ["endDate", "offers", "image"] },
  Recipe: { required: ["name", "image", "recipeIngredient", "recipeInstructions"], recommended: ["author", "totalTime"] },
  FAQPage: { required: ["mainEntity"], recommended: [] },
  VideoObject: { required: ["name", "description", "thumbnailUrl", "uploadDate"], recommended: ["duration"] },
  Person: { required: ["name"], recommended: ["url"] },
  SoftwareApplication: { required: ["name", "offers", "applicationCategory"], recommended: ["aggregateRating"] },
};

/** Subtypes that inherit another type's expectations. */
const SCHEMA_ALIASES: Readonly<Record<string, string>> = {
  Restaurant: "LocalBusiness",
  Store: "LocalBusiness",
  CafeOrCoffeeShop: "LocalBusiness",
  Bakery: "LocalBusiness",
  FoodEstablishment: "LocalBusiness",
  ProfessionalService: "LocalBusiness",
  MedicalBusiness: "LocalBusiness",
  NewsArticle: "Article",
  BlogPosting: "Article",
  TechArticle: "Article",
  ScholarlyArticle: "Article",
  Blog: "WebPage",
  CollectionPage: "WebPage",
  ItemPage: "WebPage",
  AboutPage: "WebPage",
  ContactPage: "WebPage",
  Corporation: "Organization",
  NGO: "Organization",
  EducationalOrganization: "Organization",
  OnlineStore: "Organization",
  IndividualProduct: "Product",
  ProductModel: "Product",
  AggregateOffer: "Offer",
  BusinessEvent: "Event",
  MusicEvent: "Event",
  SportsEvent: "Event",
  MobileApplication: "SoftwareApplication",
  WebApplication: "SoftwareApplication",
};

export function expectationsFor(type: string): SchemaExpectation | undefined {
  return SCHEMA_EXPECTATIONS[type] ?? SCHEMA_EXPECTATIONS[SCHEMA_ALIASES[type] ?? ""];
}

export interface JsonLdNode {
  type: string;
  /** Property names present on the node, `@`-prefixed keys excluded. */
  keys: string[];
  name?: string;
  missing_required: string[];
  missing_recommended: string[];
  /** Whether this type has expectations at all — an unknown type is reported, not judged. */
  known: boolean;
}

export interface JsonLdParsed {
  /** 1-based position of the block on the page. */
  index: number;
  ok: boolean;
  error?: string;
  nodes: JsonLdNode[];
}

/**
 * Parse the JSON-LD blocks and check each node against its type.
 *
 * `@graph` is flattened and a top-level array is iterated, because both are
 * ordinary ways to put several entities in one block. Nesting below that is
 * left alone: a Product's `offers` is checked as part of the Product's own
 * expectations, and walking arbitrarily deep would report the same missing
 * property from three directions.
 */
export function parseJsonLd(blocks: JsonLdBlock[]): JsonLdParsed[] {
  return blocks.map((block, at) => {
    const index = at + 1;
    let value: unknown;
    try {
      value = JSON.parse(block.text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        index,
        ok: false,
        error: block.truncated ? `${reason} (the block was too large to read in full)` : reason,
        nodes: [],
      };
    }

    const nodes: JsonLdNode[] = [];
    for (const entity of flattenEntities(value)) {
      for (const type of typesOf(entity)) {
        nodes.push(describeNode(type, entity));
      }
    }
    return { index, ok: true, nodes };
  });
}

function flattenEntities(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenEntities);
  if (typeof value !== "object" || value === null) return [];
  const entity = value as Record<string, unknown>;
  const graph = entity["@graph"];
  if (graph !== undefined) {
    const rest = Object.keys(entity).some((key) => key !== "@graph" && key !== "@context") ? [entity] : [];
    return [...rest, ...flattenEntities(graph)];
  }
  return [entity];
}

function typesOf(entity: Record<string, unknown>): string[] {
  const raw = entity["@type"];
  const types = (Array.isArray(raw) ? raw : [raw])
    .filter((type): type is string => typeof type === "string" && type.trim() !== "")
    // schema.org URLs are a legal way to spell a type.
    .map((type) => type.trim().replace(/^https?:\/\/schema\.org\//i, ""));
  return types.length > 0 ? types : [];
}

function describeNode(type: string, entity: Record<string, unknown>): JsonLdNode {
  const keys = Object.keys(entity).filter((key) => !key.startsWith("@"));
  const present = new Set(keys);
  const expectation = expectationsFor(type);
  const node: JsonLdNode = {
    type,
    keys,
    missing_required: expectation ? expectation.required.filter((key) => !hasValue(entity, present, key)) : [],
    missing_recommended: expectation ? expectation.recommended.filter((key) => !hasValue(entity, present, key)) : [],
    known: expectation !== undefined,
  };
  const name = entity.name ?? entity.headline;
  if (typeof name === "string" && name.trim() !== "") node.name = name.trim();
  return node;
}

/** Present *and* non-empty: `"name": ""` is the same problem as no name at all. */
function hasValue(entity: Record<string, unknown>, present: Set<string>, key: string): boolean {
  if (!present.has(key)) return false;
  const value = entity[key];
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/* ── Small shared helpers ─────────────────────────────────────────────── */

/** Read a meta value however the page spelled it: `property` first, then `name`. */
export function metaValues(page: PageSeo, key: string): string[] {
  const lower = key.toLowerCase();
  const values = [...(page.properties[lower] ?? []), ...(page.named[lower] ?? [])];
  return values.filter((value) => value !== undefined);
}

/** Two URLs that address the same page. The fragment is not part of the address. */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    if (left.href === right.href) return true;
    // A trailing slash on the root is the same address with or without it.
    return left.href.replace(/\/$/, "") === right.href.replace(/\/$/, "");
  } catch {
    return false;
  }
}

function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${count} ${level}`)
    .join(", ");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function elide(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function kb(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1000))}KB`;
}
