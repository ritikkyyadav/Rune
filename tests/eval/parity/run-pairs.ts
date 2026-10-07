#!/usr/bin/env bun
// ─── Paired parity runs ───
//
// Two arms, the same tasks, the same wall clock, and one row per arm per
// (task, run) in `results.jsonl` — the `ParityRunResult` rows the parity index
// (score.ts / aggregate.ts / report.ts) pairs on (task, run, mode).
//
// What makes a pair a fair pair, in the order this file enforces it:
//
//   1. Identical starting bytes. Each arm gets a FRESH workspace from the
//      task's own `prepare`, in its own evidence directory; no arm ever sees
//      the other's tree.
//   2. Alternating order. For each (task, run) the arm that goes first
//      alternates, across tasks and across repetitions, so a provider that
//      degrades over an evening does not always land on the same side. A
//      re-queued pair starts with the arm that went second last time.
//   3. The same clock, and nothing else. Both arms get the task's
//      `WALL_LIMIT_MS`; neither gets a turn or dollar cap (the parity profile).
//   4. One classifier. Whether a row counts is `classifyOutcome`'s decision,
//      from facts every arm reports the same way — with the workspace's own
//      evidence of work, and the measured build's, added here.
//   5. The same grader, from outside. `grade` reads only the tree the arm left
//      and never trusts what the arm said about it; scope is measured from a
//      `git status` snapshot taken before and after, before the grader writes
//      anything into the tree.
//   6. Whole pairs, and the row that counts. Both rows of a pair are written
//      together, after both arms ran. An arm whose run produced no row at all
//      — the rig could not prepare the tree or start the tool — is RE-RUN
//      once, at once; if it still produces none, it gets an unscored row, so
//      the pair stays whole. An arm whose row came back UNSCORED (an outage,
//      a quota wall) is retried once, at the end of the queue, ALONE: the arm
//      that succeeded is never run again to keep it company. The retry is
//      written under the same run number as `attempt: 2`, the report pairs
//      the latest attempt, and the first one stays in the file as evidence.
//      Before the retry the task is prepared and held to the fingerprint its
//      partner ran from; if the fixture is no longer that one, the series
//      stops — source drift — rather than pair two different tasks. The one
//      time half a pair is written is when the budget stops the series
//      BETWEEN two arms: the row that exists is kept, and reported partnerless.
//   7. One build per series. The Rune build is fingerprinted when the series
//      starts and after every Rune run; a row whose build moved — rebuilt by
//      another session between two runs, not only during one — is
//      `source_changed`. And every row records the `--version` its tool gave
//      just before that run, so a comparator that auto-updates mid-series
//      (Claude Code went 2.1.283 → 2.1.284 overnight while this was written)
//      is on the record as two versions, not one.
//
// And the door: nothing live starts unless `RUNE_EVAL_BUDGET_USD` or
// `RUNE_EVAL_QUOTA_PCT` is set, AND the series was given its limits — how many
// pairs, how many arm runs, how much wall time — AND every account it cannot
// watch was accepted as such (`bounded`). All of it is checked before the
// first pair and again before every arm run (series-budget.ts). The plan, the
// limits and each task's grader are written to `manifest.json` before anything
// runs. `--dry-run` plans every pair and spawns nothing at all — not even
// `--version` — prepares no workspace, and writes nothing unless it is asked
// for the manifest.
//
//   bun run tests/eval/parity/run-pairs.ts --dry-run --arms rune,claude-code \
//     --mode product --runs 1 --rune-model M --claude-code-model M --out DIR

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { claudeCodeArm } from "../comparison/arms/claude-code";
import { codexArm } from "../comparison/arms/codex";
import { OPENCODE_PROVIDER, opencodeArm } from "../comparison/arms/opencode";
import {
  RUNE_DEFAULT_PROVIDER,
  RUNE_SOURCE_COMMAND,
  buildFingerprint,
  runeArm,
} from "../comparison/arms/rune";
import {
  type ArmLimits,
  type ArmResult,
  type ArmTask,
  type Classification,
  type ComparatorArm,
  binarySha256Of,
  classifyOutcome,
  terminalOf,
  tooManyUnscored,
  workspaceOf,
} from "../comparison/arms/types";
import { authorisedBudgetUsd } from "../comparison/runner";
import { mulberry32 } from "./bootstrap";
import { corpusParityTasks } from "./corpus-source";
import {
  MANIFEST_SCHEMA,
  TASK_SOURCES,
  availableTasks,
  buildManifest,
  manifestDrift,
  manifestProblems,
  manifestTask,
  selectTasks,
  type ParityManifest,
  type TaskSource,
} from "./manifest";
import {
  NEW_BUDGET_STATE,
  budgetLines,
  budgetProblems,
  gateBeforeArm,
  gateBeforePair,
  type AccountBudget,
  type BudgetState,
  type SeriesBudget,
  type SeriesLimits,
} from "./series-budget";
import {
  SCHEMA,
  WALL_LIMIT_MS,
  quality,
  type Outcome,
  type ParityArm,
  type ParityMode,
  type ParityRunResult,
  type ParityTask,
  type ScopeScore,
  type Terminal,
  type UnscoredReason,
} from "./types";

export const ARMS: Readonly<Record<ParityArm, ComparatorArm>> = {
  rune: runeArm,
  "claude-code": claudeCodeArm,
  opencode: opencodeArm,
  codex: codexArm,
};

/** The route an arm takes when the series names none, recorded on its rows. */
const DEFAULT_PROVIDER: Partial<Record<ParityArm, string>> = {
  rune: RUNE_DEFAULT_PROVIDER,
  opencode: OPENCODE_PROVIDER,
};

// ─── The authorisation ───

export interface Authorisation {
  /** The series' dollar ceiling (list-price estimate), or null. */
  budgetUsd: number | null;
  /** Stop once a Rune row reports this share of its window used, or null. */
  quotaPct: number | null;
}

/**
 * `RUNE_EVAL_QUOTA_PCT`: a plain number from 1 to 100, and nothing cleverer.
 *
 * The same stance as the dollar figure: `Number()` reads `0x10` as 16 and
 * `1e2` as 100, which are thresholds nobody typed. Zero is refused because a
 * quota gate at 0% is a series that never runs; above 100 is refused because
 * it is a series that never stops.
 */
export function authorisedQuotaPct(raw: string): number {
  const text = raw.trim();
  const value = /^\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(value) || value < 1 || value > 100)
    throw new Error(
      `RUNE_EVAL_QUOTA_PCT must be a plain number from 1 to 100 (the share of the subscription window at which the series stops), not ${raw}.`,
    );
  return value;
}

/**
 * Either authorisation, or no live run.
 *
 * Refuse-by-default: an unset variable is a no, not a default. A variable
 * that IS set but malformed is refused rather than ignored, even when the
 * other one is fine — a typo in a limit is not a limit.
 */
export function pairsAuthorisation(env: NodeJS.ProcessEnv = process.env): Authorisation {
  const budgetSet = Boolean(env.RUNE_EVAL_BUDGET_USD?.trim());
  const quotaSet = Boolean(env.RUNE_EVAL_QUOTA_PCT?.trim());
  if (!budgetSet && !quotaSet)
    throw new Error(
      "Live parity runs spend real money or subscription quota and are not authorised here. Set " +
        "RUNE_EVAL_BUDGET_USD to the dollars you have decided to spend on the series, or " +
        "RUNE_EVAL_QUOTA_PCT to the share of Rune's subscription window (1-100) at which it must " +
        "stop. --dry-run needs neither, and the offline corpus (tests/eval/corpus/run-offline.ts) " +
        "makes no model calls at all.",
    );
  return {
    budgetUsd: budgetSet ? authorisedBudgetUsd(env) : null,
    quotaPct: quotaSet ? authorisedQuotaPct(env.RUNE_EVAL_QUOTA_PCT!) : null,
  };
}

/**
 * What one run is charged against RUNE_EVAL_BUDGET_USD, or null when nobody
 * can say. Pure.
 *
 * The larger of the two figures an arm has (Rune's pricing table applied to
 * its tokens, and the tool's own reconstruction), because this is the
 * founder's money and the smaller one might be the wrong one. A run whose
 * tool never started, or whose own ledger shows no model call, cost nothing.
 * Anything else with no figure is unknown — never a zero.
 */
export function chargeOf(
  result: Pick<ArmResult, "listUsd" | "reportedCostUsd" | "calls"> | null,
): number | null {
  if (!result) return 0;
  const known = [result.listUsd, result.reportedCostUsd].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (known.length) return Math.max(...known);
  return result.calls === 0 ? 0 : null;
}

// ─── The plan ───

/** One arm's settings for a series. */
export interface ArmSpec {
  model: string;
  provider?: string;
  reasoningEffort?: string;
  /** A pinned build or a fixture; the arm's default executable otherwise. */
  command?: string[];
}

export interface PairJob {
  task: ParityTask;
  run: number;
  /** Which arm goes first, then second. */
  order: [ParityArm, ParityArm];
}

/** The one retry an unscored row gets: the arm(s) it names, and no other. */
export interface RetryJob {
  task: ParityTask;
  run: number;
  /** The arms whose first row was unscored, in the order they are retried. */
  retry: ParityArm[];
}

/** Tasks in a seeded order: Fisher–Yates over mulberry32, so a seed names one order. Pure. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Every planned pair, in order, with the arm order alternating.
 *
 * The first arm flips with (run + position), the rule `runPilot` has always
 * used — so it alternates across tasks within a repetition AND across
 * repetitions of one task. With a seed, each repetition runs the tasks in an
 * order of its own, drawn from that seed: a provider that tires over an
 * evening does not always meet the same task, or the same family, last.
 * Without one, the order given is the order run. Pure: tested without spawning.
 */
export function planPairs(
  tasks: readonly ParityTask[],
  arms: readonly [ParityArm, ParityArm],
  runs: number,
  seed: number | null = null,
): PairJob[] {
  const jobs: PairJob[] = [];
  for (let run = 1; run <= runs; run++) {
    const order = seed === null ? tasks : shuffled(tasks, seed + run);
    for (const [index, task] of order.entries())
      jobs.push({
        task,
        run,
        order: (run - 1 + index) % 2 === 0 ? [arms[0], arms[1]] : [arms[1], arms[0]],
      });
  }
  return jobs;
}

/**
 * The retry of a pair's unscored row(s). One arm unscored: that arm alone —
 * the one that succeeded is not run again. Both: both, the other arm first.
 */
export function retryOf(job: PairJob, unscored: readonly ParityArm[]): RetryJob {
  return {
    task: job.task,
    run: job.run,
    retry: [job.order[1], job.order[0]].filter((arm) => unscored.includes(arm)),
  };
}

// ─── Scope ───
//
// Measured from the tree, never from what the arm said it touched. A snapshot
// is every path `git status --porcelain --ignored --untracked-files=all` lists
// — tracked changes, untracked files, ignored files — each with a fingerprint
// of its bytes, plus HEAD. Taken before the run and again after it (and before
// the grader copies anything in), the difference is what the run created,
// modified or deleted, including files it committed.

export interface WorkspaceSnapshot {
  head: string | null;
  /**
   * HEAD's tree: the committed files by content, with no author, date or
   * message in it. Two fresh checkouts of one fixture have two commits and one
   * tree, which is what makes it the fixture's fingerprint.
   */
  tree?: string | null;
  /** path → "<XY> <fingerprint>" for every path git status lists. */
  entries: Record<string, string>;
  /** Paths changed by commits made since the `since` snapshot, if any. */
  committed: string[];
  /** Of those, the paths the commits CREATED: new files, not edits to old ones. */
  added?: string[];
  /**
   * What is on disk now at each path the `since` snapshot listed and this one
   * does not. A path leaves the listing by being committed, reverted or
   * deleted, and only its bytes say which.
   */
  settled?: Record<string, string>;
}

/**
 * Paths no scope rule looks at: dependencies. Nothing else — not even the
 * grader's `.rune-acceptance/`, because the after-snapshot is taken before the
 * grader writes, so anything under that name was put there by the arm.
 */
export const SCOPE_EXCLUDE: readonly RegExp[] = [/(^|\/)node_modules\//];

/**
 * A tool's own state directory in the workspace — "the harness's own profile
 * dirs" of the brief. Written at startup, before any model call, so it is not
 * evidence that the tool WORKED (a tool that died at launch would otherwise
 * look like one that had done something), and it is not a code change, so it
 * does not zero a no-code task. It is still a leftover: scope 0.5, like any.
 */
export const TOOL_STATE = /^(?:\.rune|\.claude|\.opencode|\.codex)\//;

/** New untracked paths that are leftovers, not deliverables. */
export const ARTIFACT =
  /(^|\/)(?:\.rune|\.claude|\.opencode|\.codex|target|dist|build|coverage|\.cache|\.turbo|__pycache__)\/|\.log$|(^|\/)\.DS_Store$|\.(?:tmp|swp|bak|orig|rej)$/;

/**
 * Parse `git status --porcelain -z`. A rename (`R`) lists its destination, and
 * its SOURCE as a deletion — the old path is gone from the tree, which is a
 * change like any other. A copy's source is untouched and is skipped.
 */
export function parsePorcelainZ(text: string): Array<{ code: string; path: string }> {
  const out: Array<{ code: string; path: string }> = [];
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    out.push({ code, path: field.slice(3) });
    if (code[0] === "R" || code[0] === "C") {
      const source = fields[++i];
      if (code[0] === "R" && source) out.push({ code: " D", path: source });
    }
  }
  return out;
}

function fingerprint(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (stat.isDirectory()) return "dir";
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  // `--no-optional-locks`: a snapshot must not write, not even the index's
  // stat cache, into the tree it is measuring. `GIT_CEILING_DIRECTORIES`: git
  // looks for the repository in the workspace and never above it — an arm that
  // deleted `.git` must not have its tree measured as part of whatever
  // repository the evidence directory happens to sit in (the Rune checkout,
  // for an --out under tests/eval/results).
  const run = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: root,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(root)) },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: run.status === 0, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** The tree as git sees it, with every listed path fingerprinted. */
export function snapshotWorkspace(
  root: string,
  since?: WorkspaceSnapshot,
  exclude: readonly RegExp[] = SCOPE_EXCLUDE,
): WorkspaceSnapshot {
  const status = git(root, ["status", "--porcelain", "--ignored", "--untracked-files=all", "-z"]);
  if (!status.ok) throw new Error(`git status failed in ${root}: ${status.stderr.trim()}`);
  const headRun = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const head = headRun.ok ? headRun.stdout.trim() : null;
  const treeRun = head ? git(root, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]) : null;
  const tree = treeRun?.ok ? treeRun.stdout.trim() : null;
  const entries: Record<string, string> = {};
  for (const { code, path } of parsePorcelainZ(status.stdout)) {
    if (exclude.some((pattern) => pattern.test(path))) continue;
    entries[path] = `${code} ${fingerprint(join(root, path))}`;
  }
  const committed: string[] = [];
  const added: string[] = [];
  if (since?.head && head && since.head !== head) {
    // `--no-renames`: a committed rename is its destination created and its
    // source deleted, the same two changes `parsePorcelainZ` reads an
    // uncommitted one as.
    const diff = git(root, ["diff", "--name-status", "--no-renames", "-z", since.head, head]);
    const fields = diff.stdout.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      committed.push(fields[i + 1]!);
      if (fields[i] === "A") added.push(fields[i + 1]!);
    }
  }
  if (!since) return { head, tree, entries, committed };
  const settled: Record<string, string> = {};
  for (const path of Object.keys(since.entries))
    if (!(path in entries)) settled[path] = fingerprint(join(root, path));
  return { head, tree, entries, committed, added, settled };
}

// ─── Fingerprints ───

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * The task as an arm was given it, as one digest: the id, the prompt's bytes,
 * the seeded tree, the uncommitted work lying in it, and the wall limit. Pure.
 *
 * From the snapshot taken after `prepare` and before the tool starts, so it is
 * what THIS run started from, not what the source says a run should. Paths git
 * ignores are left out: an install writes caches there whose bytes differ from
 * one preparation to the next, and they are not the task.
 */
export function taskFingerprint(
  task: Pick<ParityTask, "id" | "prompt">,
  prepared: WorkspaceSnapshot,
  limitMs: number,
): string {
  const uncommitted = Object.entries(prepared.entries)
    .filter(([, entry]) => !entry.startsWith("!!"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256({
    id: task.id,
    prompt: task.prompt,
    tree: prepared.tree ?? null,
    uncommitted,
    limitMs,
  });
}

/** The arm's settings for a series, as one digest. Pure. */
export function configFingerprint(
  arm: ParityArm,
  mode: ParityMode,
  spec: Pick<ArmSpec, "model" | "reasoningEffort">,
  provider: string | undefined,
): string {
  return sha256({
    arm,
    mode,
    model: spec.model,
    provider: provider ?? null,
    reasoningEffort: spec.reasoningEffort ?? null,
  });
}

/** Every path the run created, modified, deleted or committed. Pure. */
export function changedPaths(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  exclude: readonly RegExp[] = SCOPE_EXCLUDE,
): string[] {
  const keys = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  const changed = [...keys].filter((path) => before.entries[path] !== after.entries[path]);
  return [...new Set([...changed, ...after.committed])]
    .filter((path) => !exclude.some((pattern) => pattern.test(path)))
    .sort();
}

export interface ScopeResult {
  scope: ScopeScore;
  /** The offending paths, when the score is below 1. */
  notes?: string[];
  /** Everything the run changed (exclusions applied). */
  changed: string[];
}

const NOTE_LIMIT = 40;
const noted = (paths: string[]): string[] =>
  paths.length > NOTE_LIMIT
    ? [...paths.slice(0, NOTE_LIMIT), `… and ${paths.length - NOTE_LIMIT} more`]
    : paths;

/** `path` is one of `patterns`: an exact path, or under a directory named with a trailing slash. */
export function matchesPath(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern,
  );
}

const codeOf = (entry: string | undefined): string => entry?.slice(0, 2) ?? "";
const printOf = (entry: string): string => entry.slice(3);

/**
 * The bytes at `path` are not the ones that were there before the run.
 *
 * Asked of the bytes, not of git's state for the path: a file that was only
 * staged, or committed as it stood, has the person's bytes in it still.
 */
function bytesChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot, path: string): boolean {
  const was = before.entries[path];
  const now = after.entries[path];
  // Clean before the run: anything git lists or a commit touched is a change.
  if (was === undefined) return now !== undefined || after.committed.includes(path);
  return (now === undefined ? after.settled?.[path] : printOf(now)) !== printOf(was);
}

/** `path` was in the tree before the run, as opposed to being created by it. */
function existedBefore(before: WorkspaceSnapshot, after: WorkspaceSnapshot, path: string): boolean {
  if (path in before.entries) return true;
  if (after.added?.includes(path)) return false;
  if (after.committed.includes(path)) return true;
  // Untracked, ignored, or added / renamed-to / copied-to in the index: new.
  const code = codeOf(after.entries[path]);
  return !(code === "??" || code === "!!" || "ARC".includes(code[0] ?? " "));
}

/**
 * The person's uncommitted work at `path` is gone: reverted to the commit, or
 * removed, and in no commit the run made. Caller has checked the bytes moved.
 */
function workLost(before: WorkspaceSnapshot, after: WorkspaceSnapshot, path: string): boolean {
  const was = before.entries[path];
  if (was === undefined || after.committed.includes(path)) return false;
  const now = after.entries[path];
  if (now === undefined) return true;
  return printOf(now) === "missing" && printOf(was) !== "missing";
}

/**
 * What a coding task's run did that no coding task allows, each path with the
 * rule it broke. Three rules, in this order:
 *
 *   protected   the task's own words put the path out of bounds, and its bytes
 *               are different now.
 *   lost        uncommitted work that was in the tree — a modified tracked
 *               file, an untracked one — was reverted or removed without being
 *               committed.
 *   outside     the task declared the paths its work may change
 *               (`allowedPaths`), and an EXISTING file outside them was
 *               modified or deleted. A file the run created is never outside:
 *               a new test, a new module, is the work.
 *
 * The last two never apply to a path git ignores or to an untracked leftover
 * that was already lying there (`ARTIFACT`): neither is somebody's work, and a
 * rebuilt cache or a log that grew is not an edit. A declared path is never
 * `lost` either — the task said it may be changed, deleting included.
 */
function outOfBounds(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  task: Pick<ParityTask, "protectedPaths" | "allowedPaths">,
  candidates: readonly string[],
): string[] {
  const out: string[] = [];
  for (const path of candidates) {
    if (TOOL_STATE.test(path) || !bytesChanged(before, after, path)) continue;
    if (matchesPath(task.protectedPaths ?? [], path)) {
      out.push(`${path} (protected)`);
      continue;
    }
    // Not somebody's work: what git ignores, and a leftover that was lying there.
    const was = codeOf(before.entries[path]);
    if (was === "!!" || codeOf(after.entries[path]) === "!!") continue;
    if (was === "??" && ARTIFACT.test(path)) continue;
    const allowed = task.allowedPaths ? matchesPath(task.allowedPaths, path) : undefined;
    if (allowed === true) continue;
    if (workLost(before, after, path)) out.push(`${path} (uncommitted work lost)`);
    else if (allowed === false && existedBefore(before, after, path))
      out.push(`${path} (outside the task's paths)`);
  }
  return out;
}

/**
 * The scope score, from two snapshots. Pure.
 *
 *   0    a no-code task (explain, plan) in which any path other than the files
 *        it asked for was created, modified or deleted — tracked or untracked,
 *        ignored or not. Only dependencies (`node_modules/`) and the tool's own
 *        state directory (`TOOL_STATE`) are left to the next rule.
 *   0    a coding task whose run changed a path the task protected, lost
 *        uncommitted work that was in the tree, or — where the task declared
 *        its paths — changed an existing file outside them (`outOfBounds`).
 *   0.5  the run left NEW ignored or untracked ARTIFACTS beyond what the task
 *        needs: anything git ignores that was not there before (`.rune/` in
 *        these fixtures), or a new untracked build/log/tool-state leftover
 *        (`target/`, `*.log`, `.claude/`).
 *   1    otherwise. New source and test files on a coding task are the work.
 */
export function scoreScope(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  task: ScopeContract,
  exclude: readonly RegExp[] = SCOPE_EXCLUDE,
): ScopeResult {
  return scopeUnder(2, before, after, task, exclude);
}

/**
 * The score as `parity-run/1` computed it: the no-code rule and the leftovers
 * rule, and nothing about what a coding task changed. Kept so the index those
 * rules produce can still be computed beside the current one (`legacy.scope`).
 */
export function scoreScopeV1(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  task: ScopeContract,
  exclude: readonly RegExp[] = SCOPE_EXCLUDE,
): ScopeScore {
  return scopeUnder(1, before, after, task, exclude).scope;
}

type ScopeContract = Pick<
  ParityTask,
  "noCode" | "expectedNewFiles" | "protectedPaths" | "allowedPaths"
>;

function scopeUnder(
  rules: 1 | 2,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  task: ScopeContract,
  exclude: readonly RegExp[],
): ScopeResult {
  const changed = changedPaths(before, after, exclude);
  const expected = new Set(task.expectedNewFiles ?? []);
  const unexpected = changed.filter((path) => !expected.has(path));
  if (task.noCode) {
    const edits = unexpected.filter((path) => !TOOL_STATE.test(path));
    if (edits.length) return { scope: 0, notes: noted(edits), changed };
  } else if (rules === 2) {
    const outside = outOfBounds(before, after, task, unexpected);
    if (outside.length) return { scope: 0, notes: noted(outside), changed };
  }
  const artifacts = unexpected.filter((path) => {
    if (path in before.entries) return false;
    const code = after.entries[path]?.slice(0, 2);
    return code === "!!" || (code === "??" && ARTIFACT.test(path));
  });
  if (artifacts.length) return { scope: 0.5, notes: noted(artifacts), changed };
  return { scope: 1, changed };
}

/**
 * The score for a run that left a tree git can no longer read — `.git`
 * deleted or corrupted. The snapshot worked before the run, so the run did it:
 * that is out of scope for any task, and it is evidence the tool did something.
 */
export function unreadableTreeScope(reason: string): ScopeResult {
  return {
    scope: 0,
    notes: [`the run left a tree git cannot read: ${reason.slice(0, 300)}`],
    changed: [".git"],
  };
}

/** The rig's evidence that the tool did work: a change outside its own state. */
export const workspaceTouched = (changed: readonly string[]): boolean =>
  changed.some((path) => !TOOL_STATE.test(path));

// ─── One row ───

export const NO_OUTCOME: Outcome = {
  hiddenPassed: 0,
  hiddenTotal: 0,
  regressionsIntroduced: 0,
  buildBroken: false,
  impossible: [],
};

/** The tool claimed success while the grader found the work incomplete. */
export function isFalseCompletion(claimedSuccess: boolean, outcome: Outcome): boolean {
  const q = quality(outcome);
  return claimedSuccess && q !== null && q < 1;
}

/**
 * Ended by itself — finished, or honestly not — inside the limit, and did not
 * claim what it had not done. A run that crashed, was stopped or was refused
 * is not clean however quickly it ended.
 */
export function isClean(
  terminal: Terminal,
  result: Pick<ArmResult, "durationMs">,
  limitMs: number,
  falseCompletion: boolean,
): boolean {
  return (
    (terminal === "completed" || terminal === "incomplete") &&
    result.durationMs <= limitMs &&
    !falseCompletion
  );
}

/**
 * The `parity-run/1` rule: only that the rig had not stopped it. It never
 * asked how the process ended, so one that died at once, having claimed
 * nothing, passed. Kept for `legacy.clean`.
 */
export function isCleanV1(
  result: Pick<ArmResult, "stopped" | "durationMs">,
  limitMs: number,
  falseCompletion: boolean,
): boolean {
  return !result.stopped && result.durationMs <= limitMs && !falseCompletion;
}

export interface RowInput {
  task: ParityTask;
  run: number;
  arm: ParityArm;
  mode: ParityMode;
  spec: ArmSpec;
  /** What the tool's `--version` said just before this run. */
  version: string;
  binarySha256?: string;
  /** The source the tool was run from, where the series fingerprinted one. */
  sourceBuild?: string;
  /** Every model the arm's configuration names, where the arm states them. */
  roster?: readonly string[];
  /** Null when the tool never started (prepare failed, or the spawn threw). */
  result: ArmResult | null;
  classification: Classification;
  outcome: Outcome;
  scope: ScopeResult;
  /** The same two snapshots under the `parity-run/1` rule (`scoreScopeV1`). */
  legacyScope: ScopeScore;
  /** `taskFingerprint` of the prepared tree; null when it could not be prepared. */
  taskFingerprint: string | null;
  /** 2 on the retry of an unscored row; absent on a first attempt. */
  attempt?: number;
  limitMs: number;
  startedAt: Date;
  completedAt: Date;
  evidence: string;
}

/** A `ParityRunResult`, assembled in one place so every path builds the same shape. */
export function parityRow(input: RowInput): ParityRunResult {
  const { result, classification } = input;
  const falseCompletion = result ? isFalseCompletion(result.claimedSuccess, input.outcome) : false;
  const terminal: Terminal = result ? terminalOf(result.signals) : "not_started";
  const provider = input.spec.provider ?? DEFAULT_PROVIDER[input.arm];
  const row: ParityRunResult = {
    schema: SCHEMA,
    task: input.task.id,
    family: input.task.family,
    run: input.run,
    ...(input.attempt ? { attempt: input.attempt } : {}),
    arm: input.arm,
    mode: input.mode,
    model: input.spec.model,
    ...(provider ? { provider } : {}),
    ...(input.spec.reasoningEffort ? { reasoningEffort: input.spec.reasoningEffort } : {}),
    models: [...new Set(result?.models ?? [])].sort(),
    fingerprints: {
      task: input.taskFingerprint,
      grader: input.task.grader,
      config: configFingerprint(input.arm, input.mode, input.spec, provider),
    },
    version: input.version,
    ...(input.binarySha256 ? { binarySha256: input.binarySha256 } : {}),
    ...(input.sourceBuild ? { sourceBuild: input.sourceBuild } : {}),
    ...(input.roster?.length ? { roster: [...new Set(input.roster)].sort() } : {}),
    scored: classification.scored,
    ...(classification.scored ? {} : { unscoredReason: classification.unscoredReason! }),
    outcome: input.outcome,
    terminal,
    clean: result ? isClean(terminal, result, input.limitMs, falseCompletion) : false,
    falseCompletion,
    scope: input.scope.scope,
    ...(input.scope.notes ? { scopeNotes: input.scope.notes } : {}),
    legacy: {
      clean: result ? isCleanV1(result, input.limitMs, falseCompletion) : false,
      scope: input.legacyScope,
    },
    wallMs: result
      ? result.durationMs
      : Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
    calls: result?.calls ?? null,
    listUsd: result?.listUsd ?? null,
    ...(result && result.quotaPct !== undefined ? { quotaPct: result.quotaPct } : {}),
    exitCode: result?.exitCode ?? null,
    ...(result?.stopped ? { stopped: result.stopped } : {}),
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    evidence: input.evidence,
  };
  return row;
}

const unscoredAs = (reason: UnscoredReason): Classification => ({
  scored: false,
  unscoredReason: reason,
});

/**
 * "Excluded for every arm": a check the grader could run for one arm and not
 * the other (a Chromium that started once and not twice) makes the two rows
 * answer different questions. The side the grader failed is unscored, which
 * unscores — and re-queues — the pair. Pure.
 */
export function reconcileImpossible(
  a: ParityRunResult,
  b: ParityRunResult,
): [ParityRunResult, ParityRunResult] {
  const onlyIn = (x: ParityRunResult, y: ParityRunResult) =>
    x.outcome.impossible.filter((id) => !y.outcome.impossible.includes(id));
  const fix = (row: ParityRunResult, extra: string[]): ParityRunResult =>
    extra.length && row.scored
      ? { ...row, scored: false, unscoredReason: "grader_infrastructure" }
      : row;
  return [fix(a, onlyIn(a, b)), fix(b, onlyIn(b, a))];
}

// ─── The series ───

export interface PairSeriesOptions {
  tasks: ParityTask[];
  arms: [ParityArm, ParityArm];
  runs: number;
  mode: ParityMode;
  out: string;
  specs: Partial<Record<ParityArm, ArmSpec>>;
  dryRun?: boolean;
  /** Where the authorisation and the arms' inputs are read from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** The arm implementations — the real ones unless a test injects fakes. */
  implementations?: Partial<Record<ParityArm, ComparatorArm>>;
  /**
   * What the measured build IS, for the arms whose build is pinned for the
   * series (Rune: the binary's hash, or the source tree's digest). Null for
   * an arm whose build is not the thing under test. Tests inject it.
   */
  fingerprint?: (arm: ParityArm, limits: ArmLimits) => string | null;
  log?: (line: string) => void;
  /** Seeds the order tasks run in within each repetition. Default: the order given. */
  seed?: number | null;
  /** The hard stops (series-budget.ts). A live series is refused without them. */
  limits?: SeriesLimits;
  /** Each arm's account: its window as read before the series, and where to stop. */
  accounts?: Partial<Record<ParityArm, AccountBudget>>;
  /** The operator accepts that an account cannot be watched; the limits are then the bound. */
  bounded?: boolean;
  /** Where each task came from, by id, for the manifest. Default: "given". */
  sources?: Readonly<Record<string, TaskSource>>;
  /** The clock the wall allowance is measured on, in ms. Tests inject it. */
  now?: () => number;
  /** With `dryRun`: write the manifest to this path. A dry run writes nothing else. */
  writeManifest?: string;
}

export interface PairSeriesReport {
  kind: "parity-pairs" | "parity-pairs-dry-run";
  lines: string[];
  rows: ParityRunResult[];
  planned: number;
  /** Pairs both of whose arms ran. */
  pairsRun: number;
  unscoredPairs: number;
  /** Pairs whose unscored arm(s) were queued for their one retry. */
  requeued: number;
  /** Arms re-run because a run produced no row, as `task#run:arm`. */
  rerunArms: string[];
  /** Arm runs the series made, every one. */
  attempts: number;
  /** Arms retried alone after an unscored row, as `task#run:arm`. */
  retried: string[];
  /** Rows written without a partner because the series stopped between two arms. */
  halfPairs: string[];
  manifest: ParityManifest;
  stoppedEarly?: string;
}

export const RESULTS = "results.jsonl";
export const SERIES = "series.json";
export const MANIFEST = "manifest.json";

const armTaskOf = (task: ParityTask): ArmTask => ({
  id: task.id,
  prompt: task.prompt,
  ...((task as { browser?: boolean }).browser ? { browser: true } : {}),
});

function limitsFor(options: PairSeriesOptions, arm: ParityArm, task: ParityTask): ArmLimits {
  const spec = options.specs[arm]!;
  return {
    timeoutMs: WALL_LIMIT_MS[task.size],
    model: spec.model,
    ...(spec.provider ? { provider: spec.provider } : {}),
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    mode: options.mode,
    ...(spec.command ? { command: spec.command } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
}

/** The Rune build is the one pinned for a series; a comparator's is its version. */
const defaultFingerprint = (arm: ParityArm, limits: ArmLimits): string | null =>
  arm === "rune" ? buildFingerprint(limits.command ?? [...RUNE_SOURCE_COMMAND]) : null;

/**
 * Where one arm run's evidence goes. A retry after an unscored row, and a
 * re-run after a missing one, each get a directory of their own: nothing is
 * ever written into a directory an earlier run made.
 */
const runDir = (
  out: string,
  taskId: string,
  run: number,
  arm: ParityArm,
  tryNo = 1,
  retry = false,
) =>
  join(
    out,
    taskId,
    `run-${run}`,
    `${arm}${retry ? "-retry" : ""}${tryNo === 1 ? "" : `-attempt-${tryNo}`}`,
  );

function validate(options: PairSeriesOptions): void {
  const [a, b] = options.arms;
  if (a === b) throw new Error(`A pair needs two different arms, not ${a} twice.`);
  if (!options.tasks.length) throw new Error("No tasks: a series needs at least one.");
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error(`--runs must be a positive whole number, not ${options.runs}.`);
  if (options.seed != null && !(Number.isInteger(options.seed) && options.seed >= 0))
    throw new Error(`--seed must be a whole number of at least 0, not ${options.seed}.`);
  for (const arm of options.arms) {
    if (!(options.implementations?.[arm] ?? ARMS[arm])) throw new Error(`Unknown arm: ${arm}`);
    if (!options.specs[arm]?.model)
      throw new Error(`${arm}: no model named. Every row records the model it ran; name one.`);
  }
  const ids = options.tasks.map((task) => task.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Task ${duplicate} appears twice in the series.`);
}

/** Print-ready lines for a plan: argv, cwd, the env NAMES (never values), refusals. */
function planLines(
  options: PairSeriesOptions,
  jobs: PairJob[],
  implementation: (arm: ParityArm) => ComparatorArm,
): { lines: string[]; refusals: string[] } {
  const [a, b] = options.arms;
  const families = new Map<string, number>();
  for (const task of options.tasks) families.set(task.family, (families.get(task.family) ?? 0) + 1);
  const lines: string[] = [
    `parity pairs: ${a} vs ${b} · mode ${options.mode} · ${options.tasks.length} task(s) × ${options.runs} run(s) = ${jobs.length} pair(s)`,
    `tasks by family: ${[...families]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([family, count]) => `${family} × ${count}`)
      .join(", ")}`,
    `order: ${options.seed == null ? "the tasks as given" : `tasks shuffled within each repetition, seed ${options.seed}`}; the first arm alternates`,
    `wall limits: small ${WALL_LIMIT_MS.small / 60_000} min, serious ${WALL_LIMIT_MS.serious / 60_000} min — the same for both arms; no turn or dollar cap on either`,
    `an unscored row is retried once, at the end, for that arm alone — the arm that succeeded is not run again; the series stops when more than a quarter of the ${jobs.length} planned pair(s) come back unscored`,
  ];
  const refusals = new Set<string>();
  for (const arm of options.arms) {
    const spec = options.specs[arm]!;
    lines.push(
      `${arm}: model ${spec.model}${spec.provider ? ` via ${spec.provider}` : ""}${spec.reasoningEffort ? ` effort ${spec.reasoningEffort}` : ""}${spec.command ? ` command ${JSON.stringify(spec.command)}` : ""}`,
    );
    const sample = implementation(arm).plan(
      armTaskOf(jobs[0]!.task),
      runDir(options.out, jobs[0]!.task.id, jobs[0]!.run, arm),
      limitsFor(options, arm, jobs[0]!.task),
    );
    for (const gap of sample.parityGaps) lines.push(`  parity — ${gap}`);
  }
  for (const [index, job] of jobs.entries()) {
    lines.push(
      `${String(index + 1).padStart(3, " ")}. ${job.task.id} (${job.task.family}${job.task.noCode ? ", no-code" : ""}) run ${job.run}: ${job.order[0]} first, then ${job.order[1]}`,
    );
    for (const arm of job.order) {
      const plan = implementation(arm).plan(
        armTaskOf(job.task),
        runDir(options.out, job.task.id, job.run, arm),
        limitsFor(options, arm, job.task),
      );
      lines.push(
        `      ${arm}`,
        `        cwd  ${plan.cwd}`,
        `        argv ${JSON.stringify(plan.command)}`,
        `        env  ${Object.keys(plan.env).sort().join(", ")}`,
      );
      if (plan.refusal) {
        lines.push(`        REFUSED live: ${plan.refusal}`);
        refusals.add(`${arm}: ${plan.refusal}`);
      }
    }
  }
  return { lines, refusals: [...refusals] };
}

/**
 * Each arm's account for this series. `RUNE_EVAL_QUOTA_PCT` is Rune's stop,
 * as it has always been, unless the series names one itself.
 */
function accountsOf(
  options: PairSeriesOptions,
  quotaPct: number | null,
): Partial<Record<ParityArm, AccountBudget>> {
  const out: Partial<Record<ParityArm, AccountBudget>> = {};
  for (const arm of options.arms) {
    const given = options.accounts?.[arm];
    out[arm] = {
      usedPct: given?.usedPct ?? null,
      stopAtPct: given?.stopAtPct ?? (arm === "rune" ? quotaPct : null),
    };
  }
  return out;
}

function manifestOf(
  options: PairSeriesOptions,
  jobs: readonly PairJob[],
  budget: Pick<SeriesBudget, "accounts" | "bounded"> & { limits: SeriesLimits | null },
): ParityManifest {
  return buildManifest({
    arms: options.arms,
    mode: options.mode,
    runs: options.runs,
    seed: options.seed ?? null,
    tasks: options.tasks.map((task) => manifestTask(task, options.sources?.[task.id] ?? "given")),
    specs: options.specs,
    limits: budget.limits,
    accounts: budget.accounts,
    bounded: budget.bounded,
    order: jobs.map((job) => ({
      task: job.task.id,
      run: job.run,
      first: job.order[0],
      second: job.order[1],
    })),
  });
}

const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** One arm's run of one job: a row, the reason the rig produced none, or a fixture that moved. */
type Attempt =
  | { row: ParityRunResult; chargeUsd: number | null }
  | { missing: string; reason: UnscoredReason; dir: string; startedAt: Date }
  | { drift: string };

/**
 * Plan (and, unless `dryRun`, run) a paired series.
 *
 * The refusals come first and in this order, so a series that is going to be
 * refused has started nothing: the authorisation, the limits and the accounts
 * nobody can watch, what the accounts read before the series, the output
 * directory, the plans' own refusals (no evaluation profile, no API key), the
 * versions and the build. Only then is the output directory created, and the
 * manifest written into it before the first pair.
 */
export async function runPairs(options: PairSeriesOptions): Promise<PairSeriesReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  validate(options);
  const implementation = (arm: ParityArm) => options.implementations?.[arm] ?? ARMS[arm];
  const fingerprintOf = options.fingerprint ?? defaultFingerprint;
  const jobs = planPairs(options.tasks, options.arms, options.runs, options.seed ?? null);
  const env = options.env ?? process.env;

  if (options.dryRun) {
    const { lines } = planLines(options, jobs, implementation);
    // A dry run needs no authorisation, so it reads the two variables only to
    // SHOW what a live run would be held to, and never refuses over them.
    const peek = <T>(read: () => T): T | null => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    const quotaPct = env.RUNE_EVAL_QUOTA_PCT?.trim()
      ? peek(() => authorisedQuotaPct(env.RUNE_EVAL_QUOTA_PCT!))
      : null;
    const accounts = accountsOf(options, quotaPct);
    const bounded = options.bounded ?? false;
    const manifest = manifestOf(options, jobs, {
      limits: options.limits ?? null,
      accounts,
      bounded,
    });
    if (options.limits)
      lines.push(
        ...budgetLines(
          {
            budgetUsd: env.RUNE_EVAL_BUDGET_USD?.trim()
              ? peek(() => authorisedBudgetUsd(env))
              : null,
            accounts,
            limits: options.limits,
            bounded,
          },
          options.arms,
          manifest.needs,
        ),
      );
    else
      lines.push(
        `limits: none given. A live run needs --max-pairs, --max-attempts and --wall-allowance-min; this plan needs ${manifest.needs.pairs} pair(s), ${manifest.needs.armRuns} arm run(s) before any retry, and up to ${minutes(manifest.needs.worstCaseWallMs)} if every run uses its whole wall limit.`,
      );
    if (options.writeManifest)
      writeFileSync(options.writeManifest, JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
      });
    lines.push(
      `${jobs.length} pair(s) planned. Nothing was executed, no workspace was prepared and nothing was written${options.writeManifest ? ` but the manifest (${options.writeManifest})` : ""}: a dry run spawns nothing, not even --version.`,
      "A live run needs RUNE_EVAL_BUDGET_USD (an estimate-gated dollar stop) or RUNE_EVAL_QUOTA_PCT (stop at that share of Rune's window), and its limits.",
    );
    for (const line of lines) log(line);
    return {
      kind: "parity-pairs-dry-run",
      lines,
      rows: [],
      planned: jobs.length,
      pairsRun: 0,
      unscoredPairs: 0,
      requeued: 0,
      rerunArms: [],
      attempts: 0,
      retried: [],
      halfPairs: [],
      manifest,
    };
  }

  const authorised = pairsAuthorisation(env);
  if (authorised.budgetUsd === null && !options.arms.includes("rune"))
    throw new Error(
      "RUNE_EVAL_QUOTA_PCT is read from the Rune row of each pair, and this series has no Rune arm. Authorise it with RUNE_EVAL_BUDGET_USD instead.",
    );
  const accounts = accountsOf(options, authorised.quotaPct);
  const planned = manifestOf(options, jobs, {
    limits: options.limits ?? null,
    accounts,
    bounded: options.bounded ?? false,
  });
  if (!options.limits)
    throw new Error(
      `A live series needs its limits before the first pair: --max-pairs, --max-attempts and --wall-allowance-min. This plan is ${planned.needs.pairs} pair(s), ${planned.needs.armRuns} arm run(s) before any retry, and up to ${minutes(planned.needs.worstCaseWallMs)} if every run uses its whole wall limit.`,
    );
  const budget: SeriesBudget = {
    budgetUsd: authorised.budgetUsd,
    accounts,
    limits: options.limits,
    bounded: options.bounded ?? false,
  };
  const problems = budgetProblems(budget, options.arms, jobs.length);
  if (problems.length) throw new Error(`Refused before anything ran:\n  ${problems.join("\n  ")}`);
  // What the accounts read BEFORE the series, held to the same gate every
  // later pair is: a window already past its stop refuses the first pair.
  const preflight = gateBeforePair(
    budget,
    NEW_BUDGET_STATE(),
    jobs[0]!.order,
    WALL_LIMIT_MS[jobs[0]!.task.size],
  );
  if (preflight)
    throw new Error(`Refused before anything ran: ${preflight.replace(/^Series stopped: /, "")}`);

  const out = resolve(options.out);
  // Evidence is never overwritten: not the results, and not a run's directory.
  for (const path of [
    join(out, RESULTS),
    join(out, SERIES),
    join(out, MANIFEST),
    ...options.tasks.map((task) => join(out, task.id)),
  ])
    if (existsSync(path))
      throw new Error(
        `${path} already exists. Use a fresh output directory: evidence is never overwritten, and a second series appended to the first would pair across two runs.`,
      );
  const { lines, refusals } = planLines(options, jobs, implementation);
  if (refusals.length) throw new Error(`Refused before anything ran:\n  ${refusals.join("\n  ")}`);
  const bounds = budgetLines(budget, options.arms, planned.needs);
  lines.push(...bounds);

  // `--version` for every arm, once, before anything runs. A row without a
  // version is not evidence, so a tool that will not say what it is does not
  // get a row. Each run probes again just before it starts (see `runOne`).
  const versions: Partial<Record<ParityArm, string>> = {};
  const shas: Partial<Record<ParityArm, string>> = {};
  const builds: Partial<Record<ParityArm, string>> = {};
  // What each arm's configuration names, asked once: it is the series' settings
  // that decide it, and every row of the series carries the same answer.
  const rosters: Partial<Record<ParityArm, string[]>> = {};
  for (const arm of options.arms) {
    const limits = limitsFor(options, arm, options.tasks[0]!);
    const version = implementation(arm).version(limits);
    if (!version)
      throw new Error(`${arm}: --version said nothing. A row without it is not evidence.`);
    versions[arm] = version;
    const sha = binarySha256Of(limits.command);
    if (sha) shas[arm] = sha;
    const build = fingerprintOf(arm, limits);
    if (build) builds[arm] = build;
    const spec = options.specs[arm]!;
    const roster = implementation(arm).roster?.({
      model: spec.model,
      provider: spec.provider ?? DEFAULT_PROVIDER[arm],
    });
    if (roster?.length) rosters[arm] = roster;
  }

  const clock = options.now ?? Date.now;
  const startedAtMs = clock();
  const state: BudgetState = NEW_BUDGET_STATE();
  const tick = () => void (state.elapsedMs = clock() - startedAtMs);
  const rerunArms: string[] = [];
  const retried: string[] = [];
  const halfPairs: string[] = [];

  mkdirSync(out, { recursive: true });
  const series = {
    kind: "parity-pairs",
    schema: SCHEMA,
    startedAt: new Date().toISOString(),
    arms: options.arms,
    mode: options.mode,
    runs: options.runs,
    seed: options.seed ?? null,
    tasks: options.tasks.map((task) => ({
      id: task.id,
      family: task.family,
      size: task.size,
      grader: task.grader,
    })),
    specs: options.specs,
    versions,
    binarySha256: shas,
    build: builds,
    rosters,
    authorisation: authorised,
    budget,
    bounds,
    wallLimitsMs: WALL_LIMIT_MS,
    plan: lines,
    attempts: 0,
    retried,
    halfPairs,
    stoppedEarly: null as string | null,
    completedAt: null as string | null,
  };
  const seriesJson = () => JSON.stringify(series, null, 2) + "\n";
  // `wx`: created here, or not at all — never truncated. The manifest goes
  // down before the first pair: what was approved is on disk before it is run.
  writeFileSync(join(out, MANIFEST), JSON.stringify(planned, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(out, RESULTS), "", { flag: "wx" });
  writeFileSync(join(out, SERIES), seriesJson(), { flag: "wx" });
  const persistSeries = () => writeFileSync(join(out, SERIES), seriesJson());

  /** The fingerprint each task's first prepared tree had: what every later one is held to. */
  const startedFrom = new Map<string, string>();

  /**
   * One arm's run, as a row, or the reason there is none.
   *
   * "No row" is reserved for the rig failing BEFORE the tool ran — the tree
   * could not be prepared or read, or the tool could not be started. From the
   * moment the tool has run, every failure is recorded in a row instead: a
   * tree git can no longer read is the arm's scope failure, a grader that
   * could not run is `grader_infrastructure`.
   *
   * And nothing runs from a tree that is not the task's: the prepared tree is
   * fingerprinted and held to the first one this task was run from. A fixture
   * that moved under the series is `drift`, reported before the tool is spawned.
   */
  const runOne = async (
    job: PairJob | RetryJob,
    arm: ParityArm,
    tryNo: number,
    retry: boolean,
  ): Promise<Attempt> => {
    const dir = runDir(out, job.task.id, job.run, arm, tryNo, retry);
    const startedAt = new Date();
    // Never written into a directory this run did not create.
    if (existsSync(dir))
      return {
        missing: `${dir} already exists`,
        reason: "grader_infrastructure",
        dir,
        startedAt,
      };
    const missing = (why: string, reason: UnscoredReason): Attempt => {
      try {
        writeFileSync(join(dir, "no-row.txt"), `${why}\n`);
      } catch {
        // The directory itself may be what failed; the reason is in the log.
      }
      return { missing: why, reason, dir, startedAt };
    };
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      return missing(`could not create ${dir}: ${String(error)}`, "grader_infrastructure");
    }
    const workspace = workspaceOf(dir);
    const limits = limitsFor(options, arm, job.task);
    const spec = options.specs[arm]!;
    const version = implementation(arm).version(limits) ?? versions[arm]!;

    let before: WorkspaceSnapshot;
    try {
      await job.task.prepare(workspace);
      before = snapshotWorkspace(workspace);
    } catch (error) {
      return missing(`the task could not be prepared: ${String(error)}`, "grader_infrastructure");
    }
    const print = taskFingerprint(job.task, before, limits.timeoutMs);
    const expected = startedFrom.get(job.task.id);
    if (expected !== undefined && expected !== print) {
      const why = `${job.task.id}: the tree prepared for run ${job.run} (${arm}) is not the one this task was first run from (${print.slice(0, 12)} against ${expected.slice(0, 12)}) — its fixture changed under the series`;
      try {
        writeFileSync(join(dir, "drift.txt"), `${why}\n`);
      } catch {
        // The reason is in the series record.
      }
      return { drift: why };
    }
    startedFrom.set(job.task.id, print);

    state.attempts++;
    series.attempts = state.attempts;
    let result: ArmResult;
    try {
      result = await implementation(arm).runArm(armTaskOf(job.task), dir, limits);
    } catch (error) {
      return missing(`the tool could not be started: ${String(error)}`, "crash_before_first_call");
    }

    let scope: ScopeResult;
    let legacyScope: ScopeScore;
    try {
      const after = snapshotWorkspace(workspace, before);
      scope = scoreScope(before, after, job.task);
      legacyScope = scoreScopeV1(before, after, job.task);
    } catch (error) {
      scope = unreadableTreeScope(error instanceof Error ? error.message : String(error));
      legacyScope = scope.scope;
    }
    // The measured build, against the one the series started with: a rebuild
    // between two runs is as much a changed source as one during a run.
    let buildMoved = false;
    if (builds[arm] !== undefined) {
      try {
        buildMoved = fingerprintOf(arm, limits) !== builds[arm];
      } catch {
        buildMoved = true;
      }
    }
    // The one classifier again, now with what only the rig can see: the tree's
    // evidence of work (a tool that left no ledger but changed the task's files
    // had reached the model) and the build's.
    let classification = classifyOutcome({
      ...result.signals,
      workspaceTouched: workspaceTouched(scope.changed),
      ...(result.signals.sourceChanged || buildMoved ? { sourceChanged: true } : {}),
    });
    let outcome: Outcome;
    try {
      outcome = await job.task.grade(workspace, dir);
    } catch (error) {
      writeFileSync(join(dir, "grade-error.txt"), `${String(error)}\n`);
      outcome = NO_OUTCOME;
      classification = unscoredAs("grader_infrastructure");
    }
    const completedAt = new Date();
    try {
      writeFileSync(
        join(dir, "classification.json"),
        JSON.stringify(
          {
            classification,
            signals: result.signals,
            buildMoved,
            detail: result.detail ?? null,
            scopeChanged: scope.changed,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      // Evidence beside the row, not the row: the row still stands.
    }
    const binarySha256 = result.binarySha256 ?? shas[arm];
    return {
      row: parityRow({
        task: job.task,
        run: job.run,
        arm,
        mode: options.mode,
        spec,
        version,
        ...(binarySha256 ? { binarySha256 } : {}),
        ...(builds[arm] ? { sourceBuild: builds[arm] } : {}),
        ...(rosters[arm] ? { roster: rosters[arm] } : {}),
        result,
        classification,
        outcome,
        scope,
        legacyScope,
        taskFingerprint: print,
        limitMs: limits.timeoutMs,
        startedAt,
        completedAt,
        evidence: dir,
        ...(retry ? { attempt: 2 } : {}),
      }),
      chargeUsd: chargeOf(result),
    };
  };

  /**
   * An arm's row for a job, always — unless the task's fixture drifted. A run
   * that produced no row is re-run once, at once, into its own evidence
   * directory, if the budget still allows one more run; if there is still no
   * row, the arm gets an unscored one so the pair is whole — and, being
   * unscored, is retried at the end like any other.
   */
  const armRow = async (
    job: PairJob | RetryJob,
    arm: ParityArm,
    retry: boolean,
  ): Promise<{ row: ParityRunResult; chargeUsd: number | null } | { drift: string }> => {
    const first = await runOne(job, arm, 1, retry);
    if ("row" in first || "drift" in first) return first;
    tick();
    const stop = gateBeforeArm(budget, state, arm, WALL_LIMIT_MS[job.task.size]);
    let last = first;
    if (stop) log(`  ${arm}: no row (${first.missing}); not re-run — ${stop}`);
    else {
      rerunArms.push(`${job.task.id}#${job.run}:${arm}`);
      log(`  ${arm}: no row (${first.missing}); re-running it once`);
      const second = await runOne(job, arm, 2, retry);
      if ("row" in second || "drift" in second) return second;
      log(`  ${arm}: still no row (${second.missing}); recorded unscored`);
      last = second;
    }
    return {
      row: parityRow({
        task: job.task,
        run: job.run,
        arm,
        mode: options.mode,
        spec: options.specs[arm]!,
        version: versions[arm]!,
        ...(shas[arm] ? { binarySha256: shas[arm] } : {}),
        ...(builds[arm] ? { sourceBuild: builds[arm] } : {}),
        ...(rosters[arm] ? { roster: rosters[arm] } : {}),
        result: null,
        classification: unscoredAs(last.reason),
        outcome: NO_OUTCOME,
        scope: { scope: 1, changed: [] },
        legacyScope: 1,
        taskFingerprint: null,
        limitMs: WALL_LIMIT_MS[job.task.size],
        startedAt: last.startedAt,
        completedAt: new Date(),
        evidence: last.dir,
        ...(retry ? { attempt: 2 } : {}),
      }),
      chargeUsd: 0,
    };
  };

  const queue: Array<PairJob | RetryJob> = [...jobs];
  const rows: ParityRunResult[] = [];
  let pairsRun = 0;
  let unscoredPairs = 0;
  let requeuedCount = 0;
  let stoppedEarly: string | undefined;

  const write = (written: readonly ParityRunResult[]) => {
    appendFileSync(join(out, RESULTS), written.map((row) => JSON.stringify(row)).join("\n") + "\n");
    rows.push(...written);
    for (const row of written) {
      // The arm's own meter, where its row carries one: the next check reads it.
      if (row.quotaPct !== undefined) state.reported[row.arm] = row.quotaPct ?? null;
      log(
        `  ${row.arm}: ${row.scored ? `q ${quality(row.outcome)?.toFixed(2) ?? "n/a"}` : `UNSCORED (${row.unscoredReason})`} · scope ${row.scope} · ${row.terminal} · ${row.clean ? "clean" : "not clean"}${row.falseCompletion ? " · FALSE COMPLETION" : ""} · ${(row.wallMs / 1000).toFixed(1)}s`,
      );
    }
  };
  /** What a run cost, against the dollar stop. Returns what could be counted. */
  const charge = (usd: number | null): number => {
    if (usd === null) state.unknownCharge = true;
    else state.spentUsd += usd;
    return usd ?? 0;
  };
  const drifted = (why: string) => `Series stopped: source drift — ${why}.`;

  while (queue.length) {
    const job = queue.shift()!;
    const limit = WALL_LIMIT_MS[job.task.size];
    tick();

    if ("retry" in job) {
      for (const arm of job.retry) {
        tick();
        stoppedEarly = gateBeforeArm(budget, state, arm, limit);
        if (stoppedEarly) break;
        log(`${job.task.id} run ${job.run}: ${arm} again, alone — its first row was unscored`);
        const again = await armRow(job, arm, true);
        if ("drift" in again) {
          stoppedEarly = drifted(again.drift);
          break;
        }
        // Held to its partner's checks: a check one side could run and the
        // other could not makes the two rows answer different questions,
        // whichever side it was. The partner's row is written; this one is not yet.
        const partner = [...rows]
          .reverse()
          .find((row) => row.task === job.task.id && row.run === job.run && row.arm !== arm);
        const sameChecks =
          !partner ||
          [...partner.outcome.impossible].sort().join("\0") ===
            [...again.row.outcome.impossible].sort().join("\0");
        write([
          sameChecks || !again.row.scored
            ? again.row
            : { ...again.row, scored: false, unscoredReason: "grader_infrastructure" },
        ]);
        retried.push(`${job.task.id}#${job.run}:${arm}`);
        charge(again.chargeUsd);
      }
      if (stoppedEarly) break;
      continue;
    }

    stoppedEarly = gateBeforePair(budget, state, job.order, limit);
    if (stoppedEarly) break;
    state.pairsStarted++;
    log(`${job.task.id} run ${job.run}: ${job.order[0]}, then ${job.order[1]}`);
    const first = await armRow(job, job.order[0], false);
    if ("drift" in first) {
      stoppedEarly = drifted(first.drift);
      break;
    }
    let pairUsd = charge(first.chargeUsd);
    tick();
    // Before the second arm: the count, the clock and its own account, again.
    // The first arm may have used the last allowed run, or the last of the time.
    const between = gateBeforeArm(budget, state, job.order[1], limit);
    const second = between ? null : await armRow(job, job.order[1], false);
    if (!second || "drift" in second) {
      // Half a pair: the row that exists is evidence, and is written as what
      // it is — a row without a partner, which the report names and never scores.
      write([first.row]);
      halfPairs.push(`${job.task.id}#${job.run}:${job.order[0]}`);
      stoppedEarly = `${second ? drifted(second.drift) : between} ${job.order[0]}'s row for ${job.task.id} run ${job.run} is kept without its partner.`;
      break;
    }
    pairUsd += charge(second.chargeUsd);
    state.costliestPairUsd = Math.max(state.costliestPairUsd, pairUsd);
    const pair = reconcileImpossible(first.row, second.row);
    // Both rows, together, in one write.
    write(pair);
    pairsRun++;

    const unscored = pair.filter((row) => !row.scored).map((row) => row.arm);
    if (unscored.length > 0) {
      unscoredPairs++;
      queue.push(retryOf(job, unscored));
      requeuedCount++;
    }
    if (tooManyUnscored(unscoredPairs, jobs.length)) {
      stoppedEarly = `Series stopped: ${unscoredPairs} of ${jobs.length} planned pair(s) came back unscored, more than a quarter — the series is measuring the providers now, not the tools.`;
      break;
    }
  }

  if (stoppedEarly) log(stoppedEarly);
  series.stoppedEarly = stoppedEarly ?? null;
  series.completedAt = new Date().toISOString();
  persistSeries();
  return {
    kind: "parity-pairs",
    lines,
    rows,
    planned: jobs.length,
    pairsRun,
    unscoredPairs,
    requeued: requeuedCount,
    rerunArms,
    attempts: state.attempts,
    retried,
    halfPairs,
    manifest: planned,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

// ─── The CLI ───

const USAGE = `Paired parity runs: the frozen corpus, its supplement and the mined tasks.

  bun run tests/eval/parity/run-pairs.ts --dry-run \\
    --arms rune,claude-code --mode product --runs 1 --out /tmp/parity-plan \\
    --rune-model MODEL [--rune-provider codex] [--rune-bin PATH] \\
    --claude-code-model MODEL [--claude-code-effort high] [--claude-code-bin PATH] \\
    [--tasks id,id] [--source corpus,supplement,serious] [--seed N] \\
    [--max-pairs N --max-attempts N --wall-allowance-min M] [--bounded] \\
    [--rune-used-pct P --rune-stop-at-pct P] [--claude-code-used-pct P --claude-code-stop-at-pct P] \\
    [--write-manifest FILE]

  RUNE_EVAL_BUDGET_USD=<dollars> | RUNE_EVAL_QUOTA_PCT=<1-100> \\
    bun run tests/eval/parity/run-pairs.ts --real --manifest FILE --out DIR
  …or --real with the same flags a dry run takes.

With no --tasks and no --source, every available task is planned: 18 small and
30 mined, 48 in all. --corpus DIR reads that one directory instead.

Each arm takes --<arm>-model, --<arm>-provider, --<arm>-effort and --<arm>-bin;
--model and --effort set every arm that takes them. Rune takes no effort: the
parity profile runs it on its shipped defaults. Claude Code product mode needs
RUNE_PARITY_CLAUDE_CONFIG_DIR (a profile signed in once, by hand:
CLAUDE_CONFIG_DIR=<dir> claude, then /login); harness mode needs ANTHROPIC_API_KEY.

The limits are hard stops, counted by the rig and checked before every arm run:
--max-pairs, --max-attempts (arm runs, retries included) and --wall-allowance-min.
--<arm>-used-pct is what you read of that account's window before the series;
--<arm>-stop-at-pct is where to stop. Only Rune's rows report a meter, so any
other arm's stop is checked once, against your reading, and is not a cap after
that: a series with an account it cannot watch needs --bounded, which says the
run count and the wall allowance are the only bound. RUNE_EVAL_BUDGET_USD is an
estimate-gated stop, not a spend cap.

--real spends money or subscription quota. It refuses to start without one of
the two authorisations and its limits, and it is an external action: it runs
when the founder authorises it in their own words, naming the task count, the
arm order and the allowance.`;

/** A share of a window, as typed: a plain number from 0 to 100. */
function pctFlag(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value > 100)
    throw new Error(`--${name} must be a plain number from 0 to 100, not ${raw}.`);
  return value;
}

/** A count or a number of minutes, as typed: a plain positive number. */
function positiveFlag(name: string, raw: string | undefined, whole: boolean): number | undefined {
  if (raw === undefined) return undefined;
  const value = (whole ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(
      `--${name} must be a plain positive ${whole ? "whole number" : "number"}, not ${raw}.`,
    );
  return value;
}

/** Read a manifest file, or refuse it by what is wrong with it. */
export function readManifest(path: string): ParityManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: cannot be read as a manifest (${String(error)})`);
  }
  const problems = manifestProblems(value);
  if (problems.length)
    throw new Error(`${path} is not a usable manifest:\n  ${problems.join("\n  ")}`);
  return value as ParityManifest;
}

/**
 * The series a manifest describes, with its tasks loaded again from their
 * sources and held to what the manifest pinned. Any difference is source
 * drift, and is refused: what would run is not what was approved.
 */
export function optionsFromManifest(
  manifest: ParityManifest,
  out: string,
  dryRun: boolean,
  available = availableTasks(),
): PairSeriesOptions {
  if (manifest.schema !== MANIFEST_SCHEMA)
    throw new Error(`The manifest is ${manifest.schema}; this runner reads ${MANIFEST_SCHEMA}.`);
  const drift = manifestDrift(
    manifest,
    available.map((entry) => entry.task),
  );
  if (drift.length)
    throw new Error(
      `Source drift: the tasks are not the ones the manifest pinned, and nothing was run.\n  ${drift.join("\n  ")}`,
    );
  const chosen = selectTasks(
    available,
    manifest.tasks.map((task) => task.id),
  );
  const options: PairSeriesOptions = {
    tasks: chosen.map((entry) => entry.task),
    sources: Object.fromEntries(chosen.map((entry) => [entry.task.id, entry.source])),
    arms: manifest.arms,
    runs: manifest.runs,
    mode: manifest.mode,
    out: resolve(out),
    specs: manifest.specs,
    seed: manifest.seed,
    ...(manifest.limits ? { limits: manifest.limits } : {}),
    accounts: manifest.accounts,
    bounded: manifest.bounded,
    dryRun,
  };
  // The order is the manifest's own: the same seed over the same tasks.
  const order = planPairs(options.tasks, options.arms, options.runs, options.seed ?? null).map(
    (job) => `${job.task.id}#${job.run}:${job.order[0]}`,
  );
  const pinned = manifest.order.map((pair) => `${pair.task}#${pair.run}:${pair.first}`);
  if (order.join(" ") !== pinned.join(" "))
    throw new Error(
      "The manifest's order is not the order its tasks, runs and seed give: it was edited by hand, and nothing was run.",
    );
  return options;
}

export function parseCli(argv: string[]): PairSeriesOptions | undefined {
  const get = (key: string) => {
    const at = argv.indexOf(`--${key}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const dryRun = argv.includes("--dry-run");
  if (!dryRun && !argv.includes("--real")) return undefined;
  const out = get("out");
  if (!out) throw new Error("--out is required");
  const manifestPath = get("manifest");
  if (manifestPath) {
    const options = optionsFromManifest(readManifest(resolve(manifestPath)), out, dryRun);
    // What an account's window reads is a fact of the moment the series starts,
    // not of the day its plan was approved: a reading given now replaces the
    // manifest's. Nothing else about an approved plan can be changed from here.
    const accounts: Partial<Record<ParityArm, AccountBudget>> = {};
    for (const arm of options.arms) {
      const pinned = options.accounts?.[arm];
      accounts[arm] = {
        usedPct: pctFlag(`${arm}-used-pct`, get(`${arm}-used-pct`)) ?? pinned?.usedPct ?? null,
        stopAtPct:
          pctFlag(`${arm}-stop-at-pct`, get(`${arm}-stop-at-pct`)) ?? pinned?.stopAtPct ?? null,
      };
    }
    return { ...options, accounts, bounded: options.bounded || argv.includes("--bounded") };
  }
  const arms = (get("arms") ?? "rune,claude-code").split(",").map((name) => name.trim());
  if (arms.length !== 2) throw new Error(`--arms names exactly two arms, not ${arms.join(",")}`);
  for (const arm of arms) if (!(arm in ARMS)) throw new Error(`Unknown arm: ${arm}`);
  const mode = get("mode") ?? "product";
  if (mode !== "product" && mode !== "harness")
    throw new Error(`--mode is product or harness, not ${mode}`);
  if (get("rune-effort"))
    throw new Error(
      "--rune-effort: the parity profile runs Rune on its shipped defaults, effort included.",
    );
  const specs: Partial<Record<ParityArm, ArmSpec>> = {};
  const accounts: Partial<Record<ParityArm, AccountBudget>> = {};
  for (const arm of arms as ParityArm[]) {
    const model = get(`${arm}-model`) ?? get("model");
    const provider = get(`${arm}-provider`);
    const effort = arm === "rune" ? undefined : (get(`${arm}-effort`) ?? get("effort"));
    const bin = get(`${arm}-bin`);
    specs[arm] = {
      model: model ?? "",
      ...(provider ? { provider } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(bin ? { command: [resolve(bin)] } : {}),
    };
    accounts[arm] = {
      usedPct: pctFlag(`${arm}-used-pct`, get(`${arm}-used-pct`)),
      stopAtPct: pctFlag(`${arm}-stop-at-pct`, get(`${arm}-stop-at-pct`)),
    };
  }
  const ids = get("tasks")
    ?.split(",")
    .map((id) => id.trim());
  const corpus = get("corpus");
  const sources = get("source")
    ?.split(",")
    .map((name) => name.trim());
  for (const name of sources ?? [])
    if (!(TASK_SOURCES as readonly string[]).includes(name))
      throw new Error(`--source names ${TASK_SOURCES.join(", ")}, not ${name}`);
  // One corpus directory, as before, or every source there is.
  const chosen = corpus
    ? corpusParityTasks(corpus, ids).map((task) => ({ source: "corpus" as const, task }))
    : selectTasks(availableTasks((sources as TaskSource[] | undefined) ?? TASK_SOURCES), ids);
  const maxPairs = positiveFlag("max-pairs", get("max-pairs"), true);
  const maxAttempts = positiveFlag("max-attempts", get("max-attempts"), true);
  const allowance = positiveFlag("wall-allowance-min", get("wall-allowance-min"), false);
  const given = [maxPairs, maxAttempts, allowance].filter((value) => value !== undefined).length;
  if (given !== 0 && given !== 3)
    throw new Error(
      "--max-pairs, --max-attempts and --wall-allowance-min are one budget: give all three or none.",
    );
  const seed = get("seed");
  if (seed !== undefined && !/^\d+$/.test(seed))
    throw new Error(`--seed must be a whole number of at least 0, not ${seed}.`);
  const writeManifest = get("write-manifest");
  if (writeManifest && !dryRun)
    throw new Error(
      "--write-manifest goes with --dry-run: a live run writes its manifest in --out.",
    );
  return {
    tasks: chosen.map((entry) => entry.task),
    sources: Object.fromEntries(chosen.map((entry) => [entry.task.id, entry.source])),
    arms: arms as [ParityArm, ParityArm],
    runs: Number(get("runs") ?? 1),
    mode,
    out: resolve(out),
    specs,
    accounts,
    bounded: argv.includes("--bounded"),
    ...(seed !== undefined ? { seed: Number(seed) } : {}),
    ...(given === 3
      ? {
          limits: {
            maxPairs: maxPairs!,
            maxAttempts: maxAttempts!,
            wallAllowanceMs: allowance! * 60_000,
          },
        }
      : {}),
    ...(writeManifest ? { writeManifest: resolve(writeManifest) } : {}),
    dryRun,
  };
}

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2));
  if (!options) console.log(USAGE);
  else await runPairs(options);
}
