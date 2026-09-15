#!/usr/bin/env bun
// ─── Running a comparator arm over the frozen corpus ───
//
// The Rune side of a comparison is `runner.ts --corpus`. This is the other
// side: it takes the SAME twelve tasks, seeds the same fixtures, and grades
// with the same `acceptance.json`, so a Claude Code row and a Rune row are
// answering one question.
//
// Two doors, and only two:
//
//   --dry-run  prints the plan — every argv, cwd, kept credential and parity
//              gap, for every task — and executes nothing. The only child
//              process a dry run starts is `<tool> --version`.
//   --real     the live path, which spends. It refuses to start unless
//              `RUNE_EVAL_BUDGET_USD` names a positive number of dollars
//              somebody decided to spend, exactly as `runPilot` does, and
//              refuses a `--budget-usd` above it.
//
// And one rule that is not in the code, because no code can enforce it: on a
// subscription, a live run spends the founder's quota, which makes it an
// external action. It runs when the founder authorises it in their own words,
// naming the task count and the arm order. Until then these arms are validated
// and idle.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { authorisedBudgetUsd, checkTask, comparisonPrompt, corpusTasks, seedTask } from "../runner";
import type { ComparisonTask } from "../tasks";
import { claudeCodeArm } from "./claude-code";
import { codexArm } from "./codex";
import { opencodeArm } from "./opencode";
import type { ArmLimits, ArmName, ArmPlan, ArmTask, ComparatorArm } from "./types";
import { credentialShaped, workspaceOf } from "./types";

/**
 * The arms this driver can run.
 *
 * `rune` is deliberately absent: the Rune arm lives in `runPilot`, where the
 * source digest, the profile isolation and the reserve-before-inference cap
 * live with it. A second Rune implementation would be a second thing to keep
 * honest.
 */
export const ARMS: Record<Exclude<ArmName, "rune">, ComparatorArm> = {
  opencode: opencodeArm,
  "claude-code": claudeCodeArm,
  codex: codexArm,
};

export interface ArmSeriesOptions {
  arms: Array<Exclude<ArmName, "rune">>;
  out: string;
  /** The frozen corpus directory. */
  corpus: string;
  tasks?: string[];
  model?: string;
  reasoningEffort?: string;
  budgetUsd: number;
  timeoutMs: number;
  dryRun?: boolean;
  /** Executable overrides, by arm — a pinned build, or a test's fixture. */
  command?: Partial<Record<ArmName, string[]>>;
}

export function limitsFor(options: ArmSeriesOptions, arm: ArmName): ArmLimits {
  return {
    timeoutMs: options.timeoutMs,
    budgetUsd: options.budgetUsd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.command?.[arm] ? { command: options.command[arm]! } : {}),
  };
}

export interface PlannedRun {
  task: string;
  arm: Exclude<ArmName, "rune">;
  dir: string;
  plan: ArmPlan;
}

export interface SeriesPlan {
  versions: Record<string, string | null>;
  runs: PlannedRun[];
  lines: string[];
}

const KEPT_CREDENTIALS = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter(credentialShaped).sort();

/**
 * What the run WOULD do, in full, without doing any of it.
 *
 * The plan is the thing a reviewer reads before a dollar is spent: the exact
 * argv, the exact working directory, which credential-shaped variables survived
 * the scrub, and what the arm cannot match. It is also what the offline test
 * asserts, so the plan a reviewer reads is the plan the live path runs.
 */
/**
 * The tasks a series will run, and a refusal for any id that matched nothing.
 *
 * `--tasks` used to be a filter and only a filter, so a list where every id was
 * wrong threw and a list with ONE typo silently shrank: `--tasks a,b-typo,c`
 * planned two runs, printed "2 run(s) planned", and said nothing about the
 * third. On `--real` that is a founder authorising three tasks and paying for
 * two, with the shortfall visible only by counting lines.
 *
 * The empty check comes first so the message for "none of these exist" stays
 * the one it has always been.
 */
export function selectedTasks(options: ArmSeriesOptions): ComparisonTask[] {
  const catalogue = corpusTasks(options.corpus);
  const tasks = catalogue.filter((task) => !options.tasks || options.tasks.includes(task.id));
  if (!tasks.length) throw new Error("No tasks selected from the corpus.");
  const known = new Set(catalogue.map((task) => task.id));
  const unmatched = (options.tasks ?? []).filter((id) => !known.has(id));
  if (unmatched.length)
    throw new Error(
      `--tasks names ${unmatched.length} id(s) this corpus does not hold: ${unmatched.join(", ")}. ` +
        `The corpus holds: ${catalogue.map((task) => task.id).join(", ")}.`,
    );
  return tasks;
}

/**
 * The most a series can spend, in dollars: every planned run at the per-task
 * ceiling. Needs no `--version` probe and spawns nothing, so the authorisation
 * gate can ask it before anything runs.
 */
export function worstCaseSeriesUsd(options: ArmSeriesOptions): {
  runs: number;
  usd: number;
} {
  const runs = selectedTasks(options).length * options.arms.length;
  return { runs, usd: runs * options.budgetUsd };
}

export function planSeries(options: ArmSeriesOptions): SeriesPlan {
  const tasks = selectedTasks(options);
  const versions: Record<string, string | null> = {};
  const runs: PlannedRun[] = [];
  // The comparator gets the same bytes the Rune arm gets — `comparisonPrompt`
  // is the runner's own, imported rather than reproduced.
  const armTask = (task: ComparisonTask): ArmTask => ({
    id: task.id,
    prompt: comparisonPrompt(task),
    ...(task.browser ? { browser: true } : {}),
  });
  const lines: string[] = [
    `plan: ${options.arms.join(", ")} over ${tasks.length} corpus task(s) from ${resolve(options.corpus)}`,
    `limits: model=${options.model ?? "(the tool's default)"} effort=${options.reasoningEffort ?? "(the tool's default)"} timeout=${options.timeoutMs}ms budget=$${options.budgetUsd}/task`,
  ];
  for (const arm of options.arms) {
    const implementation = ARMS[arm];
    const limits = limitsFor(options, arm);
    versions[arm] = implementation.version(limits);
    lines.push(`${arm}: version ${versions[arm] ?? "(unreported)"}`);
    for (const gap of implementation.plan(armTask(tasks[0]!), join(options.out, "plan"), limits)
      .parityGaps)
      lines.push(`  parity — ${gap}`);
  }
  for (const [index, task] of tasks.entries())
    for (const arm of options.arms) {
      const limits = limitsFor(options, arm);
      const dir = join(options.out, `${task.id}-${arm}`);
      const plan = ARMS[arm].plan(armTask(task), dir, limits);
      runs.push({ task: task.id, arm, dir, plan });
      lines.push(
        `${String(index + 1).padStart(2, " ")}. ${task.id} · ${arm}`,
        `    cwd  ${plan.cwd}`,
        `    argv ${JSON.stringify(plan.command)}`,
        `    auth ${KEPT_CREDENTIALS(plan.env).join(", ") || "(none present in this shell)"}`,
      );
    }
  // The figure the person authorising the run is actually authorising. It was
  // missing, and "budget=$2/task" beside "24 run(s) planned" left the
  // multiplication as an exercise for the reader.
  lines.push(
    `${runs.length} run(s) planned. Nothing was executed: a dry run spawns nothing but --version.`,
    `worst case: ${runs.length} run(s) × $${options.budgetUsd}/task = $${(runs.length * options.budgetUsd).toFixed(2)} total across the series. RUNE_EVAL_BUDGET_USD is the ceiling for the SERIES and must be at least this to run it live.`,
  );
  return { versions, runs, lines };
}

const write = (path: string, value: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};

/**
 * The live series.
 *
 * Same order as `runPilot`'s evidence: seed the fixture, run the arm, grade it
 * from outside the workspace, write the row, persist after every row. An
 * infrastructure interruption stops the series, because a quota that ran out
 * halfway makes every later row a different experiment.
 */
export async function runArmSeries(options: ArmSeriesOptions) {
  // The authorisation is the FIRST thing, ahead of the plan: `planSeries`
  // probes each tool's `--version`, and a run that is going to be refused
  // should not have started a child process to find out.
  const authorised = options.dryRun ? null : authorisedBudgetUsd();
  // RUNE_EVAL_BUDGET_USD is the ceiling for the WHOLE series, not for one task.
  // The gate used to compare it with `options.budgetUsd` alone, which meant the
  // documented command — 12 tasks × 2 arms × `--budget-usd 2` — planned $48 of
  // worst-case spend against a $2 authorisation and no running total was ever
  // compared with anything.
  if (authorised !== null) {
    const worst = worstCaseSeriesUsd(options);
    if (worst.usd > authorised)
      throw new Error(
        `This series plans ${worst.runs} run(s) at $${options.budgetUsd}/task — up to $${worst.usd.toFixed(2)} in total, ` +
          `above the authorised RUNE_EVAL_BUDGET_USD $${authorised}, which is the ceiling for the WHOLE series. ` +
          `Lower --budget-usd, select fewer tasks or arms, or authorise the larger figure.`,
      );
  }
  const plan = planSeries(options);
  if (options.dryRun) {
    for (const line of plan.lines) console.log(line);
    return { schema: 1, kind: "comparator-arm-dry-run", plan: plan.lines, results: [] };
  }
  if (existsSync(join(options.out, "report.json")))
    throw new Error(
      "Report already exists. Use a fresh output directory so evidence is never overwritten.",
    );
  const byId = new Map<string, ComparisonTask>(
    corpusTasks(options.corpus).map((task) => [task.id, task]),
  );
  // `runPilot`'s preflight, in the same place and for the same reason: a
  // browser task without a browser runtime is not a failed layout, it is a
  // task that could not start, and finding that out after inference is money
  // spent on nothing.
  if ([...byId.values()].some((task) => task.browser && plan.runs.some((r) => r.task === task.id)))
    if (!process.env.RUNE_BENCH_PLAYWRIGHT)
      throw new Error(
        "A selected task is a browser task and RUNE_BENCH_PLAYWRIGHT is unset. Point it at an installed Playwright module, or select the ten non-browser tasks with --tasks.",
      );
  const report = {
    schema: 1,
    kind: "comparator-arm-series",
    startedAt: new Date().toISOString(),
    corpus: resolve(options.corpus),
    limits: {
      perTaskListUsd: options.budgetUsd,
      seriesAuthorisedUsd: authorised,
      seriesWorstCaseUsd: worstCaseSeriesUsd(options).usd,
      timeoutMs: options.timeoutMs,
    },
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
    versions: plan.versions,
    limitations: [
      "One comparator arm per row. The Rune row for the same task comes from runner.ts --corpus; the two are comparable because the fixture and the acceptance are the same bytes.",
      "Claude Code and Codex run different model families, so a row against both is a harness comparison across families, never a same-model one.",
      "A subscription arm spends quota, not dollars. Quota is reported separately from any list-price figure and neither is an invoice.",
      "Infrastructure interruptions are unscored with usage retained, and stop the series.",
    ],
    results: [] as Array<Record<string, unknown>>,
  };
  const persist = () =>
    write(join(options.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  mkdirSync(options.out, { recursive: true });
  persist();
  // The running total, against the SERIES authorisation. A run whose cost
  // nobody reported counts as the full per-task ceiling: an unknown price is
  // not a free one, and this is the founder's money.
  let spentUsd = 0;
  const charged = (result: { listUsd: number | null; reportedCostUsd: number | null }): number =>
    result.reportedCostUsd === null && result.listUsd === null
      ? options.budgetUsd
      : Math.max(result.reportedCostUsd ?? 0, result.listUsd ?? 0);
  for (const run of plan.runs) {
    // Before the spend, not after it: the next run may cost the whole ceiling.
    if (authorised !== null && spentUsd + options.budgetUsd > authorised) {
      const stop = `Series stopped before ${run.task} · ${run.arm}: $${spentUsd.toFixed(4)} spent and the next run may cost up to $${options.budgetUsd}, which is past the authorised $${authorised}.`;
      console.log(stop);
      (report as Record<string, unknown>).stoppedEarly = stop;
      persist();
      break;
    }
    const task = byId.get(run.task)!;
    seedTask(task, workspaceOf(run.dir));
    const prompt = comparisonPrompt(task);
    write(join(run.dir, "prompt.txt"), prompt);
    console.log(`${run.task}: ${run.arm}`);
    const result = await ARMS[run.arm].runArm(
      { id: task.id, prompt, ...(task.browser ? { browser: true } : {}) },
      run.dir,
      limitsFor(options, run.arm),
    );
    spentUsd += charged(result);
    (report as Record<string, unknown>).spentUsd = spentUsd;
    const check = checkTask(task, workspaceOf(run.dir), run.dir);
    report.results.push({
      task: run.task,
      ...result,
      // The prompt and the argv are already in the plan; the environment never
      // reaches the report, because its values are credentials.
      env: undefined,
      acceptancePassed: check.passed,
      success: result.scored && check.passed && result.exitCode === 0,
      evidence: run.dir,
      completedAt: new Date().toISOString(),
    });
    persist();
    console.log(
      `${run.arm}: ${result.scored ? (check.passed ? "acceptance passed" : "acceptance failed") : `UNSCORED (${result.unscoredReason})`}; ${result.listUsd === null ? "cost unknown" : `$${result.listUsd.toFixed(4)} list`}; ${(result.durationMs / 1000).toFixed(1)}s`,
    );
    if (!result.scored) break;
  }
  return report;
}

const USAGE = `Comparator arms over the frozen corpus.

  bun run tests/eval/comparison/arms/run-arms.ts --dry-run \\
    --arms claude-code,codex --corpus tests/eval/corpus --out /tmp/arm-plan

  RUNE_EVAL_BUDGET_USD=<dollars> bun run tests/eval/comparison/arms/run-arms.ts --real \\
    --arms claude-code,codex --corpus tests/eval/corpus --model MODEL \\
    --effort high --out /tmp/rune-arms-<date> --budget-usd 2 --timeout-seconds 600

--real spends real money or subscription quota and refuses to start without
RUNE_EVAL_BUDGET_USD. A live comparator run is an external action: it happens
only when the founder authorises it in their own words, with the task count and
the arm order.`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const at = args.indexOf(`--${key}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--real")) {
    console.log(USAGE);
  } else {
    const out = get("out");
    if (!out) throw new Error("--out is required");
    const arms = (get("arms") ?? "claude-code,codex")
      .split(",")
      .map((name) => name.trim()) as Array<Exclude<ArmName, "rune">>;
    for (const arm of arms) if (!ARMS[arm]) throw new Error(`Unknown arm: ${arm}`);
    await runArmSeries({
      arms,
      out: resolve(out),
      corpus: get("corpus") ?? join(import.meta.dir, "../../corpus"),
      ...(get("tasks") ? { tasks: get("tasks")!.split(",") } : {}),
      ...(get("model") ? { model: get("model")! } : {}),
      reasoningEffort: get("effort") ?? "high",
      budgetUsd: Number(get("budget-usd") ?? 2),
      timeoutMs: Number(get("timeout-seconds") ?? 600) * 1000,
      dryRun,
    });
  }
}
