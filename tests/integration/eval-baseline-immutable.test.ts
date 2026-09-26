/**
 * P10.4a — the RUNNER leaves the committed eval baseline untouched.
 *
 * The writer's half of this fix is unit-tested in
 * `tests/unit/evolve/baseline-immutable.test.ts`. This half spawns the thing CI
 * actually invokes — `tests/eval/runner.ts --compare` — and checks the committed
 * baseline is byte-identical afterwards.
 *
 * It lives here rather than in the unit suite because the runner drives the
 * native `rune-tools` binary and refuses to score without it
 * (`assertToolsBinary`). The unit jobs never build that binary, so in
 * `tests/unit/` this case failed on every runner with "the native tool binary
 * is not executable" — about the rig, not the baseline. The integration job
 * builds it, and a missing binary is still a loud failure here, not a skip.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RUNNER = join(REPO_ROOT, "tests", "eval", "runner.ts");
const MOCK_BASELINE = join(REPO_ROOT, "tests", "eval", "baseline-mock.json");

describe("the runner leaves the committed baseline untouched", () => {
  it("a passing --compare run prints 'baseline unchanged' and writes nothing", async () => {
    const before = readFileSync(MOCK_BASELINE);
    const beforeMtime = statSync(MOCK_BASELINE).mtimeMs;

    const proc = Bun.spawn(
      ["bun", RUNNER, "--compare", "--tasks", "tool-discipline", "--max", "1"],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    const after = readFileSync(MOCK_BASELINE);
    expect(after.equals(before)).toBe(true);
    expect(statSync(MOCK_BASELINE).mtimeMs).toBe(beforeMtime);
    expect(`${stdout}${stderr}`).toContain("baseline unchanged");
  }, 180_000);
});
