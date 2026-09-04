import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, closeSession } from "../src/engine/browser.js";
import { snapshotPage } from "../src/tools/snapshot.js";
import { waitFor } from "../src/tools/wait-for.js";
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

type Result = Awaited<ReturnType<typeof waitFor>>;
const texts = (result: Result): string[] => result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
const images = (result: Result) => result.content.filter((c) => c.type === "image");

const APP = (query = "") => `${fixtures.url}/vue-app.html${query}`;
const VIEWPORT = { width: 800, height: 600 };

describe("framewatch_wait_for — hot_update", () => {
  it("returns when Vite's hot update lands after the last look, with the file and the timing", async () => {
    // The banner changes and the hot-update line is logged 600ms after load;
    // the snapshot is the "last look", so the update is newer than it.
    await snapshotPage({ url: APP("?hmr=600"), viewport: VIEWPORT, wait_ms: 0 });
    const result = await waitFor({ until: "hot_update", timeout_ms: 5000 });

    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toMatch(/^Hot update landed after \d+ms: \/src\/App\.vue/);
    expect(text).toContain("Vue 3");
    expect(images(result)).toHaveLength(1);
  });

  it("does not count an update that landed before the last look", async () => {
    await snapshotPage({ url: APP("?hmr=50"), viewport: VIEWPORT, wait_ms: 0 });
    // Let the update fire, then look again: it is now older than the last look.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await snapshotPage({});
    const result = await waitFor({ until: "hot_update", timeout_ms: 600 });

    expect(result.isError).toBe(true);
    const [text] = texts(result);
    expect(text).toContain("No hot update within 600ms");
    expect(text).toMatch(/last one landed \d+ms before this call/);
  });

  it("counts a css-only update and a full reload", async () => {
    await snapshotPage({ url: APP("?css=300"), viewport: VIEWPORT, wait_ms: 0 });
    const css = await waitFor({ until: "hot_update", timeout_ms: 3000, include_screenshot: false });
    expect(texts(css)[0]).toMatch(/^Hot update landed after \d+ms \(css\)/);
    expect(images(css)).toHaveLength(0);

    await closeSession();
    await snapshotPage({ url: APP("?reload=300"), viewport: VIEWPORT, wait_ms: 0 });
    const reload = await waitFor({ until: "hot_update", timeout_ms: 5000 });
    expect(texts(reload)[0]).toMatch(/^Full reload landed after \d+ms/);
  });

  it("says when the page has no Vite connection at all", async () => {
    await snapshotPage({ url: `${fixtures.url}/basic.html`, viewport: VIEWPORT });
    const result = await waitFor({ until: "hot_update", timeout_ms: 400 });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("no Vite dev-server connection");
  });

  it("appends a fresh snapshot when asked", async () => {
    await snapshotPage({ url: APP("?hmr=200"), viewport: VIEWPORT, wait_ms: 0 });
    const result = await waitFor({ until: "hot_update", timeout_ms: 3000, include_snapshot: true });
    const last = texts(result).at(-1)!;
    expect(last).toMatch(/^Snapshot — \d+ elements/);
    expect(last).toContain('"Version 2"');
  });
});

describe("framewatch_wait_for — other conditions", () => {
  it("vue_ready waits for a late-mounting app and its router", async () => {
    const result = await waitFor({ url: APP("?delay=500"), until: "vue_ready", timeout_ms: 5000, viewport: VIEWPORT });
    expect(result.isError).toBeFalsy();
    expect(texts(result)[0]).toMatch(/^Vue ready after \d+ms — Vue 3[\d.]+ — route \/vue-app\.html\?delay=500 \(home\)/);
  });

  it("selector waits for an element to appear", async () => {
    const result = await waitFor({ url: APP("/login?delay=300"), until: "selector", selector: "#submit", timeout_ms: 5000, viewport: VIEWPORT });
    expect(result.isError).toBeFalsy();
    expect(texts(result)[0]).toMatch(/^"#submit" appeared after \d+ms/);
  });

  it("network_idle waits for the page to go quiet", async () => {
    const result = await waitFor({ url: APP(), until: "network_idle", timeout_ms: 5000, viewport: VIEWPORT });
    expect(result.isError).toBeFalsy();
    expect(texts(result)[0]).toMatch(/^Network idle after \d+ms/);
  });

  it("times out with the condition named", async () => {
    const result = await waitFor({ url: APP(), until: "selector", selector: "#never", timeout_ms: 400, viewport: VIEWPORT });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain('"#never" did not appear within 400ms');
  });

  it("refuses when no page is open and no url was given", async () => {
    const result = await waitFor({ until: "vue_ready" });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("pass `url`");
  });
});
