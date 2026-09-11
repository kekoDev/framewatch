import type { Page } from "playwright";
import { detectVue, waitForVueReady } from "./vue.js";

/**
 * Wait for a page to reach a state worth looking at.
 *
 * `wait_ms` is a guess in both directions: too short and the frame shows a
 * half-loaded page, too long and every call pays for it. Each condition here
 * is a signal the page itself gives off — its images have their pixels, its
 * fonts have swapped in, its animations have stopped, its requests have gone
 * quiet, its Vue app has mounted — polled until it holds or the timeout
 * passes. A condition that was not met is reported, never thrown: the frame
 * is still worth having, and "images still loading after 5s" is a finding.
 */

export const WAIT_CONDITIONS = ["load", "network_idle", "vue_ready", "images", "fonts", "animations"] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];

export interface WaitOptions {
  timeout_ms: number;
  /** How often to re-check a polled condition. */
  poll_ms?: number;
}

export interface WaitResult {
  condition: WaitCondition;
  met: boolean;
  waited_ms: number;
  /** What was found: "3 images", "1 image still loading", "no Vue app". */
  detail?: string;
}

export async function waitUntil(page: Page, condition: WaitCondition, options: WaitOptions): Promise<WaitResult> {
  const started = Date.now();
  const done = (met: boolean, detail?: string): WaitResult => ({
    condition,
    met,
    waited_ms: Date.now() - started,
    ...(detail !== undefined ? { detail } : {}),
  });
  const timeout = Math.max(1, options.timeout_ms);

  switch (condition) {
    case "load": {
      try {
        await page.waitForLoadState("load", { timeout });
        return done(true);
      } catch {
        return done(false, "load event did not fire");
      }
    }
    case "network_idle": {
      try {
        await page.waitForLoadState("networkidle", { timeout });
        return done(true);
      } catch {
        return done(false, "requests still in flight");
      }
    }
    case "vue_ready": {
      const result = await waitForVueReady(page, { detect_ms: timeout, ready_ms: timeout });
      if (!result.vue) return done(false, "no Vue app mounted");
      const vue = (await detectVue(page)) ?? result.vue;
      return done(true, `Vue ${vue.version}${vue.route ? `, route ${vue.route.path}` : ""}`);
    }
    case "fonts": {
      const ready = await Promise.race([
        page.evaluate(fontsInPage).catch(() => false),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
      ]);
      return ready ? done(true, "fonts ready") : done(false, "fonts still loading");
    }
    case "images":
    case "animations": {
      // Neither can be judged before the document exists; a capture asks at
      // navigation commit, when "no images" would be true and worthless.
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
      const probe = condition === "images" ? imagesInPage : animationsInPage;
      const poll = options.poll_ms ?? 50;
      const deadline = started + timeout;
      let last: ProbeResult = { met: false, detail: "" };
      for (;;) {
        last = await page.evaluate(probe).catch((): ProbeResult => ({ met: false, detail: "page could not be read" }));
        if (last.met || Date.now() >= deadline) break;
        await page.waitForTimeout(Math.min(poll, Math.max(1, deadline - Date.now())));
      }
      return done(last.met, last.detail);
    }
  }
}

/** The one line a tool prints about a wait it was asked for. */
export function describeWait(result: WaitResult): string {
  const detail = result.detail ? ` (${result.detail})` : "";
  return result.met
    ? `waited ${result.waited_ms}ms for ${result.condition}${detail}`
    : `${result.condition} not met after ${result.waited_ms}ms${detail}`;
}

/* ── In-page ──────────────────────────────────────────────────────────────
 * Serialised into Chromium: nothing here may reference a module value.
 */

interface ProbeResult {
  met: boolean;
  detail: string;
}

function imagesInPage(): ProbeResult {
  const doc = (globalThis as any).document;
  if (!doc) return { met: true, detail: "no document" };
  const images: any[] = Array.prototype.slice.call(doc.querySelectorAll("img"));
  let loading = 0;
  for (const img of images) {
    // `complete` is true for a failed load as well; a broken image is not
    // something to keep waiting for.
    if (!img.complete) loading++;
  }
  const total = images.length;
  const noun = (n: number): string => `${n} image${n === 1 ? "" : "s"}`;
  if (loading === 0) return { met: true, detail: total === 0 ? "no images" : noun(total) };
  return { met: false, detail: `${noun(loading)} still loading of ${total}` };
}

function animationsInPage(): ProbeResult {
  const doc = (globalThis as any).document;
  if (!doc || typeof doc.getAnimations !== "function") return { met: true, detail: "no animations API" };
  const animations: any[] = doc.getAnimations();
  let running = 0;
  for (const animation of animations) {
    if (animation.playState !== "running") continue;
    // An infinite animation never finishes; waiting for it would always time out.
    const timing = animation.effect && typeof animation.effect.getTiming === "function" ? animation.effect.getTiming() : null;
    if (timing && timing.iterations === Infinity) continue;
    running++;
  }
  if (running === 0) return { met: true, detail: animations.length === 0 ? "no animations" : "animations finished" };
  return { met: false, detail: `${running} animation${running === 1 ? "" : "s"} still running` };
}

async function fontsInPage(): Promise<boolean> {
  const doc = (globalThis as any).document;
  if (!doc || !doc.fonts || !doc.fonts.ready) return true;
  await doc.fonts.ready;
  return true;
}
