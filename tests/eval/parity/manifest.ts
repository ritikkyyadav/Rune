// ─── The parity manifest ───
//
// One file that says, before anything is spent, exactly what a series will run
// and what it may use: which tasks and what grades each, which arms on which
// settings, how many repetitions in what order, how many arm runs and minutes
// it may take, and what was read of each account's window.
//
// It composes the task sources that already exist — the frozen corpus and its
// supplement through `corpusParityTasks`, the mined tasks through
// `seriousTasks` — and is a second copy of neither. The paired CLI used to read
// one corpus directory; the 48 tasks the gate needs were never one list.
//
// A manifest is written by a dry run and read back by a live one. In between,
// the tasks are loaded again from their sources and held to it
// (`manifestDrift`): a task whose prompt or checks changed since the manifest
// was written is not the task that was approved, and nothing runs.
//
// Only `availableTasks` touches the disk (through the loaders). The rest is pure.

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { seriousTasks } from "../serious/source";
import { CORPUS_DIR, corpusParityTasks } from "./corpus-source";
import type { ArmSpec } from "./run-pairs";
import type { AccountBudget, SeriesLimits } from "./series-budget";
import {
  WALL_LIMIT_MS,
  type Family,
  type ParityArm,
  type ParityMode,
  type ParityTask,
} from "./types";

export type TaskSource = "corpus" | "supplement" | "serious";
export const TASK_SOURCES: readonly TaskSource[] = ["corpus", "supplement", "serious"];

/** The supplement to the frozen corpus, in the corpus's own layout. */
export const SUPPLEMENT_DIR = resolve(import.meta.dir, "../parity-tasks");

export interface SourcedTask {
  source: TaskSource;
  task: ParityTask;
}

/**
 * Every task a series can be pointed at, from the loaders that already read
 * them. The same id in two sources is refused: a row names its task by id.
 */
export function availableTasks(
  sources: readonly TaskSource[] = TASK_SOURCES,
  dirs: { corpus?: string; supplement?: string; serious?: string } = {},
): SourcedTask[] {
  const load: Record<TaskSource, () => ParityTask[]> = {
    corpus: () => corpusParityTasks(dirs.corpus ?? CORPUS_DIR),
    supplement: () => corpusParityTasks(dirs.supplement ?? SUPPLEMENT_DIR),
    serious: () => seriousTasks(dirs.serious ? { dir: dirs.serious } : {}),
  };
  const out: SourcedTask[] = [];
  for (const source of TASK_SOURCES) {
    if (!sources.includes(source)) continue;
    for (const task of load[source]()) {
      const clash = out.find((other) => other.task.id === task.id);
      if (clash)
        throw new Error(
          `Task ${task.id} is in both ${clash.source} and ${source}: an id names one task.`,
        );
      out.push({ source, task });
    }
  }
  return out;
}

/** The tasks named, in the order named; all of them when none is. An unknown id is refused by name. */
export function selectTasks(all: readonly SourcedTask[], ids?: readonly string[]): SourcedTask[] {
  if (!ids) return [...all];
  const unknown = ids.filter((id) => !all.some((entry) => entry.task.id === id));
  if (unknown.length > 0)
    throw new Error(
      `No such task: ${unknown.join(", ")}. ${all.length} task(s) are available from ${[...new Set(all.map((entry) => entry.source))].join(", ")}.`,
    );
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) throw new Error(`Task ${twice} is named twice.`);
  return ids.map((id) => all.find((entry) => entry.task.id === id)!);
}

export const MANIFEST_KIND = "parity-manifest" as const;
export const MANIFEST_SCHEMA = "parity-manifest/1" as const;

/** One task as the manifest pins it: enough to tell, later, that it is still that task. */
export interface ManifestTask {
  id: string;
  family: Family;
  size: "small" | "serious";
  source: TaskSource | "given";
  /** `ParityTask.grader`: what grades it. */
  grader: string;
  /** sha256 of the prompt's bytes: what every arm is sent. */
  prompt: string;
}

export interface ManifestPair {
  task: string;
  run: number;
  first: ParityArm;
  second: ParityArm;
}

export interface ParityManifest {
  kind: typeof MANIFEST_KIND;
  schema: typeof MANIFEST_SCHEMA;
  arms: [ParityArm, ParityArm];
  mode: ParityMode;
  runs: number;
  /** Seeds the order tasks run in within each repetition. Null: the order given. */
  seed: number | null;
  tasks: ManifestTask[];
  /** How many of the tasks each family has. */
  families: Partial<Record<Family, number>>;
  specs: Partial<Record<ParityArm, ArmSpec>>;
  wallLimitsMs: Readonly<Record<"small" | "serious", number>>;
  /** Null on a plan nobody has given limits yet: such a manifest cannot be run live. */
  limits: SeriesLimits | null;
  accounts: Partial<Record<ParityArm, AccountBudget>>;
  bounded: boolean;
  /** Every pair, in the order it will be run. */
  order: ManifestPair[];
  /** What the plan needs if nothing is retried and every run uses its whole wall limit. */
  needs: { pairs: number; armRuns: number; worstCaseWallMs: number };
}

export const promptDigest = (prompt: string): string =>
  createHash("sha256").update(prompt).digest("hex");

export const manifestTask = (
  task: Pick<ParityTask, "id" | "family" | "size" | "grader" | "prompt">,
  source: ManifestTask["source"],
): ManifestTask => ({
  id: task.id,
  family: task.family,
  size: task.size,
  source,
  grader: task.grader,
  prompt: promptDigest(task.prompt),
});

export interface ManifestInput {
  arms: [ParityArm, ParityArm];
  mode: ParityMode;
  runs: number;
  seed: number | null;
  tasks: ManifestTask[];
  specs: Partial<Record<ParityArm, ArmSpec>>;
  limits: SeriesLimits | null;
  accounts: Partial<Record<ParityArm, AccountBudget>>;
  bounded: boolean;
  order: ManifestPair[];
}

/** The manifest for a planned series. Pure. */
export function buildManifest(input: ManifestInput): ParityManifest {
  const families: Partial<Record<Family, number>> = {};
  for (const task of input.tasks) families[task.family] = (families[task.family] ?? 0) + 1;
  const sizeOf = new Map(input.tasks.map((task) => [task.id, task.size]));
  return {
    kind: MANIFEST_KIND,
    schema: MANIFEST_SCHEMA,
    arms: input.arms,
    mode: input.mode,
    runs: input.runs,
    seed: input.seed,
    tasks: input.tasks,
    families: Object.fromEntries(Object.entries(families).sort(([a], [b]) => a.localeCompare(b))),
    specs: input.specs,
    wallLimitsMs: WALL_LIMIT_MS,
    limits: input.limits,
    accounts: input.accounts,
    bounded: input.bounded,
    order: input.order,
    needs: {
      pairs: input.order.length,
      armRuns: 2 * input.order.length,
      worstCaseWallMs: input.order.reduce(
        (sum, pair) => sum + 2 * WALL_LIMIT_MS[sizeOf.get(pair.task) ?? "small"],
        0,
      ),
    },
  };
}

/** What is wrong with a parsed manifest file. Empty: it can be read. */
export function manifestProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return ["not a JSON object"];
  const m = value as Partial<ParityManifest>;
  const problems: string[] = [];
  if (m.kind !== MANIFEST_KIND || m.schema !== MANIFEST_SCHEMA)
    problems.push(
      `not a ${MANIFEST_SCHEMA} manifest (kind ${JSON.stringify(m.kind)}, schema ${JSON.stringify(m.schema)})`,
    );
  if (!Array.isArray(m.arms) || m.arms.length !== 2) problems.push("arms must name two arms");
  if (m.mode !== "product" && m.mode !== "harness")
    problems.push("mode must be product or harness");
  if (!Number.isInteger(m.runs) || (m.runs as number) < 1)
    problems.push("runs must be a positive whole number");
  if (!Array.isArray(m.tasks) || m.tasks.length === 0)
    problems.push("tasks must name at least one task");
  if (!Array.isArray(m.order)) problems.push("order must list the pairs");
  if (typeof m.specs !== "object" || m.specs === null)
    problems.push("specs must give each arm its settings");
  if (Array.isArray(m.tasks) && Array.isArray(m.order) && Number.isInteger(m.runs)) {
    const ids = new Set(m.tasks.map((task) => task.id));
    if (m.order.length !== m.tasks.length * (m.runs as number))
      problems.push(
        `order lists ${m.order.length} pair(s); ${m.tasks.length} task(s) × ${m.runs} run(s) is ${m.tasks.length * (m.runs as number)}`,
      );
    for (const pair of m.order)
      if (!ids.has(pair.task))
        problems.push(`order names ${pair.task}, which is not one of the tasks`);
  }
  return problems;
}

/**
 * How the tasks as they load NOW differ from the tasks the manifest pinned.
 * Empty: they are the same tasks. Pure.
 *
 * A task that is gone, moved family or size, is sent another prompt or is
 * graded by other checks is source drift: the plan that was approved is not
 * the plan that would run.
 */
export function manifestDrift(
  manifest: Pick<ParityManifest, "tasks">,
  available: readonly Pick<ParityTask, "id" | "family" | "size" | "grader" | "prompt">[],
): string[] {
  const drift: string[] = [];
  for (const pinned of manifest.tasks) {
    const now = available.find((task) => task.id === pinned.id);
    if (!now) {
      drift.push(`${pinned.id}: no longer available from its source`);
      continue;
    }
    if (now.family !== pinned.family)
      drift.push(`${pinned.id}: filed under ${now.family}, and the manifest says ${pinned.family}`);
    if (now.size !== pinned.size)
      drift.push(`${pinned.id}: now ${now.size}, and the manifest says ${pinned.size}`);
    if (promptDigest(now.prompt) !== pinned.prompt)
      drift.push(`${pinned.id}: its prompt changed since the manifest was written`);
    if (now.grader !== pinned.grader)
      drift.push(`${pinned.id}: its checks changed since the manifest was written`);
  }
  return drift;
}
