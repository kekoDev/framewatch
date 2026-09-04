import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import {
  NO_NOISE,
  describeClickable,
  describeNoise,
  diffPageState,
  discoverClickables,
  installClickWatcher,
  measureNoise,
  probeHover,
  readPageState,
  resetClickWatcher,
  resolveClickable,
  sameUrl,
  type ClickEvidence,
  type Clickable,
  type PageState,
} from "../src/engine/clicks.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

/* ── The verdict, with no browser anywhere near it ────────────────────── */

const state = (over: Partial<PageState> = {}): PageState => ({
  url: "http://app.test/page",
  doc: "document-1",
  watching: true,
  mutations: 0,
  changes: [],
  elements: 120,
  fields: 111,
  storage: 222,
  scroll_x: 0,
  scroll_y: 0,
  title: "App",
  ...over,
});

const evidence = (over: Partial<ClickEvidence> = {}): ClickEvidence => ({
  console: [],
  network: [],
  dialogs: [],
  popups: [],
  downloads: [],
  focus_self: true,
  ...over,
});

const request = (url: string, status = 200) => ({
  method: "GET",
  url,
  status,
  duration_ms: 12,
  timestamp_ms: 40,
});

const logged = (level: "log" | "warn" | "error" | "info", text: string) => ({ level, text, timestamp_ms: 40 });

const kinds = (effects: Array<{ kind: string }>): string[] => effects.map((effect) => effect.kind);

describe("diffPageState — a click that did nothing", () => {
  it("reports no effects at all when every channel stayed silent", () => {
    expect(diffPageState(state(), state())).toEqual([]);
  });

  it("does not count a bare '#' appearing in the URL as going anywhere", () => {
    // Clicking <a href="#"> appends a '#' to the address. Counting that as a
    // navigation would report every dead link there is as working.
    const effects = diffPageState(state(), state({ url: "http://app.test/page#" }));

    expect(effects).toEqual([]);
  });
});

describe("diffPageState — what a click can do", () => {
  it("reports a navigation, and stops comparing two different documents", () => {
    const after = state({ url: "http://app.test/next", doc: "document-2", elements: 40, fields: 9, title: "Next" });
    const effects = diffPageState(state(), after);

    expect(kinds(effects)).toEqual(["navigated"]);
    expect(effects[0].detail).toContain("http://app.test/next");
  });

  it("tells a reload apart from a navigation", () => {
    const effects = diffPageState(state(), state({ doc: "document-2" }));

    expect(kinds(effects)).toEqual(["reloaded"]);
  });

  it("names what changed in the DOM, not just how much", () => {
    const after = state({ mutations: 3, changes: ["+ div.modal in #app"] });
    const effects = diffPageState(state(), after);

    expect(kinds(effects)).toEqual(["dom"]);
    expect(effects[0].detail).toContain("+ div.modal in #app");
  });

  it("reports a field, storage, scroll, title or focus change on its own", () => {
    expect(kinds(diffPageState(state(), state({ fields: 999 })))).toEqual(["fields"]);
    expect(kinds(diffPageState(state(), state({ storage: 999 })))).toEqual(["storage"]);
    expect(kinds(diffPageState(state(), state({ scroll_y: 400 })))).toEqual(["scroll"]);
    expect(kinds(diffPageState(state(), state({ title: "Changed" })))).toEqual(["title"]);
    expect(kinds(diffPageState(state(), state(), evidence({ focus_self: false })))).toEqual(["focus"]);
  });

  it("ignores a scroll of a pixel or two, which is layout rounding rather than a jump", () => {
    expect(diffPageState(state(), state({ scroll_y: 2 }))).toEqual([]);
  });

  it("counts a dialog, a popup and a download as things that happened", () => {
    const effects = diffPageState(
      state(),
      state(),
      evidence({ dialogs: ["alert: saved"], popups: ["http://app.test/tab"], downloads: ["report.csv"] }),
    );

    expect(kinds(effects)).toEqual(["dialog", "popup", "download"]);
  });

  it("falls back to the element count when the observer never installed", () => {
    const before = state({ watching: false });
    const effects = diffPageState(before, state({ watching: false, elements: 130 }));

    expect(kinds(effects)).toEqual(["dom"]);
    expect(effects[0].detail).toContain("gained 10");
  });

  it("puts a handler that threw at the top, ahead of everything else it did", () => {
    const effects = diffPageState(
      state(),
      state({ mutations: 2, changes: ["~ button#save [class]"] }),
      evidence({ console: [logged("error", "TypeError: rows is undefined")] }),
    );

    expect(kinds(effects)[0]).toBe("error");
    expect(kinds(effects)).toContain("dom");
  });

  it("separates a handler that only wrote to the console from one that threw", () => {
    const effects = diffPageState(state(), state(), evidence({ console: [logged("log", "clicked")] }));

    expect(kinds(effects)).toEqual(["console"]);
  });
});

describe("diffPageState — a page that will not sit still", () => {
  const noise = measureNoise(
    state(),
    state({ mutations: 6, changes: ["~ text in div#clock"] }),
    evidence({ network: [request("http://app.test/api/poll")], console: [logged("log", "tick")] }),
  );

  it("collects what the page does by itself, described rather than counted", () => {
    expect(noise.changes).toEqual(["~ text in div#clock"]);
    expect(noise.network).toEqual(["http://app.test/api/poll"]);
    expect(noise.console).toEqual(["tick"]);
  });

  it("never declares the DOM, network or console unusable — those are filtered by content", () => {
    // Two windows of the same length never catch the same number of clock
    // ticks, so a count cannot decide this; what changed can.
    expect(noise.unstable).not.toContain("dom");
    expect(noise.unstable).not.toContain("network");
    expect(noise.unstable).not.toContain("console");
  });

  it("stays quiet about a click that only repeated the page's own churn", () => {
    const after = state({ mutations: 9, changes: ["~ text in div#clock"] });
    const effects = diffPageState(
      after,
      after,
      evidence({ network: [request("http://app.test/api/poll")], console: [logged("log", "tick")] }),
      noise,
    );

    expect(effects).toEqual([]);
  });

  it("still finds the one change the page does not make on its own", () => {
    const after = state({ mutations: 9, changes: ["~ text in div#clock", "+ div#banner in body"] });
    const effects = diffPageState(state(), after, evidence(), noise);

    expect(kinds(effects)).toEqual(["dom"]);
    expect(effects[0].detail).toContain("+ div#banner in body");
    expect(effects[0].detail).not.toContain("div#clock");
  });

  it("drops a signal that fired with nobody clicking, since it can prove nothing", () => {
    const restless = measureNoise(state(), state({ scroll_y: 300 }), evidence());
    expect(restless.unstable).toContain("scroll");

    expect(diffPageState(state(), state({ scroll_y: 300 }), evidence(), restless)).toEqual([]);
  });

  it("keeps the signals no page produces by accident, however restless it is", () => {
    const restless = { ...NO_NOISE, unstable: ["navigated", "dialog", "error"] as never };
    const effects = diffPageState(state(), state({ url: "http://app.test/next" }), evidence(), restless);

    expect(kinds(effects)).toEqual(["navigated"]);
  });
});

describe("describeNoise", () => {
  it("says nothing about a page that is actually still", () => {
    expect(describeNoise(NO_NOISE)).toBeUndefined();
  });

  it("describes what a restless one is up to", () => {
    const noise = measureNoise(
      state(),
      state({ mutations: 4, changes: ["~ text in div#clock"] }),
      evidence({ network: [request("http://app.test/api/poll")] }),
    );

    expect(describeNoise(noise)).toBe("4 DOM changes, 1 request");
  });
});

describe("sameUrl", () => {
  it("treats a trailing empty fragment as the same place", () => {
    expect(sameUrl("http://app.test/p", "http://app.test/p#")).toBe(true);
  });

  it("does not treat a real fragment as the same place", () => {
    expect(sameUrl("http://app.test/p", "http://app.test/p#pricing")).toBe(false);
  });
});

describe("describeClickable", () => {
  it("names an element by its text", () => {
    expect(describeClickable({ tag: "button", text: "Save", kind: "button", selector: "#save" })).toBe('button "Save"');
  });

  it("falls back to where a link points when it has no text of its own", () => {
    expect(describeClickable({ tag: "a", text: "", kind: "link", href: "http://app.test/x", selector: "a" })).toBe(
      "a → http://app.test/x",
    );
  });

  it("falls back to the selector for anything else", () => {
    expect(describeClickable({ tag: "div", text: "", kind: "pointer", selector: "div.card" })).toBe("div div.card");
  });
});

/* ── Finding the candidates, on a real page ───────────────────────────── */

async function onPage<T>(file: string, fn: (page: Page) => Promise<T>): Promise<T> {
  return withPage({ viewport: { width: 900, height: 700 } }, async (page) => {
    await page.goto(`${fixtures.url}/${file}`, { waitUntil: "load" });
    return fn(page);
  });
}

const named = (found: Clickable[]): string[] => found.map((item) => item.description);
const usable = (found: Clickable[]): Clickable[] => found.filter((item) => item.skip === undefined);

describe("discoverClickables", () => {
  let found: Clickable[];

  beforeAll(async () => {
    found = await onPage("dead-clicks-shapes.html", (page) => discoverClickables(page));
  });

  it("finds a plain element that only a pointer cursor makes clickable", () => {
    const card = usable(found).find((item) => item.kind === "pointer");

    expect(card?.description).toContain("A card that is its own button");
  });

  it("keeps only the element the pointer style starts at, not every descendant of it", () => {
    // `cursor` is inherited, so the card's h3 and p compute to `pointer` too —
    // a card with a heading and a paragraph in it is one button, not three.
    expect(found.filter((item) => item.kind === "pointer")).toHaveLength(1);
    expect(found.map((item) => item.tag)).not.toContain("h3");
    expect(found.map((item) => item.tag)).not.toContain("p");
  });

  it("drops a pointer wrapper around a real link, and keeps the link", () => {
    expect(named(found)).toContain('a "A link inside a pointer wrapper"');
    expect(named(found).some((name) => name.startsWith("div") && name.includes("pointer wrapper"))).toBe(false);
  });

  it("drops a pointer-styled span inside a button, and keeps the button", () => {
    expect(named(found)).toContain('button "A span inside a button"');
    expect(named(found).some((name) => name.startsWith("span"))).toBe(false);
  });

  it("finds elements made clickable by a role or an onclick attribute", () => {
    const byRole = found.find((item) => item.selector === "#by-role");
    const byHandler = found.find((item) => item.selector === "#by-handler");

    expect(byRole?.kind).toBe("role");
    expect(byRole?.role).toBe("button");
    expect(byHandler?.kind).toBe("handler");
  });

  it("addresses two elements with no ids apart, so each is clicked rather than one of them twice", async () => {
    const rows = found.filter((item) => item.description.endsWith('row"'));
    expect(rows).toHaveLength(2);

    // Neither has an id, so both are addressed by a generated path. Whether
    // they are told apart by the path or by the index within it does not
    // matter; that each one resolves back to itself does.
    const texts = await onPage("dead-clicks-shapes.html", async (page) =>
      Promise.all(
        rows.map(async (row) => {
          const handle = await resolveClickable(page, row);
          return handle?.evaluate((node: any) => String(node.textContent));
        }),
      ),
    );
    expect(texts).toEqual(["First row", "Second row"]);
  });

  it("refuses to click what a user could not click either", () => {
    const reason = (selector: string): string | undefined => found.find((item) => item.selector === selector)?.skip;

    expect(reason("#invisible")).toBe("not visible");
    expect(reason("#sizeless")).toBe("has no size on screen");
    expect(reason("#download")).toBe("downloads a file");
  });

  it("clicks a javascript: link, which is the one most likely to be dead", () => {
    expect(found.find((item) => item.selector === "#js-href")?.skip).toBeUndefined();
  });

  it("leaves other people's sites alone", async () => {
    const external = await onPage("dead-clicks.html", async (page) => {
      const all = await discoverClickables(page);
      return all.find((item) => item.selector === "#external");
    });

    expect(external?.skip).toContain("links to another site");
    expect(external?.skip).toContain("https://example.com");
  });

  it("stays inside `selector`, and out of `exclude`", async () => {
    const [inside, excluded] = await onPage("dead-clicks.html", async (page) => [
      await discoverClickables(page, { selector: "#rows, section:nth-of-type(2)" }),
      await discoverClickables(page, { exclude: "#danger" }),
    ]);

    expect(named(inside)).toContain('button "Save draft"');
    expect(named(inside)).not.toContain('button "Show panel"');
    expect(excluded.find((item) => item.selector === "#danger")?.skip).toBe("excluded");
  });

  it("can be told to ignore pointer styling altogether", async () => {
    const semantic = await onPage("dead-clicks-shapes.html", (page) =>
      discoverClickables(page, { include_pointer: false }),
    );

    expect(semantic.some((item) => item.kind === "pointer")).toBe(false);
    expect(named(semantic)).toContain('button "A span inside a button"');
  });
});

describe("the in-page watcher", () => {
  it("counts and describes what changed, and forgets it when reset", async () => {
    const readings = await onPage("dead-clicks.html", async (page) => {
      await installClickWatcher(page);
      await resetClickWatcher(page);
      await page.click("#alive-dom");
      const after = await readPageState(page);
      await resetClickWatcher(page);
      const cleared = await readPageState(page);
      return { after, cleared };
    });

    expect(readings.after?.watching).toBe(true);
    expect(readings.after?.mutations).toBeGreaterThan(0);
    expect(readings.after?.changes.join(" ")).toContain("div#panel");
    expect(readings.cleared?.mutations).toBe(0);
    expect(readings.cleared?.changes).toEqual([]);
  });

  it("keeps watching across a navigation, and says the document is a new one", async () => {
    const [first, second] = await onPage("dead-clicks.html", async (page) => {
      await installClickWatcher(page);
      const before = await readPageState(page);
      await page.goto(`${fixtures.url}/basic.html`, { waitUntil: "load" });
      return [before, await readPageState(page)];
    });

    expect(first?.doc).not.toBe("");
    expect(second?.doc).not.toBe(first?.doc);
    expect(second?.watching).toBe(true);
  });
});

describe("probeHover", () => {
  it("names what the page changes when the pointer is over an element", async () => {
    const probe = await onPage("dead-clicks.html", async (page) => {
      const handle = await page.$("#dead-hover");
      return probeHover(page, handle!, { settle_ms: 80 });
    });

    expect(probe.cursor).toBe("pointer");
    expect(probe.changed).toContain("background");
    expect(probe.changed).toContain("text colour");
  });

  it("says so when nothing at all happens under the pointer", async () => {
    const probe = await onPage("dead-clicks.html", async (page) => {
      const handle = await page.$("#dead-button");
      return probeHover(page, handle!, { settle_ms: 80 });
    });

    expect(probe.changed).toEqual([]);
    expect(probe.failed).toBeUndefined();
  });
});
