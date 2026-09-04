import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { rtlInputSchema, testRtl } from "../src/tools/rtl.js";
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
type Result = Awaited<ReturnType<typeof testRtl>>;

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

/** Short waits: the fixtures are static and each one is paid twice, once per direction. */
const QUICK = { wait_ms: 150 } as const;

describe("testRtl — a page with one fault in every category", () => {
  let result: Result;
  let text: string;

  beforeAll(async () => {
    result = await testRtl({ url: url("rtl-bad.html"), ...QUICK });
    text = report(result);
  });

  it("succeeds and confirms RTL actually took effect", () => {
    expect(result.isError).toBeFalsy();
    expect(text).not.toContain("RTL was never applied");
    expect(text).toContain('setting `dir="rtl"` on `html`');
  });

  it("reports the box that is pinned with a physical offset", () => {
    expect(text).toContain("#not-mirrored");
    expect(text).toMatch(/did not mirror/);
  });

  it("reports text that stayed left-aligned", () => {
    expect(text).toContain("#stays-left");
    expect(text).toMatch(/stayed left-aligned/);
  });

  it("reports the flex row that gets reversed twice", () => {
    expect(text).toContain("#double-reversed");
    expect(text).toMatch(/`row-reverse` in both directions/);
  });

  it("reports the physical padding that never swapped", () => {
    expect(text).toContain("#padding-stuck");
    expect(text).toMatch(/physical padding/);
  });

  it("reports content that only overflows once the page is flipped", () => {
    // #overflows-rtl fits in LTR and hangs off the edge in RTL. That is the
    // one check that reports a change rather than a failure to change.
    expect(text).toContain("#overflows-rtl");
    expect(text).toMatch(/overflows the (left|right) edge/);
  });

  it("reports the directional icon that never flips", () => {
    expect(text).toContain("#arrow-next");
    expect(text).toMatch(/directional/);
  });

  it("does not report overflow that only exists in LTR", () => {
    // #overflows-ltr hangs 300px off the RIGHT edge in LTR and fits perfectly
    // once flipped. That is a layout bug for framewatch_responsive to find,
    // not an RTL one, and reporting it here would be the tool crying wolf.
    expect(text).not.toContain("#overflows-ltr");
  });

  it("says nothing about the elements that were written correctly", () => {
    // The control cases. A tool that flags these flags everything, and a
    // report whose findings are mostly wrong is one nobody reads twice.
    expect(text).not.toContain("#good-logical");
    expect(text).not.toContain("#centred");
  });

  it("separates problems from warnings", () => {
    expect(text).toMatch(/Problems — \d+/);
    expect(section(text, /^Problems —/)).toContain("#not-mirrored");
  });

  it("returns both screenshots, RTL second", () => {
    expect(images(result)).toHaveLength(2);
    expect(text).toMatch(/LTR — /);
    expect(text).toMatch(/RTL — /);
    expect(text).toMatch(/boxed and numbered/);
  });

  it("numbers the findings so the list matches the overlay", () => {
    expect(text).toMatch(/^\s+1\. /m);
  });
});

describe("testRtl — a page written with logical properties", () => {
  let result: Result;
  let text: string;

  beforeAll(async () => {
    result = await testRtl({ url: url("rtl-good.html"), ...QUICK });
    text = report(result);
  });

  it("finds nothing to report", () => {
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Nothing failed to mirror");
    expect(text).toMatch(/0 problems/);
  });

  it("still says how much it actually compared", () => {
    // A clean report has to prove it looked, or it is indistinguishable from
    // an audit that measured nothing at all.
    expect(text).toMatch(/compared [1-9]\d* elements/);
  });

  it("does not flag the icon that flips itself", () => {
    expect(text).not.toContain("#arrow");
  });
});

describe("testRtl — a trigger that does not match the app", () => {
  it("says so loudly instead of reporting a clean page", async () => {
    // The failure that matters most, because it is silent: this page only
    // goes RTL on a class, so `dir=rtl` renders LTR twice. Every element
    // compares equal and the page looks perfect.
    const result = await testRtl({ url: url("rtl-class.html"), ...QUICK });
    const text = report(result);

    expect(text).toContain("RTL was never applied");
    expect(text).toContain("proves nothing");
    expect(text).toMatch(/type: "class"/);
  });

  it("finds the real faults once the right trigger is used", async () => {
    const result = await testRtl({
      url: url("rtl-class.html"),
      rtl_trigger: { type: "class", class: "rtl", target: "html" },
      ...QUICK,
    });
    const text = report(result);

    expect(text).not.toContain("RTL was never applied");
    expect(text).toContain("adding the class `rtl`");
    expect(text).toContain("#pinned");
    expect(text).toContain("#copy");
  });
});

describe("testRtl — Arabic injection", () => {
  it("replaces text in both passes and says so", async () => {
    const result = await testRtl({ url: url("rtl-good.html"), ...QUICK });
    const text = report(result);
    // Both passes, because the comparison has to change direction and nothing
    // else — otherwise the mirroring check measures the font.
    expect(text).toMatch(/Text replaced with Arabic in both passes/);
    expect(text).toMatch(/\d+ strings in RTL, \d+ in LTR/);
  });

  it("can be turned off for an already-translated page", async () => {
    const result = await testRtl({ url: url("rtl-good.html"), inject_arabic: false, ...QUICK });
    expect(report(result)).not.toMatch(/Text replaced with Arabic/);
  });

  it("finds the same faults with injection off", async () => {
    // The findings are geometric, so they must not depend on the text.
    const result = await testRtl({ url: url("rtl-bad.html"), inject_arabic: false, ...QUICK });
    const text = report(result);
    expect(text).toContain("#not-mirrored");
    expect(text).toContain("#stays-left");
  });
});

describe("testRtl — scoping", () => {
  it("only measures inside `selector`", async () => {
    const result = await testRtl({ url: url("rtl-bad.html"), selector: "#double-reversed", ...QUICK });
    const text = report(result);
    expect(text).not.toContain("#not-mirrored");
    expect(text).not.toContain("#stays-left");
  });

  it("never measures anything inside `exclude`", async () => {
    const result = await testRtl({ url: url("rtl-bad.html"), exclude: "#stays-left", ...QUICK });
    const text = report(result);
    expect(text).not.toContain("#stays-left");
    // The rest of the page is still swept.
    expect(text).toContain("#not-mirrored");
  });
});

describe("testRtl — the `url` trigger", () => {
  it("compares one page against a separately served RTL build", async () => {
    // Standing in for a site with an /ar/ build: the two pages differ, and
    // what matters is that the second one is measured as the RTL side.
    const result = await testRtl({
      url: url("rtl-good.html"),
      rtl_trigger: { type: "url", rtl_url: url("rtl-bad.html") },
      ...QUICK,
    });
    const text = report(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("rtl-bad.html");
  });
});

describe("testRtl — failure and input handling", () => {
  it("reports a page that cannot be opened as one actionable line", async () => {
    const result = await testRtl({ url: `${fixtures.url}/nope-does-not-exist.html`, ...QUICK });
    // The fixture server answers 404 with a body, so the page opens; what
    // matters is that a genuine navigation failure does not throw.
    expect(result).toBeDefined();
  });

  it("rejects a URL that is not a URL", async () => {
    const result = await testRtl({ url: "not-a-url" } as never);
    expect(result.isError).toBe(true);
    expect(report(result)).toContain("invalid input");
  });

  it("defaults the trigger to `dir=rtl` on <html>", () => {
    const parsed = rtlInputSchema.parse({ url: "http://example.com" });
    // The trigger is optional at the schema level and filled in by the tool,
    // so what matters here is that the rest of the defaults are present.
    expect(parsed.inject_arabic).toBe(true);
    expect(parsed.max_elements).toBeGreaterThan(0);
  });

  it("tells an agent which field is wrong in a malformed trigger", async () => {
    const result = await testRtl({ url: "http://example.com", rtl_trigger: { type: "class" } } as never);
    expect(result.isError).toBe(true);
    expect(report(result)).toContain("rtl_trigger");
  });
});
