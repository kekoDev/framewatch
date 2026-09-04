import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser-backed tests share a single Playwright instance per process;
    // run files sequentially to avoid launching several browsers at once.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
      // Two things this report structurally cannot see: the DOM and performance
      // probes, which run inside Chromium, and src/index.ts plus the register*Tool
      // functions, which run in a child process. Both are covered by tests that
      // assert on their output — read low numbers there as uninstrumented.
    },
  },
});
