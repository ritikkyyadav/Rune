/**
 * The Parity Index bootstrap: seeded, stratified by task, 10th–90th percentile
 * — and, beside it and under its own name, the task-level one: whole tasks
 * resampled, 2.5th–97.5th.
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
  TASK_INTERVAL_QUANTILES,
  bootstrapClustered,
  bootstrapStratified,
  mulberry32,
  percentile,
  resampleClusters,
  resampleStratified,
  strata,
} from "../../eval/parity/bootstrap";
import { computeAxes, gateFamily, scoreFamily } from "../../eval/parity/score";
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

describe("the task-level interval: whole tasks resampled", () => {
  const items = [
    { task: "b", id: "b1" },
    { task: "a", id: "a1" },
    { task: "b", id: "b2" },
    { task: "b", id: "b3" },
    { task: "c", id: "c1" },
  ];
  const mean = (sample: { x: number }[]) => ({
    m: sample.reduce((sum, item) => sum + item.x, 0) / sample.length,
  });

  test("a replicate is as many tasks as there are, each drawn whole", () => {
    const groups = strata(items, (i) => i.task);
    const rng = mulberry32(7);
    const sizes = new Set<number>();
    for (let r = 0; r < 500; r++) {
      const sample = resampleClusters(groups, rng);
      sizes.add(sample.length);
      let at = 0;
      let drawn = 0;
      while (at < sample.length) {
        const group = groups.find((g) => g[0] === sample[at])!;
        expect(sample.slice(at, at + group.length)).toEqual(group);
        at += group.length;
        drawn++;
      }
      expect(drawn).toBe(groups.length);
    }
    // Tasks of 1, 3 and 1 pairs: three draws bring from 3 to 9, where a
    // stratified replicate is always the input's own 5.
    expect([Math.min(...sizes), Math.max(...sizes)]).toEqual([3, 9]);
  });

  test("it is a 95% interval: the 2.5th and 97.5th percentiles", () => {
    expect(TASK_INTERVAL_QUANTILES).toEqual([0.025, 0.975]);
    // Five tasks, one of them at 100 and four at 0. The replicate's mean is
    // 20·k for k draws of the 100, k ~ Binomial(5, 1/5): P(k ≤ 2) = .942 and
    // P(k ≤ 3) = .993, so the 97.5th percentile is k = 3 and the 90th is k = 2.
    const five = ["a", "b", "c", "d", "e"].map((task) => ({ task, x: task === "e" ? 100 : 0 }));
    const across = bootstrapClustered(five, (i) => i.task, mean, ["m"], { seed: DEFAULT_SEED }).m!;
    expect(across).toEqual({ lo: 0, hi: 60, replicates: BOOTSTRAP_B });
    // Stratified, every task is in every replicate: nothing moves at all.
    const within = bootstrapStratified(five, (i) => i.task, mean, ["m"], { seed: DEFAULT_SEED });
    expect(within.m).toEqual({ lo: 20, hi: 20, replicates: BOOTSTRAP_B });
  });

  test("one task has no spread across tasks: the interval is absent, not zero wide", () => {
    const one = [1, 2, 3].map((x) => ({ task: "a", x }));
    expect(bootstrapClustered(one, (i) => i.task, mean, ["m"], { seed: 1 })).toEqual({ m: null });
    expect(
      bootstrapClustered(
        [],
        (i: { task: string }) => i.task,
        () => ({ m: 1 }),
        ["m"],
        { seed: 1 },
      ),
    ).toEqual({ m: null });
    // Two is enough to resample.
    const two = [...one, { task: "b", x: 9 }];
    expect(bootstrapClustered(two, (i) => i.task, mean, ["m"], { seed: 1 }).m).not.toBeNull();
    const f = scoreFamily(
      "F1",
      "product",
      pairsOf([...pair("a", 1, {}, {}), ...pair("a", 2, {}, {})]),
      {
        seed: DEFAULT_SEED,
      },
    );
    expect(f.interval!.PI).not.toBeNull();
    expect(f.taskInterval).toBeNull();
  });

  test("seeded like the other, and drawn from a stream of its own", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ task: `t${i % 4}`, x: Math.sqrt(i + 1) }));
    const across = (seed: number) =>
      bootstrapClustered(many, (i) => i.task, mean, ["m"], { seed }).m;
    expect(across(9)).toEqual(across(9));
    expect(across(9)).not.toEqual(across(10));
    // Asking for the task-level interval moves no draw of the within-task one.
    const before = bootstrapStratified(many, (i) => i.task, mean, ["m"], { seed: 9 });
    across(9);
    expect(bootstrapStratified(many, (i) => i.task, mean, ["m"], { seed: 9 })).toEqual(before);
  });

  test("identical runs within each task: within tasks nothing moves, across tasks it does", () => {
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
    expect(f.interval!.O!.hi - f.interval!.O!.lo).toBeCloseTo(0, 9);
    // Drawing task b three times is O = 50; never drawing it is O = 100.
    expect(f.taskInterval!.O).toMatchObject({ lo: 50, hi: 100, replicates: BOOTSTRAP_B });
    expect(f.taskInterval!.PI!.hi - f.taskInterval!.PI!.lo).toBeGreaterThan(10);
    // No pair has both arms at q = 1 four times over: E is absent in both.
    expect(f.interval!.E).toBeNull();
    expect(f.taskInterval!.E).toBeNull();
    // The gate reads the within-task bound, as it always has; the other is reported.
    expect({ status: f.status, reasons: f.reasons }).toEqual(
      gateFamily({
        axes: f.axes!,
        PI: f.PI!,
        piLower: f.interval!.PI!.lo,
        n: f.n,
        tasks: f.tasks.length,
        efficiencyPairs: f.efficiency.pairs,
      }),
    );
    expect(f.reasons.some((reason) => reason.startsWith("PI lower bound"))).toBe(false);
    expect(f.taskInterval!.PI!.lo).toBeLessThan(85);
  });
});

describe("E's interval exists only where E does, at either level", () => {
  test("three both-succeeded pairs: no E, and no interval for it however a resample falls", () => {
    // Task a twice over gives four both-succeeded pairs: E exists in such
    // replicates, and at the point it does not.
    const rows = [
      ...pair("a", 1, {}, {}),
      ...pair("a", 2, {}, {}),
      ...pair("b", 1, {}, {}),
      ...pair("c", 1, { passed: 2 }, {}),
    ];
    const f = scoreFamily("F1", "product", pairsOf(rows), { seed: DEFAULT_SEED });
    expect(f.axes!.E).toBeNull();
    expect(f.efficiency.pairs).toBe(3);
    expect(f.interval!.E).toBeNull();
    expect(f.taskInterval!.E).toBeNull();
    expect(f.taskInterval!.PI).not.toBeNull();
    // The replicates where it would have existed are real: resampled by hand, E is there.
    const across = bootstrapClustered(
      pairsOf(rows).map(toScored),
      (p) => p.task,
      (sample) => ({ E: computeAxes(sample, "product")!.axes.E }),
      ["E"],
      { seed: DEFAULT_SEED },
    );
    expect(across.E!.replicates).toBeGreaterThan(0);
    expect(across.E!.replicates).toBeLessThan(BOOTSTRAP_B);
  });
});

describe("the family interval", () => {
  const golden = pairsOf(goldenPairs());

  test("the golden family's interval is the one it had before the task-level one existed", () => {
    // B = 400, the default seed: the bounds parity-report/1 printed for these rows.
    const f = scoreFamily("F1", "product", golden, { seed: DEFAULT_SEED, b: 400 });
    expect(`${f.interval!.PI!.lo.toFixed(1)}–${f.interval!.PI!.hi.toFixed(1)}`).toBe("77.4–98.3");
    expect(f.taskInterval!.PI!.replicates).toBe(400);
    expect(f.taskInterval!.PI!.lo).toBeLessThanOrEqual(f.interval!.PI!.lo);
  });

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
