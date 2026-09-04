import { describe, expect, it } from "vitest";
import type { CheckOutcome } from "../src/engine/links.js";
import {
  classifyHref,
  dedupeKey,
  isAlwaysValidFragment,
  isInternal,
  judgeCheck,
  statusText,
} from "../src/utils/link-rules.js";

const BASE = "https://example.com/shop/item?id=1";

/* ── What an href is, before anything is fetched ──────────────────────── */

describe("classifyHref", () => {
  it("resolves a relative link against the page it was found on", () => {
    expect(classifyHref("../cart", BASE)).toMatchObject({ kind: "http", resolved: "https://example.com/cart" });
  });

  it("resolves a protocol-relative URL with the page's own scheme", () => {
    expect(classifyHref("//cdn.example.com/app.js", BASE)).toMatchObject({
      kind: "http",
      resolved: "https://cdn.example.com/app.js",
    });
  });

  it("trims the whitespace a hand-written href picks up", () => {
    expect(classifyHref("  /about  ", BASE)).toMatchObject({ kind: "http", resolved: "https://example.com/about" });
  });

  it("keeps a fragment on a link to another page, and says what it is", () => {
    expect(classifyHref("/help#returns", BASE)).toMatchObject({
      kind: "http",
      resolved: "https://example.com/help#returns",
      fragment: "returns",
    });
  });

  it("calls a link into this same page a fragment, not a request", () => {
    expect(classifyHref("#pricing", BASE)).toMatchObject({ kind: "same_page", fragment: "pricing" });
  });

  it("treats a bare # as a link to the top of the page", () => {
    expect(classifyHref("#", BASE)).toMatchObject({ kind: "same_page", fragment: "" });
  });

  it("recognises a link that only re-states the page's own address", () => {
    expect(classifyHref("item?id=1", BASE)).toMatchObject({ kind: "same_page" });
  });

  it("calls an empty href what it is — a link to the current page", () => {
    expect(classifyHref("", BASE).kind).toBe("empty");
  });

  it("separates the schemes a browser hands to something else", () => {
    expect(classifyHref("mailto:hi@example.com", BASE)).toMatchObject({ kind: "mailto" });
    expect(classifyHref("tel:+15551234", BASE)).toMatchObject({ kind: "tel" });
    expect(classifyHref("javascript:void(0)", BASE)).toMatchObject({ kind: "javascript" });
    expect(classifyHref("data:image/png;base64,iVBOR", BASE)).toMatchObject({ kind: "data" });
    expect(classifyHref("ftp://files.example.com/x", BASE)).toMatchObject({ kind: "scheme", scheme: "ftp" });
  });

  it("flags a mailto: with no address behind it", () => {
    expect(classifyHref("mailto:", BASE).reason).toMatch(/no address/i);
  });

  it("calls an href that is not a URL malformed rather than throwing", () => {
    expect(classifyHref("http://", BASE).kind).toBe("malformed");
    expect(classifyHref("https://exa mple.com/ ]", BASE).kind).toBe("malformed");
  });

  it("survives a base URL it cannot parse", () => {
    expect(classifyHref("/about", "not a url").kind).toBe("malformed");
  });
});

/* ── Which requests are the same request ──────────────────────────────── */

describe("dedupeKey", () => {
  it("counts two links that differ only by fragment as one request", () => {
    expect(dedupeKey("https://example.com/a#one")).toBe(dedupeKey("https://example.com/a#two"));
  });

  it("keeps the query string, which is part of what was asked for", () => {
    expect(dedupeKey("https://example.com/a?x=1")).not.toBe(dedupeKey("https://example.com/a?x=2"));
  });

  it("does not conflate a path with its trailing-slash form — they redirect differently", () => {
    expect(dedupeKey("https://example.com/a")).not.toBe(dedupeKey("https://example.com/a/"));
  });
});

describe("isInternal", () => {
  it("is true only for the same scheme, host and port", () => {
    expect(isInternal("https://example.com/a", "https://example.com")).toBe(true);
    expect(isInternal("https://cdn.example.com/a", "https://example.com")).toBe(false);
    expect(isInternal("http://example.com/a", "https://example.com")).toBe(false);
    expect(isInternal("https://example.com:8443/a", "https://example.com")).toBe(false);
  });
});

describe("isAlwaysValidFragment", () => {
  it("accepts the two fragments every browser resolves without an element", () => {
    expect(isAlwaysValidFragment("")).toBe(true);
    expect(isAlwaysValidFragment("top")).toBe(true);
    expect(isAlwaysValidFragment("TOP")).toBe(true);
    expect(isAlwaysValidFragment("pricing")).toBe(false);
  });
});

/* ── What the answer means ────────────────────────────────────────────── */

const outcome = (over: Partial<CheckOutcome> = {}): CheckOutcome => ({
  chain: ["https://example.com/a"],
  method: "HEAD",
  ...over,
});

describe("judgeCheck", () => {
  it("passes a plain 200", () => {
    const verdict = judgeCheck(outcome({ status: 200 }));
    expect(verdict.category).toBe("ok");
    expect(verdict.detail).toContain("200 OK");
    expect(verdict.hops).toBe(0);
  });

  it("calls a 404 broken and names it", () => {
    const verdict = judgeCheck(outcome({ status: 404 }));
    expect(verdict.category).toBe("broken");
    expect(verdict.detail).toContain("404 Not Found");
  });

  it("calls a 500 broken", () => {
    expect(judgeCheck(outcome({ status: 503 })).category).toBe("broken");
  });

  it("reports a single redirect that lands somewhere real as a redirect, not a failure", () => {
    const verdict = judgeCheck(outcome({ chain: ["https://example.com/a", "https://example.com/b"], status: 200 }));
    expect(verdict.category).toBe("redirect");
    expect(verdict.hops).toBe(1);
    expect(verdict.detail).toContain("https://example.com/b");
  });

  it("says so when a link is written as http and has to be upgraded", () => {
    const verdict = judgeCheck(outcome({ chain: ["http://example.com/a", "https://example.com/a"], status: 200 }));
    expect(verdict.category).toBe("redirect");
    expect(verdict.detail).toMatch(/https/i);
    expect(verdict.fix).toMatch(/https/i);
  });

  it("flags a chain of hops rather than treating it as one redirect", () => {
    const verdict = judgeCheck(
      outcome({ chain: ["https://example.com/a", "https://example.com/b", "https://example.com/c"], status: 200 }),
    );
    expect(verdict.hops).toBe(2);
    expect(verdict.fix).toMatch(/hop|chain/i);
  });

  it("calls a redirect that ends on an error page broken, and says it redirected first", () => {
    const verdict = judgeCheck(outcome({ chain: ["https://example.com/a", "https://example.com/gone"], status: 404 }));
    expect(verdict.category).toBe("broken");
    expect(verdict.detail).toContain("404");
    expect(verdict.detail).toMatch(/redirect/i);
  });

  it("prints a status nobody standardised as the bare number", () => {
    expect(judgeCheck(outcome({ status: 999 })).detail).toMatch(/^999 —/);
  });

  it("does not call a link the server refused to answer broken", () => {
    expect(judgeCheck(outcome({ status: 401 })).category).toBe("blocked");
    expect(judgeCheck(outcome({ status: 403 })).category).toBe("blocked");
    expect(judgeCheck(outcome({ status: 429 })).category).toBe("blocked");
    expect(judgeCheck(outcome({ status: 999 })).category).toBe("blocked");
  });

  it("explains a 429 as the check being rate-limited rather than the link being dead", () => {
    expect(judgeCheck(outcome({ status: 429 })).detail).toMatch(/rate|too many/i);
  });

  it("says when even a GET was refused with a 405", () => {
    expect(judgeCheck(outcome({ status: 405, method: "GET" })).category).toBe("blocked");
    expect(judgeCheck(outcome({ status: 405, method: "GET" })).detail).toMatch(/GET/);
  });

  it("calls a redirect with nowhere to go broken", () => {
    const verdict = judgeCheck(outcome({ status: 302 }));
    expect(verdict.category).toBe("broken");
    expect(verdict.detail).toMatch(/Location/i);
  });

  it("detects a redirect loop from the chain itself", () => {
    const verdict = judgeCheck(
      outcome({ chain: ["https://example.com/a", "https://example.com/b", "https://example.com/a"], status: 302 }),
    );
    expect(verdict.category).toBe("error");
    expect(verdict.detail).toMatch(/loop/i);
  });

  it("reports a chain that never ended", () => {
    const verdict = judgeCheck(outcome({ chain: ["https://example.com/a", "https://example.com/b"], hops_exceeded: true }));
    expect(verdict.category).toBe("error");
    expect(verdict.detail).toMatch(/redirect/i);
  });

  it("separates a timeout from every other kind of failure", () => {
    const verdict = judgeCheck(outcome({ error: "apiRequestContext.head: Timeout 5000ms exceeded" }));
    expect(verdict.category).toBe("timeout");
  });

  it("turns the errors a link check actually hits into something readable", () => {
    expect(judgeCheck(outcome({ error: "getaddrinfo ENOTFOUND nope.invalid" })).detail).toMatch(/resolve/i);
    expect(judgeCheck(outcome({ error: "connect ECONNREFUSED 127.0.0.1:1" })).detail).toMatch(/listening|refused/i);
    expect(judgeCheck(outcome({ error: "socket hang up" })).detail).toMatch(/closed|hang/i);
    expect(judgeCheck(outcome({ error: "self-signed certificate in chain" })).detail).toMatch(/certificate/i);
  });

  it("keeps an error it has no phrase for rather than dropping it", () => {
    expect(judgeCheck(outcome({ error: "something nobody predicted" })).detail).toContain("something nobody predicted");
  });
});

describe("statusText", () => {
  it("names the statuses a report prints", () => {
    expect(statusText(200)).toBe("OK");
    expect(statusText(301)).toBe("Moved Permanently");
    expect(statusText(404)).toBe("Not Found");
  });

  it("invents no name for a status nobody standardised", () => {
    // 999 is what a couple of large sites answer to automated checks. Calling
    // it "999 non-standard" reads worse than calling it 999.
    expect(statusText(999)).toBe("");
  });
});
