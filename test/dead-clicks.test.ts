import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { deadClicksInputSchema, findDeadClicks } from "../src/tools/dead-clicks.js";
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
type Result = Awaited<ReturnType<typeof findDeadClicks>>;

const report = (result: Result): string =>
  (result.content as Block[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
const images = (result: Result): Block[] => (result.content as Block[]).filter((block) => block.type === "image");
const url = (file: string): string => `${fixtures.url}/${file}`;

/** The block of lines under one heading, so a name can be tested against the right section. */
const section = (text: string, heading: RegExp): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line === "");
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

/** Short waits everywhere: the fixture reacts instantly and each element costs `settle_ms`. */
const QUICK = { wait_ms: 150, settle_ms: 300 } as const;

describe("findDeadClicks — a page with four dead controls on it", () => {
  let swept: Result;
  let text: string;

  beforeAll(async () => {
    swept = await findDeadClicks({ url: url("dead-clicks.html"), ...QUICK });
    text = report(swept);
  });

  it("finds every element that did nothing, and no others", () => {
    const dead = section(text, /^Dead —/);

    expect(swept.isError).toBeFalsy();
    expect(dead).toContain("#dead-hash");
    expect(dead).toContain("#dead-button");
    expect(dead).toContain("#dead-div");
    expect(dead).toContain("#dead-hover");
    expect(dead).not.toContain("#alive");
    expect(text).toMatch(/4 dead/);
  });

  it("reports the one whose handler threw separately from the ones that did nothing", () => {
    const broken = section(text, /^Broken —/);

    expect(broken).toContain("#alive-throw");
    expect(broken).toMatch(/TypeError/);
    expect(section(text, /^Dead —/)).not.toContain("#alive-throw");
  });

  it("says what each of the live ones actually did, one channel at a time", () => {
    const alive = section(text, /^Alive —/);

    expect(alive).toMatch(/#alive-dom.*DOM change/);
    expect(alive).toMatch(/#alive-net.*request/);
    expect(alive).toMatch(/#alive-store.*localStorage/);
    expect(alive).toMatch(/#alive-scroll.*scrolled/);
    expect(alive).toMatch(/#alive-field.*field/);
    expect(alive).toMatch(/#alive-link.*went to/);
  });

  it("counts a link to '#' as dead, however much the address bar changed", () => {
    // Clicking <a href="#"> puts a bare '#' in the URL and does nothing else.
    expect(section(text, /^Dead —/)).toContain("#dead-hash");
    expect(text).toContain('its href is "#"');
  });

  it("separates a dead control that lights up under the pointer from one that does not", () => {
    expect(text).toMatch(/#dead-hover\)\n\s+Looks clickable:[^\n]*hovering it changes background/);
    expect(text).toMatch(/#dead-button\)\n\s+Looks clickable:[^\n]*hovering it changes nothing/);
  });

  it("says a dead <div> had nothing but a pointer cursor to suggest it was a control", () => {
    expect(text).toMatch(/#dead-div\)\n\s+Looks clickable: it is a plain element styled with a pointer cursor/);
  });

  it("never clicks another site, a mail client, or something that is disabled", () => {
    const untouched = section(text, /^Not clicked/);

    expect(untouched).toContain("links to another site (https://example.com)");
    expect(untouched).toContain("hands the click to mailto");
    expect(untouched).toMatch(/#disabled.*disabled/);
  });

  it("flags a control that claims to be unavailable and works anyway", () => {
    const lying = section(text, /^Marked aria-disabled/);

    expect(lying).toContain("#aria-off");
    // Listed once, in its own section, rather than twice.
    expect(section(text, /^Alive —/)).not.toContain("#aria-off");
  });

  it("comes back with the page, marked up", () => {
    expect(images(swept)).toHaveLength(1);
    expect(text).toContain("boxed in red");
  });
});

describe("findDeadClicks — a page that will not sit still", () => {
  let text: string;

  beforeAll(async () => {
    // A clock rewriting itself every 100ms and a fetch every 200ms, with
    // nobody touching the page.
    text = report(await findDeadClicks({ url: url("dead-clicks-noisy.html"), ...QUICK }));
  });

  it("says out loud that the page changes on its own", () => {
    expect(text).toMatch(/changes on its own — .*DOM changes.*requests/);
  });

  it("still tells the dead control from the live one underneath the churn", () => {
    expect(section(text, /^Dead —/)).toContain("#noisy-dead");
    expect(section(text, /^Alive —/)).toContain("#noisy-alive");
    expect(text).toMatch(/1 dead/);
  });
});

describe("findDeadClicks — keeping it away from things", () => {
  it("leaves anything matching `exclude` alone", async () => {
    const text = report(
      await findDeadClicks({ url: url("dead-clicks.html"), exclude: "#danger", selector: "section", ...QUICK }),
    );

    expect(section(text, /^Not clicked/)).toMatch(/#danger.*excluded/);
  });

  it("sweeps only what is inside `selector`", async () => {
    const text = report(
      await findDeadClicks({ url: url("dead-clicks.html"), selector: "section:nth-of-type(2)", ...QUICK }),
    );

    expect(text).toContain("#dead-button");
    expect(text).not.toContain("#alive-dom");
  });

  it("stops at `max_elements` and says which element it stopped at", async () => {
    const text = report(await findDeadClicks({ url: url("dead-clicks.html"), max_elements: 2, ...QUICK }));

    expect(text).toMatch(/past `max_elements` \(2\)/);
    expect(text).toContain("#alive-store");
  });

  it("can be told to ignore pointer styling, which is the noisiest signal", async () => {
    const text = report(
      await findDeadClicks({
        url: url("dead-clicks.html"),
        selector: "section:nth-of-type(2)",
        include_pointer: false,
        ...QUICK,
      }),
    );

    expect(text).toContain("#dead-button");
    expect(text).not.toContain("#dead-div");
  });

  it("can be told to skip the hover check", async () => {
    const text = report(
      await findDeadClicks({
        url: url("dead-clicks.html"),
        selector: "section:nth-of-type(2)",
        include_hover: false,
        ...QUICK,
      }),
    );

    expect(text).toContain("#dead-button");
    expect(text).not.toMatch(/hovering it/);
  });
});

describe("findDeadClicks — failures", () => {
  it("rejects input that cannot be acted on", async () => {
    const result = await findDeadClicks({ url: "not-a-url" });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("invalid input");
  });

  it("says so when nothing on the page looks clickable at all", async () => {
    const result = await findDeadClicks({ url: url("basic.html"), ...QUICK });

    expect(result.isError).toBe(true);
    expect(report(result)).toMatch(/nothing on this page looks clickable/);
  });

  it("names the selector when nothing inside it looks clickable", async () => {
    const result = await findDeadClicks({ url: url("dead-clicks.html"), selector: "h1", ...QUICK });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("`h1`");
  });

  it("reports a page it could not open", async () => {
    const result = await findDeadClicks({
      url: url("missing.html"),
      wait_for: "#nothing",
      wait_for_timeout_ms: 800,
    });

    expect(result.isError).toBe(true);
    expect(report(result)).toContain("#nothing");
  });
});

describe("deadClicksInputSchema", () => {
  it("defaults to a sweep that checks hover and pointer-styled elements", () => {
    const parsed = deadClicksInputSchema.parse({ url: "http://localhost:3000" });

    expect(parsed.include_hover).toBe(true);
    expect(parsed.include_pointer).toBe(true);
    expect(parsed.settle_ms).toBe(500);
    expect(parsed.max_elements).toBe(40);
    expect(parsed.full_page).toBe(false);
  });

  it("refuses to click more elements than the cap allows", () => {
    expect(deadClicksInputSchema.safeParse({ url: "http://localhost:3000", max_elements: 500 }).success).toBe(false);
  });
});
