import { defineConfig } from "vitest/config";
import path from "path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Isolated HOME for tests. The temp dir is created at config-load time so its
// path can be passed through the `env` option, which vitest propagates to every
// worker. Mutating process.env inside globalSetup does NOT reliably reach worker
// threads (the prior approach silently left CCR_CONFIG_DIR empty, so HOME_DIR
// fell back to the user's real ~/.claude-code-router and tests wrote real state).
// A deterministic path lets the globalSetup teardown clean the same directory.
const TEST_HOME = path.join(tmpdir(), "ccr-core-test-home");
rmSync(TEST_HOME, { recursive: true, force: true });
mkdirSync(TEST_HOME, { recursive: true });

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    globalSetup: ["./src/__tests__/setup.ts"],
    env: {
      CCR_CONFIG_DIR: TEST_HOME,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
