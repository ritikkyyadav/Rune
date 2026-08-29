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
  /** Tasks that actually produced a measurable result (total - throttled). */
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
  categories: CategoryStats[];
  tasks: TaskResult[];
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
export function baselinePathFor(mode: "mock" | "real"): string {
  return join(__dirname, mode === "mock" ? "baseline-mock.json" : "baseline.json");
}
const RESULTS_DIR = join(__dirname, "results");

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
  const measured = total - throttled;
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
    const catMeasured = catTotal - catThrottled;
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
    measured,
    cleanPassRate,
    totalCost,
    avgCostPerTask,
    totalListCost,
    avgListCostPerTask,
    avgDurationMs,
    avgTurns,
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

  console.log("\n  \x1b[1mGear eval suite\x1b[0m" + modeLabel);
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

  if (report.totalListCost > 0) {
    lines.push(
      `  \x1b[2mMetered-equivalent: $${report.totalListCost.toFixed(4)} total · ` +
        `$${report.avgListCostPerTask.toFixed(4)}/task\x1b[0m`,
    );
  }
  if (report.totalCost > 0) {
    console.log(
      `  \x1b[2mTotal cost: $${report.totalCost.toFixed(4)} · avg $/task: $${report.avgCostPerTask.toFixed(4)}\x1b[0m`,
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
 * is lost. Only promote it to baseline.json when it's a clean snapshot — i.e.
 * zero throttled tasks — unless `force` is set. This is what stops a broken or
 * rate-limited run (like the no-credits "16% ceiling") from clobbering a good
 * baseline.
 */
export async function writeBaseline(report: SuiteReport, force = false): Promise<void> {
  const shape = baselineShape(report);
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  const tag =
    report.mode === "real" ? `${report.provider}-${report.model}`.replace(/[^\w.-]/g, "_") : "mock";
  const archivePath = join(RESULTS_DIR, `run-${stamp}-${tag}.json`);
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(archivePath, JSON.stringify(shape, null, 2) + "\n");

  if (report.throttled > 0 && !force) {
    console.log(
      `  \x1b[2mRun archived to tests/eval/results/ (baseline NOT updated — ${report.throttled} throttled task(s); pass --write-baseline to force)\x1b[0m`,
    );
    return;
  }
  const baselinePath = baselinePathFor(report.mode);
  await writeFile(baselinePath, JSON.stringify(shape, null, 2) + "\n");
  console.log(
    `  \x1b[2mBaseline written to tests/eval/${report.mode === "mock" ? "baseline-mock.json" : "baseline.json"} (archived in results/)\x1b[0m`,
  );
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
