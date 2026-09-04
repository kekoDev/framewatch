import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { closeBrowser, closeSession, getSessionPage, withSessionLock } from "../src/engine/browser.js";
import { componentOf, componentTree, detectVue, routerNavigate, waitForVueReady } from "../src/engine/vue.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await closeSession();
  await fixtures.close();
  await closeBrowser();
});

beforeEach(async () => {
  await closeSession();
});

const APP = (query = "") => `${fixtures.url}/vue-app.html${query}`;

/** Open the fixture on the session page and run `fn` against it, inside the lock like the tools. */
async function onApp<T>(query: string, fn: (page: Page) => Promise<T>): Promise<T> {
  return withSessionLock(async () => {
    const { page } = await getSessionPage({ viewport: { width: 800, height: 600 } });
    await page.goto(APP(query), { waitUntil: "load" });
    return fn(page);
  });
}

describe("detectVue", () => {
  it("finds the app, its version, the router and the current route", async () => {
    const info = await onApp("/login", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return detectVue(page);
    });
    expect(info).toMatchObject({ major: 3, router: true, production: false, route: { path: "/vue-app.html/login", name: "login" } });
    expect(info?.version).toMatch(/^3\./);
  });

  it("knows a production build when it sees one", async () => {
    const info = await onApp("?prod=1", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return detectVue(page);
    });
    expect(info?.production).toBe(true);
  });

  it("returns null on a page with no Vue", async () => {
    const info = await withSessionLock(async () => {
      const { page } = await getSessionPage();
      await page.goto(`${fixtures.url}/basic.html`);
      return detectVue(page);
    });
    expect(info).toBeNull();
  });
});

describe("waitForVueReady", () => {
  it("returns as soon as a late-mounting app is up, and says how long that took", async () => {
    const result = await onApp("?delay=400", (page) => waitForVueReady(page, { detect_ms: 3000, ready_ms: 2000 }));
    expect(result.vue).not.toBeNull();
    expect(result.waited_ms).toBeGreaterThanOrEqual(300);
    expect(result.waited_ms).toBeLessThan(2500);
  });

  it("gives up after detect_ms on a page with no Vue, without an error", async () => {
    const result = await withSessionLock(async () => {
      const { page } = await getSessionPage();
      await page.goto(`${fixtures.url}/basic.html`);
      return waitForVueReady(page, { detect_ms: 300, ready_ms: 1000 });
    });
    expect(result.vue).toBeNull();
    expect(result.waited_ms).toBeGreaterThanOrEqual(250);
  });
});

describe("componentOf", () => {
  it("reads the component name, props, state and ancestry off an element", async () => {
    const info = await onApp("/login", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return componentOf(page.locator("#submit"));
    });
    expect(info).toEqual({
      name: "LoginForm",
      props: { title: '"Welcome back"', max: "3" },
      state: { email: '""', password: '""', loading: "false", items: "[3]", submit: "fn" },
      path: ["RouterView", "App"],
    });
  });

  it("attributes an element inside a child component to that child", async () => {
    const info = await onApp("/login", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return componentOf(page.locator("#email input"));
    });
    expect(info).toMatchObject({ name: "BaseInput", props: { label: '"Email"', modelValue: '""' }, path: ["LoginForm", "RouterView", "App"] });
  });

  it("says so on a production build, and on an element outside the app", async () => {
    const prod = await onApp("?prod=1", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return componentOf(page.locator("#banner"));
    });
    expect(prod).toEqual({ unavailable: "production build — no component data on elements" });

    const outside = await withSessionLock(async () => {
      const { page } = await getSessionPage();
      await page.goto(`${fixtures.url}/basic.html`);
      return componentOf(page.locator("body"));
    });
    expect(outside).toBeNull();
  });
});

describe("componentTree", () => {
  it("walks the tree from the root, naming components and collapsing router built-ins", async () => {
    const tree = await onApp("/login", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return componentTree(page);
    });
    expect(tree).toEqual({
      total: 4,
      root: { name: "App", children: [{ name: "LoginForm", children: [{ name: "BaseInput", children: [] }, { name: "BaseInput", children: [] }] }] },
    });
  });
});

describe("routerNavigate", () => {
  it("pushes a route without reloading and reports where it ended", async () => {
    const result = await onApp("", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      await page.evaluate(() => {
        (globalThis as any).__marker = 1;
      });
      const outcome = await routerNavigate(page, "/vue-app.html/settings");
      const marker = await page.evaluate(() => (globalThis as any).__marker);
      const shown = await page.locator("#settings").count();
      return { outcome, marker, shown };
    });
    expect(result.outcome).toEqual({ ok: true, route: { path: "/vue-app.html/settings", name: "settings" } });
    // Same document: in-page state survived.
    expect(result.marker).toBe(1);
    expect(result.shown).toBe(1);
  });

  it("reports a route the router does not know", async () => {
    const outcome = await onApp("", async (page) => {
      await waitForVueReady(page, { detect_ms: 2000, ready_ms: 2000 });
      return routerNavigate(page, "/nowhere");
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no route|not matched|No match/i);
  });
});
