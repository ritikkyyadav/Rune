#!/usr/bin/env bun
import { runSuite, IS_REAL_MODE } from "./harness";
import type { EvalTask } from "./harness";
import { ALL_TASKS } from "./tasks";
import { buildReport, printReport, writeBaseline, printModelSweep } from "./report";
import type { ModelSweepResult } from "./report";

// ─── Real-mode defaults & key wiring ───
//
// In --real mode the suite drives a LIVE model through the real engine/gateway.
// Provider/model come from env (ALAN_EVAL_PROVIDER / ALAN_EVAL_MODEL), with the
// older ALAN_PROVIDER / ALAN_MODEL names accepted as fallbacks. The dev default
// is a FREE model (Gemini 2.5 Flash). For a later production-validation pass, set
// ALAN_EVAL_PROVIDER / ALAN_EVAL_MODEL to a paid top-tier model
// (e.g. anthropic / claude-sonnet-4-20250514).

const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = "gemini-2.5-flash";

/** Which env var holds the API key for each provider. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
};

interface CliArgs {
  real: boolean;
  /** Filter by category or exact task name (substring-insensitive on name). */
  tasksFilter?: string;
  /** Cap the number of tasks that run (after filtering). */
  max?: number;
  /** Regression gate: exit 0 if passRate >= this (0–1); else require all pass. */
  minPassRate?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { real: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--real") {
      args.real = true;
    } else if (a === "--tasks") {
      args.tasksFilter = argv[++i];
    } else if (a.startsWith("--tasks=")) {
      args.tasksFilter = a.slice("--tasks=".length);
    } else if (a === "--max") {
      args.max = Number(argv[++i]);
    } else if (a.startsWith("--max=")) {
      args.max = Number(a.slice("--max=".length));
    } else if (a === "--min-pass-rate") {
      args.minPassRate = Number(argv[++i]);
    } else if (a.startsWith("--min-pass-rate=")) {
      args.minPassRate = Number(a.slice("--min-pass-rate=".length));
    }
  }
  return args;
}

/** Apply --tasks (category OR name match) and --max to the task list. */
function selectTasks(tasks: EvalTask[], args: CliArgs): EvalTask[] {
  let out = tasks;
  if (args.tasksFilter) {
    const f = args.tasksFilter.toLowerCase();
    out = out.filter(
      (t) => t.category.toLowerCase() === f || t.name.toLowerCase().includes(f),
    );
  }
  if (args.max != null && Number.isFinite(args.max) && args.max > 0) {
    out = out.slice(0, args.max);
  }
  return out;
}

/**
 * MODEL_SWEEP: comma-separated list of "provider:model" pairs.
 * Example: ALAN_MODEL_SWEEP="anthropic:claude-haiku-4-5-20251001,openai:gpt-4o-mini"
 *
 * Sweeps only run in real mode — in mock mode every task uses the mock provider.
 */
function parseModelSweep(): Array<{ provider: string; model: string }> | null {
  const raw = process.env.ALAN_MODEL_SWEEP;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) {
        return { provider: process.env.ALAN_EVAL_PROVIDER ?? process.env.ALAN_PROVIDER ?? DEFAULT_PROVIDER, model: entry };
      }
      return { provider: entry.slice(0, colonIdx), model: entry.slice(colonIdx + 1) };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --real flag OR the legacy ALAN_EVAL_REAL=1 env var enables real mode.
  const real = args.real || IS_REAL_MODE;

  const provider =
    process.env.ALAN_EVAL_PROVIDER ?? process.env.ALAN_PROVIDER ?? DEFAULT_PROVIDER;
  const model = process.env.ALAN_EVAL_MODEL ?? process.env.ALAN_MODEL ?? DEFAULT_MODEL;

  // ── Fail fast if --real is requested without the relevant API key. ──
  // Never touch the network or hang waiting on input.
  if (real) {
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (!keyEnv) {
      console.error(
        `\n  \x1b[31mUnknown provider "${provider}".\x1b[0m Set ALAN_EVAL_PROVIDER to one of: ` +
          `${Object.keys(PROVIDER_KEY_ENV).join(", ")}\n`,
      );
      process.exit(1);
    }
    if (!process.env[keyEnv]) {
      console.error(
        `\n  \x1b[31m--real requires a live API key, but ${keyEnv} is not set.\x1b[0m\n` +
          `  Provider: ${provider}   Model: ${model}\n\n` +
          `  Set the key and retry, e.g.:\n` +
          `    \x1b[2m${keyEnv}=sk-... bun run tests/eval/runner.ts --real\x1b[0m\n\n` +
          `  Optional overrides: ALAN_EVAL_PROVIDER, ALAN_EVAL_MODEL, --tasks <cat|name>, --max <n>\n`,
      );
      process.exit(1);
    }
  }

  // Select tasks (filters apply in both modes; handy for a cheap smoke run).
  let tasks = selectTasks(ALL_TASKS, args);
  // Mock mode needs a deterministic script per task; real mode judges purely by
  // verify(), so a script is optional there.
  if (!real) {
    tasks = tasks.filter((t) => t.script != null);
  }

  if (tasks.length === 0) {
    console.error(
      `\n  \x1b[31mNo tasks matched\x1b[0m` +
        (args.tasksFilter ? ` filter "${args.tasksFilter}"` : "") +
        `. Categories: comprehension, fix-failing-test, multi-file-refactor, new-feature, tool-discipline, core.\n`,
    );
    process.exit(1);
  }

  const modeLabel = real ? `real (${provider}/${model})` : "mock LLM provider";
  console.log("\n  \x1b[1mAlan eval suite\x1b[0m");
  console.log(`  \x1b[2m${tasks.length} tasks · ${modeLabel}\x1b[0m\n`);

  const sweepConfig = real ? parseModelSweep() : null;

  if (sweepConfig && sweepConfig.length > 1) {
    // ── Model sweep mode (real only) ──
    console.log(`  Running sweep across ${sweepConfig.length} models...\n`);
    const sweepResults: ModelSweepResult[] = [];

    for (const { provider: p, model: m } of sweepConfig) {
      console.log(`  \x1b[1m${p}/${m}\x1b[0m`);
      const results = await runSuite(tasks, { real: true, provider: p, model: m });
      const report = buildReport(results, "real", m, p);
      printReport(report);
      sweepResults.push({ model: m, provider: p, report });
    }

    printModelSweep(sweepResults);
    if (sweepResults.length > 0) {
      await writeBaseline(sweepResults[0].report);
    }

    const floor =
      args.minPassRate != null && Number.isFinite(args.minPassRate) ? args.minPassRate : 1;
    const allPassed = sweepResults.every((s) => s.report.passRate >= floor);
    process.exit(allPassed ? 0 : 1);
  }

  // ── Single model / mock mode ──
  const results = await runSuite(tasks, real ? { real: true, provider, model } : {});

  const report = buildReport(
    results,
    real ? "real" : "mock",
    real ? model : undefined,
    real ? provider : undefined,
  );
  printReport(report);
  await writeBaseline(report);

  const ok =
    args.minPassRate != null && Number.isFinite(args.minPassRate)
      ? report.passRate >= args.minPassRate
      : report.passed === report.total;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
