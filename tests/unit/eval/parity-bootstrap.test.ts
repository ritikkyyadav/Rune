/**
 * The Parity Index bootstrap: seeded, stratified by task, 10th–90th percentile.
 *
 * The stratification test is built so that only a stratified resample can give
 * a zero-width interval: every task's pairs are identical within the task and
 * different across tasks, so resampling within a task always rebuilds the same
 * set, while resampling across tasks changes the mix in almost every replicate.
 */

import { describe, expect, test } from "bun:test";

import { pairRows } from "../../eval/parity/aggregate";
import {
  BOOTSTRAP_B,
  DEFAULT_SEED,
  INTERVAL_QUANTILES,
  bootstrapStratified,
  mulberry32,
  percentile,
  resampleStratified,
  strata,
} from "../../eval/parity/bootstrap";
import { computeAxes, scoreFamily } from "../../eval/parity/score";
import type { ParityRunResult } from "../../eval/parity/types";
import { GOLDEN, goldenPairs, pair } from "../../fixtures/parity/rows";

const pairsOf = (rows: ParityRunResult[]) => pairRows(rows, "product", "claude-code").pairs;

describe("mulberry32", () => {
  test("the same seed gives the same stream; another seed another stream", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(xs);
  });

  test("uniform on [0, 1)", () => {
    const rng = mulberry32(DEFAULT_SEED);
    let sum = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = rng();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(Math.abs(sum / 20_000 - 0.5)).toBeLessThan(0.01);
  });
});

describe("percentile (linear between order statistics)", () => {
  test("by hand", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.1)).toBeCloseTo(1.4, 12);
    expect(percentile([5, 1, 4, 2, 3], 0.9)).toBeCloseTo(4.6, 12);
    expect(percentile([7], 0.1)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });

  test("the interval is 80%: the 10th and 90th percentiles", () => {
    expect(INTERVAL_QUANTILES).toEqual([0.1, 0.9]);
    expect(BOOTSTRAP_B).toBe(2000);
  });
});

describe("resampling is stratified by task", () => {
  const items = [
    { task: "b", id: "b1" },
    { task: "a", id: "a1" },
    { task: "b", id: "b2" },
    { task: "b", id: "b3" },
    { task: "c", id: "c1" },
  ];

  test("strata come out in task order, items in input order", () => {
    expect(strata(items, (i) => i.task).map((g) => g.map((i) => i.id))).toEqual([
      ["a1"],
      ["b1", "b2", "b3"],
      ["c1"],
    ]);
  });

  test("every replicate keeps each task's count and draws only from that task", () => {
    const groups = strata(items, (i) => i.task);
    const rng = mulberry32(7);
    for (let r = 0; r < 500; r++) {
      const sample = resampleStratified(groups, rng);
      expect(sample.length).toBe(items.length);
      expect(sample.slice(0, 1).every((i) => i.task === "a")).toBe(true);
      expect(sample.slice(1, 4).every((i) => i.task === "b")).toBe(true);
      expect(sample.slice(4).every((i) => i.task === "c")).toBe(true);
    }
  });

  test("identical pairs within each task: the interval collapses to the point", () => {
    // Task a: both succeed. Task b: Rune half-fails. Task c: the comparator half-fails.
    const rows = [
      ...pair("a", 1, {}, {}),
      ...pair("a", 2, {}, {}),
      ...pair("b", 1, { passed: 2 }, {}),
      ...pair("b", 2, { passed: 2 }, {}),
      ...pair("c", 1, {}, { passed: 2 }),
      ...pair("c", 2, {}, { passed: 2 }),
    ];
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: DEFAULT_SEED });
    expect(f.interval!.PI!.lo).toBeCloseTo(f.PI!, 9);
    expect(f.interval!.PI!.hi).toBeCloseTo(f.PI!, 9);
    expect(f.interval!.O!.hi - f.interval!.O!.lo).toBeCloseTo(0, 9);
  });

  test("an unstratified resample of the same pairs would not collapse", () => {
    // The control for the test above: pooled resampling moves the mix of tasks.
    const rows = [
      ...pair("a", 1, {}, {}),
      ...pair("a", 2, {}, {}),
      ...pair("b", 1, { passed: 2 }, {}),
      ...pair("b", 2, { passed: 2 }, {}),
      ...pair("c", 1, {}, { passed: 2 }),
      ...pair("c", 2, {}, { passed: 2 }),
    ];
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: DEFAULT_SEED });
    const pooled = bootstrapStratified(
      pairsOf(rows),
      () => "one stratum",
      (sample) => ({ O: computeAxes(sample.map(toScored), "product")!.axes.O }),
      ["O"],
      { seed: DEFAULT_SEED },
    );
    expect(pooled.O!.hi - pooled.O!.lo).toBeGreaterThan(1);
    expect(f.interval!.O!.hi - f.interval!.O!.lo).toBeCloseTo(0, 9);
  });
});

// A raw pair as the scorer's included pair, for the pooled control above.
function toScored(p: ReturnType<typeof pairsOf>[number]) {
  const q = (r: ParityRunResult) => r.outcome.hiddenPassed / r.outcome.hiddenTotal;
  const side = (r: ParityRunResult) => ({
    q: q(r),
    clean: r.clean,
    scope: r.scope,
    wallMs: r.wallMs,
    calls: r.calls,
    listUsd: r.listUsd,
  });
  return { task: p.task, run: p.run, family: p.family, r: side(p.rune), c: side(p.comparator) };
}

describe("the family interval", () => {
  const golden = pairsOf(goldenPairs());

  test("seeded: the same seed reproduces the interval to the last digit", () => {
    const a = scoreFamily("F1", "product", golden, { seed: 9 });
    const b = scoreFamily("F1", "product", golden, { seed: 9 });
    expect(a.interval).toEqual(b.interval);
  });

  test("another seed draws other replicates", () => {
    // A continuous statistic: the golden family's axes take few distinct values,
    // so two seeds can land on the same order statistics there.
    const items = Array.from({ length: 12 }, (_, i) => ({
      task: `t${i % 3}`,
      x: Math.sqrt(i + 1),
    }));
    const run = (seed: number) =>
      bootstrapStratified(
        items,
        (i) => i.task,
        (s) => ({ m: s.reduce((a, i) => a + i.x, 0) / s.length }),
        ["m"],
        { seed },
      ).m;
    expect(run(9)).toEqual(run(9));
    expect(run(9)).not.toEqual(run(10));
  });

  test("the input order does not move the interval", () => {
    const a = scoreFamily("F1", "product", golden, { seed: 9 });
    const b = scoreFamily("F1", "product", [...golden].reverse(), { seed: 9 });
    expect(b.interval).toEqual(a.interval);
  });

  test("PI and every axis carry an interval over all B replicates, the point inside", () => {
    const f = scoreFamily("F1", "product", golden, { seed: DEFAULT_SEED });
    expect(f.PI).toBeCloseTo(GOLDEN.PI, 9);
    for (const k of ["PI", "O", "R", "S"] as const) {
      const i = f.interval![k]!;
      expect(i.replicates).toBe(BOOTSTRAP_B);
      expect(i.lo).toBeLessThanOrEqual(i.hi);
    }
    // E exists only in replicates with at least four both-succeeded pairs.
    const e = f.interval!.E!;
    expect(e.replicates).toBeGreaterThan(0);
    expect(e.replicates).toBeLessThanOrEqual(BOOTSTRAP_B);
    expect(f.interval!.PI!.lo).toBeLessThanOrEqual(f.PI!);
    expect(f.interval!.PI!.hi).toBeGreaterThanOrEqual(f.PI! - 5);
  });

  test("the gate reads the bootstrap's lower bound", () => {
    const f = scoreFamily("F1", "product", golden, { seed: DEFAULT_SEED });
    const lower = f.interval!.PI!.lo;
    expect(f.status).toBe(lower >= 85 ? "PASS" : "PROVISIONAL");
    if (lower < 85) expect(f.reasons.some((r) => r.startsWith("PI lower bound"))).toBe(true);
  });
});
