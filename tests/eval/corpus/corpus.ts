/**
 * The frozen diagnostic corpus: loading, materialising and reading it.
 *
 * Nothing here calls a model. A corpus task is a directory of plain files —
 * the fixture the run starts from, the acceptance the run is judged by, a
 * hand-written correct solution, and the scripted transcripts the offline
 * runner replays. This module is the only place that knows the layout, so the
 * sanity check, the offline runner and the live runner's `--corpus` option all
 * read the same bytes.
 *
 * Layout, per `<task-id>/`:
 *
 *   task.json           id, family, the prompt verbatim, file lists, browser
 *   acceptance.json     `AcceptanceSpec[]` — the evaluator criteria, never prompted
 *   checks/check.mjs    the acceptance commands' implementation
 *   fixture/**          the tracked starting tree (committed by `materialise`)
 *   untracked/**        files written AFTER the commit (the dirty-worktree shape)
 *   solution/**         a hand-written CORRECT answer, used only by the sanity check
 *   variants/<name>/**  the trees the `omission` / `wrong` / `silent` arms write
 *   scenarios/*.json    ordered content-block turns for the scripted provider
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { AcceptanceSpec } from "../../../packages/orchestrator/src/contract";

export const CORPUS_ROOT = import.meta.dir;

/** The directory the acceptance scripts are materialised into, inside the workspace. */
export const CHECK_DIR = ".rune-acceptance";

export type Family =
  "fix" | "omission-prone-feature" | "migration" | "frontend" | "research" | "dirty-worktree";

export type ScenarioName = "correct" | "omission" | "wrong" | "silent" | "stopped" | "wrong-v6";

/** The arm order, pinned. Changing it changes what the report's rows mean. */
export const SCENARIOS: ScenarioName[] = ["correct", "omission", "wrong", "silent", "stopped"];

/**
 * Extra arms a task carries beyond the pinned five.
 *
 * The five are every task's; these are the ones an ATTACK produced. V6 wrote
 * wrong solutions for three tasks that passed every acceptance criterion, and a
 * fourth arm for `cache-plan` whose omission the acceptance could not see — so
 * `0 / 48` was a property of the arms the author thought of, not of the oracle.
 * Adding them as arms is what makes that visible in the denominator instead of
 * in a footnote: a task declares them in `task.json`, and a run that skips them
 * is not a complete run.
 */
export function armsFor(task: CorpusTask): ScenarioName[] {
  return [...SCENARIOS, ...(task.extraScenarios ?? [])];
}

/**
 * The twelve tasks, in their pinned order.
 *
 * Nothing is added or dropped after the first offline run without a dated note
 * in `README.md`. The order is the report's order.
 */
export const TASK_IDS = [
  "csv-state-machine",
  "off-by-one-window",
  "queue-race",
  "health-endpoint-and-changelog",
  "note-field-and-exporter",
  "dependent-migration",
  "three-module-dependent",
  "responsive-project-board",
  "signup-form-states",
  "explain-quote-handling",
  "cache-plan",
  "working-tree-integration",
] as const;

export type TaskId = (typeof TASK_IDS)[number];

export interface CorpusTask {
  id: string;
  family: Family;
  /** Where the fixture came from, when it was taken from somewhere. */
  source?: string;
  /** Handed to the engine verbatim. */
  prompt: string;
  /** Tracked fixture paths, relative to `fixture/`. */
  files: string[];
  /** Untracked paths, relative to `untracked/`, written after the commit. */
  untracked?: string[];
  /** Needs `RUNE_BENCH_PLAYWRIGHT`; skipped, never passed, without it. */
  browser?: boolean;
  /** Constraints the corpus pins, for a reader. Not enforced by the runtime. */
  constraints?: string[];
  /** Anything a reader of the report needs to know about this task. */
  notes?: string;
  /** Arms beyond the pinned five — see `armsFor`. */
  extraScenarios?: ScenarioName[];
  dir: string;
}

/** One block of a scripted turn. `contentFrom` fills `input.content` from a file. */
export type ScenarioBlock =
  { text: string } | { tool: string; input: Record<string, unknown>; contentFrom?: string };

export interface CorpusScenario {
  scenario: ScenarioName;
  /** What this arm is meant to be, in one line. Printed in the report. */
  note: string;
  /** Engine reliability overrides — `stopped` uses a turn ceiling. */
  maxTurns?: number;
  turns: ScenarioBlock[][];
}

const read = (path: string) => readFileSync(path, "utf8");

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function loadTask(id: string): CorpusTask {
  const dir = join(CORPUS_ROOT, id);
  const meta = JSON.parse(read(join(dir, "task.json"))) as Omit<CorpusTask, "dir">;
  return { ...meta, dir };
}

export function loadTasks(): CorpusTask[] {
  return TASK_IDS.map(loadTask);
}

export function loadAcceptance(task: CorpusTask): AcceptanceSpec[] {
  return JSON.parse(read(join(task.dir, "acceptance.json"))) as AcceptanceSpec[];
}

export function loadScenario(task: CorpusTask, name: ScenarioName): CorpusScenario {
  return JSON.parse(read(join(task.dir, "scenarios", `${name}.json`))) as CorpusScenario;
}

function writeFile(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function git(root: string, args: string[]): void {
  const res = spawnSync(
    "git",
    [
      "-c",
      "user.name=Corpus",
      "-c",
      "user.email=corpus@localhost",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
}

/**
 * Write one task's starting tree into a scratch checkout.
 *
 * The tracked fixture is committed, so the run has a parent commit to probe;
 * the untracked files land afterwards, which is the dirty-worktree shape the
 * corpus is measuring. The acceptance scripts are copied into
 * `.rune-acceptance/`, which `.gitignore` hides: they are the evaluator's, not
 * the task's, and nothing in the fixture refers to them.
 */
export function materialise(task: CorpusTask, root: string): void {
  mkdirSync(root, { recursive: true });
  for (const path of task.files) writeFile(join(root, path), read(join(task.dir, "fixture", path)));
  writeFile(join(root, ".gitignore"), `${CHECK_DIR}/\n.rune/\nnode_modules/\n`);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--no-verify", "-qm", `corpus fixture: ${task.id}`]);
  for (const path of task.untracked ?? [])
    writeFile(join(root, path), read(join(task.dir, "untracked", path)));
  const checks = join(task.dir, "checks");
  if (existsSync(checks)) cpSync(checks, join(root, CHECK_DIR), { recursive: true });
  // The browser runtime reaches an acceptance command through a file, not the
  // environment: the tool sandbox filters environment variables, and a check
  // that silently could not find Chromium would be scored as a failed layout.
  if (task.browser && browserAvailable())
    writeFile(
      join(root, CHECK_DIR, "env.json"),
      JSON.stringify(
        {
          playwrightModule: process.env.RUNE_BENCH_PLAYWRIGHT,
          browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
        },
        null,
        2,
      ) + "\n",
    );
}

/** Copy `solution/` or `variants/<name>/` over a materialised workspace. */
export function applyTree(task: CorpusTask, root: string, subdir: string): string[] {
  const from = join(task.dir, subdir);
  const files = listFiles(from);
  for (const path of files) writeFile(join(root, path), read(join(from, path)));
  return files;
}

export function solutionFiles(task: CorpusTask): string[] {
  return listFiles(join(task.dir, "solution"));
}

/** Whether a browser task can run here. A missing runtime is a skip, never a pass. */
export function browserAvailable(): boolean {
  return Boolean(process.env.RUNE_BENCH_PLAYWRIGHT);
}
