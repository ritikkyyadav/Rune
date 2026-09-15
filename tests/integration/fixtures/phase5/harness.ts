/**
 * Materialising a Phase 5 fixture and running its acceptance from OUTSIDE the
 * tree. Not a test file: importing a test file to borrow a helper runs its
 * suite twice, and these two helpers are shared by both Phase 5 integration
 * tests.
 */

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface AcceptanceRun {
  passed: string[];
  failed: string[];
  skipped: string[];
}

/**
 * Run a fixture's acceptance against a tree.
 *
 * A criterion marked `browser` needs a real Chromium and is SKIPPED when
 * `RUNE_TEST_PLAYWRIGHT` is unset — reported as a skip and counted as neither
 * a pass nor a failure. The spec is explicit that a skip is not a pass.
 */
export function runAcceptance(root: string, acceptancePath: string): AcceptanceRun {
  const spec = JSON.parse(readFileSync(acceptancePath, "utf-8")) as {
    criteria: Array<{ id: string; command: string; browser?: boolean }>;
  };
  const out: AcceptanceRun = { passed: [], failed: [], skipped: [] };
  for (const criterion of spec.criteria) {
    if (criterion.browser && !process.env.RUNE_TEST_PLAYWRIGHT) {
      out.skipped.push(criterion.id);
      continue;
    }
    const proc = Bun.spawnSync(["bash", "-lc", criterion.command], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    (proc.exitCode === 0 ? out.passed : out.failed).push(criterion.id);
  }
  return out;
}

/** Materialise `files/`, then lay an overlay over it the way a run would end. */
export function materialise(fixtureDir: string, overlay: string): string {
  const work = mkdtempSync(join(tmpdir(), "rune-phase5-"));
  cpSync(join(fixtureDir, "files"), work, { recursive: true });
  cpSync(join(fixtureDir, overlay), work, { recursive: true });
  return work;
}
