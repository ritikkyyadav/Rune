/**
 * Reporting utilities for the eval suite.
 * Prints pass-rate, $/task, avg turns, per-category breakdown,
 * and writes a baseline to tests/eval/baseline.json.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import type { TaskResult } from "./harness";

export interface CategoryStats {
  category: string;
  total: number;
  passed: number;
  passRate: number;
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
  totalCost: number;
  avgCostPerTask: number;
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

const BASELINE_PATH = join(__dirname, "baseline.json");

export function buildReport(
  results: TaskResult[],
  mode: "mock" | "real",
  model?: string,
  provider?: string,
): SuiteReport {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const passRate = total > 0 ? passed / total : 0;
  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const avgCostPerTask = total > 0 ? totalCost / total : 0;
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
    const catCost = tasks.reduce((s, t) => s + t.cost, 0);
    const catTurns = tasks.reduce((s, t) => s + t.turns, 0);
    return {
      category,
      total: catTotal,
      passed: catPassed,
      passRate: catTotal > 0 ? catPassed / catTotal : 0,
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
    totalCost,
    avgCostPerTask,
    avgDurationMs,
    avgTurns,
    categories,
    tasks: results,
  };
}

export function printReport(report: SuiteReport): void {
  const pct = (report.passRate * 100).toFixed(1);
  const tone = report.passRate === 1 ? "32" : report.passRate >= 0.6 ? "33" : "31";
  const modeLabel = report.mode === "real"
    ? ` · ${report.provider ?? "?"}/${report.model ?? "?"}`
    : " · mock LLM provider";

  console.log("\n  \x1b[1mAlan eval suite\x1b[0m" + modeLabel);
  console.log(`  \x1b[2m${report.total} tasks\x1b[0m\n`);

  // Per-category breakdown
  const catHeader = "  Category".padEnd(32) + "Pass".padEnd(12) + "AvgMs".padEnd(12) + "AvgTurns".padEnd(12) + "AvgCost";
  console.log(`\x1b[2m${catHeader}\x1b[0m`);
  console.log(`\x1b[2m${"─".repeat(80)}\x1b[0m`);

  for (const cat of report.categories) {
    const catPct = (cat.passRate * 100).toFixed(0);
    const catTone = cat.passRate === 1 ? "32" : cat.passRate >= 0.5 ? "33" : "31";
    const passStr = `${cat.passed}/${cat.total} (${catPct}%)`;
    const costStr = cat.avgCost > 0 ? `$${cat.avgCost.toFixed(4)}` : "-";
    console.log(
      `  \x1b[${catTone}m${cat.category.padEnd(30)}\x1b[0m` +
        passStr.padEnd(12) +
        `${cat.avgDurationMs.toFixed(0)}ms`.padEnd(12) +
        `${cat.avgTurns.toFixed(1)}`.padEnd(12) +
        costStr,
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

  console.log(`\n  \x1b[${tone}m${report.passed}/${report.total} passed (${pct}%)\x1b[0m`);

  if (report.totalCost > 0) {
    console.log(
      `  \x1b[2mTotal cost: $${report.totalCost.toFixed(4)} · avg $/task: $${report.avgCostPerTask.toFixed(4)}\x1b[0m`,
    );
  }
  console.log();
}

export async function writeBaseline(report: SuiteReport): Promise<void> {
  const baseline = {
    timestamp: report.timestamp,
    mode: report.mode,
    model: report.model,
    provider: report.provider,
    passRate: report.passRate,
    passed: report.passed,
    total: report.total,
    totalCost: report.totalCost,
    avgCostPerTask: report.avgCostPerTask,
    avgDurationMs: report.avgDurationMs,
    avgTurns: report.avgTurns,
    categories: report.categories.map((c) => ({
      category: c.category,
      passed: c.passed,
      total: c.total,
      passRate: c.passRate,
      avgCost: c.avgCost,
    })),
  };
  await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`  \x1b[2mBaseline written to tests/eval/baseline.json\x1b[0m`);
}

export async function loadBaseline(): Promise<SuiteReport | null> {
  try {
    const raw = await readFile(BASELINE_PATH, "utf8");
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
