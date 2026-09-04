import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultAuthPath,
  describeAuth,
  readStorageState,
  resolveStorageState,
  storageStateSummary,
  writeStorageState,
  type StorageState,
} from "../src/utils/storage-state.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "framewatch-state-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STATE: StorageState = {
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
  origins: [{ origin: "http://127.0.0.1:1234", localStorage: [{ name: "fw_token", value: "fixture-token" }] }],
};

describe("readStorageState", () => {
  it("reads a state file back as the object Playwright wrote", async () => {
    const path = join(dir, "good.json");
    await writeFile(path, JSON.stringify(STATE));
    expect(await readStorageState(path)).toEqual(STATE);
  });

  it("says the file is missing and names the tool that creates it", async () => {
    const path = join(dir, "nope.json");
    const error = await readStorageState(path).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toMatch(/not found/i);
    expect((error as Error).message).toContain("framewatch_save_auth");
  });

  it("says the file is not valid JSON rather than leaking a parser error", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    const error = await readStorageState(path).catch((e: Error) => e);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toMatch(/not valid JSON/i);
    expect((error as Error).message).toContain("framewatch_save_auth");
  });

  it("rejects JSON that is not a browser state file", async () => {
    const path = join(dir, "wrong.json");
    await writeFile(path, JSON.stringify({ hello: "world" }));
    const error = await readStorageState(path).catch((e: Error) => e);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toMatch(/cookies/);
    expect((error as Error).message).toContain("framewatch_save_auth");
  });

  it("reports one actionable line, never a stack or a multi-line node error", async () => {
    const error = await readStorageState(join(dir, "missing", "deep.json")).catch((e: Error) => e);
    expect((error as Error).message).not.toContain("\n");
  });
});

describe("writeStorageState", () => {
  it("creates the directories the path needs", async () => {
    const path = join(dir, "nested", "deeper", "auth.json");
    await writeStorageState(STATE, path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(STATE);
  });

  it("round-trips through readStorageState", async () => {
    const path = join(dir, "round.json");
    await writeStorageState(STATE, path);
    expect(await readStorageState(path)).toEqual(STATE);
  });

  it("overwrites an existing state file rather than appending to it", async () => {
    const path = join(dir, "twice.json");
    await writeStorageState(STATE, path);
    await writeStorageState({ cookies: [], origins: [] }, path);
    expect(await readStorageState(path)).toEqual({ cookies: [], origins: [] });
  });
});

describe("storageStateSummary", () => {
  it("counts the cookies, the origins and the stored keys", () => {
    expect(storageStateSummary(STATE)).toBe("1 cookie, 1 origin with 1 stored key");
  });

  it("pluralises, and says plainly when a state carries nothing", () => {
    expect(storageStateSummary({ cookies: [], origins: [] })).toBe("no cookies and nothing in storage");
    expect(
      storageStateSummary({
        cookies: [STATE.cookies[0], STATE.cookies[0]],
        origins: [
          { origin: "http://a.test", localStorage: [{ name: "a", value: "1" }, { name: "b", value: "2" }] },
          { origin: "http://b.test", localStorage: [] },
        ],
      }),
    ).toBe("2 cookies, 2 origins with 2 stored keys");
  });
});

describe("resolveStorageState", () => {

  it("uses the default file when it exists and nothing was asked for, and says it was automatic", async () => {
    const auto = join(dir, "auto.json");
    await writeStorageState(STATE, auto);
    const auth = await resolveStorageState(undefined, { FRAMEWATCH_AUTH_STATE: auto });
    expect(auth).toMatchObject({ path: auto, auto: true });
    expect(auth?.state.cookies).toHaveLength(1);
    expect(auth?.saved_at).toBeInstanceOf(Date);
  });

  it("resolves to nothing when there is no default file, and when asked for none", async () => {
    const nowhere = join(dir, "absent.json");
    expect(await resolveStorageState(undefined, { FRAMEWATCH_AUTH_STATE: nowhere })).toBeNull();
    const auto = join(dir, "auto2.json");
    await writeStorageState(STATE, auto);
    expect(await resolveStorageState("none", { FRAMEWATCH_AUTH_STATE: auto })).toBeNull();
  });

  it("reads an explicit path as before, marked not automatic, and still fails loudly when it is missing", async () => {
    const explicit = join(dir, "explicit.json");
    await writeStorageState(STATE, explicit);
    expect(await resolveStorageState(explicit, {})).toMatchObject({ path: explicit, auto: false });
    await expect(resolveStorageState(join(dir, "nope.json"), {})).rejects.toThrow(/framewatch_save_auth/);
  });

  it("refuses a corrupt default file rather than silently ignoring it", async () => {
    const bad = join(dir, "bad-auto.json");
    await writeFile(bad, "{ not json", "utf8");
    await expect(resolveStorageState(undefined, { FRAMEWATCH_AUTH_STATE: bad })).rejects.toThrow(/storage_state: "none"/);
  });

  it("defaults to .framewatch/auth.json under the working directory unless the environment says otherwise", () => {
    expect(defaultAuthPath({}, "/work")).toBe(join("/work", ".framewatch/auth.json"));
    expect(defaultAuthPath({ FRAMEWATCH_AUTH_STATE: "/elsewhere/a.json" }, "/work")).toBe("/elsewhere/a.json");
  });
});

describe("describeAuth", () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const auth = { path: ".framewatch/auth.json", state: STATE, auto: true, saved_at: twoHoursAgo };

  it("says which file was picked up and how to skip it", () => {
    expect(describeAuth(auth, false)).toBe(
      'Auth: using .framewatch/auth.json (saved 2h ago) — pass storage_state: "none" to open the page signed out.',
    );
  });

  it("says nothing for an explicit file that worked", () => {
    expect(describeAuth({ ...auth, auto: false }, false)).toBeNull();
  });

  it("says the saved session did not sign in when a login form is showing, automatic or not", () => {
    const expected =
      "Auth: .framewatch/auth.json (saved 2h ago) did not sign you in — this page shows a login form. " +
      "Run framewatch_save_auth again to refresh it.";
    expect(describeAuth(auth, true)).toBe(expected);
    expect(describeAuth({ ...auth, auto: false }, true)).toBe(expected);
  });
});
