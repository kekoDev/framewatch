import type { Page } from "playwright";

/**
 * Slow the page's animations down (or speed them up).
 *
 * A 200ms transition recorded at 10 frames a second is two frames, which is
 * no help to anyone debugging it. Chromium's devtools protocol can scale the
 * document's animation clock, and that covers CSS animations, CSS transitions
 * and the Web Animations API alike — the same control the devtools animation
 * panel uses. It does not touch JavaScript timers, so a `setTimeout`-driven
 * sequence runs at its own pace; the tool says so wherever this is on.
 *
 * Set before the page navigates so the rate is in force from its first frame.
 * The session is left attached: it lives as long as the page, which in a
 * capture is one call.
 */
export async function setAnimationSpeed(page: Page, playbackRate: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate });
}

/** The summary line for a capture that ran at a speed other than 1. */
export function describeAnimationSpeed(playbackRate: number): string {
  const shown = Number.isInteger(playbackRate) ? String(playbackRate) : String(Number(playbackRate.toFixed(2)));
  return `Animations at ${shown}× speed (CSS animations and transitions; JavaScript timers run as normal)`;
}
