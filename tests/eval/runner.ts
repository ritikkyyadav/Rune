#!/usr/bin/env bun
import { readFile } from "fs/promises";

import { runSuite, IS_REAL_MODE } from "./harness";
import type { EvalTask } from "./harness";
import { ALL_TASKS } from "./tasks";
import {
  buildReport,
  printReport,
  writeBaseline,
  printModelSweep,
  compareToBaseline,
  printComparison,
  baselinePathFor,
  compareArms,
  printArmComparison,
} from "./report";
import type { ArmComparison, ModelSweepResult } from "./report";
import {
  VARIANT_IDS,
  isVariantId,
  variant as variantOf,
  variantConfig,
} from "../../packages/orchestrator/src/evolve/variants";
import { currentYardstick } from "../../packages/orchestrator/src/evolve/yardstick";

// ─── Real-mode defaults & key wiring ───
//
// In --real mode the suite drives a LIVE model through the real engine/gateway.
// Provider/model come from env (RUNE_EVAL_PROVIDER / RUNE_EVAL_MODEL), with the
// older RUNE_PROVIDER / RUNE_MODEL names accepted as fallbacks. The dev default
// is a FREE model (Gemini 2.5 Flash). For a later production-validation pass, set
// RUNE_EVAL_PROVIDER / RUNE_EVAL_MODEL to a paid top-tier model
// (e.g. anthropic / claude-sonnet-4-20250514).

const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Providers that authenticate from a stored OAuth credential rather than an
 * env var — a ChatGPT plan, logged in once with `rune login`.
 *
 * They were absent from the map below, and the map was also the allowlist, so
 * `--real` refused to run on them at all: the suite could not measure the
 * transport carrying most of this agent's real traffic. There is no key name
 * to demand here; a missing login surfaces as an auth error on the first call,
 * which is the same failure the env-var check exists to pre-empt.
 */
const SUBSCRIPTION_PROVIDERS = new Set(["codex"]);

/** Which env var holds the API key for each provider. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GOOGLE_API_KEY",
  "ollama-turbo": "OLLAMA_API_KEY",
};

interface CliArgs {
  real: boolean;
  /** Filter by category or exact task name (substring-insensitive on name). */
  tasksFilter?: string;
  /** Cap the number of tasks that run (after filtering). */
  max?: number;
  /** Regression gate: exit 0 if cleanPassRate >= this (0–1); else require all pass. */
  minPassRate?: number;
  /** Re-anchor the mode's baseline on this run. The ONLY way the baseline moves. */
  writeBaseline?: boolean;
  /** Compare against a recorded baseline and fail on regression beyond --noise. */
  compare?: string;
  /** Noise band for --compare (fraction of pass-rate). Default 0 mock / 0.05 real. */
  noise?: number;
  /** Paired A/B: run control, then this variant, on the same tasks in the same order. */
  ab?: string;
  /** Write the paired report as JSON here (the ledger reads it). */
  abOut?: string;
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
    } else if (a === "--write-baseline") {
      args.writeBaseline = true;
    } else if (a === "--compare") {
      // Optional value: bare --compare resolves to the mode-specific baseline
      // (baseline-mock.json for mock runs, baseline.json for real) in main().
      const next = argv[i + 1];
      args.compare = next && !next.startsWith("--") ? argv[++i] : "auto";
    } else if (a.startsWith("--compare=")) {
      args.compare = a.slice("--compare=".length);
    } else if (a === "--noise") {
      args.noise = Number(argv[++i]);
    } else if (a.startsWith("--noise=")) {
      args.noise = Number(a.slice("--noise=".length));
    } else if (a === "--ab") {
      args.ab = argv[++i];
    } else if (a.startsWith("--ab=")) {
      args.ab = a.slice("--ab=".length);
    } else if (a === "--ab-out") {
      args.abOut = argv[++i];
    } else if (a.startsWith("--ab-out=")) {
      args.abOut = a.slice("--ab-out=".length);
    }
  }
  return args;
}

/** Apply --tasks (category OR name match) and --max to the task list. */
function selectTasks(tasks: EvalTask[], args: CliArgs): EvalTask[] {
  let out = tasks;
  if (args.tasksFilter) {
    const f = args.tasksFilter.toLowerCase();
    out = out.filter((t) => t.category.toLowerCase() === f || t.name.toLowerCase().includes(f));
  }
  if (args.max != null && Number.isFinite(args.max) && args.max > 0) {
    out = out.slice(0, args.max);
  }
  return out;
}

/**
 * MODEL_SWEEP: comma-separated list of "provider:model" pairs.
 * Example: RUNE_MODEL_SWEEP="anthropic:claude-haiku-4-5-20251001,openai:gpt-4o-mini"
 *
 * Sweeps only run in real mode — in mock mode every task uses the mock provider.
 */
function parseModelSweep(): Array<{ provider: string; model: string }> | null {
  const raw = process.env.RUNE_MODEL_SWEEP ?? process.env.RUNE_MODEL_SWEEP;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) {
        return {
          provider:
            process.env.RUNE_EVAL_PROVIDER ??
            process.env.RUNE_EVAL_PROVIDER ??
            process.env.RUNE_PROVIDER ??
            process.env.RUNE_PROVIDER ??
            DEFAULT_PROVIDER,
          model: entry,
        };
      }
      return { provider: entry.slice(0, colonIdx), model: entry.slice(colonIdx + 1) };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // --real flag OR the legacy RUNE_EVAL_REAL=1 env var enables real mode.
  const real = args.real || IS_REAL_MODE;

  const provider =
    process.env.RUNE_EVAL_PROVIDER ??
    process.env.RUNE_EVAL_PROVIDER ??
    process.env.RUNE_PROVIDER ??
    process.env.RUNE_PROVIDER ??
    DEFAULT_PROVIDER;
  const model =
    process.env.RUNE_EVAL_MODEL ??
    process.env.RUNE_EVAL_MODEL ??
    process.env.RUNE_MODEL ??
    process.env.RUNE_MODEL ??
    DEFAULT_MODEL;

  // ── Fail fast if --real is requested without the relevant API key. ──
  // Never touch the network or hang waiting on input.
  if (real && !SUBSCRIPTION_PROVIDERS.has(provider)) {
    const keyEnv = PROVIDER_KEY_ENV[provider];
    if (!keyEnv) {
      console.error(
        `\n  \x1b[31mUnknown provider "${provider}".\x1b[0m Set RUNE_EVAL_PROVIDER to one of: ` +
          `${[...Object.keys(PROVIDER_KEY_ENV), ...SUBSCRIPTION_PROVIDERS].join(", ")}\n`,
      );
      process.exit(1);
    }
    if (!process.env[keyEnv]) {
      console.error(
        `\n  \x1b[31m--real requires a live API key, but ${keyEnv} is not set.\x1b[0m\n` +
          `  Provider: ${provider}   Model: ${model}\n\n` +
          `  Set the key and retry, e.g.:\n` +
          `    \x1b[2m${keyEnv}=sk-... bun run tests/eval/runner.ts --real\x1b[0m\n\n` +
          `  Optional overrides: RUNE_EVAL_PROVIDER, RUNE_EVAL_MODEL, --tasks <cat|name>, --max <n>\n`,
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
  console.log("\n  \x1b[1mRune eval suite\x1b[0m");
  console.log(`  \x1b[2m${tasks.length} tasks · ${modeLabel}\x1b[0m\n`);

  // ── Paired A/B (P7.4) ──
  //
  // Control then treatment, same task set, same order, same seeds, same
  // process. Everything about the two runs is identical except the variant's
  // configuration delta, which is what makes the difference attributable.
  // The control arm runs FIRST and unconditionally: without a control group
  // measured in the same process on the same day, a treatment number is a
  // number about the machine, not about the change.
  if (args.ab) {
    if (!isVariantId(args.ab)) {
      console.error(
        `\n  \x1b[31mUnknown variant "${args.ab}".\x1b[0m Declared variants: ${VARIANT_IDS.join(", ")}\n` +
          `  The registry is closed on purpose (packages/orchestrator/src/evolve/variants.ts).\n`,
      );
      process.exit(1);
    }
    const v = variantOf(args.ab);
    console.log(`  \x1b[1mA/B\x1b[0m ${v.id} \x1b[2m— ${v.summary}\x1b[0m`);
    console.log(`  \x1b[2m${v.hypothesis}\x1b[0m\n`);

    const armOpts = real ? { real: true as const, provider, model } : {};

    console.log("  \x1b[1mcontrol\x1b[0m");
    const controlResults = await runSuite(tasks, { ...armOpts, arm: "control" });
    const controlReport = buildReport(
      controlResults,
      real ? "real" : "mock",
      real ? model : undefined,
      real ? provider : undefined,
    );

    console.log(`\n  \x1b[1mtreatment\x1b[0m \x1b[2m(${v.id})\x1b[0m`);
    const treatmentResults = await runSuite(tasks, {
      ...armOpts,
      arm: v.id,
      configOverrides: variantConfig(v.id),
    });
    const treatmentReport = buildReport(
      treatmentResults,
      real ? "real" : "mock",
      real ? model : undefined,
      real ? provider : undefined,
    );

    const cmp: ArmComparison = compareArms(v.id, controlReport, treatmentReport, {
      noiseBand: args.noise != null && Number.isFinite(args.noise) ? args.noise : undefined,
    });
    printArmComparison(cmp);

    if (args.abOut) {
      // The ledger reads this file; `rune evolve promote` refuses without a
      // passing entry for the exact hash pair it names.
      await Bun.write(
        args.abOut,
        JSON.stringify(
          {
            comparison: cmp,
            control: controlReport,
            treatment: treatmentReport,
            // The yardstick this measurement ran against. A promotion is
            // refused when the suite has moved since a human blessed it, so an
            // old report can never be replayed against a changed ruler.
            yardstick: currentYardstick(__dirname).hash,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log(`  \x1b[2mreport written to ${args.abOut}\x1b[0m\n`);
    }
    // A/B is a measurement, not a gate on the suite: exit 0 when the run
    // completed, whatever the verdict. A non-zero exit here would make "the
    // variant lost" indistinguishable from "the suite is broken".
    process.exit(cmp.compared > 0 ? 0 : 1);
  }

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
      await writeBaseline(sweepResults[0].report, args.writeBaseline === true);
    }

    const floor =
      args.minPassRate != null && Number.isFinite(args.minPassRate) ? args.minPassRate : 1;
    const allPassed = sweepResults.every((s) => s.report.cleanPassRate >= floor);
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

  // ── Baseline regression gate (--compare) ──
  // Runs BEFORE writeBaseline so the run is judged against the old snapshot,
  // not against itself. Incompatible baselines (different mode/model) skip
  // cleanly instead of gating on a measurement of something else.
  let compareOk = true;
  if (args.compare) {
    const comparePath =
      args.compare === "auto" ? baselinePathFor(real ? "real" : "mock") : args.compare;
    let baseline: Parameters<typeof compareToBaseline>[1] = null;
    try {
      baseline = JSON.parse(await readFile(comparePath, "utf8"));
    } catch {
      baseline = null; // missing/corrupt baseline → skip, printComparison explains
    }
    const noise = args.noise != null && Number.isFinite(args.noise) ? args.noise : real ? 0.05 : 0;
    const cmp = compareToBaseline(report, baseline, noise);
    printComparison(cmp);
    compareOk = cmp.ok;
  }

  // Baseline hygiene (P10.4a): the baseline is IMMUTABLE unless --write-baseline
  // says otherwise. The run is always archived to results/; the yardstick only
  // moves when someone means to move it.
  //
  // It used to re-anchor on every passing `--compare` run, so the gate rewrote
  // the very file it had just compared against — a ruler that redraws itself to
  // match the last thing it measured. A filtered run is still a subset and a
  // failed-gate run is still a regression, so both are called out when the flag
  // is passed anyway.
  if (args.writeBaseline) {
    if (args.tasksFilter != null || args.max != null) {
      console.log(
        "  \x1b[33m⚠ re-anchoring the baseline on a FILTERED run — the anchor now covers a subset of the suite\x1b[0m",
      );
    }
    if (!compareOk) {
      console.log(
        "  \x1b[33m⚠ re-anchoring the baseline on a run that FAILED the regression gate\x1b[0m",
      );
    }
  }
  await writeBaseline(report, args.writeBaseline === true);

  // Gate on the CLEAN rate (throttled tasks excluded). With no explicit floor,
  // require every MEASURED task to pass — throttled tasks neither pass nor fail
  // the gate, so a rate-limited run won't spuriously fail CI.
  const ok =
    args.minPassRate != null && Number.isFinite(args.minPassRate)
      ? report.cleanPassRate >= args.minPassRate
      : report.passed === report.measured && report.measured > 0;
  process.exit(ok && compareOk ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
