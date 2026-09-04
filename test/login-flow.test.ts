import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, closeSession } from "../src/engine/browser.js";
import { capturePage } from "../src/tools/capture.js";
import { performInteraction } from "../src/tools/interact.js";
import { LOGIN_PASSWORD, startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * End-to-end tests for the flow the README leads with: replay a login script
 * while recording, with every context layer on. The individual pieces are
 * covered elsewhere (capture.test.ts, context.test.ts, interaction.test.ts);
 * what this file checks is that they still say the right thing together on a
 * page that behaves like a real form — validation, a failed POST, a successful
 * one, and a transition after it.
 */

let fixtures: FixtureServer;

beforeAll(async () => {
  fixtures = await startFixtureServer();
});

afterAll(async () => {
  await closeSession();
  await fixtures.close();
  await closeBrowser();
});

type Result = Awaited<ReturnType<typeof capturePage>>;
type TextBlock = { type: "text"; text: string };

const VIEWPORT = { width: 480, height: 360 };
const LOGIN = (): string => `${fixtures.url}/login.html`;

const texts = (result: Result): string[] =>
  result.content.filter((c): c is TextBlock => c.type === "text").map((c) => c.text);
const summary = (result: Result): string => texts(result)[0];
const cards = (result: Result): string[] => texts(result).slice(1);
/** Every line of every card, so a section line can be found wherever it landed. */
const allLines = (result: Result): string[] => cards(result).flatMap((t) => t.split("\n").map((l) => l.trim()));

function typeCredentials(password: string) {
  return [
    { action: "type" as const, selector: "#email", value: "test@example.com", delay_ms: 300 },
    { action: "type" as const, selector: "#password", value: password, delay_ms: 200 },
    { action: "click" as const, selector: "#submit", delay_ms: 200 },
    { action: "wait" as const, delay_ms: 900 },
  ];
}

describe("capture of a failed login", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({
      url: LOGIN(),
      duration_ms: 3000,
      viewport: VIEWPORT,
      interactions: typeCredentials("wrong-password"),
      include_console: true,
      include_network: true,
      include_dom: true,
      include_performance: true,
    });
  });

  it("replays the whole script and names the steps in the summary", () => {
    expect(result.isError).toBeFalsy();
    expect(summary(result)).toContain("Interactions: 4/4 replayed");
    expect(summary(result)).toContain('type "test@example.com" into "#email"');
    expect(summary(result)).toContain('click "#submit"');
  });

  it("keeps an [interaction] card for each step that changed the page", () => {
    const interactionCards = cards(result).filter((t) => t.includes("[interaction]"));
    // Typing into two fields and clicking submit all change pixels; the
    // trailing `wait` step forces a frame too.
    expect(interactionCards.length).toBeGreaterThanOrEqual(3);
  });

  it("reports the 401 on the network layer with a duration", () => {
    const post = allLines(result).find((l) => l.startsWith("POST") && l.includes("/api/login"));
    expect(post).toBeDefined();
    expect(post).toMatch(/→ 401 \(\d+ms\)/);
  });

  it("reports the page's own error on the console layer", () => {
    const errors = allLines(result).filter((l) => l.startsWith("[error]"));
    expect(errors.some((l) => l.includes("login failed: Invalid email or password"))).toBe(true);
  });

  it("reports the error banner appearing on the DOM layer", () => {
    const dom = allLines(result).filter((l) => l.startsWith("~") || l.startsWith("+") || l.startsWith("-"));
    expect(dom.some((l) => l.includes("#error"))).toBe(true);
  });

  it("reports the layout shift the banner caused on the performance layer", () => {
    const lines = allLines(result);
    expect(lines.some((l) => /^layout shifts \d+/.test(l))).toBe(true);
  });

  it("counts all four layers in the context summary", () => {
    expect(summary(result)).toMatch(/Context — .*console: \d+ entr/);
    expect(summary(result)).toMatch(/network: \d+ request/);
    expect(summary(result)).toMatch(/DOM: \d+ mutation/);
  });
});

describe("capture of a successful login", () => {
  let result: Result;

  beforeAll(async () => {
    result = await capturePage({
      url: LOGIN(),
      duration_ms: 3000,
      viewport: VIEWPORT,
      interactions: typeCredentials(LOGIN_PASSWORD),
      include_console: true,
      include_network: true,
    });
  });

  it("reports the 200 and the token message rather than an error", () => {
    const lines = allLines(result);
    expect(lines.find((l) => l.startsWith("POST") && l.includes("/api/login"))).toMatch(/→ 200 \(\d+ms\)/);
    expect(lines.some((l) => l.includes("[info] auth token stored"))).toBe(true);
    expect(lines.some((l) => l.includes("[error]"))).toBe(false);
  });

  it("keeps frames for the welcome panel fading in after the form disappears", () => {
    // The form is replaced by a 320x200 panel over a 400ms transition, so the
    // frames after the click have to differ from each other, not just from the form.
    const changed = cards(result)
      .map((t) => /Changed: ([\d.]+)%/.exec(t)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(changed.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...changed)).toBeGreaterThan(5);
  });
});

describe("capture of client-side validation", () => {
  it("shows the console error with no network request at all", async () => {
    const result = await capturePage({
      url: LOGIN(),
      duration_ms: 1500,
      viewport: VIEWPORT,
      interactions: [{ action: "click", selector: "#submit", delay_ms: 300 }],
      include_console: true,
      include_network: true,
    });

    const lines = allLines(result);
    expect(lines.some((l) => l.includes("[error] login failed: Email and password are required"))).toBe(true);
    // The form never reached the network: the only request is the document itself.
    const requests = lines.filter((l) => /^(GET|POST) http/.test(l));
    expect(requests.some((l) => l.includes("/api/"))).toBe(false);
    expect(requests.filter((l) => l.includes("login.html"))).toHaveLength(1);
  });
});

describe("framewatch_interact against the login form", () => {
  it("carries page state between calls: type, then submit, then see the failure", async () => {
    const typed = await performInteraction({
      url: LOGIN(),
      action: "type",
      selector: "#email",
      value: "test@example.com",
      viewport: VIEWPORT,
      wait_ms: 200,
    });
    expect(typed.isError).toBeFalsy();

    await performInteraction({ action: "type", selector: "#password", value: "wrong-password", wait_ms: 200 });

    const submitted = await performInteraction({
      action: "click",
      selector: "#submit",
      wait_ms: 800,
      include_console: true,
      include_network: true,
    });

    const [line, , after] = texts(submitted);
    expect(line).toContain('click "#submit"');
    expect(line).toMatch(/[\d.]+% of the frame changed/);
    // The two earlier calls typed into the same page; if state had not carried
    // over, this click would have hit the validation path and made no request.
    expect(after).toMatch(/POST .*\/api\/login → 401 \(\d+ms\)/);
    expect(after).toContain("[error] login failed: Invalid email or password");
  });
});
