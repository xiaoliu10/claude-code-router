import { defineConfig } from "vitest/config";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated HOME for tests — created at config-load so the path propagates to
// workers via `env`. See packages/core/vitest.config.ts for the full rationale.
const TEST_HOME = join(tmpdir(), "ccr-shared-test-home");
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
});
