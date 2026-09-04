import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, closeSession } from "../src/engine/browser.js";
import { interactInputSchema, performInteraction } from "../src/tools/interact.js";
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

type Block = { type: string; text?: string };
type Result = Awaited<ReturnType<typeof performInteraction>>;

const texts = (result: Result): string[] => (result.content as Block[]).filter((c) => c.type === "text").map((c) => c.text!);
/** The three text blocks in order: the summary, the before card, the after card. */
const parts = (result: Result): { summary: string; before: string; after: string } => {
  const [summary, before, after] = texts(result);
  return { summary, before, after };
};

const VIEWPORT = { width: 400, height: 300 };
const PAGE = (): string => `${fixtures.url}/interact-context.html`;

describe("performInteraction context layers", () => {
  it("attaches the console output an action caused to the after card, and the page's load output to the before card", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 300,
      viewport: VIEWPORT,
    });

    expect(result.isError).toBeFalsy();
    const { summary, before, after } = parts(result);

    expect(after).toContain("[log] go clicked");
    expect(after).toContain("[error] go exploded");
    // Said during page load, before the "before" frame was taken.
    expect(before).toContain("[log] fixture loaded");
    expect(before).not.toContain("go clicked");
    expect(summary).toContain("Context — console:");
  });

  it("collects console output by default and drops it when asked not to", async () => {
    const on = await performInteraction({ url: PAGE(), action: "click", selector: "#go", wait_ms: 300, viewport: VIEWPORT });
    expect(parts(on).after).toContain("go clicked");

    await closeSession();
    const off = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 300,
      viewport: VIEWPORT,
      include_console: false,
    });
    const { summary, after } = parts(off);
    expect(after).not.toContain("go clicked");
    expect(summary).not.toContain("Context —");
  });

  it("reports the network requests an action made, with method, url and status", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 500,
      viewport: VIEWPORT,
      include_network: true,
    });

    const { summary, after } = parts(result);
    expect(after).toContain("Network:");
    expect(after).toMatch(/GET \S+\/api\/ok → 200 \(\d+ms\)/);
    expect(summary).toContain("network:");
  });

  it("reports the DOM mutations an action caused", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 300,
      viewport: VIEWPORT,
      include_dom: true,
    });

    const { summary, after } = parts(result);
    expect(after).toContain("DOM:");
    expect(after).toContain("div.added");
    expect(after).toContain("#app");
    expect(summary).toContain("DOM:");
  });

  it("reports the layout shift an action caused", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 500,
      viewport: VIEWPORT,
      include_performance: true,
    });

    const { summary, after } = parts(result);
    expect(after).toContain("Performance:");
    expect(after).toMatch(/layout shifts [1-9]/);
    expect(summary).toContain("performance:");
  });

  it("reports only what this call caused, not what earlier calls on the same page did", async () => {
    const first = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 300,
      viewport: VIEWPORT,
      include_dom: true,
    });
    expect(parts(first).after).toContain("go clicked");

    // Same page, still open; this one says nothing and changes no structure.
    const second = await performInteraction({
      action: "hover",
      selector: "#quiet",
      wait_ms: 300,
      include_dom: true,
    });

    const { summary, before, after } = parts(second);
    expect(after).not.toContain("go clicked");
    expect(before).not.toContain("go clicked");
    expect(before).not.toContain("fixture loaded");
    expect(summary).toContain("console: silent");
    // The hover only adds a class, so there is a mutation, but not the click's.
    expect(after).not.toContain("div.added");
  });

  it("turns a layer on for a page that was already open, with no navigation", async () => {
    // First call installs nothing but the console layer...
    await performInteraction({ url: PAGE(), action: "hover", selector: "#quiet", wait_ms: 100, viewport: VIEWPORT });

    // ...and the second asks for DOM and performance on the document that is
    // already loaded, which an init script alone would never reach.
    const result = await performInteraction({
      action: "click",
      selector: "#go",
      wait_ms: 400,
      include_dom: true,
      include_performance: true,
    });

    const { after } = parts(result);
    expect(after).toContain("div.added");
    expect(after).toMatch(/layout shifts [1-9]/);
  });

  it("keeps collecting across a navigation within the same session", async () => {
    await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 200,
      viewport: VIEWPORT,
      include_dom: true,
    });

    // Navigate the same session page back to the fixture: the probe has to be
    // reinstalled by its init script in the new document.
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#go",
      wait_ms: 400,
      include_dom: true,
    });

    const { after } = parts(result);
    expect(after).toContain("go clicked");
    expect(after).toContain("div.added");
  });

  it("records each mutation once, not twice, when the probe is installed on a live page", async () => {
    await performInteraction({ url: PAGE(), action: "hover", selector: "#quiet", wait_ms: 100, viewport: VIEWPORT });

    const result = await performInteraction({ action: "click", selector: "#go", wait_ms: 400, include_dom: true });
    const { after } = parts(result);

    // The fixture appends exactly one div.added. A doubly-installed observer
    // would report it as "×2".
    const line = after.split("\n").find((text) => text.includes("div.added"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/×\s*[2-9]/);
  });

  it("still reports context when the action itself changed nothing on screen", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "hover",
      selector: "#app",
      wait_ms: 100,
      viewport: VIEWPORT,
    });

    const { summary, before } = parts(result);
    expect(result.isError).toBeFalsy();
    expect(summary).toContain("no visual change");
    // Nothing moved, but the page still said something on the way in.
    expect(summary).toContain("Context — console: 1 entry");
    expect(before).toContain("[log] fixture loaded");
  });
});

describe("interact input schema", () => {
  it("collects console output unless told otherwise, and nothing else by default", () => {
    const parsed = interactInputSchema.parse({ action: "click", selector: "#a" });
    expect(parsed.include_console).toBe(true);
    expect(parsed.include_network).toBe(false);
    expect(parsed.include_dom).toBe(false);
    expect(parsed.include_performance).toBe(false);
  });
});
