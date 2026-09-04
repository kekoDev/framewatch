import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, closeSession } from "../src/engine/browser.js";
import { auditAccessibility } from "../src/tools/accessibility.js";
import { mockApi } from "../src/tools/api-mock.js";
import { capturePage } from "../src/tools/capture.js";
import { comparePages } from "../src/tools/compare.js";
import { findDeadClicks } from "../src/tools/dead-clicks.js";
import { testForms } from "../src/tools/form-test.js";
import { performInteraction } from "../src/tools/interact.js";
import { captureResponsive } from "../src/tools/responsive.js";
import { auditSeo } from "../src/tools/seo.js";
import { takeScreenshot } from "../src/tools/screenshot.js";
import { writeStorageState, type StorageState } from "../src/utils/storage-state.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * Restoring saved auth (`storage_state`) in every tool that opens a page.
 *
 * gate.html shows its feed only when BOTH a cookie and a localStorage token
 * are present, so a tool that reaches `#feed` has restored both halves of the
 * state — and one that has not restored it sits on the gate, which is what the
 * negative cases assert. Saving the state is `save-auth.test.ts`.
 */

let fixtures: FixtureServer;
let dir: string;
/** A state file that opens the gate, and one path that has never existed. */
let authPath: string;
let missingPath: string;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  dir = await mkdtemp(join(tmpdir(), "framewatch-auth-"));
  authPath = join(dir, "auth.json");
  missingPath = join(dir, "no-such-auth.json");
  await writeStorageState(gateState(fixtures.url), authPath);
});

afterAll(async () => {
  await closeSession();
  await fixtures.close();
  await closeBrowser();
  await rm(dir, { recursive: true, force: true });
});

/** What gate.html stores once its password has been accepted. */
function gateState(origin: string): StorageState {
  return {
    cookies: [
      {
        name: "fw_session",
        value: "yes",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [{ origin, localStorage: [{ name: "fw_token", value: "fixture-token" }] }],
  };
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const text = (result: Result): string =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

/** The gated page. Reaching `#feed` on it is the proof that auth was restored. */
const gate = (): string => `${fixtures.url}/gate.html`;

describe("framewatch_screenshot storage_state", () => {
  it("opens the page already past the gate", async () => {
    const result = await takeScreenshot({
      url: gate(),
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(result.isError).toBeFalsy();
  });

  it("sits on the gate without it, which is what makes the restore meaningful", async () => {
    const result = await takeScreenshot({
      url: gate(),
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 1500,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("#feed");
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await takeScreenshot({ url: gate(), wait_ms: 0, storage_state: missingPath });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(missingPath);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_capture storage_state", () => {
  it("records the app itself rather than its login screen", async () => {
    const result = await capturePage({
      url: gate(),
      duration_ms: 600,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(result.isError).toBeFalsy();
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await capturePage({ url: gate(), duration_ms: 600, storage_state: missingPath });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_responsive storage_state", () => {
  it("restores the state in every viewport's own context", async () => {
    const result = await captureResponsive({
      url: gate(),
      viewports: [
        { name: "mobile", width: 390, height: 844 },
        { name: "desktop", width: 1280, height: 720 },
      ],
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("2 of 2 viewports");
  });

  it("reports a missing state file once, not once per viewport", async () => {
    const result = await captureResponsive({ url: gate(), wait_ms: 0, storage_state: missingPath });
    expect(result.isError).toBe(true);
    const report = text(result);
    expect(report).toContain("framewatch_save_auth");
    expect(report.match(/framewatch_save_auth/g)).toHaveLength(1);
  });
});

describe("framewatch_accessibility storage_state", () => {
  it("audits the page behind the gate", async () => {
    const result = await auditAccessibility({
      url: gate(),
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(result.isError).toBeFalsy();
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await auditAccessibility({ url: gate(), wait_ms: 0, storage_state: missingPath });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_compare storage_state", () => {
  it("restores the state on both URL sides, so the two are the same authenticated page", async () => {
    const result = await comparePages({
      url_a: gate(),
      url_b: gate(),
      wait_ms: 0,
      wait_for: "#feed",
      wait_for_timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("pixel-identical");
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await comparePages({ url_a: gate(), url_b: gate(), wait_ms: 0, storage_state: missingPath });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_interact storage_state", () => {
  it("opens the session page with the saved state and keeps it across later calls", async () => {
    await closeSession();

    const first = await performInteraction({
      url: gate(),
      action: "hover",
      selector: "#feed",
      wait_ms: 0,
      timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(first.isError).toBeFalsy();

    // A reload with no `storage_state` at all: the cookie and the token live in
    // the session's context now, so the feed is still what comes back.
    const reloaded = await performInteraction({ action: "navigate", value: gate(), wait_ms: 0, timeout_ms: 3000 });
    expect(reloaded.isError).toBeFalsy();

    const still = await performInteraction({ action: "hover", selector: "#feed", wait_ms: 0, timeout_ms: 3000 });
    expect(still.isError).toBeFalsy();
  });

  it("applies a state passed to a session that was opened without one, saying the page was reset", async () => {
    await closeSession();

    const unauthed = await performInteraction({ url: gate(), action: "hover", selector: "#gate", wait_ms: 0, timeout_ms: 3000 });
    expect(unauthed.isError).toBeFalsy();

    const authed = await performInteraction({
      url: gate(),
      action: "hover",
      selector: "#feed",
      wait_ms: 0,
      timeout_ms: 3000,
      storage_state: authPath,
    });
    expect(authed.isError).toBeFalsy();
    expect(text(authed)).toMatch(/reopened/i);
    expect(text(authed)).toMatch(/auth|state/i);
  });

  it("says the state file is missing instead of failing on the page", async () => {
    await closeSession();
    const result = await performInteraction({
      url: gate(),
      action: "hover",
      selector: "#feed",
      wait_ms: 0,
      storage_state: missingPath,
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_form_test storage_state", () => {
  /** The profile form only exists once signed in — signed out the page has no fields at all. */
  const gatedForm = (): string => `${fixtures.url}/form-gated.html`;

  it("fills the form that only exists behind the gate", async () => {
    const result = await testForms({ url: gatedForm(), strategies: ["valid"], storage_state: authPath });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("#display-name");
  });

  it("finds nothing to fill without it, which is what makes the restore meaningful", async () => {
    const result = await testForms({ url: gatedForm(), strategies: ["valid"] });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no fillable fields/i);
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await testForms({ url: gatedForm(), strategies: ["valid"], storage_state: missingPath });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(missingPath);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_seo storage_state", () => {
  const gate = (): string => `${fixtures.url}/gate.html`;

  it("audits the page as a signed-in visitor sees it", async () => {
    const result = await auditSeo({ url: gate(), wait_ms: 0, storage_state: authPath });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('✓ H1 — "Feed"');
    expect(text(result)).not.toContain("not visible");
  });

  it("without it, the same h1 is in the DOM but nothing renders it", async () => {
    const result = await auditSeo({ url: gate(), wait_ms: 0 });

    expect(text(result)).toContain("not visible, but still crawled");
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await auditSeo({ url: gate(), wait_ms: 0, storage_state: missingPath });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(missingPath);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_dead_clicks storage_state", () => {
  const gated = (): string => `${fixtures.url}/form-gated.html`;

  it("sweeps the controls that only exist once signed in", async () => {
    const result = await findDeadClicks({ url: gated(), wait_ms: 100, settle_ms: 250, storage_state: authPath });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("#save");
  });

  it("without it there is nothing to click at all, which is what makes the restore meaningful", async () => {
    const result = await findDeadClicks({ url: gated(), wait_ms: 100, settle_ms: 250 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/nothing on this page looks clickable/);
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await findDeadClicks({ url: gated(), wait_ms: 100, settle_ms: 250, storage_state: missingPath });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(missingPath);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("framewatch_api_mock storage_state", () => {
  const gate = (): string => `${fixtures.url}/gate.html`;

  it("records the app behind the gate while its API is mocked", async () => {
    const result = await mockApi({
      url: gate(),
      mocks: [{ url_pattern: "**/api/products*", scenario: "empty" }],
      duration_ms: 600,
      wait_for: "#feed",
      storage_state: authPath,
    });

    expect(result.isError).toBeFalsy();
  });

  it("never reaches the feed without it, which is what makes the restore meaningful", async () => {
    const result = await mockApi({
      url: gate(),
      mocks: [{ url_pattern: "**/api/products*", scenario: "empty" }],
      duration_ms: 600,
      wait_for: "#feed",
      wait_for_timeout_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("#feed");
  });

  it("says the state file is missing instead of failing on the page", async () => {
    const result = await mockApi({
      url: gate(),
      mocks: [{ url_pattern: "**/api/products*", scenario: "empty" }],
      duration_ms: 600,
      storage_state: missingPath,
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(missingPath);
    expect(text(result)).toContain("framewatch_save_auth");
  });
});

describe("automatic pickup of the saved auth", () => {
  afterEach(async () => {
    delete process.env.FRAMEWATCH_AUTH_STATE;
    await closeSession();
  });

  it("framewatch_screenshot opens the gate with the default file and says so", async () => {
    process.env.FRAMEWATCH_AUTH_STATE = authPath;
    const result = await takeScreenshot({ url: gate(), wait_for: "#feed" });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(`Auth: using ${authPath} (saved`);
    expect(text(result)).toContain('storage_state: "none"');
  });

  it("storage_state \"none\" opens the page signed out, with no auth line", async () => {
    process.env.FRAMEWATCH_AUTH_STATE = authPath;
    const result = await takeScreenshot({ url: gate(), storage_state: "none", wait_ms: 200 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).not.toContain("Auth:");
    // Still on the gate: the login form is what got screenshotted.
    const again = await takeScreenshot({ url: gate(), storage_state: "none", wait_for: "#pass" });
    expect(again.isError).toBeFalsy();
  });

  it("framewatch_capture and the session tools pick it up too", async () => {
    process.env.FRAMEWATCH_AUTH_STATE = authPath;
    const capture = await capturePage({ url: gate(), duration_ms: 600, wait_for: "#feed" });
    expect(capture.isError).toBeFalsy();
    expect(text(capture)).toContain("Auth: using");

    const interact = await performInteraction({ url: gate(), action: "hover", selector: "#feed", wait_ms: 100 });
    expect(interact.isError).toBeFalsy();
    expect(text(interact)).toContain("Auth: using");
  });

  it("says when the saved session no longer signs in", async () => {
    const stale = join(dir, "stale.json");
    // The cookie survived but the token is gone — the gate shows again.
    const state = gateState(fixtures.url);
    state.origins = [];
    await writeStorageState(state, stale);
    process.env.FRAMEWATCH_AUTH_STATE = stale;

    const result = await takeScreenshot({ url: gate(), wait_ms: 300 });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("did not sign you in");
    expect(text(result)).toContain("framewatch_save_auth");
  });
});
