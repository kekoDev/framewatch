import type { BrowserContext, Page } from "playwright";
import {
  MAX_SEO_HEADINGS,
  MAX_SEO_IMAGES_LISTED,
  MAX_SEO_IMAGE_BYTES,
  MAX_SEO_JSONLD_BLOCKS,
  MAX_SEO_JSONLD_LENGTH,
  MAX_SEO_TEXT_LENGTH,
  SEO_FETCH_TIMEOUT_MS,
} from "../constants.js";
import { getDimensions } from "../utils/image.js";

/**
 * SEO engine.
 *
 * Everything here talks to the page or the network; nothing here decides
 * whether what it found is good or bad — that is `utils/seo-rules.ts`, which
 * is pure and therefore testable without a browser.
 *
 * The split matters more than it looks. What a crawler sees is a fact about
 * one particular page load: the DOM *after* the app has rendered (which is why
 * this reads the live document rather than the HTML source), the response
 * headers, robots.txt, and whether the share image actually resolves. What
 * counts as a problem is a judgement, and judgements need unit tests.
 */

/* ── What the page says about itself ──────────────────────────────────── */

/** A `<link rel=…>`, with its href resolved against the document. */
export interface LinkTag {
  href: string;
  resolved?: string;
  hreflang?: string;
  type?: string;
}

export interface HeadingNode {
  level: number;
  text: string;
  /** Not rendered — a visually-hidden h1 is still crawled, so this is context, not a verdict. */
  hidden: boolean;
  empty: boolean;
}

export interface ImageNode {
  src: string;
  /** How the element is named in the report — `#hero`, `.logo`, or its source. */
  description: string;
}

export interface ImageSummary {
  total: number;
  /** Images with no `alt` attribute at all (not the same as `alt=""`). */
  missing_alt: ImageNode[];
  missing_alt_total: number;
  /** `alt=""` — a decorative image, correctly marked. */
  empty_alt: number;
  /** No `width`/`height` attributes, so the browser cannot reserve space (layout shift). */
  no_dimensions: number;
  lazy: number;
}

export interface JsonLdBlock {
  /** The raw script contents, elided at MAX_SEO_JSONLD_LENGTH. */
  text: string;
  truncated: boolean;
}

export interface AnchorSummary {
  total: number;
  internal: number;
  external: number;
  nofollow: number;
  /** Links with neither text nor an accessible name — a dead end for a crawler. */
  empty: number;
}

/**
 * Everything read out of the rendered document, unjudged.
 *
 * Meta tags are kept as three raw maps rather than a curated set of named
 * fields. `<meta name>` and `<meta property>` are different attributes and
 * pages use them interchangeably (`og:title` shows up under both), so the
 * rules look a key up in whichever map has it instead of the extraction
 * deciding in advance which spellings exist.
 */
export interface PageSeo {
  url: string;
  title: string | null;
  title_count: number;
  lang: string;
  dir: string;
  charset: string;
  named: Record<string, string[]>;
  properties: Record<string, string[]>;
  http_equiv: Record<string, string[]>;
  links: Record<string, LinkTag[]>;
  headings: HeadingNode[];
  heading_total: number;
  heading_counts: Record<string, number>;
  images: ImageSummary;
  jsonld: JsonLdBlock[];
  jsonld_total: number;
  /** Elements carrying microdata / RDFa, so "no JSON-LD" can say whether there is markup elsewhere. */
  microdata: number;
  word_count: number;
  anchors: AnchorSummary;
  /** Nodes in the document — Lighthouse's DOM-size warning, and a decent proxy for a page a crawler will struggle with. */
  dom_nodes: number;
}

interface ExtractOptions {
  max_headings: number;
  max_images: number;
  max_text: number;
  max_jsonld: number;
  max_jsonld_length: number;
}

/**
 * Read the SEO-relevant parts of the rendered document.
 *
 * One `evaluate`, and everything it can find in one pass. It runs against the
 * live DOM on purpose: a single-page app serves an empty `<div id="app">` in
 * its HTML and fills in the title, the description and the structured data
 * afterwards, so reading the source would report every client-rendered page as
 * having no SEO at all.
 *
 * Written against `globalThis` because this package compiles with the Node lib
 * only, and because a page can be mid-teardown when this lands in it.
 */
export async function extractSeo(page: Page, options: Partial<ExtractOptions> = {}): Promise<PageSeo> {
  const opts: ExtractOptions = {
    max_headings: options.max_headings ?? MAX_SEO_HEADINGS,
    max_images: options.max_images ?? MAX_SEO_IMAGES_LISTED,
    max_text: options.max_text ?? MAX_SEO_TEXT_LENGTH,
    max_jsonld: options.max_jsonld ?? MAX_SEO_JSONLD_BLOCKS,
    max_jsonld_length: options.max_jsonld_length ?? MAX_SEO_JSONLD_LENGTH,
  };

  return page.evaluate((o: ExtractOptions): PageSeo => {
    const g = globalThis as any;
    const doc = g.document;

    const flat = (value: unknown): string =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim();
    const elide = (value: unknown, max: number): string => {
      const text = flat(value);
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    const resolve = (href: string): string | undefined => {
      try {
        return new g.URL(href, doc.baseURI ?? g.location.href).href;
      } catch {
        return undefined;
      }
    };
    const push = (map: Record<string, string[]>, key: string, value: string): void => {
      if (!key) return;
      (map[key] ??= []).push(value);
    };

    /* Meta tags — three maps, keyed exactly as the page spelled them. */
    const named: Record<string, string[]> = {};
    const properties: Record<string, string[]> = {};
    const httpEquiv: Record<string, string[]> = {};
    let charset = "";
    for (const meta of doc.querySelectorAll("meta")) {
      if (meta.hasAttribute("charset")) charset = flat(meta.getAttribute("charset"));
      const content = flat(meta.getAttribute("content"));
      const name = flat(meta.getAttribute("name")).toLowerCase();
      const property = flat(meta.getAttribute("property")).toLowerCase();
      const equiv = flat(meta.getAttribute("http-equiv")).toLowerCase();
      if (name) push(named, name, content);
      if (property) push(properties, property, content);
      if (equiv) {
        push(httpEquiv, equiv, content);
        if (equiv === "content-type" && !charset) {
          const match = /charset=([\w-]+)/i.exec(content);
          if (match) charset = match[1];
        }
      }
    }

    /* <link rel=…>, grouped by rel. One tag can carry several rels. */
    const links: Record<string, LinkTag[]> = {};
    for (const link of doc.querySelectorAll("link[rel]")) {
      const href = flat(link.getAttribute("href"));
      const tag: LinkTag = { href };
      const resolved = href ? resolve(href) : undefined;
      if (resolved) tag.resolved = resolved;
      const hreflang = flat(link.getAttribute("hreflang"));
      if (hreflang) tag.hreflang = hreflang;
      const type = flat(link.getAttribute("type"));
      if (type) tag.type = type;
      for (const rel of flat(link.getAttribute("rel")).toLowerCase().split(/\s+/)) {
        if (rel) (links[rel] ??= []).push(tag);
      }
    }

    /* Headings, in document order — the outline a crawler builds. */
    const headings: HeadingNode[] = [];
    const headingCounts: Record<string, number> = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
    const headingElements = doc.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const heading of headingElements) {
      const level = Number(heading.tagName.slice(1));
      headingCounts[`h${level}`] = (headingCounts[`h${level}`] ?? 0) + 1;
      if (headings.length >= o.max_headings) continue;
      // offsetParent is null for display:none and for position:fixed, so the
      // rect is checked too — a fixed header's h1 is visible, not hidden.
      const rect = heading.getBoundingClientRect?.();
      const hidden = (heading.offsetParent === null && (!rect || (rect.width === 0 && rect.height === 0))) || false;
      const text = flat(heading.textContent);
      headings.push({ level, text: elide(text, o.max_text), hidden, empty: text.length === 0 });
    }

    /* Images. A missing alt attribute and alt="" are different findings. */
    const imageElements = doc.querySelectorAll("img");
    const missingAlt: ImageNode[] = [];
    let missingAltTotal = 0;
    let emptyAlt = 0;
    let noDimensions = 0;
    let lazy = 0;
    for (const image of imageElements) {
      const src = flat(image.getAttribute("src") || image.getAttribute("data-src") || image.currentSrc);
      if (!image.hasAttribute("alt")) {
        missingAltTotal++;
        if (missingAlt.length < o.max_images) {
          const id = flat(image.getAttribute("id"));
          const cls = flat(image.getAttribute("class")).split(" ")[0];
          const description = id ? `#${id}` : cls ? `img.${cls}` : elide(src || "img", o.max_text);
          missingAlt.push({ src: elide(src, o.max_text), description });
        }
      } else if (flat(image.getAttribute("alt")) === "") {
        emptyAlt++;
      }
      if (!image.hasAttribute("width") || !image.hasAttribute("height")) noDimensions++;
      if (flat(image.getAttribute("loading")).toLowerCase() === "lazy") lazy++;
    }

    /* Structured data: collected raw, parsed in Node where a syntax error can be reported. */
    const scripts = doc.querySelectorAll('script[type="application/ld+json"], script[type="application/ld+json;charset=utf-8"]');
    const jsonld: JsonLdBlock[] = [];
    for (const script of scripts) {
      if (jsonld.length >= o.max_jsonld) break;
      const text = String(script.textContent ?? "");
      jsonld.push({
        text: text.length > o.max_jsonld_length ? text.slice(0, o.max_jsonld_length) : text,
        truncated: text.length > o.max_jsonld_length,
      });
    }

    /* Links out of the page. */
    const anchors = doc.querySelectorAll("a[href]");
    let internal = 0;
    let external = 0;
    let nofollow = 0;
    let emptyAnchors = 0;
    const origin = g.location?.origin;
    for (const anchor of anchors) {
      const href = flat(anchor.getAttribute("href"));
      const resolved = resolve(href);
      if (resolved) {
        try {
          if (new g.URL(resolved).origin === origin) internal++;
          else external++;
        } catch {
          /* not a URL we can classify */
        }
      }
      if (/\bnofollow\b/i.test(flat(anchor.getAttribute("rel")))) nofollow++;
      const label = flat(anchor.textContent) || flat(anchor.getAttribute("aria-label")) || flat(anchor.getAttribute("title"));
      if (!label && anchor.querySelector("img[alt]:not([alt=''])") === null) emptyAnchors++;
    }

    const bodyText = flat(doc.body?.innerText ?? "");

    return {
      url: String(g.location?.href ?? ""),
      title: doc.title === undefined || doc.title === null ? null : flat(doc.title),
      title_count: doc.querySelectorAll("title").length,
      lang: flat(doc.documentElement?.getAttribute("lang")),
      dir: flat(doc.documentElement?.getAttribute("dir")),
      charset,
      named,
      properties,
      http_equiv: httpEquiv,
      links,
      headings,
      heading_total: headingElements.length,
      heading_counts: headingCounts,
      images: {
        total: imageElements.length,
        missing_alt: missingAlt,
        missing_alt_total: missingAltTotal,
        empty_alt: emptyAlt,
        no_dimensions: noDimensions,
        lazy,
      },
      jsonld,
      jsonld_total: scripts.length,
      microdata: doc.querySelectorAll("[itemscope]").length,
      word_count: bodyText ? bodyText.split(" ").length : 0,
      anchors: { total: anchors.length, internal, external, nofollow, empty: emptyAnchors },
      dom_nodes: doc.getElementsByTagName("*").length,
    };
  }, opts);
}

/* ── robots.txt ───────────────────────────────────────────────────────── */

export interface RobotsFetch {
  url: string;
  status?: number;
  text?: string;
  /** Why there is no text: unreachable, timed out, or a protocol with no robots.txt. */
  error?: string;
}

/**
 * Fetch the origin's robots.txt.
 *
 * Through the browser context, so it goes out with the same cookies and proxy
 * settings as the page did. A 404 is not a failure — it is the answer "there
 * are no rules", which is what the rules module does with it.
 */
export async function fetchRobots(context: BrowserContext, pageUrl: string, timeoutMs = SEO_FETCH_TIMEOUT_MS): Promise<RobotsFetch> {
  let robotsUrl: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url: pageUrl, error: `${parsed.protocol}// has no robots.txt` };
    }
    robotsUrl = new URL("/robots.txt", parsed.origin).href;
  } catch (error) {
    return { url: pageUrl, error: firstLine(error) };
  }

  try {
    const response = await context.request.get(robotsUrl, { timeout: timeoutMs, failOnStatusCode: false });
    const status = response.status();
    if (status >= 400) return { url: robotsUrl, status };
    return { url: robotsUrl, status, text: await response.text() };
  } catch (error) {
    return { url: robotsUrl, error: firstLine(error) };
  }
}

/* ── The share image ──────────────────────────────────────────────────── */

export interface ImageProbe {
  url: string;
  ok: boolean;
  status?: number;
  content_type?: string;
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
  /** The image itself, when it is small enough to hand back to the client. */
  data?: Buffer;
}

/**
 * Fetch a share image and measure it.
 *
 * An `og:image` pointing at a 404, or at a 40x40 favicon, is invisible from
 * the page itself and shows up as a blank card on every network that renders
 * the link — which is exactly the sort of thing nobody notices until someone
 * shares the page. So it is fetched and measured rather than merely reported
 * as present.
 */
export async function probeImage(
  context: BrowserContext,
  url: string,
  timeoutMs = SEO_FETCH_TIMEOUT_MS,
  maxBytes = MAX_SEO_IMAGE_BYTES,
): Promise<ImageProbe> {
  try {
    const response = await context.request.get(url, { timeout: timeoutMs, failOnStatusCode: false });
    const status = response.status();
    const contentType = response.headers()["content-type"];
    const probe: ImageProbe = { url, ok: status < 400, status };
    if (contentType) probe.content_type = contentType;
    if (!probe.ok) return probe;

    const body = await response.body();
    probe.bytes = body.byteLength;
    try {
      const { width, height } = await getDimensions(body);
      probe.width = width;
      probe.height = height;
      if (body.byteLength <= maxBytes) probe.data = body;
    } catch (error) {
      // Reachable but not an image this build can decode (an SVG on a libvips
      // without librsvg, an HTML error page served as 200). Worth saying.
      probe.error = firstLine(error);
    }
    return probe;
  } catch (error) {
    return { url, ok: false, error: firstLine(error) };
  }
}

/* ── Performance ──────────────────────────────────────────────────────── */

export interface ResourceGroup {
  type: string;
  count: number;
  bytes: number;
}

export interface PerfMetrics {
  ttfb_ms?: number;
  dom_content_loaded_ms?: number;
  load_ms?: number;
  fcp_ms?: number;
  lcp_ms?: number;
  lcp_element?: string;
  cls?: number;
  long_tasks: number;
  requests: number;
  transfer_bytes: number;
  /** True when at least one resource reported a transferSize of 0 — see `readPerformance`. */
  transfer_incomplete: boolean;
  resources: ResourceGroup[];
}

/**
 * The observers that have to be running before the page loads.
 *
 * LCP, CLS and long tasks are only observable as they happen. `buffered: true`
 * covers the gap between document start and this script running, but nothing
 * covers a script that arrives after the event, so this goes in through
 * `addInitScript` before the first navigation.
 */
export const PERF_INIT_SCRIPT = (): void => {
  const g = globalThis as any;
  // Whole-page metrics: the main frame owns them.
  if (g.top && g.top !== g) return;
  if (g.__framewatch_seo_perf) return;
  const state = { lcp: 0, lcp_element: "", cls: 0, long_tasks: 0 };
  g.__framewatch_seo_perf = state;
  if (typeof g.PerformanceObserver !== "function") return;

  const describe = (element: any): string => {
    if (!element || !element.tagName) return "";
    const tag = String(element.tagName).toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const cls = element.classList && element.classList.length > 0 ? `.${element.classList[0]}` : "";
    return `${tag}${id}${cls}`;
  };

  const observe = (type: string, handle: (entries: any[]) => void): void => {
    try {
      new g.PerformanceObserver((list: any) => handle(list.getEntries())).observe({ type, buffered: true });
    } catch {
      // This browser does not report this entry type; the metric is simply absent.
    }
  };

  observe("largest-contentful-paint", (entries) => {
    for (const entry of entries) {
      // Each entry supersedes the last: LCP is the final one before interaction.
      state.lcp = entry.startTime;
      state.lcp_element = describe(entry.element);
    }
  });
  observe("layout-shift", (entries) => {
    for (const entry of entries) {
      // Shifts within 500ms of a real interaction are the user's doing, and
      // Chrome's CLS excludes them for the same reason.
      if (!entry.hadRecentInput) state.cls += entry.value;
    }
  });
  observe("longtask", (entries) => {
    state.long_tasks += entries.length;
  });
};

/**
 * Read the metrics back once the page has settled.
 *
 * Everything else — navigation timing, paint timing, resource weight — is
 * still in the performance buffer at this point and needs no observer.
 *
 * `transferSize` is 0 for a cross-origin resource that does not send
 * `Timing-Allow-Origin`, which is indistinguishable from a cached response, so
 * the total is reported alongside a flag saying it is a floor rather than a
 * total.
 */
export async function readPerformance(page: Page): Promise<PerfMetrics | undefined> {
  try {
    return await page.evaluate((): PerfMetrics => {
      const g = globalThis as any;
      const perf = g.performance;
      const state = g.__framewatch_seo_perf ?? { lcp: 0, lcp_element: "", cls: 0, long_tasks: 0 };
      const round = (value: unknown): number | undefined => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
      };

      const metrics: PerfMetrics = {
        long_tasks: state.long_tasks ?? 0,
        requests: 0,
        transfer_bytes: 0,
        transfer_incomplete: false,
        resources: [],
      };

      const nav = perf?.getEntriesByType?.("navigation")?.[0];
      if (nav) {
        metrics.ttfb_ms = round(nav.responseStart);
        metrics.dom_content_loaded_ms = round(nav.domContentLoadedEventEnd);
        metrics.load_ms = round(nav.loadEventEnd) || undefined;
        if (nav.transferSize > 0) metrics.transfer_bytes += nav.transferSize;
      }

      for (const paint of perf?.getEntriesByType?.("paint") ?? []) {
        if (paint.name === "first-contentful-paint") metrics.fcp_ms = round(paint.startTime);
      }
      if (state.lcp > 0) {
        metrics.lcp_ms = round(state.lcp);
        if (state.lcp_element) metrics.lcp_element = state.lcp_element;
      }
      if (typeof state.cls === "number") metrics.cls = Math.round(state.cls * 1000) / 1000;

      const byType = new Map<string, ResourceGroup>();
      for (const resource of perf?.getEntriesByType?.("resource") ?? []) {
        metrics.requests++;
        const size = Number(resource.transferSize) || 0;
        if (size === 0) metrics.transfer_incomplete = true;
        metrics.transfer_bytes += size;
        const type = String(resource.initiatorType || "other");
        const group = byType.get(type) ?? { type, count: 0, bytes: 0 };
        group.count++;
        group.bytes += size;
        byType.set(type, group);
      }
      metrics.resources = [...byType.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);

      return metrics;
    });
  } catch {
    // Cosmetic: a page that dies before this is read still gets its audit.
    return undefined;
  }
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0];
}
