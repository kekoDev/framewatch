import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import sharp from "sharp";
import { closeBrowser, withPage } from "../src/engine/browser.js";
import { FrameRecorder, recordFrames } from "../src/engine/recorder.js";
import type { RawFrame } from "../src/types.js";
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

describe("recordFrames", () => {
  it("records valid PNG frames of the viewport at the default interval, with ascending timestamps", async () => {
    const started = Date.now();
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1000, interval_ms: 100 });
    });
    const elapsed = Date.now() - started;

    expect(result.frames.length).toBeGreaterThanOrEqual(6);
    expect(result.dropped).toBe(0);

    for (const frame of result.frames) {
      const meta = await sharp(frame.buffer).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(VIEWPORT.width);
      expect(meta.height).toBe(VIEWPORT.height);
      expect(frame.is_interaction).toBe(false);
      expect(frame.trigger).toBeUndefined();
    }

    const timestamps = result.frames.map((f) => f.timestamp_ms);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
    expect(timestamps[0]).toBeLessThan(50);
    // The final frame is captured on stop(), so it lands at (or after) the requested duration.
    expect(timestamps[timestamps.length - 1]).toBeGreaterThanOrEqual(950);

    expect(result.duration_ms).toBeGreaterThanOrEqual(950);
    expect(result.duration_ms).toBeLessThanOrEqual(elapsed);
  });
});

describe("recordFrames interval", () => {
  it("honours a custom interval_ms (250ms → roughly 4-5 interval frames plus the final frame in 1s)", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1000, interval_ms: 250 });
    });

    expect(result.frames.length).toBeGreaterThanOrEqual(4);
    expect(result.frames.length).toBeLessThanOrEqual(7);

    // Interval frames (all but the final stop() frame) are spaced by the interval, never bunched.
    const timestamps = result.frames.map((f) => f.timestamp_ms);
    for (let i = 1; i < timestamps.length - 1; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(200);
    }
  });
});

async function pixelAt(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe("recordFrames content", () => {
  it("captures frames that reflect the page changing over time (white → black at 500ms)", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "commit" });
      return recordFrames(page, { duration_ms: 1200, interval_ms: 100 });
    });

    const early = result.frames.find((f) => f.timestamp_ms < 300);
    const late = result.frames.find((f) => f.timestamp_ms >= 900);
    expect(early).toBeDefined();
    expect(late).toBeDefined();
    expect(await pixelAt(early!.buffer, 200, 150)).toEqual([255, 255, 255]);
    expect(await pixelAt(late!.buffer, 200, 150)).toEqual([0, 0, 0]);
  });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("FrameRecorder.captureNow", () => {
  it("inserts an out-of-band interaction frame at the right timestamp and keeps frames sorted", async () => {
    let captured: RawFrame | null = null;
    let calledAt = 0;
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const started = Date.now();
      return recordFrames(page, { duration_ms: 1000, interval_ms: 100 }, async (recorder) => {
        await sleep(350);
        calledAt = Date.now() - started;
        captured = await recorder.captureNow("interaction");
      });
    });

    expect(captured).not.toBeNull();
    const frame = captured as unknown as RawFrame;
    expect(frame.is_interaction).toBe(true);
    expect(frame.trigger).toBe("interaction");
    expect(frame.timestamp_ms).toBeGreaterThanOrEqual(calledAt - 5);
    expect(frame.timestamp_ms).toBeLessThan(calledAt + 500);

    const interactionFrames = result.frames.filter((f) => f.is_interaction);
    expect(interactionFrames).toHaveLength(1);
    expect(interactionFrames[0]).toBe(frame);
    expect(result.frames.filter((f) => f.trigger === "interaction")).toHaveLength(1);

    const timestamps = result.frames.map((f) => f.timestamp_ms);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
    // The interval loop kept running around the forced frame.
    expect(result.frames.length).toBeGreaterThanOrEqual(7);
  });
});

describe("FrameRecorder.captureNow on a closed page", () => {
  it("resolves to null instead of throwing", async () => {
    const captured = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.setContent("<h1>bye</h1>");
      const recorder = new FrameRecorder(page, { interval_ms: 100 });
      await page.close();
      return recorder.captureNow("interaction");
    });
    expect(captured).toBeNull();
  });
});

describe("FrameRecorder navigation detection", () => {
  it("captures a 'navigation' frame when the page navigates during recording, and never throws", async () => {
    let navigatedAt = 0;
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const started = Date.now();
      return recordFrames(page, { duration_ms: 1200, interval_ms: 50 }, async () => {
        await sleep(300);
        await page.goto(`${fixtures.url}/recorder-target.html`, { waitUntil: "load" });
        navigatedAt = Date.now() - started;
      });
    });

    const navFrames = result.frames.filter((f) => f.trigger === "navigation");
    expect(navFrames.length).toBeGreaterThanOrEqual(1);
    expect(navFrames[0].is_interaction).toBe(false);
    expect(navFrames[0].timestamp_ms).toBeGreaterThanOrEqual(250);
    expect(navFrames[0].timestamp_ms).toBeLessThanOrEqual(navigatedAt + 100);

    // Screenshot failures during the transition are counted, not thrown.
    expect(result.dropped).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.dropped)).toBe(true);

    // The last frame (captured on stop) shows the target page (green).
    const last = result.frames[result.frames.length - 1];
    expect(await pixelAt(last.buffer, 200, 150)).toEqual([0, 160, 0]);
  });
});

describe("FrameRecorder navigation before start()", () => {
  it("does not tag a navigation that happened before start() (listener is attached in start)", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const recorder = new FrameRecorder(page, { interval_ms: 100 });
      await page.goto(`${fixtures.url}/recorder-target.html`, { waitUntil: "load" });
      recorder.start();
      await sleep(400);
      return recorder.stop();
    });

    expect(result.frames.filter((f) => f.trigger === "navigation")).toHaveLength(0);
    expect(result.frames.every((f) => f.trigger === undefined && !f.is_interaction)).toBe(true);
    expect(result.frames.length).toBeGreaterThanOrEqual(3);
  });
});

describe("recordFrames with a rejecting `during` callback", () => {
  it("stops the recorder (no more frames, listener removed) and rethrows promptly", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      let recorder: FrameRecorder | undefined;
      const listenersBefore = page.listenerCount("framenavigated");
      const started = Date.now();

      await expect(
        recordFrames(page, { duration_ms: 5000, interval_ms: 50 }, async (r) => {
          recorder = r;
          await sleep(200);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      // Rejected promptly — did not wait out the full 5s duration.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(recorder).toBeDefined();
      expect(page.listenerCount("framenavigated")).toBe(listenersBefore);

      const countAfterStop = recorder!.frames.length;
      expect(countAfterStop).toBeGreaterThanOrEqual(2);
      await sleep(300);
      expect(recorder!.frames.length).toBe(countAfterStop);
    });
  });
});

describe("FrameRecorder.start idempotence", () => {
  it("calling start() twice runs a single loop and attaches a single navigation listener", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const listenersBefore = page.listenerCount("framenavigated");
      const recorder = new FrameRecorder(page, { interval_ms: 100 });

      recorder.start();
      recorder.start();
      expect(page.listenerCount("framenavigated")).toBe(listenersBefore + 1);

      await sleep(600);
      const result = await recorder.stop();
      expect(page.listenerCount("framenavigated")).toBe(listenersBefore);

      // One loop: ~6 interval frames + final. A second loop would roughly double this.
      expect(result.frames.length).toBeGreaterThanOrEqual(4);
      expect(result.frames.length).toBeLessThanOrEqual(9);
      const timestamps = result.frames.map((f) => f.timestamp_ms);
      for (let i = 1; i < timestamps.length - 1; i++) {
        expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(60);
      }
    });
  });
});

describe("FrameRecorder screenshot serialisation", () => {
  it("never has two screenshots in flight, even with a tiny interval and concurrent captureNow calls", async () => {
    await withPage({ viewport: { width: 1280, height: 720 } }, async (page) => {
      // A busy page so each screenshot takes a while.
      const cells = Array.from({ length: 400 }, (_, i) => `<div style="background:hsl(${i % 360},80%,50%)"></div>`).join("");
      await page.setContent(
        `<style>body{margin:0}#g{display:grid;grid-template-columns:repeat(20,1fr);height:100vh}#g div{min-height:36px}</style>` +
          `<div id="g">${cells}</div>`,
      );

      // Instrument the real screenshot call with an in-flight counter.
      const realScreenshot = page.screenshot.bind(page);
      let inFlight = 0;
      let maxInFlight = 0;
      let calls = 0;
      page.screenshot = (async (...args: Parameters<typeof realScreenshot>) => {
        inFlight++;
        calls++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await realScreenshot(...args);
        } finally {
          inFlight--;
        }
      }) as typeof page.screenshot;

      const result = await recordFrames(page, { duration_ms: 600, interval_ms: 16 }, async (r) => {
        // Fire several out-of-band captures without awaiting between them.
        const burst = Array.from({ length: 5 }, () => r.captureNow("interaction"));
        await sleep(100);
        await Promise.all([...burst, r.captureNow("navigation")]);
      });

      expect(calls).toBeGreaterThanOrEqual(8);
      expect(maxInFlight).toBe(1);
      expect(result.frames.filter((f) => f.is_interaction)).toHaveLength(5);

      // Sorted result and monotonic capture order (frames are stamped when their screenshot starts).
      const timestamps = result.frames.map((f) => f.timestamp_ms);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });
  });
});

describe("FrameRecorder with the page closed mid-recording", () => {
  it("stops the loop silently (no throw, no pile of dropped ticks) and stop() skips the final frame", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1000, interval_ms: 100 }, async () => {
        await sleep(300);
        await page.close();
      });
    });

    expect(result.frames.length).toBeGreaterThanOrEqual(2);
    expect(result.frames.length).toBeLessThanOrEqual(6);
    // At most the one screenshot that was in flight when the page closed.
    expect(result.dropped).toBeLessThanOrEqual(1);
    expect(result.frames.every((f) => f.timestamp_ms < 600)).toBe(true);
    // The recorder gives up as soon as the page is gone rather than idling out the duration.
    expect(result.duration_ms).toBeLessThan(900);
  });
});

describe("FrameRecorder in-page navigation (location.assign)", () => {
  it("tags the navigation and counts any transition screenshot failures in `dropped` instead of throwing", async () => {
    const target = `${fixtures.url}/recorder-target.html`;
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1200, interval_ms: 30 }, async () => {
        await sleep(300);
        await page.evaluate((url) => location.assign(url), target);
      });
    });

    expect(result.frames.filter((f) => f.trigger === "navigation").length).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(result.dropped)).toBe(true);
    expect(result.dropped).toBeGreaterThanOrEqual(0);
    expect(result.frames.length).toBeGreaterThanOrEqual(10);

    const first = result.frames[0];
    const last = result.frames[result.frames.length - 1];
    expect(await pixelAt(first.buffer, 200, 150)).toEqual([255, 255, 255]);
    expect(await pixelAt(last.buffer, 200, 150)).toEqual([0, 160, 0]);
  });
});

describe("FrameRecorder.stop idempotence", () => {
  it("a second stop() returns the same frames without capturing again", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const recorder = new FrameRecorder(page, { interval_ms: 100 });
      recorder.start();
      await sleep(250);
      const first = await recorder.stop();
      const second = await recorder.stop();
      expect(second.frames.length).toBe(first.frames.length);
      expect(second.duration_ms).toBe(first.duration_ms);
      expect(recorder.frames.length).toBe(first.frames.length);
    });
  });
});

describe("FrameRecorder screenshot timeout", () => {
  it("gives up on a screenshot that stalls behind a pending navigation instead of hanging for Playwright's 30s default", async () => {
    // A server that accepts the connection and never answers: the main frame
    // has a committed-but-unfinished navigation, and Chromium will not produce
    // a screenshot until it resolves.
    const sockets: import("node:net").Socket[] = [];
    const stalling = createServer(() => {});
    stalling.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
    const port = (stalling.address() as import("node:net").AddressInfo).port;

    try {
      const started = Date.now();
      const result = await withPage({ viewport: VIEWPORT }, async (page) => {
        await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
        const recorder = new FrameRecorder(page, { interval_ms: 100 });
        recorder.start();
        await sleep(150);
        void page.evaluate((url) => location.assign(url), `http://127.0.0.1:${port}/never`).catch(() => {});
        await sleep(600);
        return recorder.stop();
      });
      const elapsed = Date.now() - started;

      // Without a screenshot timeout this takes 30s+ per stalled call (60s+ overall).
      expect(elapsed).toBeLessThan(12_000);
      expect(result.dropped).toBeGreaterThanOrEqual(1);
      expect(result.frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalling.close(() => resolve()));
    }
  });
});

describe("FrameRecorder same-document navigation storm", () => {
  it("coalesces pushState/replaceState bursts instead of queueing a forced screenshot for every one", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-spa.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1000, interval_ms: 100 });
    });

    // ~10 interval frames + the final one. A `framenavigated` storm (60/s) must
    // not multiply that: at most one extra navigation frame per interval.
    expect(result.frames.length).toBeLessThanOrEqual(25);
    expect(result.frames.filter((f) => f.trigger === "navigation").length).toBeLessThanOrEqual(12);
  });

  it("does not overrun the requested duration when the page navigates on every animation frame", async () => {
    const started = Date.now();
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-spa.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 1000, interval_ms: 100 });
    });
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("FrameRecorder SPA route changes", () => {
  it("still tags a same-document route change (pushState to a new path) as a navigation", async () => {
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 700, interval_ms: 100 }, async () => {
        await sleep(250);
        await page.evaluate(() => history.pushState(null, "", "/dashboard/settings"));
      });
    });

    const navFrames = result.frames.filter((f) => f.trigger === "navigation");
    expect(navFrames).toHaveLength(1);
    expect(navFrames[0].timestamp_ms).toBeGreaterThanOrEqual(240);
  });
});

describe("FrameRecorder navigation tagging resilience", () => {
  it("carries the navigation tag forward when every capture around the navigation fails", async () => {
    const target = `${fixtures.url}/recorder-target.html`;
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });

      // Screenshots taken in the first 300ms after the navigation all fail —
      // the real-world case is Chromium refusing to paint mid-navigation,
      // which also blocks every capture queued behind it.
      const real = page.screenshot.bind(page);
      let failUntil = 0;
      page.screenshot = (async (...args: Parameters<typeof real>) => {
        if (Date.now() < failUntil) throw new Error("simulated mid-navigation failure");
        return real(...args);
      }) as typeof page.screenshot;

      const recorder = new FrameRecorder(page, { interval_ms: 100 });
      recorder.start();
      await sleep(150);
      failUntil = Date.now() + 300;
      await page.evaluate((url) => location.assign(url), target);
      await sleep(600);
      const result = await recorder.stop();

      // The tag must survive the failed captures and land on the next frame
      // that actually succeeds, rather than being lost with them.
      const nav = result.frames.filter((f) => f.trigger === "navigation");
      expect(nav).toHaveLength(1);
      expect(result.dropped).toBeGreaterThanOrEqual(1);
      expect(await pixelAt(nav[0].buffer, 200, 150)).toEqual([0, 160, 0]);
    });
  });
});

describe("FrameRecorder frame timestamps", () => {
  it("stamps a frame when its screenshot resolves, not when it was requested", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      // Only the second screenshot is slow, so nothing is queued ahead of it:
      // it is requested at ~0ms and only produced at ~300ms.
      const real = page.screenshot.bind(page);
      let call = 0;
      page.screenshot = (async (...args: Parameters<typeof real>) => {
        if (++call === 2) await sleep(300);
        return real(...args);
      }) as typeof page.screenshot;

      const recorder = new FrameRecorder(page, { interval_ms: 1000 });
      recorder.start();
      await sleep(50); // let the immediate tick-0 screenshot finish
      const frame = await recorder.captureNow("interaction");
      await recorder.stop();

      expect(frame).not.toBeNull();
      expect(frame!.timestamp_ms).toBeGreaterThanOrEqual(300);
    });
  });
});

describe("FrameRecorder interval validation", () => {
  it("falls back to the default interval for a zero, negative or NaN interval_ms instead of screenshotting flat out", async () => {
    for (const interval of [0, -100, NaN]) {
      const result = await withPage({ viewport: VIEWPORT }, async (page) => {
        await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
        return recordFrames(page, { duration_ms: 500, interval_ms: interval });
      });
      // 500ms at the 100ms default is ~6 frames; a tight loop produces dozens.
      expect(result.frames.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("FrameRecorder dropped counter", () => {
  it("counts each interval tick whose screenshot failed and records no frame for it", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      const real = page.screenshot.bind(page);
      let call = 0;
      page.screenshot = (async (...args: Parameters<typeof real>) => {
        call++;
        if (call === 2 || call === 3) throw new Error("simulated screenshot failure");
        return real(...args);
      }) as typeof page.screenshot;

      const recorder = new FrameRecorder(page, { interval_ms: 100 });
      recorder.start();
      await sleep(450);
      const result = await recorder.stop();

      expect(result.dropped).toBe(2);
      expect(result.frames.length).toBe(call - 2);
    });
  });
});

describe("FrameRecorder final frame", () => {
  it("captures one extra frame at stop() so the settled end state is always recorded", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      // One interval frame at t=0; the next tick would only fire at t=1000ms.
      const recorder = new FrameRecorder(page, { interval_ms: 1000 });
      recorder.start();
      await sleep(300);
      expect(recorder.frames.length).toBe(1);

      const result = await recorder.stop();
      expect(result.frames).toHaveLength(2);
      expect(result.frames[1].timestamp_ms).toBeGreaterThanOrEqual(250);
      expect(result.frames[1].timestamp_ms).toBeLessThan(900);
      expect(result.frames[1].trigger).toBeUndefined();
    });
  });
});

describe("FrameRecorder tick scheduling", () => {
  it("skips the ticks missed by a slow screenshot instead of firing the whole backlog at once", async () => {
    await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      // Two very slow screenshots (8 intervals each), then normal speed. A
      // scheduler that just advances tick-by-tick is left with a backlog of
      // ~16 overdue ticks and fires them back to back the moment it catches up.
      const real = page.screenshot.bind(page);
      let call = 0;
      page.screenshot = (async (...args: Parameters<typeof real>) => {
        if (++call <= 2) await sleep(400);
        return real(...args);
      }) as typeof page.screenshot;

      const result = await recordFrames(page, { duration_ms: 1600, interval_ms: 50 });

      // Ignore the final stop() frame, which is deliberately out of schedule.
      const interval = result.frames.filter((f) => f.trigger === undefined).map((f) => f.timestamp_ms).slice(0, -1);
      expect(interval.length).toBeGreaterThanOrEqual(5);

      // A tick-by-tick scheduler never catches up once it falls behind: its
      // delay stays negative, so it screenshots flat out for the rest of the
      // recording. Honouring the schedule caps the count at ~duration/interval.
      expect(interval.length).toBeLessThanOrEqual(1600 / 50);

      // Frames are stamped when their screenshot resolves, so varying
      // screenshot durations make individual gaps jitter around the interval —
      // but a backlog burst makes nearly *every* gap far too small.
      const gaps = interval.slice(1).map((t, i) => t - interval[i]);
      expect(gaps.filter((g) => g < 40).length).toBeLessThanOrEqual(2);
    });
  });
});

describe("FrameRecorder first frame after a navigation commit", () => {
  it("retries the screenshot Chromium refuses before its first paint, so the initial frame is not lost", async () => {
    // goto(waitUntil: "commit") returns before Chromium has produced any frame:
    // an immediate screenshot fails with "Unable to capture screenshot" about
    // half the time. Run several times so a flaky pass is unlikely.
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await withPage({ viewport: VIEWPORT }, async (page) => {
        await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "commit" });
        const recorder = new FrameRecorder(page, { interval_ms: 100 });
        recorder.start();
        await sleep(120);
        return recorder.stop();
      });
      expect(result.dropped).toBe(0);
      expect(result.frames[0].timestamp_ms).toBeLessThan(120);
    }
  });
});

describe("recordFrames when the page dies mid-recording", () => {
  it("returns as soon as the page closes instead of idling out the rest of duration_ms", async () => {
    const started = Date.now();
    const result = await withPage({ viewport: VIEWPORT }, async (page) => {
      await page.goto(`${fixtures.url}/recorder-flip.html`, { waitUntil: "load" });
      return recordFrames(page, { duration_ms: 8000, interval_ms: 100 }, async () => {
        await sleep(300);
        await page.close();
      });
    });

    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.frames.length).toBeGreaterThanOrEqual(2);
  });
});
