import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import {
  describeInteraction,
  executeInteraction,
  needsTouch,
  validateInteraction,
  type Interaction,
} from "../src/engine/interaction.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
});

const VIEWPORT = { width: 400, height: 300 };

/** Open interactive.html and run `fn` against it. `touch` enables a touch-capable context. */
async function onFixture<T>(fn: (page: Page) => Promise<T>, touch = false): Promise<T> {
  return withPage({ viewport: VIEWPORT, contextOptions: touch ? { hasTouch: true } : {} }, async (page) => {
    await page.goto(`${fixtures.url}/interactive.html`, { waitUntil: "load" });
    return fn(page);
  });
}

/** Open login.html (a real form) and run `fn` against it. */
async function onLogin<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return withPage({ viewport: VIEWPORT }, async (page) => {
    await page.goto(`${fixtures.url}/login.html`, { waitUntil: "load" });
    return fn(page);
  });
}

/** Everything the fixture page recorded, in order. */
function events(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __events: string[] }).__events);
}

describe("executeInteraction click", () => {
  it("clicks the element matching `selector`", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "click", selector: "#btn" });
      return events(page);
    });
    expect(log).toContain("click");
  });

  it("clicks at `x`,`y` when no selector is given", async () => {
    const log = await onFixture(async (page) => {
      // #btn covers 20,20 → 140,60.
      await executeInteraction(page, { action: "click", x: 80, y: 40 });
      return events(page);
    });
    expect(log).toContain("click");
  });

  it("reports the selector and the timeout when the element never appears", async () => {
    const error = await onFixture(async (page) => {
      return executeInteraction(page, { action: "click", selector: "#nope" }, { timeout_ms: 300 }).catch((e: Error) => e);
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("#nope");
    expect((error as Error).message).toContain("300ms");
    // One actionable line, not Playwright's multi-line call log.
    expect((error as Error).message).not.toContain("\n");
  });
});

describe("executeInteraction hover", () => {
  it("moves the pointer over the element so it receives mouseenter", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "hover", selector: "#hover" });
      return events(page);
    });
    expect(log).toContain("hover");
  });
});

describe("executeInteraction type", () => {
  it("puts `value` into the element matching `selector` and fires an input event", async () => {
    const { log, value } = await onFixture(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#text", value: "hello@example.com" });
      return { log: await events(page), value: await page.inputValue("#text") };
    });
    expect(value).toBe("hello@example.com");
    expect(log).toContain("input:hello@example.com");
  });

  it("replaces existing text rather than appending to it", async () => {
    const value = await onFixture(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#text", value: "first" });
      await executeInteraction(page, { action: "type", selector: "#text", value: "second" });
      return page.inputValue("#text");
    });
    expect(value).toBe("second");
  });

  it("types into the focused element when no selector is given", async () => {
    const value = await onFixture(async (page) => {
      await page.focus("#text");
      await executeInteraction(page, { action: "type", value: "focused" });
      return page.inputValue("#text");
    });
    expect(value).toBe("focused");
  });
});

describe("executeInteraction key", () => {
  it("presses the named key on whatever is focused", async () => {
    const log = await onFixture(async (page) => {
      await page.focus("#text");
      await executeInteraction(page, { action: "key", value: "Enter" });
      return events(page);
    });
    expect(log).toContain("key:Enter");
  });

  it("presses a modifier combo", async () => {
    const log = await onFixture(async (page) => {
      await page.focus("#text");
      await executeInteraction(page, { action: "key", value: "Control+a" });
      return events(page);
    });
    expect(log).toContain("key:Control+a");
  });

  it("focuses `selector` first when one is given, so the key goes to that element", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "key", selector: "#text", value: "Backspace" });
      return events(page);
    });
    expect(log).toContain("key:Backspace");
  });

  it("submits a form when Enter is pressed in one of its fields", async () => {
    const log = await onLogin(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#email", value: "a@b.c" });
      await executeInteraction(page, { action: "type", selector: "#password", value: "secret" });
      await executeInteraction(page, { action: "key", value: "Enter" });
      return events(page);
    });
    expect(log).toContain("submit:a@b.c");
  });

  it("reports an unknown key name in one actionable line", async () => {
    const error = await onFixture(async (page) => {
      return executeInteraction(page, { action: "key", value: "NotAKey" }).catch((e: Error) => e);
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("NotAKey");
    expect((error as Error).message).not.toContain("\n");
  });
});

describe("executeInteraction type with special keys", () => {
  it("presses Enter for a `\n` in the value, submitting the form it was typed into", async () => {
    const { log, email } = await onLogin(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#email", value: "a@b.c" });
      await executeInteraction(page, { action: "type", selector: "#password", value: "secret\n" });
      return { log: await events(page), email: await page.inputValue("#email") };
    });
    // The newline is a key press, never text: the field holds the password alone.
    expect(email).toBe("a@b.c");
    expect(log).toContain("submit:a@b.c");
  });

  it("keeps the text before and after a `\n` out of the key press", async () => {
    const value = await onFixture(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#text", value: "one\ntwo" });
      return page.inputValue("#text");
    });
    expect(value).toBe("onetwo");
  });

  it("presses Tab for a `\t`, moving focus to the next field", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#text", value: "abc\t" });
      return events(page);
    });
    expect(log).toContain("key:Tab");
    expect(log).toContain("focus:echo");
  });

  it("presses the key in the field named by `selector` even when the value is only a newline", async () => {
    const log = await onLogin(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#email", value: "a@b.c" });
      await executeInteraction(page, { action: "type", selector: "#password", value: "secret" });
      await executeInteraction(page, { action: "type", selector: "#password", value: "\n" });
      return events(page);
    });
    expect(log).toContain("submit:a@b.c");
  });

  it("still replaces the field's contents rather than appending when the value has a newline", async () => {
    const value = await onFixture(async (page) => {
      await executeInteraction(page, { action: "type", selector: "#text", value: "first" });
      await executeInteraction(page, { action: "type", selector: "#text", value: "second\n" });
      return page.inputValue("#text");
    });
    expect(value).toBe("second");
  });
});

describe("executeInteraction select", () => {
  it("selects the option whose value is `value` and fires a change event", async () => {
    const { log, value } = await onFixture(async (page) => {
      await executeInteraction(page, { action: "select", selector: "#sel", value: "b" });
      return { log: await events(page), value: await page.inputValue("#sel") };
    });
    expect(value).toBe("b");
    expect(log).toContain("change:b");
  });
});

describe("executeInteraction scroll", () => {
  it("scrolls the page by `delta_y`", async () => {
    const scrollY = await onFixture(async (page) => {
      await executeInteraction(page, { action: "scroll", delta_y: 400 });
      await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 2000 });
      return page.evaluate(() => window.scrollY);
    });
    expect(scrollY).toBeGreaterThanOrEqual(300);
  });

  it("scrolls the element under `selector` instead of the page when one is given", async () => {
    const { boxTop, pageTop } = await onFixture(async (page) => {
      await executeInteraction(page, { action: "scroll", selector: "#box", delta_y: 200 });
      await page.waitForFunction(() => document.getElementById("box")!.scrollTop > 0, null, { timeout: 2000 });
      return {
        boxTop: await page.evaluate(() => document.getElementById("box")!.scrollTop),
        pageTop: await page.evaluate(() => window.scrollY),
      };
    });
    expect(boxTop).toBeGreaterThan(0);
    expect(pageTop).toBe(0);
  });
});

describe("executeInteraction tap", () => {
  it("sends a real touch to the element matching `selector`", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "tap", selector: "#touch" });
      return events(page);
    }, true);
    expect(log).toContain("touchstart");
    expect(log).toContain("up");
  });

  it("sends a real touch at `x`,`y` when no selector is given", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "tap", x: 280, y: 140 });
      return events(page);
    }, true);
    expect(log).toContain("touchstart");
    expect(log.some((e) => e.startsWith("down:280,140"))).toBe(true);
  });

  it("explains that tap needs a touch-enabled context rather than leaking Playwright's wording", async () => {
    const error = await onFixture(async (page) => {
      return executeInteraction(page, { action: "tap", x: 280, y: 140 }).catch((e: Error) => e);
    });
    expect((error as Error).message).toMatch(/touch/i);
  });
});

describe("executeInteraction swipe", () => {
  it("drags a touch point from `x`,`y` by `delta_x`,`delta_y` with intermediate move events", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "swipe", x: 300, y: 150, delta_x: -200, delta_y: 0 });
      return events(page);
    }, true);

    expect(log.some((e) => e.startsWith("down:300,150"))).toBe(true);
    const moves = log.filter((e) => e.startsWith("move:"));
    // A swipe is a drag, not a jump: the page must see it travel.
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(moves[moves.length - 1]).toBe("move:100,150");
    expect(log[log.length - 1]).toBe("up");
  });

  it("moves diagonally when both deltas are given", async () => {
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "swipe", x: 100, y: 100, delta_x: 100, delta_y: 60 });
      return events(page);
    }, true);
    const moves = log.filter((e) => e.startsWith("move:"));
    expect(moves[moves.length - 1]).toBe("move:200,160");
  });
});

describe("executeInteraction navigate", () => {
  it("navigates the page to `value`", async () => {
    const url = await onFixture(async (page) => {
      await executeInteraction(page, { action: "navigate", value: `${fixtures.url}/recorder-target.html` });
      return page.url();
    });
    expect(url).toBe(`${fixtures.url}/recorder-target.html`);
  });

  it("resolves relative URLs against the current page", async () => {
    const url = await onFixture(async (page) => {
      await executeInteraction(page, { action: "navigate", value: "recorder-target.html" });
      return page.url();
    });
    expect(url).toBe(`${fixtures.url}/recorder-target.html`);
  });
});

describe("executeInteraction wait", () => {
  it("waits for delay_ms and leaves the page untouched", async () => {
    const started = Date.now();
    const log = await onFixture(async (page) => {
      await executeInteraction(page, { action: "wait", delay_ms: 250 });
      return events(page);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(log).toEqual([]);
  });
});

describe("executeInteraction delay_ms", () => {
  it("waits before performing the action, not after", async () => {
    const clickedAt = await onFixture(async (page) => {
      const started = Date.now();
      await executeInteraction(page, { action: "click", selector: "#btn", delay_ms: 200 });
      const at = await page.evaluate(() => (window as unknown as { __events: string[] }).__events.length);
      return { elapsed: Date.now() - started, count: at };
    });
    expect(clickedAt.count).toBe(1);
    expect(clickedAt.elapsed).toBeGreaterThanOrEqual(190);
  });
});

describe("validateInteraction", () => {
  const ok = (i: Interaction) => validateInteraction(i) === null;

  it("accepts the documented shapes", () => {
    expect(ok({ action: "click", selector: "#a" })).toBe(true);
    expect(ok({ action: "click", x: 1, y: 2 })).toBe(true);
    expect(ok({ action: "tap", selector: "#a" })).toBe(true);
    expect(ok({ action: "tap", x: 1, y: 2 })).toBe(true);
    expect(ok({ action: "hover", selector: "#a" })).toBe(true);
    expect(ok({ action: "type", selector: "#a", value: "x" })).toBe(true);
    expect(ok({ action: "type", value: "x" })).toBe(true);
    expect(ok({ action: "select", selector: "#a", value: "x" })).toBe(true);
    expect(ok({ action: "scroll", delta_y: 100 })).toBe(true);
    expect(ok({ action: "scroll", delta_x: 100 })).toBe(true);
    expect(ok({ action: "swipe", x: 1, y: 2, delta_x: 10 })).toBe(true);
    expect(ok({ action: "navigate", value: "http://localhost/" })).toBe(true);
    expect(ok({ action: "wait", delay_ms: 100 })).toBe(true);
    expect(ok({ action: "key", value: "Enter" })).toBe(true);
    expect(ok({ action: "key", selector: "#a", value: "Enter" })).toBe(true);
  });

  it("names the missing field for each incomplete shape", () => {
    expect(validateInteraction({ action: "click" })).toMatch(/selector.*x.*y|x.*y.*selector/is);
    expect(validateInteraction({ action: "click", x: 1 })).toMatch(/y/);
    expect(validateInteraction({ action: "hover" })).toMatch(/selector/);
    expect(validateInteraction({ action: "type" })).toMatch(/value/);
    expect(validateInteraction({ action: "select", selector: "#a" })).toMatch(/value/);
    expect(validateInteraction({ action: "select", value: "a" })).toMatch(/selector/);
    expect(validateInteraction({ action: "scroll" })).toMatch(/delta/);
    expect(validateInteraction({ action: "swipe", delta_x: 1 })).toMatch(/x.*y|y.*x/is);
    expect(validateInteraction({ action: "swipe", x: 1, y: 2 })).toMatch(/delta/);
    expect(validateInteraction({ action: "navigate" })).toMatch(/value/);
    expect(validateInteraction({ action: "key" })).toMatch(/value/);
    expect(validateInteraction({ action: "key", value: "" })).toMatch(/value/);
  });

  it("is enforced by executeInteraction, which never touches the page for an invalid step", async () => {
    const { error, log } = await onFixture(async (page) => {
      const error = await executeInteraction(page, { action: "click" }).catch((e: Error) => e);
      return { error, log: await events(page) };
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/selector/);
    expect(log).toEqual([]);
  });
});

describe("needsTouch", () => {
  it("is true when any step is a tap or a swipe, false otherwise", () => {
    expect(needsTouch([{ action: "click", selector: "#a" }])).toBe(false);
    expect(needsTouch([{ action: "click", selector: "#a" }, { action: "tap", x: 1, y: 1 }])).toBe(true);
    expect(needsTouch([{ action: "swipe", x: 1, y: 1, delta_x: 5 }])).toBe(true);
    expect(needsTouch([])).toBe(false);
  });
});

describe("describeInteraction", () => {
  it("renders a one-line, human-readable summary of each action", () => {
    expect(describeInteraction({ action: "click", selector: "#submit" })).toBe('click "#submit"');
    expect(describeInteraction({ action: "click", x: 10, y: 20 })).toBe("click at 10,20");
    expect(describeInteraction({ action: "tap", selector: "#a" })).toBe('tap "#a"');
    expect(describeInteraction({ action: "hover", selector: "#a" })).toBe('hover "#a"');
    expect(describeInteraction({ action: "type", selector: "#email", value: "a@b.c" })).toBe('type "a@b.c" into "#email"');
    expect(describeInteraction({ action: "type", value: "a" })).toBe('type "a"');
    expect(describeInteraction({ action: "select", selector: "#s", value: "b" })).toBe('select "b" in "#s"');
    expect(describeInteraction({ action: "scroll", delta_y: 400 })).toBe("scroll by 0,400");
    expect(describeInteraction({ action: "scroll", selector: "#box", delta_y: 200 })).toBe('scroll "#box" by 0,200');
    expect(describeInteraction({ action: "swipe", x: 300, y: 150, delta_x: -200 })).toBe("swipe at 300,150 by -200,0");
    expect(describeInteraction({ action: "navigate", value: "http://x/" })).toBe("navigate to http://x/");
    expect(describeInteraction({ action: "wait", delay_ms: 300 })).toBe("wait 300ms");
    expect(describeInteraction({ action: "key", value: "Enter" })).toBe('press "Enter"');
    expect(describeInteraction({ action: "key", selector: "#email", value: "Enter" })).toBe('press "Enter" in "#email"');
  });

  it("does not print a password-sized value in full", () => {
    const long = "x".repeat(200);
    const text = describeInteraction({ action: "type", selector: "#p", value: long });
    expect(text.length).toBeLessThan(120);
    expect(text).toContain("…");
  });
});
