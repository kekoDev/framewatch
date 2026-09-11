import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { renderStyleChanges, type StyleSample } from "../src/engine/layers/styles.js";
import { capturePage } from "../src/tools/capture.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

const fixtures: FixtureServer = await startFixtureServer();

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

const sample = (timestamp_ms: number, values: StyleSample["values"]): StyleSample => ({ timestamp_ms, values });

describe("renderStyleChanges", () => {
  it("lists every watched value on the first card", () => {
    const first = sample(0, { logo: { opacity: "0", transform: "none" }, subtitle: { display: "none" } });
    expect(renderStyleChanges(undefined, first)).toBe("  logo: opacity 0, transform none\n  subtitle: display none");
  });

  it("lists only the values that changed since the previous card, with the old and the new", () => {
    const prev = sample(0, { logo: { opacity: "0", transform: "none" } });
    const curr = sample(500, { logo: { opacity: "0.5", transform: "none" } });
    expect(renderStyleChanges(prev, curr)).toBe("  logo: opacity 0 → 0.5");
  });

  it("says when nothing changed, and when a selector matched nothing", () => {
    const prev = sample(0, { logo: { opacity: "1" }, ghost: null });
    const curr = sample(500, { logo: { opacity: "1" }, ghost: null });
    expect(renderStyleChanges(prev, curr)).toBe("  logo: no change\n  ghost: selector matched nothing");
  });

  it("reports an element that appeared or disappeared between cards", () => {
    const prev = sample(0, { modal: null });
    const curr = sample(500, { modal: { opacity: "1" } });
    expect(renderStyleChanges(prev, curr)).toBe("  modal: appeared — opacity 1");
    expect(renderStyleChanges(curr, sample(900, { modal: null }))).toBe("  modal: gone");
  });

  it("returns undefined when there is no sample for the card", () => {
    expect(renderStyleChanges(undefined, undefined)).toBeUndefined();
  });
});

describe("framewatch_capture watch_styles", () => {
  it("attaches the watched values to the cards they belong to", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/splash.html`,
      duration_ms: 1600,
      sensitivity: 0.02,
      max_frames: 8,
      watch_styles: [
        { selector: "#logo", properties: ["opacity"], label: "logo" },
        { selector: "#subtitle", properties: ["display"] },
        { selector: "#nope", properties: ["opacity"], label: "ghost" },
      ],
    });

    expect(result.isError).toBeFalsy();
    const texts = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
    expect(texts[0]).toMatch(/styles: 3 elements watched, \d+ readings/);
    const cards = texts.filter((t) => /^Frame \d+ @/.test(t));
    // The first card carries the starting values; the logo is invisible at 0ms.
    expect(cards[0]).toMatch(/Styles:\n  logo: opacity 0\n  #subtitle: display none\n  ghost: selector matched nothing/);
    // Some later card saw the opacity move, as old → new.
    expect(cards.some((t) => /logo: opacity [\d.]+ → [\d.]+/.test(t))).toBe(true);
    // And the last one saw the subtitle appear.
    expect(cards[cards.length - 1]).toMatch(/#subtitle: display none → block|#subtitle: no change/);
  });

  it("rejects a watch with no properties", async () => {
    const result = await capturePage({
      url: `${fixtures.url}/basic.html`,
      duration_ms: 500,
      watch_styles: [{ selector: "#x", properties: [] }],
    });
    expect(result.isError).toBe(true);
  });
});
