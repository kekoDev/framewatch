import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeBrowser, closeSession, getSessionPage, withSessionLock } from "../src/engine/browser.js";
import { takeSnapshot } from "../src/engine/snapshot.js";
import { performInteraction } from "../src/tools/interact.js";
import { snapshotPage } from "../src/tools/snapshot.js";
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

type Result = Awaited<ReturnType<typeof snapshotPage>>;
const texts = (result: Result): string[] => result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
const images = (result: Result) => result.content.filter((c) => c.type === "image");

const PAGE = () => `${fixtures.url}/snapshot.html`;
const VIEWPORT = { width: 800, height: 600 };

describe("takeSnapshot", () => {
  it("returns the aria tree with a ref on every element and counts what is interactive", async () => {
    const snapshot = await withSessionLock(async () => {
      const { page } = await getSessionPage({ viewport: VIEWPORT });
      await page.goto(PAGE());
      return takeSnapshot(page, { mode: "full", max_chars: 20_000 });
    });

    expect(snapshot.text).toMatch(/heading "Sign in" \[level=1\] \[ref=e\d+\]/);
    expect(snapshot.text).toMatch(/button "Sign in" \[ref=e\d+\]/);
    expect(snapshot.text).toMatch(/textbox "Email" \[ref=e\d+\]/);
    expect(snapshot.text).toMatch(/checkbox "Remember me" \[checked\] \[ref=e\d+\]/);
    // display:none is not in the accessibility tree.
    expect(snapshot.text).not.toContain("Not shown");
    // email, password, checkbox, button, two links, the pointer card.
    expect(snapshot.interactive).toBe(7);
    expect(snapshot.elements).toBeGreaterThan(snapshot.interactive);
    expect(snapshot.cut_lines).toBe(0);
  });

  it("flattens to the interactive elements only, with each link's url", async () => {
    const snapshot = await withSessionLock(async () => {
      const { page } = await getSessionPage({ viewport: VIEWPORT });
      await page.goto(PAGE());
      return takeSnapshot(page, { mode: "interactive", max_chars: 20_000 });
    });

    expect(snapshot.text).not.toContain("heading");
    expect(snapshot.text).not.toContain("paragraph");
    expect(snapshot.text.split("\n")).toHaveLength(7);
    expect(snapshot.text).toMatch(/^- link "Pricing" \[ref=e\d+\] \[cursor=pointer\] → \/pricing$/m);
  });

  it("scopes to a container and truncates to the budget", async () => {
    const { scoped, cut } = await withSessionLock(async () => {
      const { page } = await getSessionPage({ viewport: VIEWPORT });
      await page.goto(PAGE());
      return {
        scoped: await takeSnapshot(page, { selector: "#nav", mode: "full", max_chars: 20_000 }),
        cut: await takeSnapshot(page, { mode: "full", max_chars: 80 }),
      };
    });

    expect(scoped.text).toContain('link "Pricing"');
    expect(scoped.text).not.toContain("textbox");
    expect(scoped.interactive).toBe(2);

    expect(cut.text.length).toBeLessThanOrEqual(80);
    expect(cut.cut_lines).toBeGreaterThan(0);
  });
});

describe("snapshotPage", () => {
  it("opens the url and returns a header, how to use refs, then the tree", async () => {
    const result = await snapshotPage({ url: PAGE(), viewport: VIEWPORT });

    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toMatch(/^Snapshot of .*\/snapshot\.html — "FrameWatch Snapshot Fixture" — viewport 800x600 — \d+ elements, 7 interactive/);
    expect(text).toContain("framewatch_interact");
    expect(text).toContain("framewatch_inspect");
    expect(text).toContain('role=button[name="Sign in"]');
    expect(text).toMatch(/button "Sign in" \[ref=e\d+\]/);
    expect(images(result)).toHaveLength(0);
  });

  it("adds a screenshot when asked", async () => {
    const result = await snapshotPage({ url: PAGE(), viewport: VIEWPORT, include_screenshot: true });
    expect(images(result)).toHaveLength(1);
    expect(texts(result)[0]).toContain("images at full size");
  });

  it("refuses when no page is open and no url was given", async () => {
    const result = await snapshotPage({});
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("pass `url`");
  });

  it("reads the page the interact session left open, and says when lines were cut", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#submit", viewport: VIEWPORT });
    const result = await snapshotPage({ max_chars: 300 });

    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toContain("/snapshot.html");
    expect(text).toMatch(/\d+ more lines cut/);
  });

  it("shows what an interaction produced", async () => {
    await performInteraction({ url: PAGE(), action: "click", selector: "#submit", viewport: VIEWPORT });
    const result = await snapshotPage({ mode: "interactive" });
    expect(texts(result)[0]).toMatch(/button "Continue" \[ref=e\d+\]/);
  });

  it("reports invalid input as an error result", async () => {
    const result = await snapshotPage({ url: "not a url" });
    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("invalid input");
  });
});

describe("refs across tools", () => {
  it("lets interact act on a ref the snapshot named", async () => {
    const snapshot = await snapshotPage({ url: PAGE(), viewport: VIEWPORT, mode: "interactive" });
    const ref = /button "Sign in" \[ref=(e\d+)\]/.exec(texts(snapshot)[0])![1];

    const result = await performInteraction({ action: "click", ref, wait_ms: 100 });

    expect(result.isError).toBeFalsy();
    const headline = texts(result)[0];
    expect(headline).toContain(`click ${ref}`);
    const after = await snapshotPage({ mode: "interactive" });
    expect(texts(after)[0]).toContain('button "Continue"');
  });

  it("tells the caller to snapshot again when a ref does not resolve", async () => {
    await snapshotPage({ url: PAGE(), viewport: VIEWPORT });
    const result = await performInteraction({ action: "click", ref: "e999", timeout_ms: 500 });

    expect(result.isError).toBe(true);
    expect(texts(result)[0]).toContain("e999");
    expect(texts(result)[0]).toContain("framewatch_snapshot");
  });

  it("appends the new snapshot to an interaction when asked", async () => {
    const result = await performInteraction({
      url: PAGE(),
      action: "click",
      selector: "#submit",
      viewport: VIEWPORT,
      include_snapshot: true,
    });

    expect(result.isError).toBeFalsy();
    const last = texts(result).at(-1)!;
    expect(last).toMatch(/^Snapshot — \d+ elements, \d+ interactive/);
    expect(last).toMatch(/button "Continue" \[ref=e\d+\]/);
  });
});

describe("snapshotPage — Vue", () => {
  const APP = (query = "") => `${fixtures.url}/vue-app.html${query}`;

  it("waits for a late-mounting app instead of sleeping, and names the version and route", async () => {
    const started = Date.now();
    const result = await snapshotPage({ url: APP("/login?delay=400"), viewport: VIEWPORT, wait_ms: 3000, mode: "interactive" });
    const elapsed = Date.now() - started;

    expect(result.isError).toBeFalsy();
    const [text] = texts(result);
    expect(text).toMatch(/^Snapshot of .*\/vue-app\.html\/login\?delay=400 .* — Vue 3[\d.]+ — route \/vue-app\.html\/login\?delay=400 \(login\)/);
    expect(text).toMatch(/button "Sign in" \[ref=e\d+\]/);
    // Mounted at ~400ms; returned well before the 3000ms sleep would have.
    expect(elapsed).toBeLessThan(2500);
  });

  it("appends the component tree when asked", async () => {
    const result = await snapshotPage({ url: APP("/login"), viewport: VIEWPORT, include_components: true });
    const [text] = texts(result);
    expect(text).toContain("Components (4):");
    expect(text).toContain("  App\n    LoginForm\n      BaseInput ×2");
  });
});
