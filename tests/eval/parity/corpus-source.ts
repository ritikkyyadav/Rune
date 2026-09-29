// ─── The frozen corpus as parity tasks ───
//
// The twelve corpus tasks (tests/eval/corpus), each as a `ParityTask` any arm
// can be pointed at. It is a READER of what the comparison rig already does,
// not a second copy of it: the fixture comes from `corpusTasks` and is seeded
// by `seedTask` (commit the tracked files, then write the untracked ones — the
// dirty-worktree shape), the prompt is `comparisonPrompt` (the same bytes every
// earlier live row was sent), and the grader runs the corpus's own
// `acceptance.json` commands with the checks copied in beside the tree, exactly
// as the offline runner and `checkTask` do. So a parity row, an offline row and
// a pilot row answer one question.
//
// Two things the pilot grader did not do, because the parity index needs them:
//
//   · EVERY acceptance command runs. `checkTask` failed on the first non-zero,
//     so a run that got two of three criteria right scored the same as one
//     that got none; the index scores the share (`quality()`), so each
//     criterion is its own hidden check.
//   · a criterion whose check exits 2 WITH the checks' own PLAYWRIGHT_UNAVAILABLE
//     marker is IMPOSSIBLE here, not failed. The browser checks say that when
//     no Chromium can start, which says nothing about the page, so the
//     criterion leaves the denominator — for every arm (run-pairs reconciles
//     the two sides). An exit 2 WITHOUT the marker is a failed check: the
//     checks import the arm's own code, and arm-written code can exit 2 (the
//     dependent-migration fixture's CLI does), which must never make a
//     criterion the arm failed disappear from its denominator.
//
// And three things about running a check at all:
//
//   · the checks are copied into a `.rune-acceptance/` the grader EMPTIES
//     first, so nothing an arm left there (an `env.json` pointing a browser
//     check at a module of its own) is ever run as part of the grader;
//   · the check runs with the neutral environment an arm gets (`armEnv`), not
//     the rig's: it executes model-written code, and the founder's keys have
//     no business in that process;
//   · a check that ran out of time or flooded its output was held up by the
//     tree under test — the arm's failure. Only a check that could not be
//     STARTED is the grader's (`GraderInfrastructureError`).
//
// What the corpus gives no signal for stays at its null value: no
// pass-to-pass suite (regressionsIntroduced 0) and no separate build step
// (buildBroken false). Those are not claims that nothing regressed; they are
// the absence of a check, and the mined serious tasks are where they are real.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { armEnv, taskEnvNames } from "../comparison/arms/types";
import { comparisonPrompt, corpusTasks, seedTask } from "../comparison/runner";
import type { ComparisonTask } from "../comparison/tasks";
import { CORPUS_FAMILY, type Family, type Outcome, type ParityTask } from "./types";

/** The frozen corpus, beside this directory. */
export const CORPUS_DIR = resolve(import.meta.dir, "../corpus");

/** Where the checks are copied at grade time — the corpus's own convention. */
export const CHECK_DIR = ".rune-acceptance";

/** One acceptance criterion as `acceptance.json` states it. */
export interface CorpusCriterion {
  id: string;
  text: string;
  command: string;
}

/** A corpus task in the contract's shape, plus what the arms and grader need. */
export interface CorpusParityTask extends ParityTask {
  /** A browser task: the arms get the Playwright runtime's names in their env. */
  browser?: boolean;
  criteria: CorpusCriterion[];
}

/** A grader that could not RUN is not an arm that failed. run-pairs reads this. */
export class GraderInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderInfrastructureError";
  }
}

interface TaskMeta {
  id: string;
  family: string;
  prompt: string;
  files: string[];
  untracked?: string[];
  browser?: boolean;
  constraints?: string[];
}

/**
 * The task forbids code changes, by its own pinned constraints.
 *
 * Read from `task.json` rather than listed here: "no code may be changed"
 * (cache-plan) and "no source file may be modified" (explain-quote-handling)
 * are the corpus's two wordings, and a task that says "window.test.ts must not
 * be edited" restricts ONE file, which is a different thing.
 */
export function forbidsCode(constraints: readonly string[] | undefined): boolean {
  return (constraints ?? []).some((constraint) =>
    /\bno\s+(?:code|source(?:\s+files?)?)\b.*\b(?:changed|modified|edited|touched)\b/i.test(
      constraint,
    ),
  );
}

/**
 * The files the prompt asks the arm to CREATE: every Markdown file it names
 * that the fixture does not already hold ("Write it to PLAN.md", "Write the
 * explanation to ANSWER.md"). A file it names that already exists — the
 * CHANGELOG.md a feature task updates — is an edit, not a new file.
 */
export function expectedNewFilesOf(
  prompt: string,
  existing: readonly string[],
): string[] | undefined {
  const named = [...new Set(prompt.match(/\b[\w.-]+\.md\b/g) ?? [])];
  const created = named.filter((path) => !existing.includes(path));
  return created.length ? created : undefined;
}

/** A criterion's result: 0 passed, 1 failed, 2 impossible in this environment. */
export type CheckStatus = 0 | 1 | 2;

/** What the corpus's browser checks print when no Chromium could start. */
export const IMPOSSIBLE_MARKER = "PLAYWRIGHT_UNAVAILABLE";

/**
 * One check's status, from what its process did. Pure.
 *
 * 2 needs BOTH the exit code and the marker the checks print with it; any other
 * non-zero exit, and a check that timed out or flooded its output, is 1.
 */
export function checkStatus(run: {
  exitCode: number | null;
  output: string;
  heldUp?: boolean;
}): CheckStatus {
  if (run.heldUp) return 1;
  if (run.exitCode === 0) return 0;
  if (run.exitCode === 2 && run.output.includes(IMPOSSIBLE_MARKER)) return 2;
  return 1;
}

/**
 * The quality inputs, from what each criterion's check did.
 *
 * Pure, so the arithmetic is tested without spawning. EVERY criterion counts —
 * nothing stops at the first failure — and the impossible ones leave the total.
 */
export function outcomeFromChecks(
  results: ReadonlyArray<{ id: string; status: CheckStatus }>,
): Outcome {
  const impossible = results.filter((r) => r.status === 2).map((r) => r.id);
  const runnable = results.filter((r) => r.status !== 2);
  return {
    hiddenPassed: runnable.filter((r) => r.status === 0).length,
    hiddenTotal: runnable.length,
    regressionsIntroduced: 0,
    buildBroken: false,
    impossible,
  };
}

/** `bun …` in an acceptance command, pinned to the bun that is running this. */
const pinnedBun = (command: string): string =>
  command.replace(/^bun(?=\s)/, JSON.stringify(process.execPath));

/** The per-command time limit the pilot grader has always used. */
export const CRITERION_TIMEOUT_MS = 240_000;

/** A check's output is read to its tail; past this much it is the tree flooding it. */
const CHECK_OUTPUT_LIMIT = 16 * 1024 * 1024;

function gradeCorpus(
  taskDir: string,
  task: Pick<CorpusParityTask, "criteria" | "browser">,
  workspace: string,
  evidenceDir: string,
): Outcome {
  const checks = join(taskDir, "checks");
  if (!existsSync(checks))
    throw new GraderInfrastructureError(`the corpus task has no checks directory: ${checks}`);
  // Emptied first: whatever the arm left under this name is not the grader.
  rmSync(join(workspace, CHECK_DIR), { recursive: true, force: true });
  cpSync(checks, join(workspace, CHECK_DIR), { recursive: true });
  // The browser runtime reaches a check through a file, not the environment,
  // exactly as `materialise` hands it to the offline runner.
  if (task.browser && process.env.RUNE_BENCH_PLAYWRIGHT)
    writeFileSync(
      join(workspace, CHECK_DIR, "env.json"),
      JSON.stringify(
        {
          playwrightModule: process.env.RUNE_BENCH_PLAYWRIGHT,
          browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
        },
        null,
        2,
      ) + "\n",
    );
  // The environment an arm gets, plus the task's own names: the check runs the
  // arm's code, and nothing of the rig's shell belongs in that process.
  const env = armEnv(taskEnvNames(task));
  const results: Array<{ id: string; text: string; status: CheckStatus; tail: string }> = [];
  for (const criterion of task.criteria) {
    const run = spawnSync(pinnedBun(criterion.command), {
      cwd: workspace,
      env,
      shell: true,
      encoding: "utf8",
      timeout: CRITERION_TIMEOUT_MS,
      maxBuffer: CHECK_OUTPUT_LIMIT,
    });
    const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
    // Held up by the tree under test — out of time, or flooding its output —
    // is the arm's failure. A check that could not be STARTED is the grader's.
    const heldUp = code === "ETIMEDOUT" || code === "ENOBUFS";
    if (run.error && !heldUp)
      throw new GraderInfrastructureError(
        `${criterion.id}: the check could not start (${run.error.message})`,
      );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    results.push({
      id: criterion.id,
      text: criterion.text,
      status: checkStatus({ exitCode: run.status, output, heldUp }),
      tail: output.trim().slice(-400),
    });
  }
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "grade.json"), JSON.stringify(results, null, 2) + "\n");
  return outcomeFromChecks(results);
}

/**
 * The corpus's tasks as parity tasks, in the corpus's pinned order.
 *
 * `ids` narrows the list; an id the corpus does not hold is refused by name,
 * never silently dropped — a founder who authorised three tasks must not pay
 * for two.
 */
export function corpusParityTasks(dir: string = CORPUS_DIR, ids?: string[]): CorpusParityTask[] {
  const root = resolve(dir);
  const catalogue = corpusTasks(root);
  const known = new Set(catalogue.map((task) => task.id));
  const unknown = (ids ?? []).filter((id) => !known.has(id));
  if (unknown.length)
    throw new Error(
      `The corpus does not hold ${unknown.join(", ")}. It holds: ${[...known].join(", ")}.`,
    );
  return catalogue
    .filter((task) => !ids || ids.includes(task.id))
    .map((comparison) => parityTaskOf(root, comparison));
}

function parityTaskOf(root: string, comparison: ComparisonTask): CorpusParityTask {
  const taskDir = join(root, comparison.id);
  const meta = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as TaskMeta;
  const family: Family | undefined = CORPUS_FAMILY[meta.family];
  if (!family) throw new Error(`${meta.id}: corpus family ${meta.family} has no parity family`);
  const criteria = (
    JSON.parse(readFileSync(join(taskDir, "acceptance.json"), "utf8")) as Array<{
      id?: string;
      text: string;
      command?: string;
    }>
  ).map((criterion, index) => {
    if (!criterion.command)
      throw new Error(`${meta.id}: acceptance criterion ${index + 1} has no command`);
    return {
      id: criterion.id ?? `c${index + 1}`,
      text: criterion.text,
      command: criterion.command,
    };
  });
  const expectedNewFiles = expectedNewFilesOf(meta.prompt, [
    ...meta.files,
    ...(meta.untracked ?? []),
  ]);
  const task: CorpusParityTask = {
    id: comparison.id,
    family,
    prompt: comparisonPrompt(comparison),
    size: "small",
    ...(forbidsCode(meta.constraints) ? { noCode: true } : {}),
    ...(expectedNewFiles ? { expectedNewFiles } : {}),
    ...(comparison.browser ? { browser: true } : {}),
    criteria,
    async prepare(workspace: string): Promise<void> {
      seedTask(comparison, workspace);
    },
    async grade(workspace: string, evidenceDir: string): Promise<Outcome> {
      return gradeCorpus(taskDir, task, workspace, evidenceDir);
    },
  };
  return task;
}
