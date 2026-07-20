/**
 * vitest globalSetup — teardown for the isolated test HOME created in
 * vitest.config.ts.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup(): () => void {
  return () => {
    rmSync(join(tmpdir(), "ccr-shared-test-home"), { recursive: true, force: true });
  };
}
