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

// ─── The governance gate (P12.1) ───
// Unlike the two transcript ceilings this one is a DELTA against the recorded
// baseline, because there is no known-correct absolute number: a task that
// genuinely needs three compactions needs three summarizer calls. What must
// not happen is the figure drifting up unnoticed — 45% of this agent's
// recorded incidents are provider rate limits, and a free tier meters
// requests, not dollars.
import { GOVERNANCE_TOLERANCE } from "../../../tests/eval/report";

function governanceReport(avgGovernanceCompletions?: number): SuiteReport {
  return {
    ...report(0.1),
    ...(avgGovernanceCompletions != null ? { avgGovernanceCompletions } : {}),
  } as SuiteReport;
}

function governanceBaseline(avgGovernanceCompletions?: number): BaselineFile {
  return {
    ...baseline(0.1),
    ...(avgGovernanceCompletions != null ? { avgGovernanceCompletions } : {}),
  } as BaselineFile;
}

describe("governance-completions gate", () => {
  test("more of Rune's own calls per task fails the build with every task passing", () => {
    const out = compareToBaseline(governanceReport(6), governanceBaseline(3), 0.05);
    expect(out.ok).toBe(false);
    expect(out.reasons.join(" ")).toContain("governance completions per task rose 100%");
    expect(out.governanceDelta).toBeCloseTo(1, 6);
  });

  test("drift inside the tolerance passes", () => {
    const out = compareToBaseline(governanceReport(3.4), governanceBaseline(3), 0.05);
    expect(out.ok).toBe(true);
    expect(out.governanceDelta).toBeCloseTo(0.1333, 3);
  });

  test("making FEWER of its own calls is never a regression", () => {
    const out = compareToBaseline(governanceReport(1), governanceBaseline(3), 0.05);
    expect(out.ok).toBe(true);
    expect(out.governanceDelta).toBeLessThan(0);
  });

  test("a baseline written before the meter existed cannot manufacture a regression", () => {
    // "Not measured" and "made none" are different facts. A gate that read a
    // missing meter as zero would fail every run after this shipped.
    expect(compareToBaseline(governanceReport(4), governanceBaseline(), 0.05).ok).toBe(true);
    expect(compareToBaseline(governanceReport(4), governanceBaseline(0), 0.05).ok).toBe(true);
  });

  test("a run that recorded nothing is not judged against a baseline that did", () => {
    const out = compareToBaseline(governanceReport(), governanceBaseline(3), 0.05);
    expect(out.ok).toBe(true);
    expect(out.governanceDelta).toBeUndefined();
  });

  test("the tolerance is deliberate and matches the cost gate's band", () => {
    expect(GOVERNANCE_TOLERANCE).toBe(0.2);
  });
});
