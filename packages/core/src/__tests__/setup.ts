/**
 * vitest globalSetup — teardown for the isolated test HOME created in
 * vitest.config.ts. The dir path is deterministic (ccr-core-test-home under the
 * OS tmpdir) so this teardown can remove the same directory the workers used.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup(): () => void {
  return () => {
    rmSync(join(tmpdir(), "ccr-core-test-home"), { recursive: true, force: true });
  };
}
