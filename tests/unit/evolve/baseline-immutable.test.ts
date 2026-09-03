/**
 * P10.4a — the eval baseline is a yardstick, not a mirror.
 *
 * `bun run eval -- --compare` used to re-anchor `tests/eval/baseline-mock.json`
 * on every passing run: compare against the baseline, declare no regression,
 * then overwrite the baseline with the run that had just been judged. A ruler
 * that redraws itself to match the last thing it measured cannot detect drift,
 * and the visible symptom was a dirty baseline file in every lane, reverted by
 * hand by every agent that ran the gate.
 *
 * These tests hold the two halves of the fix: the writer never promotes unless
 * asked, and the RUNNER — the thing CI actually invokes — leaves the committed
 * baseline byte-identical after a passing `--compare`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBaseline, baselinePathFor } from "../../../tests/eval/report";
import type { SuiteReport } from "../../../tests/eval/report";
import type { TaskResult } from "../../../tests/eval/harness";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const RUNNER = join(REPO_ROOT, "tests", "eval", "runner.ts");
const MOCK_BASELINE = join(REPO_ROOT, "tests", "eval", "baseline-mock.json");

function report(overrides: Partial<SuiteReport> = {}): SuiteReport {
  const tasks: TaskResult[] = [
    { name: "t1", category: "core", pass: true, durationMs: 10, cost: 0, listCost: 0, turns: 1 },
  ];
  return {
    timestamp: "2026-09-03T00:00:00.000Z",
    mode: "mock",
    total: 1,
    passed: 1,
    passRate: 1,
    throttled: 0,
    measured: 1,
    cleanPassRate: 1,
    totalCost: 0,
    avgCostPerTask: 0,
    totalListCost: 0,
    avgListCostPerTask: 0,
    avgDurationMs: 10,
    avgTurns: 1,
    categories: [],
    tasks,
    ...overrides,
  };
}

describe("writeBaseline", () => {
  it("archives the run but leaves the baseline alone by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-baseline-"));
    try {
      const baseline = baselinePathFor("mock", dir);
      writeFileSync(baseline, '{"marker":"original"}\n');
      const before = readFileSync(baseline, "utf8");

      const out = await writeBaseline(report(), false, {
        baselineDir: dir,
        resultsDir: join(dir, "results"),
        quiet: true,
      });

      expect(out.promoted).toBe(false);
      expect(readFileSync(baseline, "utf8")).toBe(before);
      // The run is still on the record — archived, never lost.
      expect(readdirSync(join(dir, "results")).length).toBe(1);
      expect(statSync(out.archivePath).size).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-anchors only when explicitly asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-baseline-"));
    try {
      const baseline = baselinePathFor("mock", dir);
      writeFileSync(baseline, '{"marker":"original"}\n');

      const out = await writeBaseline(report(), true, {
        baselineDir: dir,
        resultsDir: join(dir, "results"),
        quiet: true,
      });

      expect(out.promoted).toBe(true);
      const written = JSON.parse(readFileSync(baseline, "utf8")) as { cleanPassRate?: number };
      expect(written.cleanPassRate).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a throttled run still cannot move the baseline on its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-baseline-"));
    try {
      const baseline = baselinePathFor("mock", dir);
      writeFileSync(baseline, '{"marker":"original"}\n');
      const out = await writeBaseline(report({ throttled: 1, measured: 0 }), false, {
        baselineDir: dir,
        resultsDir: join(dir, "results"),
        quiet: true,
      });
      expect(out.promoted).toBe(false);
      expect(readFileSync(baseline, "utf8")).toBe('{"marker":"original"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
