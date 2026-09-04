import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser, getBrowser, withPage } from "../src/engine/browser.js";

describe("browser lifecycle", () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it("launches lazily and reuses a single browser instance", async () => {
    const first = await getBrowser();
    const second = await getBrowser();
    expect(second).toBe(first);
    expect(first.isConnected()).toBe(true);
  });

  it("withPage runs the callback in a fresh context and closes it afterwards", async () => {
    const browser = await getBrowser();
    const before = browser.contexts().length;

    const result = await withPage({ viewport: { width: 500, height: 400 } }, async (page) => {
      await page.setContent("<h1>hi</h1>");
      expect(browser.contexts().length).toBe(before + 1);
      return page.viewportSize();
    });

    expect(result).toEqual({ width: 500, height: 400 });
    expect(browser.contexts().length).toBe(before);
  });

  it("withPage closes the context even when the callback throws", async () => {
    const browser = await getBrowser();
    const before = browser.contexts().length;

    await expect(
      withPage({}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(browser.contexts().length).toBe(before);
  });

  it("closeBrowser is idempotent and getBrowser relaunches afterwards", async () => {
    const first = await getBrowser();
    await closeBrowser();
    await closeBrowser();
    expect(first.isConnected()).toBe(false);

    const relaunched = await getBrowser();
    expect(relaunched).not.toBe(first);
    expect(relaunched.isConnected()).toBe(true);
  });
});

describe("browser crash recovery", () => {
  it("relaunches a fresh browser after the previous one disconnects unexpectedly", async () => {
    const first = await getBrowser();
    // Simulate a crash / external kill: close it behind the singleton's back.
    await first.close();
    expect(first.isConnected()).toBe(false);

    const second = await getBrowser();
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
    await closeBrowser();
  });

  it("does not let Playwright install its own SIGINT handler (the server owns shutdown)", async () => {
    const before = process.listenerCount("SIGINT");
    await closeBrowser();
    await getBrowser();
    expect(process.listenerCount("SIGINT")).toBe(before);
    await closeBrowser();
  });
});
