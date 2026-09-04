import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/engine/browser.js";
import { saveAuth, saveAuthInputSchema, SAVE_AUTH_TOOL_NAME } from "../src/tools/save-auth.js";
import { takeScreenshot } from "../src/tools/screenshot.js";
import { readStorageState } from "../src/utils/storage-state.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * `framewatch_save_auth`: run a login once, keep what it produced.
 *
 * gate.html grants access only for the password `letmein`, and stores both a
 * cookie and a localStorage token when it does — so a state file that opens
 * the gate again is proof the whole round trip works, which is the last test
 * here. Restoring a state in the other tools is `auth.test.ts`.
 */

let fixtures: FixtureServer;
let dir: string;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  dir = await mkdtemp(join(tmpdir(), "framewatch-save-auth-"));
});

afterAll(async () => {
  await fixtures.close();
  await closeBrowser();
  await rm(dir, { recursive: true, force: true });
});

type Result = Awaited<ReturnType<typeof saveAuth>>;

const text = (result: Result): string =>
  (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

const images = (result: Result) => result.content.filter((c) => c.type === "image");

const gate = (): string => `${fixtures.url}/gate.html`;

const exists = async (path: string): Promise<boolean> =>
  access(path)
    .then(() => true)
    .catch(() => false);

/** The gate flow, as a caller would write it. */
const login = [
  { action: "type" as const, selector: "#pass", value: "letmein" },
  { action: "click" as const, selector: ".go" },
];

describe("saveAuth", () => {
  it("runs the flow and saves the cookies and storage it produced", async () => {
    const path = join(dir, "basic.json");
    const result = await saveAuth({ url: gate(), interactions: login, output_path: path, wait_for: "#feed" });

    expect(result.isError).toBeFalsy();
    const state = await readStorageState(path);
    expect(state.cookies.map((c) => c.name)).toContain("fw_session");
    expect(state.origins[0]?.localStorage).toContainEqual({ name: "fw_token", value: "fixture-token" });
  });

  it("returns a screenshot of where the flow ended, plus what was saved and where", async () => {
    const path = join(dir, "summary.json");
    const result = await saveAuth({ url: gate(), interactions: login, output_path: path, wait_for: "#feed" });

    expect(images(result)).toHaveLength(1);
    const report = text(result);
    expect(report).toContain(path);
    expect(report).toMatch(/1 cookie/);
    expect(report).toMatch(/1 stored key/);
    // The next step the reader needs: how to use what was just written.
    expect(report).toContain("storage_state");
  });

  it("creates the directories the output path needs", async () => {
    const path = join(dir, "nested", "deep", "auth.json");
    const result = await saveAuth({ url: gate(), interactions: login, output_path: path, wait_for: "#feed" });
    expect(result.isError).toBeFalsy();
    expect(await exists(path)).toBe(true);
  });

  it("accepts a `key` step, so a form can be submitted with Enter", async () => {
    const path = join(dir, "with-key.json");
    const result = await saveAuth({
      url: gate(),
      interactions: [
        { action: "type", selector: "#pass", value: "letmein" },
        { action: "key", value: "Enter" },
      ],
      output_path: path,
      wait_for: "#feed",
    });

    expect(result.isError).toBeFalsy();
    expect((await readStorageState(path)).cookies).toHaveLength(1);
  });

  it("saves nothing when the success selector never appears, and says which selector", async () => {
    const path = join(dir, "never.json");
    const result = await saveAuth({
      url: gate(),
      interactions: [
        { action: "type", selector: "#pass", value: "wrong-password" },
        { action: "click", selector: ".go" },
      ],
      output_path: path,
      wait_for: "#feed",
      wait_for_timeout_ms: 1500,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("#feed");
    // A state file that is not signed in is worse than none: every later tool
    // would load it and quietly get the login screen.
    expect(await exists(path)).toBe(false);
  });

  it("shows the page it got stuck on when the flow fails, so the failure can be read", async () => {
    const path = join(dir, "stuck.json");
    const result = await saveAuth({
      url: gate(),
      interactions: [{ action: "click", selector: "#not-there" }],
      output_path: path,
      wait_for: "#feed",
      timeout_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("#not-there");
    expect(images(result)).toHaveLength(1);
    expect(await exists(path)).toBe(false);
  });

  it("says plainly when the flow stored nothing at all", async () => {
    const path = join(dir, "empty.json");
    const result = await saveAuth({ url: `${fixtures.url}/basic.html`, interactions: [], output_path: path });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/no cookies and nothing in storage/);
  });

  it("saves a state that opens the gate on a page that has never seen the password", async () => {
    const path = join(dir, "roundtrip.json");
    await saveAuth({ url: gate(), interactions: login, output_path: path, wait_for: "#feed" });

    const authed = await takeScreenshot({
      url: gate(),
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: path,
    });
    expect(authed.isError).toBeFalsy();
  });
});

describe("saveAuthInputSchema", () => {
  const parse = (input: Record<string, unknown>) => saveAuthInputSchema.safeParse({ url: "http://x.test/", ...input });

  it("is named framewatch_save_auth", () => {
    expect(SAVE_AUTH_TOOL_NAME).toBe("framewatch_save_auth");
  });

  it("defaults the output path to .framewatch/auth.json", () => {
    const parsed = parse({ interactions: [] });
    expect(parsed.success && parsed.data.output_path).toBe(".framewatch/auth.json");
  });

  it("accepts every action a capture script accepts", () => {
    for (const action of ["click", "tap", "type", "key", "scroll", "swipe", "hover", "select", "wait", "navigate"]) {
      const step: Record<string, unknown> = { action };
      if (action === "type") step.value = "x";
      if (action === "key") step.value = "Enter";
      if (action === "navigate") step.value = "http://x/";
      if (action === "scroll") step.delta_y = 10;
      if (action === "swipe") Object.assign(step, { x: 1, y: 1, delta_x: 5 });
      if (action === "select") Object.assign(step, { selector: "#a", value: "b" });
      if (action === "click" || action === "tap" || action === "hover") step.selector = "#a";
      expect(parse({ interactions: [step] }).success, action).toBe(true);
    }
  });

  it("rejects a step that is missing the fields its action needs", () => {
    expect(parse({ interactions: [{ action: "type" }] }).success).toBe(false);
    expect(parse({ interactions: [{ action: "key" }] }).success).toBe(false);
    expect(parse({ interactions: [{ action: "click" }] }).success).toBe(false);
  });

  it("requires the interaction script and a url", () => {
    expect(saveAuthInputSchema.safeParse({ url: "http://x.test/" }).success).toBe(false);
    expect(saveAuthInputSchema.safeParse({ interactions: [] }).success).toBe(false);
  });

  it("takes a mobile viewport with touch, as a phone-shaped app needs", () => {
    const parsed = parse({
      interactions: [],
      viewport: { width: 390, height: 844, is_mobile: true, has_touch: true },
    });
    expect(parsed.success && parsed.data.viewport).toEqual({
      width: 390,
      height: 844,
      is_mobile: true,
      has_touch: true,
    });
  });
});
