/**
 * Reporting utilities for the eval suite.
 * Prints pass-rate, $/task, avg turns, per-category breakdown,
 * and writes a baseline to tests/eval/baseline.json.
 */
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import type { TaskResult } from "./harness";

export interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  passRate: number;
  /** Tasks defeated by a provider rate/usage limit (excluded from cleanPassRate). */
  throttled: number;
  /** passed / (total - throttled): the rate over actually-measured tasks. */
  cleanPassRate: number;
  avgDurationMs: number;
  totalCost: number;
  avgCost: number;
  avgTurns: number;
}

export interface SuiteReport {
  timestamp: string;
  mode: "mock" | "real";
  model?: string;
  provider?: string;
  total: number;
  passed: number;
  passRate: number;
  /** Count of tasks excluded as throttle-contaminated. */
  throttled: number;
  /** Count of tasks excluded because infrastructure ended them. Absent when none. */
  infra?: number;
  /** Tasks that actually produced a measurable result (total - throttled - infra). */
  measured: number;
  /** passed / measured — the trustworthy number. NaN-safe (0 when measured=0). */
  cleanPassRate: number;
  totalCost: number;
  avgCostPerTask: number;
  /** Metered-equivalent totals — see the note at the computation site. */
  totalListCost: number;
  avgListCostPerTask: number;
  avgDurationMs: number;
  avgTurns: number;
  /**
   * The transcript's two measures, averaged over the tasks whose retro
   * carried them (see RetroSummary): prose about the harness, and active time
   * without a new row. Gated at absolute ceilings, not against the baseline:
   * the numbers the diagnosis set as done-when (15% each).
   */
  avgHarnessTalk?: number;
  avgSilence?: number;
  /**
   * Governance completions per task — the safety classifier, the compaction
   * summarizer, the intent read, the sub-agent report repair. Gated against
   * the BASELINE rather than an absolute ceiling, because unlike harness talk
   * there is no known-correct number: a task that genuinely needs three
   * compactions needs three summarizer calls. What must not happen is the
   * figure drifting UP unnoticed, which is what put 45% of this agent's
   * incidents on provider rate limits in the first place.
   *
   * Undefined when no task recorded it — a baseline written before the meter
   * existed says nothing about it, and the gate stays silent rather than
   * inventing a regression.
   */
  avgGovernanceCompletions?: number;
  categories: CategoryStats[];
  tasks: TaskResult[];
}

/** Ceilings from the transcript diagnosis's done-when: A and B respectively. */
export const HARNESS_TALK_CEILING = 0.15;
export const SILENCE_CEILING = 0.15;

/**
 * How far governance completions per task may rise above the recorded
 * baseline before the run fails.
 *
 * A ratio and not a ceiling, because there is no known-correct absolute
 * number: a task that genuinely needs three compactions needs three
 * summarizer calls, and a suite that grows a harder task legitimately makes
 * more of them. What must never happen is the figure creeping up unnoticed —
 * which is exactly how 45% of this agent's recorded incidents became provider
 * rate limits (measured 2026-09-07, 3,160 incidents).
 *
 * 20% matches the cost gate's default tolerance for the same reason: below it
 * is task mix, above it is a change in how the harness spends requests.
 */
export const GOVERNANCE_TOLERANCE = 0.2;

function meanOf(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (known.length === 0) return undefined;
  return known.reduce((s, v) => s + v, 0) / known.length;
}

export interface ModelSweepResult {
  model: string;
  provider: string;
  report: SuiteReport;
}

/**
 * Baselines are per-mode: mock runs are the deterministic harness-regression
 * detector, real runs are the capability anchor. One shared file meant a local
 * mock run silently clobbered the real-model baseline (and vice versa).
 */
export function baselinePathFor(mode: "mock" | "real", dir: string = __dirname): string {
  return join(dir, mode === "mock" ? "baseline-mock.json" : "baseline.json");
}
const RESULTS_DIR = join(__dirname, "results");

/** What `writeBaseline` did, so a caller (and a test) can assert on it. */
export interface BaselineWrite {
  /** The timestamped archive under results/ — written on every run. */
  archivePath: string;
  /** Whether the mode's baseline file was re-anchored. */
  promoted: boolean;
  /** The baseline file, when it was promoted. */
  baselinePath?: string;
}

export function buildReport(
  results: TaskResult[],
  mode: "mock" | "real",
  model?: string,
  provider?: string,
): SuiteReport {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const passRate = total > 0 ? passed / total : 0;
  const throttled = results.filter((r) => r.throttled).length;
  // An outage is unscored for the same reason a throttle is: nothing about
  // the harness was measured. Mock runs never have either.
  const infra = results.filter((r) => r.infra && !r.throttled).length;
  const measured = total - throttled - infra;
  const cleanPassRate = measured > 0 ? passed / measured : 0;
  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const avgCostPerTask = total > 0 ? totalCost / total : 0;
  // Metered-equivalent cost. Tracked separately because eval runs ride
  // subscription and free routes where `cost` is $0 by definition — the suite
  // could burn ten times the tokens and report the same number. This is the
  // figure the cost-regression gate compares.
  const totalListCost = results.reduce((s, r) => s + (r.listCost ?? 0), 0);
  const avgListCostPerTask = total > 0 ? totalListCost / total : 0;
  const avgDurationMs = total > 0 ? results.reduce((s, r) => s + r.durationMs, 0) / total : 0;
  const avgTurns = total > 0 ? results.reduce((s, r) => s + r.turns, 0) / total : 0;
  const avgHarnessTalk = meanOf(results.map((r) => r.retro?.harnessTalk));
  const avgSilence = meanOf(results.map((r) => r.retro?.silence));
  const avgGovernanceCompletions = meanOf(results.map((r) => r.retro?.governanceCompletions));

  // Group by category
  const byCategory = new Map<string, TaskResult[]>();
  for (const r of results) {
    const cat = r.category ?? "unknown";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  const categories: CategoryStats[] = Array.from(byCategory.entries()).map(([category, tasks]) => {
    const catPassed = tasks.filter((t) => t.pass).length;
    const catTotal = tasks.length;
    const catThrottled = tasks.filter((t) => t.throttled).length;
    const catMeasured =
      catTotal - catThrottled - tasks.filter((t) => t.infra && !t.throttled).length;
    const catCost = tasks.reduce((s, t) => s + t.cost, 0);
    const catTurns = tasks.reduce((s, t) => s + t.turns, 0);
    return {
      category,
      total: catTotal,
      passed: catPassed,
      passRate: catTotal > 0 ? catPassed / catTotal : 0,
      throttled: catThrottled,
      cleanPassRate: catMeasured > 0 ? catPassed / catMeasured : 0,
      avgDurationMs: catTotal > 0 ? tasks.reduce((s, t) => s + t.durationMs, 0) / catTotal : 0,
      totalCost: catCost,
      avgCost: catTotal > 0 ? catCost / catTotal : 0,
      avgTurns: catTotal > 0 ? catTurns / catTotal : 0,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    mode,
    model,
    provider,
    total,
    passed,
    passRate,
    throttled,
    ...(infra > 0 ? { infra } : {}),
    measured,
    cleanPassRate,
    totalCost,
    avgCostPerTask,
    totalListCost,
    avgListCostPerTask,
    avgDurationMs,
    avgTurns,
    ...(avgHarnessTalk != null ? { avgHarnessTalk } : {}),
    ...(avgSilence != null ? { avgSilence } : {}),
    ...(avgGovernanceCompletions != null ? { avgGovernanceCompletions } : {}),
    categories,
    tasks: results,
  };
}

export function printReport(report: SuiteReport): void {
  const pct = (report.passRate * 100).toFixed(1);
  const modeLabel =
    report.mode === "real"
      ? ` · ${report.provider ?? "?"}/${report.model ?? "?"}`
      : " · mock LLM provider";

  console.log("\n  \x1b[1mRune eval suite\x1b[0m" + modeLabel);
  console.log(`  \x1b[2m${report.total} tasks\x1b[0m\n`);

  // Per-category breakdown
  const catHeader =
    "  Category".padEnd(32) +
    "Pass".padEnd(12) +
    "AvgMs".padEnd(12) +
    "AvgTurns".padEnd(12) +
    "AvgCost";
  console.log(`\x1b[2m${catHeader}\x1b[0m`);
  console.log(`\x1b[2m${"─".repeat(80)}\x1b[0m`);

  for (const cat of report.categories) {
    // Score categories on the CLEAN rate (throttled tasks excluded), so a
    // rate-limited category doesn't read as red/failed.
    const catMeasured = cat.total - cat.throttled;
    const catPct = (cat.cleanPassRate * 100).toFixed(0);
    const catTone =
      catMeasured === 0
        ? "33"
        : cat.cleanPassRate === 1
          ? "32"
          : cat.cleanPassRate >= 0.5
            ? "33"
            : "31";
    const thr = cat.throttled > 0 ? ` \x1b[33m(${cat.throttled} thr)\x1b[0m` : "";
    const passStr = `${cat.passed}/${catMeasured} (${catPct}%)`;
    const costStr = cat.avgCost > 0 ? `$${cat.avgCost.toFixed(4)}` : "-";
    console.log(
      `  \x1b[${catTone}m${cat.category.padEnd(30)}\x1b[0m` +
        passStr.padEnd(12) +
        `${cat.avgDurationMs.toFixed(0)}ms`.padEnd(12) +
        `${cat.avgTurns.toFixed(1)}`.padEnd(12) +
        costStr +
        thr,
    );
  }

  console.log(`\x1b[2m${"─".repeat(80)}\x1b[0m`);

  // Summary row
  const totalPct = (report.passRate * 100).toFixed(0);
  const totalPass = `${report.passed}/${report.total} (${totalPct}%)`;
  const totalCostStr = report.totalCost > 0 ? `$${report.totalCost.toFixed(4)} total` : "-";
  console.log(
    `  ${"Total".padEnd(30)}` +
      totalPass.padEnd(12) +
      `${report.avgDurationMs.toFixed(0)}ms`.padEnd(12) +
      `${report.avgTurns.toFixed(1)}`.padEnd(12) +
      totalCostStr,
  );

  // Headline = the CLEAN rate over measured tasks. Raw rate shown as context.
  const cleanPct = (report.cleanPassRate * 100).toFixed(1);
  const cleanTone =
    report.measured === 0
      ? "33"
      : report.cleanPassRate === 1
        ? "32"
        : report.cleanPassRate >= 0.6
          ? "33"
          : "31";
  console.log(
    `\n  \x1b[${cleanTone}m${report.passed}/${report.measured} measured passed (${cleanPct}%)\x1b[0m` +
      `  \x1b[2m· raw ${report.passed}/${report.total} (${pct}%)\x1b[0m`,
  );
  if (report.throttled > 0) {
    console.log(
      `  \x1b[33m⚠ ${report.throttled} task(s) throttle-contaminated and excluded\x1b[0m` +
        `  \x1b[2m(provider rate/usage limit — not a capability miss)\x1b[0m`,
    );
  }

  // Printed even when totalCost is 0, which is the normal case: eval runs ride
  // subscription and free routes, so actual spend says nothing about how much
  // work a task took. This is the figure the cost gate compares.
  if (report.totalListCost > 0) {
    console.log(
      `  \x1b[2mMetered-equivalent: $${report.totalListCost.toFixed(4)} total · ` +
        `$${report.avgListCostPerTask.toFixed(4)}/task\x1b[0m`,
    );
  }
  if (report.totalCost > 0) {
    console.log(
      `  \x1b[2mTotal cost: $${report.totalCost.toFixed(4)} · avg $/task: $${report.avgCostPerTask.toFixed(4)}\x1b[0m`,
    );
  }
  if (report.avgHarnessTalk != null || report.avgSilence != null) {
    const talk =
      report.avgHarnessTalk != null
        ? `harness talk ${(report.avgHarnessTalk * 100).toFixed(0)}%`
        : "";
    const quiet =
      report.avgSilence != null ? `silence ${(report.avgSilence * 100).toFixed(0)}%` : "";
    console.log(
      `  \x1b[2mTranscript: ${[talk, quiet].filter(Boolean).join(" · ")} (ceilings ${HARNESS_TALK_CEILING * 100}% / ${SILENCE_CEILING * 100}%)\x1b[0m`,
    );
  }
  if (report.avgGovernanceCompletions != null) {
    // The free-tier line: a free route is priced in requests, not dollars, so
    // this is the figure that decides whether the suite would survive there.
    console.log(
      `  \x1b[2mGovernance: ${report.avgGovernanceCompletions.toFixed(2)} completions/task ` +
        `(tolerance +${(GOVERNANCE_TOLERANCE * 100).toFixed(0)}% vs baseline)\x1b[0m`,
    );
  }
  console.log();
}

function baselineShape(report: SuiteReport) {
  return {
    timestamp: report.timestamp,
    mode: report.mode,
    model: report.model,
    provider: report.provider,
    passRate: report.passRate,
    cleanPassRate: report.cleanPassRate,
    passed: report.passed,
    measured: report.measured,
    throttled: report.throttled,
    total: report.total,
    totalCost: report.totalCost,
    avgCostPerTask: report.avgCostPerTask,
    totalListCost: report.totalListCost,
    avgListCostPerTask: report.avgListCostPerTask,
    avgDurationMs: report.avgDurationMs,
    avgTurns: report.avgTurns,
    ...(report.avgHarnessTalk != null ? { avgHarnessTalk: report.avgHarnessTalk } : {}),
    ...(report.avgSilence != null ? { avgSilence: report.avgSilence } : {}),
    ...(report.avgGovernanceCompletions != null
      ? { avgGovernanceCompletions: report.avgGovernanceCompletions }
      : {}),
    categories: report.categories.map((c) => ({
      category: c.category,
      passed: c.passed,
      total: c.total,
      throttled: c.throttled,
      passRate: c.passRate,
      cleanPassRate: c.cleanPassRate,
      avgCost: c.avgCost,
    })),
    // Per-task outcomes make baselines comparable at task granularity — the
    // suite-level rate can stay flat while one task regresses and another is
    // newly added, and only this catches it.
    tasks: report.tasks.map((t) => ({
      name: t.name,
      category: t.category,
      pass: t.pass,
      throttled: !!t.throttled,
    })),
  };
}

// ─── Baseline comparison (--compare): the regression gate ───

export interface BaselineComparison {
  /** Fractional change in metered-equivalent cost per task vs baseline. */
  costDelta?: number;
  /**
   * Fractional change in GOVERNANCE completions per task vs baseline —
   * Rune's own calls, not the work. Absent when either side did not record
   * the figure. On free routes this is the number that decides whether a
   * task finishes at all, because a free tier meters requests, not dollars.
   */
  governanceDelta?: number;
  /** False when the run regressed beyond the noise band. */
  ok: boolean;
  /** Non-null when comparison was impossible (no/incompatible baseline) — not a failure. */
  skipped: string | null;
  /** cleanPassRate delta (current − baseline); negative = worse. */
  rateDelta: number;
  /** Tasks that passed in the baseline and failed (not throttled) in this run. */
  newlyFailing: string[];
  /** Tasks in the baseline missing from this run (renamed/removed — surfaced, not fatal). */
  missing: string[];
  reasons: string[];
}

export interface BaselineFile {
  mode?: "mock" | "real";
  model?: string;
  provider?: string;
  cleanPassRate?: number;
  /**
   * Metered-equivalent cost per task at the time the baseline was written.
   * Optional because every baseline recorded before the meter existed lacks
   * it — the cost gate treats its absence as "nothing to compare", never as
   * zero, or the first run after this shipped would fail on a division.
   */
  avgListCostPerTask?: number;
  /**
   * Governance completions per task when the baseline was written. Optional
   * for the same reason as the cost figure: a baseline recorded before the
   * meter existed lacks it, and its absence is "nothing to compare", never
   * zero — a gate that read a missing meter as a perfect score would fail
   * every run after this shipped.
   */
  avgGovernanceCompletions?: number;
  tasks?: Array<{ name: string; pass: boolean; throttled?: boolean }>;
}

/**
 * Compare a run against a recorded baseline. Two gates:
 *  - rate gate: cleanPassRate must not drop more than `noise` below baseline.
 *  - task gate (mock only): any task that passed in baseline and fails now is a
 *    regression regardless of the aggregate — mock runs are deterministic, so
 *    there is no noise to hide behind. In real mode task flips are reported as
 *    diagnostics but only the rate gates (single-task flakiness is real).
 * Comparing across modes or across different real models measures nothing, so
 * those comparisons are skipped (ok=true, skipped=reason) rather than guessed.
 */
/**
 * Fractional rise in metered-equivalent cost per task tolerated before the
 * gate fails. Cost is noisier than pass/fail — a model's verbosity drifts, a
 * retry lands differently — so the band is wide enough that only a structural
 * change trips it. A broken prompt cache roughly quintuples the figure; that
 * is the class of regression this is here to catch.
 */
export const DEFAULT_COST_DRIFT_TOLERANCE = 0.5;

export function compareToBaseline(
  report: SuiteReport,
  baseline: BaselineFile | null,
  noise: number,
  costTolerance: number = DEFAULT_COST_DRIFT_TOLERANCE,
): BaselineComparison {
  const out: BaselineComparison = {
    ok: true,
    skipped: null,
    rateDelta: 0,
    costDelta: 0,
    newlyFailing: [],
    missing: [],
    reasons: [],
  };
  if (!baseline || typeof baseline.cleanPassRate !== "number") {
    out.skipped = "no baseline recorded yet (run with --write-baseline to create one)";
    return out;
  }
  if (baseline.mode !== report.mode) {
    out.skipped = `baseline is a ${baseline.mode} run; this is ${report.mode} — not comparable`;
    return out;
  }
  if (
    report.mode === "real" &&
    (baseline.model !== report.model || baseline.provider !== report.provider)
  ) {
    out.skipped =
      `baseline measured ${baseline.provider}/${baseline.model}; ` +
      `this run is ${report.provider}/${report.model} — not comparable`;
    return out;
  }

  out.rateDelta = report.cleanPassRate - baseline.cleanPassRate;
  if (out.rateDelta < -noise) {
    out.ok = false;
    out.reasons.push(
      `cleanPassRate ${(report.cleanPassRate * 100).toFixed(1)}% fell ` +
        `${(-out.rateDelta * 100).toFixed(1)}pt below baseline ` +
        `${(baseline.cleanPassRate * 100).toFixed(1)}% (noise band ${(noise * 100).toFixed(1)}pt)`,
    );
  }

  // Cost gate. Only meaningful once a baseline has recorded the figure, and
  // only when the baseline actually spent something — dividing by zero
  // manufactures an infinite regression on the first run that records cost.
  const baseCost = baseline.avgListCostPerTask;
  if (typeof baseCost === "number" && baseCost > 0 && report.avgListCostPerTask > 0) {
    out.costDelta = (report.avgListCostPerTask - baseCost) / baseCost;
    if (out.costDelta > costTolerance) {
      out.ok = false;
      out.reasons.push(
        `metered-equivalent cost per task rose ${(out.costDelta * 100).toFixed(0)}% ` +
          `($${baseCost.toFixed(4)} → $${report.avgListCostPerTask.toFixed(4)}), ` +
          `past the ${(costTolerance * 100).toFixed(0)}% tolerance`,
      );
    }
  }

  // Governance gate. Against the BASELINE, not a ceiling: unlike harness talk
  // there is no known-correct absolute number — a task needing three
  // compactions needs three summarizer calls. What must not happen is the
  // figure drifting up unnoticed. Silent when either side lacks the figure,
  // and silent when the baseline recorded zero, which would make any first
  // measured call an infinite regression.
  const baseGovernance = baseline.avgGovernanceCompletions;
  if (
    typeof baseGovernance === "number" &&
    baseGovernance > 0 &&
    typeof report.avgGovernanceCompletions === "number"
  ) {
    out.governanceDelta = (report.avgGovernanceCompletions - baseGovernance) / baseGovernance;
    if (out.governanceDelta > GOVERNANCE_TOLERANCE) {
      out.ok = false;
      out.reasons.push(
        `governance completions per task rose ${(out.governanceDelta * 100).toFixed(0)}% ` +
          `(${baseGovernance.toFixed(2)} → ${report.avgGovernanceCompletions.toFixed(2)}), ` +
          `past the ${(GOVERNANCE_TOLERANCE * 100).toFixed(0)}% tolerance. ` +
          `Rune is making more of its own calls per task; on a free tier that is what a 429 looks like.`,
      );
    }
  }

  // The transcript gates are absolute ceilings, not deltas: a run whose prose
  // is 62% about the harness is wrong however the baseline scored, and a
  // baseline recorded before the measure existed says nothing about it.
  if (report.avgHarnessTalk != null && report.avgHarnessTalk > HARNESS_TALK_CEILING) {
    out.ok = false;
    out.reasons.push(
      `harness talk ${(report.avgHarnessTalk * 100).toFixed(0)}% of prose messages, over the ` +
        `${HARNESS_TALK_CEILING * 100}% ceiling`,
    );
  }
  if (report.avgSilence != null && report.avgSilence > SILENCE_CEILING) {
    out.ok = false;
    out.reasons.push(
      `silence ${(report.avgSilence * 100).toFixed(0)}% of active time without a new row, over the ` +
        `${SILENCE_CEILING * 100}% ceiling`,
    );
  }

  if (Array.isArray(baseline.tasks)) {
    const current = new Map(report.tasks.map((t) => [t.name, t]));
    for (const bt of baseline.tasks) {
      const ct = current.get(bt.name);
      if (!ct) {
        out.missing.push(bt.name);
        continue;
      }
      if (bt.pass && !ct.pass && !ct.throttled) out.newlyFailing.push(bt.name);
    }
    if (out.newlyFailing.length > 0 && report.mode === "mock") {
      out.ok = false;
      out.reasons.push(
        `deterministic task regression: ${out.newlyFailing.join(", ")} passed in baseline and fail now`,
      );
    }
  }
  return out;
}

export function printComparison(cmp: BaselineComparison): void {
  if (cmp.skipped) {
    console.log(`  \x1b[2m--compare skipped: ${cmp.skipped}\x1b[0m\n`);
    return;
  }
  const deltaStr = `${cmp.rateDelta >= 0 ? "+" : ""}${(cmp.rateDelta * 100).toFixed(1)}pt`;
  if (cmp.ok) {
    console.log(
      `  \x1b[32m✓ no regression vs baseline\x1b[0m \x1b[2m(clean rate ${deltaStr})\x1b[0m`,
    );
  } else {
    console.log(`  \x1b[31m✗ REGRESSION vs baseline\x1b[0m (clean rate ${deltaStr})`);
    for (const r of cmp.reasons) console.log(`     \x1b[31m${r}\x1b[0m`);
  }
  if (cmp.newlyFailing.length > 0 && cmp.ok) {
    // Real mode: flips inside the noise band are diagnostics, not verdicts.
    console.log(`  \x1b[33m⚠ newly failing vs baseline: ${cmp.newlyFailing.join(", ")}\x1b[0m`);
  }
  if (cmp.missing.length > 0) {
    console.log(`  \x1b[2mbaseline tasks not in this run: ${cmp.missing.join(", ")}\x1b[0m`);
  }
  console.log();
}

/**
 * Always archive a run to results/ (timestamped, never overwritten) so no run
 * is lost. Promote it to the mode's baseline ONLY when `promote` is set — which
 * only `--write-baseline` sets.
 *
 * The baseline is the yardstick. It used to re-anchor itself on every passing
 * `--compare` run: the gate compared the run against the baseline, declared no
 * regression, and then overwrote the baseline with that same run. A yardstick
 * that redraws itself to match whatever it just measured cannot detect drift —
 * a slow slide of one task per run reads as "no regression" forever — and the
 * visible symptom was a dirty `tests/eval/baseline-mock.json` in every lane,
 * reverted by hand by every agent that ran the gate. Moving the anchor is now
 * an explicit act with a flag on it.
 */
export async function writeBaseline(
  report: SuiteReport,
  promote = false,
  opts: { baselineDir?: string; resultsDir?: string; quiet?: boolean } = {},
): Promise<BaselineWrite> {
  const shape = baselineShape(report);
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const tag =
    report.mode === "real" ? `${report.provider}-${report.model}`.replace(/[^\w.-]/g, "_") : "mock";
  const resultsDir = opts.resultsDir ?? RESULTS_DIR;
  const archivePath = join(resultsDir, `run-${stamp}-${tag}.json`);
  await mkdir(resultsDir, { recursive: true });
  await writeFile(archivePath, JSON.stringify(shape, null, 2) + "\n");
  const log = (s: string) => {
    if (!opts.quiet) console.log(s);
  };

  const file = report.mode === "mock" ? "baseline-mock.json" : "baseline.json";
  if (!promote) {
    log(
      `  \x1b[2mbaseline unchanged\x1b[0m \x1b[2m(tests/eval/${file} is the yardstick; run archived to tests/eval/results/. ` +
        `Pass --write-baseline to re-anchor it.)\x1b[0m`,
    );
    return { archivePath, promoted: false };
  }
  const baselinePath = baselinePathFor(report.mode, opts.baselineDir);
  await writeFile(baselinePath, JSON.stringify(shape, null, 2) + "\n");
  log(
    `  \x1b[2mBaseline RE-ANCHORED to tests/eval/${file} (archived in results/)\x1b[0m` +
      (report.throttled > 0
        ? `\n  \x1b[33m⚠ ${report.throttled} throttled task(s) are baked into this baseline\x1b[0m`
        : ""),
  );
  return { archivePath, promoted: true, baselinePath };
}

export async function loadBaseline(mode: "mock" | "real" = "real"): Promise<SuiteReport | null> {
  try {
    const raw = await readFile(baselinePathFor(mode), "utf8");
    return JSON.parse(raw) as SuiteReport;
  } catch {
    return null;
  }
}

export function printModelSweep(sweepResults: ModelSweepResult[]): void {
  console.log("\n  \x1b[1mModel Sweep Results\x1b[0m\n");
  const header = "  Model".padEnd(40) + "Pass%".padEnd(12) + "AvgTurns".padEnd(12) + "TotalCost";
  console.log(`\x1b[2m${header}\x1b[0m`);
  console.log(`\x1b[2m${"─".repeat(75)}\x1b[0m`);

  for (const { model, provider, report } of sweepResults) {
    const label = `${provider}/${model}`.slice(0, 36);
    const pct = (report.passRate * 100).toFixed(1) + "%";
    const tone = report.passRate === 1 ? "32" : report.passRate >= 0.6 ? "33" : "31";
    const costStr = report.totalCost > 0 ? `$${report.totalCost.toFixed(4)}` : "-";
    console.log(
      `  \x1b[${tone}m${label.padEnd(38)}\x1b[0m` +
        pct.padEnd(12) +
        `${report.avgTurns.toFixed(1)}`.padEnd(12) +
        costStr,
    );
  }
  console.log();
}

// ─── Paired A/B (P7.4) ───
//
// The two-key rule. A variant is promoted only when BOTH gates pass, and they
// are different kinds of gate on purpose:
//
//   · mock mode is deterministic — same scripts, same order, same process — so
//     any per-task flip is real and the noise band is zero. This is the cheap
//     gate that runs on every change.
//   · real mode carries genuine noise, so it gets a band on the aggregate and
//     still refuses any task that regresses.
//
// Three conditions, all of which must hold:
//   1. No task regresses. An aggregate that improves while one task breaks is
//      how a "win" ships a defect.
//   2. cleanPassRate up beyond the noise band. Equal is not a win: the control
//      already exists, and "no worse" is not a reason to change anything.
//   3. totalListCost not up beyond its band. Metered-equivalent, not actual
//      spend, because eval runs ride free and subscription routes where actual
//      spend is $0 by definition and a cost gate could never fire.
//
// Throttled tasks are excluded from every comparison: a rate limit in one arm
// and not the other is the single easiest way to manufacture a fake win.

/** Cost rise tolerated in a paired A/B before the cost gate refuses. */
export const DEFAULT_AB_COST_BAND = 0.1;
/** Pass-rate improvement a real-mode arm must clear to count as a win. */
export const DEFAULT_AB_NOISE_BAND = 0.05;

export interface ArmTaskDelta {
  name: string;
  control: ArmOutcome;
  treatment: ArmOutcome;
  /** +1 fixed, −1 regressed, 0 unchanged. Null when either side went unscored. */
  delta: number | null;
  controlListCost: number;
  treatmentListCost: number;
  /** Either arm ran on a model with no list price. */
  unpriced?: boolean;
}

/** How one arm's run of one task ended, for the comparison. */
export type ArmOutcome = "pass" | "fail" | "throttled" | "infra";

export interface ArmComparison {
  variant: string;
  mode: "mock" | "real";
  /** Tasks compared on both arms (throttled rows on either side are excluded). */
  compared: number;
  excluded: string[];
  controlCleanPassRate: number;
  treatmentCleanPassRate: number;
  rateDelta: number;
  controlListCost: number;
  treatmentListCost: number;
  /** Fractional change in total metered-equivalent cost. Null when control was $0. */
  costDelta: number | null;
  regressions: string[];
  fixes: string[];
  noiseBand: number;
  costBand: number;
  /** Every gate that refused, in the order they are checked. Empty = a win. */
  refusals: string[];
  /** True only when every gate passes. */
  win: boolean;
  /**
   * The run could not answer its question: nothing comparable, most of the
   * suite unscored, or (live) a cost that is unknown. Not a win and not a
   * loss — the ledger lets it close nothing. A regression is never
   * inconclusive: harm seen on both arms' scored rows is an answer.
   */
  inconclusive: boolean;
  /**
   * What the experiment itself cost at list rates: every row of both arms,
   * excluded and interrupted ones included. The price of the learning.
   */
  spentListCost: number;
  /** Per-task rows, so a report can show the work rather than an average. */
  deltas: ArmTaskDelta[];
  /** Attribution: the config digests each arm actually ran under. */
  controlConfigHash?: string;
  treatmentConfigHash?: string;
}

function armOutcomeOf(r: TaskResult | undefined): ArmOutcome | null {
  if (!r) return null;
  if (r.throttled) return "throttled";
  if (r.infra) return "infra";
  return r.pass ? "pass" : "fail";
}

const UNSCORED: ReadonlySet<ArmOutcome> = new Set<ArmOutcome>(["throttled", "infra"]);

export function compareArms(
  variant: string,
  control: SuiteReport,
  treatment: SuiteReport,
  opts: { noiseBand?: number; costBand?: number } = {},
): ArmComparison {
  const mode = control.mode;
  // Mock is deterministic: a flip is a flip, so the band is zero. Real mode
  // gets a band because a single task's outcome genuinely varies.
  const noiseBand = opts.noiseBand ?? (mode === "mock" ? 0 : DEFAULT_AB_NOISE_BAND);
  const costBand = opts.costBand ?? DEFAULT_AB_COST_BAND;

  const byName = new Map(treatment.tasks.map((t) => [t.name, t]));
  const deltas: ArmTaskDelta[] = [];
  const excluded: string[] = [];
  // A row an arm never produced is that arm's loss of a task, for the same
  // one-sidedness check a throttle or an outage gets below.
  let missingFromControl = 0;
  let missingFromTreatment = 0;
  for (const c of control.tasks) {
    const t = byName.get(c.name);
    const co = armOutcomeOf(c);
    const to = armOutcomeOf(t);
    if (co === null || to === null) {
      excluded.push(`${c.name} (missing from the ${to === null ? "treatment" : "control"} arm)`);
      if (to === null) missingFromTreatment++;
      else missingFromControl++;
      continue;
    }
    const unpriced = Boolean(c.unpriced || t!.unpriced);
    if (UNSCORED.has(co) || UNSCORED.has(to)) {
      // A rate limit or an outage in one arm and not the other is the easiest
      // way to manufacture a fake win. Neither counts, and the row says why.
      const why = co === "infra" || to === "infra" ? "infrastructure failure" : "throttled";
      excluded.push(`${c.name} (${why})`);
      deltas.push({
        name: c.name,
        control: co,
        treatment: to,
        delta: null,
        controlListCost: c.listCost ?? 0,
        treatmentListCost: t!.listCost ?? 0,
        ...(unpriced ? { unpriced } : {}),
      });
      continue;
    }
    deltas.push({
      name: c.name,
      control: co,
      treatment: to,
      delta: co === to ? 0 : to === "pass" ? 1 : -1,
      controlListCost: c.listCost ?? 0,
      treatmentListCost: t!.listCost ?? 0,
      ...(unpriced ? { unpriced } : {}),
    });
  }

  const measured = deltas.filter((d) => d.delta !== null);
  const compared = measured.length;
  const controlPassed = measured.filter((d) => d.control === "pass").length;
  const treatmentPassed = measured.filter((d) => d.treatment === "pass").length;
  const controlCleanPassRate = compared > 0 ? controlPassed / compared : 0;
  const treatmentCleanPassRate = compared > 0 ? treatmentPassed / compared : 0;
  const rateDelta = treatmentCleanPassRate - controlCleanPassRate;

  const controlListCost = measured.reduce((s, d) => s + d.controlListCost, 0);
  const treatmentListCost = measured.reduce((s, d) => s + d.treatmentListCost, 0);
  const costDelta =
    controlListCost > 0 ? (treatmentListCost - controlListCost) / controlListCost : null;

  const regressions = measured.filter((d) => d.delta === -1).map((d) => d.name);
  const fixes = measured.filter((d) => d.delta === 1).map((d) => d.name);
  // Everything the experiment burned, scored or not: the learning's price.
  const spentListCost =
    control.tasks.reduce((s, r) => s + (r.listCost ?? 0), 0) +
    treatment.tasks.reduce((s, r) => s + (r.listCost ?? 0), 0);
  // Mock replays a script and prices nothing; its cost is not measured at all,
  // and a mock row can never promote. Live, an unknown price is a gate that
  // cannot be passed — only skipped, which is how an unpriced arm used to win.
  const unpricedRows = mode === "real" ? measured.filter((d) => d.unpriced).length : 0;
  const mostlyUnscored = excluded.length > compared;
  // Exclusion is only neutral when it falls on both arms alike. A treatment
  // that CAUSES throttling or outages — a heavier prompt, more tokens — would
  // otherwise have its failures excluded and win on the tasks that survived.
  const controlUnscored = deltas.filter((d) => UNSCORED.has(d.control)).length + missingFromControl;
  const treatmentUnscored =
    deltas.filter((d) => UNSCORED.has(d.treatment)).length + missingFromTreatment;
  const lopsided = treatmentUnscored > controlUnscored;

  const refusals: string[] = [];
  if (compared === 0) {
    refusals.push("no task was measured on both arms");
  } else if (mostlyUnscored) {
    refusals.push(
      `most of the suite went unscored (${excluded.length} excluded, ${compared} compared) — too little was measured to answer`,
    );
  }
  if (regressions.length > 0) {
    refusals.push(
      `${regressions.length} task(s) regressed: ${regressions.join(", ")} — an aggregate that improves while a task breaks is how a "win" ships a defect`,
    );
  }
  // Float slack: 1.0 − 0.95 is 0.050000000000000044, and a delta that clears a
  // band by 4e-17 is not evidence of anything.
  const EPS = 1e-9;
  if (rateDelta <= noiseBand + EPS) {
    refusals.push(
      `cleanPassRate ${rateDelta >= 0 ? "+" : ""}${(rateDelta * 100).toFixed(1)}% did not clear the ${(noiseBand * 100).toFixed(1)}% noise band — equal is not a win`,
    );
  }
  if (costDelta !== null && costDelta > costBand + EPS) {
    refusals.push(
      `metered-equivalent cost +${(costDelta * 100).toFixed(1)}% exceeds the ${(costBand * 100).toFixed(0)}% band`,
    );
  }
  if (costDelta === null && treatmentListCost > EPS) {
    // No band makes a rise from nothing a flat cost.
    refusals.push(
      `metered-equivalent cost rose from $0 to $${treatmentListCost.toFixed(4)} — a rise from nothing is not inside any band`,
    );
  }
  if (unpricedRows > 0) {
    refusals.push(
      `${unpricedRows} compared task(s) ran on a model with no list price — the cost is unknown, and an unknown cost cannot pass the cost gate`,
    );
  }
  if (lopsided) {
    refusals.push(
      `the treatment lost ${treatmentUnscored} task(s) to throttling, outages or missing rows against the control's ${controlUnscored} — exclusions that fall on one arm can manufacture a win`,
    );
  }
  // Not a loss: one stray 502 must not close a question for good.
  const inconclusive =
    regressions.length === 0 && (compared === 0 || mostlyUnscored || unpricedRows > 0 || lopsided);

  return {
    variant,
    mode,
    compared,
    excluded,
    controlCleanPassRate,
    treatmentCleanPassRate,
    rateDelta,
    controlListCost,
    treatmentListCost,
    costDelta,
    regressions,
    fixes,
    noiseBand,
    costBand,
    refusals,
    win: refusals.length === 0,
    inconclusive,
    spentListCost,
    deltas,
    controlConfigHash: control.tasks.find((t) => t.configHash)?.configHash,
    treatmentConfigHash: treatment.tasks.find((t) => t.configHash)?.configHash,
  };
}

export function printArmComparison(cmp: ArmComparison): void {
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  console.log(`\n  \x1b[1mPaired A/B\x1b[0m \x1b[2m· ${cmp.variant} · ${cmp.mode} mode\x1b[0m\n`);
  if (cmp.deltas.length > 0) {
    console.log(
      `\x1b[2m  ${"Task".padEnd(34)}${"control".padEnd(12)}${"treatment".padEnd(12)}\x1b[0m`,
    );
    console.log(`\x1b[2m${"─".repeat(70)}\x1b[0m`);
    for (const d of cmp.deltas) {
      const mark = d.delta === 1 ? "\x1b[32m▲\x1b[0m" : d.delta === -1 ? "\x1b[31m▼\x1b[0m" : " ";
      console.log(
        `  ${mark} ${d.name.slice(0, 32).padEnd(32)}${d.control.padEnd(12)}${d.treatment.padEnd(12)}`,
      );
    }
    console.log();
  }
  console.log(
    `  clean pass  ${(cmp.controlCleanPassRate * 100).toFixed(1)}%  →  ${(cmp.treatmentCleanPassRate * 100).toFixed(1)}%   \x1b[2m${pct(cmp.rateDelta)} (band ${(cmp.noiseBand * 100).toFixed(1)}%)\x1b[0m`,
  );
  console.log(
    `  list cost   $${cmp.controlListCost.toFixed(4)}  →  $${cmp.treatmentListCost.toFixed(4)}   \x1b[2m${
      cmp.costDelta === null
        ? "no data (control cost $0)"
        : `${pct(cmp.costDelta)} (band ${(cmp.costBand * 100).toFixed(0)}%)`
    }\x1b[0m`,
  );
  console.log(
    `  tasks       ${cmp.compared} compared, ${cmp.fixes.length} fixed, ${cmp.regressions.length} regressed`,
  );
  console.log(
    `  spent       $${cmp.spentListCost.toFixed(4)} list   \x1b[2mboth arms, excluded rows included — the price of this measurement\x1b[0m`,
  );
  if (cmp.controlConfigHash || cmp.treatmentConfigHash) {
    console.log(
      `  \x1b[2mconfig      control ${cmp.controlConfigHash ?? "?"} → treatment ${cmp.treatmentConfigHash ?? "?"}\x1b[0m`,
    );
  }
  if (cmp.excluded.length > 0) {
    console.log(`  \x1b[2mexcluded    ${cmp.excluded.join(", ")}\x1b[0m`);
  }
  console.log();
  if (cmp.win && cmp.mode === "mock") {
    // Mock replays a script: a win here says the change did no harm to the
    // scripted runs, never that it helps a model. Promotion needs --real.
    console.log(
      `  \x1b[32mWIN (mock)\x1b[0m — every gate passes on the script, which shows no harm and cannot show lift. \x1b[2mrune evolve ab ${cmp.variant} --real\x1b[0m\n`,
    );
  } else if (cmp.win) {
    console.log(
      `  \x1b[32mWIN\x1b[0m — every gate passes. \x1b[2mrune evolve promote ${cmp.variant}\x1b[0m\n`,
    );
  } else {
    console.log(
      cmp.inconclusive
        ? `  \x1b[33mINCONCLUSIVE\x1b[0m — this run could not answer, so it closes nothing:`
        : `  \x1b[33mNO CHANGE\x1b[0m — the variant is not promoted:`,
    );
    for (const r of cmp.refusals) console.log(`    · ${r}`);
    if (cmp.mode === "mock" && cmp.rateDelta === 0 && cmp.regressions.length === 0) {
      // Worth saying out loud, because a reader expecting the mock arm to
      // discover wins will read a tie as a broken A/B. The scripted provider
      // does not reason: it replays a script, so a change to what the model is
      // TOLD usually cannot change what it answers. Mock is the regression
      // gate — it detects harm cheaply and deterministically — and real mode
      // is the only arm that can detect an improvement.
      console.log(
        `    \x1b[2m(mock is the regression gate: the scripted provider replays a script rather than reasoning, so a tie is the expected result here. Discovery needs --real.)\x1b[0m`,
      );
    }
    console.log();
  }
}
