/**
 * P7.4 — the paired A/B gate.
 *
 * `compareArms` is the thing standing between "the number went up" and a
 * change to how the agent behaves, so its refusals matter more than its
 * acceptances. Each test below is one way a false win gets manufactured:
 * an aggregate that improves while a task breaks, a tie reported as progress,
 * a rate limit landing on one arm, cost quietly tripling for a point of pass
 * rate.
 */

import { describe, expect, it } from "bun:test";

import { compareArms } from "../../../tests/eval/report";
import type { SuiteReport } from "../../../tests/eval/report";
import type { TaskResult } from "../../../tests/eval/harness";

function task(name: string, pass: boolean, extra: Partial<TaskResult> = {}): TaskResult {
  return {
    name,
    category: "core",
    pass,
    durationMs: 100,
    cost: 0,
    listCost: 0.01,
    turns: 1,
    ...extra,
  };
}

function report(tasks: TaskResult[], mode: "mock" | "real" = "mock"): SuiteReport {
  const passed = tasks.filter((t) => t.pass).length;
  const throttled = tasks.filter((t) => t.throttled).length;
  const measured = tasks.length - throttled;
  return {
    timestamp: "2026-09-02T00:00:00.000Z",
    mode,
    total: tasks.length,
    passed,
    passRate: tasks.length ? passed / tasks.length : 0,
    throttled,
    measured,
    cleanPassRate: measured ? passed / measured : 0,
    totalCost: 0,
    avgCostPerTask: 0,
    totalListCost: tasks.reduce((s, t) => s + (t.listCost ?? 0), 0),
    avgListCostPerTask: 0,
    avgDurationMs: 100,
    avgTurns: 1,
    categories: [],
    tasks,
  };
}

describe("compareArms refuses the ways a false win is manufactured", () => {
  it("accepts a clean win: a task fixed, nothing broken, cost flat", () => {
    const control = report([task("a", true), task("b", false), task("c", true)]);
    const treatment = report([task("a", true), task("b", true), task("c", true)]);
    const cmp = compareArms("doctrine_full", control, treatment);
    expect(cmp.win).toBe(true);
    expect(cmp.refusals).toEqual([]);
    expect(cmp.fixes).toEqual(["b"]);
    expect(cmp.regressions).toEqual([]);
    expect(cmp.rateDelta).toBeCloseTo(1 / 3);
  });

  it("refuses when a task regresses even though the aggregate improves", () => {
    // Two fixed, one broken: +33% on the aggregate, and a defect shipped.
    const control = report([task("a", false), task("b", false), task("c", true)]);
    const treatment = report([task("a", true), task("b", true), task("c", false)]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.rateDelta).toBeGreaterThan(0);
    expect(cmp.win).toBe(false);
    expect(cmp.regressions).toEqual(["c"]);
    expect(cmp.refusals.join(" ")).toContain("1 task(s) regressed");
  });

  it("refuses a tie — equal is not a win", () => {
    const same = [task("a", true), task("b", false)];
    const cmp = compareArms("v", report(same), report(same));
    expect(cmp.rateDelta).toBe(0);
    expect(cmp.win).toBe(false);
    expect(cmp.refusals.join(" ")).toContain("equal is not a win");
  });

  it("refuses a regression outright", () => {
    const control = report([task("a", true), task("b", true)]);
    const treatment = report([task("a", true), task("b", false)]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.win).toBe(false);
    expect(cmp.rateDelta).toBeLessThan(0);
  });

  it("excludes a task throttled on either arm rather than counting it", () => {
    // A rate limit on one arm and not the other is the single easiest way to
    // manufacture a win: the control "fails", the treatment "passes".
    const control = report([task("a", false, { throttled: true }), task("b", true)]);
    const treatment = report([task("a", true), task("b", true)]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.compared).toBe(1);
    expect(cmp.excluded).toEqual(["a (throttled)"]);
    expect(cmp.rateDelta).toBe(0);
    expect(cmp.win).toBe(false);
  });

  it("excludes a task missing from one arm", () => {
    const control = report([task("a", true), task("b", false)]);
    const treatment = report([task("a", true)]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.compared).toBe(1);
    expect(cmp.excluded.join(" ")).toContain("b (missing from the treatment arm)");
  });

  it("refuses when nothing was measured on both arms", () => {
    const cmp = compareArms("v", report([]), report([]));
    expect(cmp.win).toBe(false);
    expect(cmp.refusals.join(" ")).toContain("no task was measured on both arms");
  });

  it("refuses a pass-rate win bought with cost beyond the band", () => {
    const control = report([task("a", false), task("b", true)]);
    const treatment = report([
      task("a", true, { listCost: 0.5 }),
      task("b", true, { listCost: 0.5 }),
    ]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.fixes).toEqual(["a"]);
    expect(cmp.costDelta).toBeGreaterThan(1);
    expect(cmp.win).toBe(false);
    expect(cmp.refusals.join(" ")).toContain("exceeds the 10% band");
  });

  it("reports no cost delta rather than zero when the control cost nothing", () => {
    // Free and subscription routes report $0 actual. A costDelta of 0 there
    // would be a claim; null is the truth.
    const control = report([task("a", false, { listCost: 0 })]);
    const treatment = report([task("a", true, { listCost: 0 })]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.costDelta).toBeNull();
  });

  it("uses a zero noise band in mock mode and a real one in real mode", () => {
    const control = report(
      [task("a", false), ...Array.from({ length: 19 }, (_, i) => task(`t${i}`, true))],
      "real",
    );
    const treatment = report(
      [task("a", true), ...Array.from({ length: 19 }, (_, i) => task(`t${i}`, true))],
      "real",
    );
    const cmp = compareArms("v", control, treatment);
    // +5% exactly, against a 5% band: not beyond it, so not a win.
    expect(cmp.noiseBand).toBeCloseTo(0.05);
    expect(cmp.rateDelta).toBeCloseTo(0.05);
    expect(cmp.win).toBe(false);
    expect(compareArms("v", report([task("a", false)]), report([task("a", true)])).noiseBand).toBe(
      0,
    );
  });

  it("carries the config digest of each arm", () => {
    const control = report([task("a", false, { configHash: "aaaaaaaaaaaa" })]);
    const treatment = report([task("a", true, { configHash: "bbbbbbbbbbbb" })]);
    const cmp = compareArms("v", control, treatment);
    expect(cmp.controlConfigHash).toBe("aaaaaaaaaaaa");
    expect(cmp.treatmentConfigHash).toBe("bbbbbbbbbbbb");
  });
});
