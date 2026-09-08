/**
 * The cost-regression gate.
 *
 * The suite has always reported a pass rate and never a price, so a change that
 * kept every task passing while quintupling the tokens was invisible. Breaking
 * the prompt cache is exactly that change — nothing fails, everything costs
 * five times more.
 *
 * The gate compares METERED-EQUIVALENT cost, because eval runs ride free and
 * subscription routes where actual spend is $0 no matter how much work is done.
 */
import { describe, expect, test } from "bun:test";
import {
  compareToBaseline,
  DEFAULT_COST_DRIFT_TOLERANCE,
  type BaselineFile,
  type SuiteReport,
} from "../../../tests/eval/report";

function report(avgListCostPerTask: number, cleanPassRate = 1): SuiteReport {
  return {
    timestamp: new Date().toISOString(),
    mode: "real",
    model: "m",
    provider: "p",
    total: 10,
    passed: 10,
    passRate: 1,
    throttled: 0,
    measured: 10,
    cleanPassRate,
    totalCost: 0,
    avgCostPerTask: 0,
    totalListCost: avgListCostPerTask * 10,
    avgListCostPerTask,
    avgDurationMs: 1,
    avgTurns: 1,
    categories: [],
    tasks: [],
  } as unknown as SuiteReport;
}

function baseline(avgListCostPerTask: number, cleanPassRate = 1): BaselineFile {
  return {
    mode: "real",
    model: "m",
    provider: "p",
    cleanPassRate,
    avgListCostPerTask,
  } as unknown as BaselineFile;
}

describe("cost-regression gate", () => {
  test("a broken prompt cache fails the build even with every task passing", () => {
    // ~5x is the measured shape of losing the cache discount entirely.
    const out = compareToBaseline(report(0.5), baseline(0.1), 0.05);
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain("cost per task rose");
    expect(out.costDelta).toBeCloseTo(4, 6);
  });

  test("ordinary drift inside the tolerance passes", () => {
    const out = compareToBaseline(report(0.12), baseline(0.1), 0.05);
    expect(out.ok).toBe(true);
    expect(out.costDelta).toBeCloseTo(0.2, 6);
  });

  test("getting cheaper is never a regression", () => {
    const out = compareToBaseline(report(0.02), baseline(0.1), 0.05);
    expect(out.ok).toBe(true);
    expect(out.costDelta).toBeLessThan(0);
  });

  test("a baseline with no cost recorded cannot manufacture a regression", () => {
    // The first run after this gate ships compares against a baseline written
    // before cost existed. Dividing by zero there would fail every build.
    const out = compareToBaseline(report(0.5), baseline(0), 0.05);
    expect(out.ok).toBe(true);
  });

  test("the tolerance is adjustable and defaults to something deliberate", () => {
    expect(DEFAULT_COST_DRIFT_TOLERANCE).toBeGreaterThan(0);
    const strict = compareToBaseline(report(0.12), baseline(0.1), 0.05, 0.1);
    expect(strict.ok).toBe(false);
  });

  test("the pass-rate gate still fires independently of cost", () => {
    const out = compareToBaseline(report(0.1, 0.5), baseline(0.1, 0.95), 0.05);
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain("cleanPassRate");
  });
});

// ─── The transcript gates ───
// Two absolute ceilings from the transcript diagnosis of 2026-09-05: prose
// about the harness (A: under 15%) and active time without a new row (B:
// under 15%). Absolute, because a run whose prose is 62% about the ledger is
// wrong whatever the baseline scored.
import { HARNESS_TALK_CEILING, SILENCE_CEILING } from "../../../tests/eval/report";

function transcriptReport(avgHarnessTalk?: number, avgSilence?: number): SuiteReport {
  return {
    ...report(0.1),
    ...(avgHarnessTalk != null ? { avgHarnessTalk } : {}),
    ...(avgSilence != null ? { avgSilence } : {}),
  } as SuiteReport;
}

describe("transcript gates", () => {
  test("the ceilings are the diagnosis's done-when numbers", () => {
    expect(HARNESS_TALK_CEILING).toBe(0.15);
    expect(SILENCE_CEILING).toBe(0.15);
  });

  test("harness talk over the ceiling fails the build with every task passing", () => {
    const out = compareToBaseline(transcriptReport(0.62, 0.05), baseline(0.1), 0.05);
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain("harness talk 62%");
  });

  test("silence over the ceiling fails the build", () => {
    const out = compareToBaseline(transcriptReport(0.02, 0.45), baseline(0.1), 0.05);
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain("silence 45%");
  });

  test("under both ceilings passes, and an unmeasured run is not judged", () => {
    expect(compareToBaseline(transcriptReport(0.1, 0.12), baseline(0.1), 0.05).ok).toBe(true);
    expect(compareToBaseline(transcriptReport(), baseline(0.1), 0.05).ok).toBe(true);
  });
});
