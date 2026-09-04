import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RawServer } from "./helpers/raw-server.js";

/**
 * What `npm publish` would actually ship, and whether it runs.
 *
 * Everything else in this suite tests the repository. A published package is a
 * different artifact: it has no `src/`, no dev dependencies and no build step,
 * and it is reached through npm's bin shim rather than by path. The failure
 * mode this file exists for is `npx framewatch-mcp-server` printing a module
 * resolution error at a user who has no way to debug it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, any>;

let workdir: string;
/** The unpacked tarball: `<workdir>/package`, exactly as npm would install it. */
let installed: string;
/** Every path inside the tarball, relative to the package root. */
let shipped: string[];

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "framewatch-pack-"));

  // --dry-run would tell us the file list, but not give us something to run.
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", workdir], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [meta] = JSON.parse(output) as [{ filename: string; files: { path: string }[] }];
  shipped = meta.files.map((f) => f.path);

  execFileSync("tar", ["-xzf", join(workdir, meta.filename)], { cwd: workdir });
  installed = join(workdir, "package");

  // The tarball has no dependencies of its own; npm would install them next to
  // it, so borrow the ones already here rather than downloading Chromium again.
  symlinkSync(join(ROOT, "node_modules"), join(installed, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}, 120_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("package metadata", () => {
  it("carries everything a registry listing needs", () => {
    expect(PKG.name).toBe("framewatch-mcp-server");
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(PKG.description).toBeTruthy();
    expect(PKG.license).toBe("MIT");
    expect(PKG.author).toBeTruthy();
    expect(PKG.repository?.url).toContain("github.com");
    expect(PKG.bugs?.url).toContain("github.com");
    expect(PKG.homepage).toBe("https://framewatch.keko.dev");
    expect(PKG.keywords).toContain("mcp");
    expect(PKG.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("declares an engine range that the Node running these tests satisfies", () => {
    expect(PKG.engines?.node).toMatch(/^>=\d+/);
    const floor = Number(/^>=(\d+)/.exec(PKG.engines.node)![1]);
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(floor);
  });

  it("ships as ESM, which is what the compiled output is", () => {
    expect(PKG.type).toBe("module");
  });

  it("keeps the browser out of the dependency list it cannot install", () => {
    // playwright, not playwright-core: the tool tells the user to run
    // `npx playwright install chromium`, and that command has to exist.
    expect(Object.keys(PKG.dependencies)).toContain("playwright");
  });
});

describe("the packed tarball", () => {
  it("ships the built output, the licence and the readme", () => {
    expect(shipped).toContain("dist/index.js");
    expect(shipped).toContain("package.json");
    expect(shipped).toContain("README.md");
    expect(shipped).toContain("LICENSE");
  });

  it("ships every entry point package.json points at", () => {
    const entries = [PKG.bin["framewatch-mcp-server"], PKG.main, PKG.types, PKG.exports["."].default, PKG.exports["."].types];
    for (const entry of entries) {
      expect(existsSync(join(installed, entry))).toBe(true);
    }
  });

  it("does not ship sources, tests or build configuration", () => {
    expect(shipped.some((p) => p.startsWith("src/"))).toBe(false);
    expect(shipped.some((p) => p.startsWith("test/"))).toBe(false);
    expect(shipped.some((p) => p.startsWith("tsconfig"))).toBe(false);
    // The README is the only markdown that belongs in the package.
    expect(shipped.filter((p) => p.endsWith(".md"))).toEqual(["README.md"]);
  });

  it("gives the bin entry a shebang, which is what makes npm's shim executable", () => {
    const bin = readFileSync(join(installed, PKG.bin["framewatch-mcp-server"]), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("keeps the source maps usable by inlining the sources it does not ship", () => {
    const map = JSON.parse(readFileSync(join(installed, "dist/index.js.map"), "utf8")) as { sourcesContent?: string[] };
    expect(map.sourcesContent?.[0]).toContain("createServer");
  });
});

describe("the packed tarball, run", () => {
  it("answers initialize as framewatch at the published version", async () => {
    const server = new RawServer({}, join(installed, PKG.bin["framewatch-mcp-server"]));
    try {
      const init = await Promise.race([
        server.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("packed server never answered initialize")), 10_000)),
      ]);
      expect((init as any).result.serverInfo.name).toBe("framewatch");
      // The server reads its own version out of the package.json next to dist/,
      // so this also proves package.json survived the pack.
      expect((init as any).result.serverInfo.version).toBe(PKG.version);
    } finally {
      await server.dispose();
    }
  });

  it("registers all seventeen tools from the packed build", async () => {
    const server = new RawServer({}, join(installed, PKG.bin["framewatch-mcp-server"]));
    try {
      await server.initialize();
      const listed = await server.request("tools/list");
      expect(listed.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "framewatch_accessibility",
        "framewatch_api_mock",
        "framewatch_capture",
        "framewatch_compare",
        "framewatch_dead_clicks",
        "framewatch_form_test",
        "framewatch_inspect",
        "framewatch_interact",
        "framewatch_links",
        "framewatch_responsive",
        "framewatch_rtl",
        "framewatch_save_auth",
        "framewatch_screenshot",
        "framewatch_seo",
        "framewatch_snapshot",
        "framewatch_start_server",
        "framewatch_stop_server",
        "framewatch_wait_for",
      ]);
    } finally {
      await server.dispose();
    }
  });
});
