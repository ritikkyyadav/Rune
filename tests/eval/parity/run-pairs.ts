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
//   6. Whole pairs, always. Both rows of a pair are written together, after
//      both arms ran, because a row without its partner keeps its whole family
//      from passing (docs/program/parity-index.md, decision 6). An arm whose
//      run produced no row at all — the rig could not prepare the tree or
//      start the tool — is RE-RUN once, at once; if it still produces none, it
//      gets an unscored row, so the pair stays whole and is re-queued like any
//      unscored pair. A pair with an unscored row is re-queued ONCE, as a new
//      run number with both arms, and its first attempt stays in the evidence.
//      The series stops only when more than a quarter of the planned pairs
//      have come back unscored.
//   7. One build per series. The Rune build is fingerprinted when the series
//      starts and after every Rune run; a row whose build moved — rebuilt by
//      another session between two runs, not only during one — is
//      `source_changed`. And every row records the `--version` its tool gave
//      just before that run, so a comparator that auto-updates mid-series
//      (Claude Code went 2.1.283 → 2.1.284 overnight while this was written)
//      is on the record as two versions, not one.
//
// And the door: nothing live starts unless `RUNE_EVAL_BUDGET_USD` (a dollar
// ceiling for the whole series) or `RUNE_EVAL_QUOTA_PCT` (stop once Rune's
// row reports that share of its subscription window used) is set, and the
// series stops as soon as no authorisation it was given can still be
// enforced. `--dry-run` plans every pair and spawns nothing at all — not even
// `--version` — and writes nothing.
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
  tooManyUnscored,
  workspaceOf,
} from "../comparison/arms/types";
import { authorisedBudgetUsd } from "../comparison/runner";
import { corpusParityTasks } from "./corpus-source";
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

/** What the gates know when the next pair is about to start. */
export interface GateState {
  pairsRun: number;
  /** The sum of every charge that could be counted. */
  spentUsd: number;
  /** Some run's charge could not be counted (`chargeOf` said null). */
  unknownCharge: boolean;
  /** The most any one pair has cost so far: the estimate for the next one. */
  costliestPairUsd: number;
  /** The last Rune row's `quotaPct` (null or absent when it reported none). */
  runeQuotaPct?: number | null;
}

/**
 * Whether the next pair may start. A reason to stop, or undefined. Pure.
 *
 * The first pair always starts: before it nothing is known, and a pair is the
 * smallest thing the index can use. After that, each authorisation that was
 * given either SEES (and may stop the series) or is BLIND — the dollar gate
 * once a run's cost could not be counted, the quota gate while Rune reports no
 * share of its window. The series goes on only while at least one of the gates
 * it was given can still see; a series nothing can bound is not one anybody
 * authorised.
 */
export function gateBeforePair(auth: Authorisation, state: GateState): string | undefined {
  if (state.pairsRun === 0) return undefined;
  const blind: string[] = [];
  let sees = false;
  if (auth.budgetUsd !== null) {
    if (state.unknownCharge)
      blind.push(
        `a run reported no cost, so spend against RUNE_EVAL_BUDGET_USD $${auth.budgetUsd} can no longer be counted`,
      );
    else if (state.spentUsd + state.costliestPairUsd > auth.budgetUsd)
      return `Series stopped: $${state.spentUsd.toFixed(4)} spent, and the next pair may cost up to $${state.costliestPairUsd.toFixed(4)}, past the authorised $${auth.budgetUsd}.`;
    else sees = true;
  }
  if (auth.quotaPct !== null) {
    const used = state.runeQuotaPct;
    if (typeof used === "number") {
      if (used >= auth.quotaPct)
        return `Series stopped: Rune reported ${used}% of its window used, at or past RUNE_EVAL_QUOTA_PCT ${auth.quotaPct}.`;
      sees = true;
    } else
      blind.push(
        "Rune's last row reported no quotaPct (its provider sent no window meter), so RUNE_EVAL_QUOTA_PCT cannot be watched",
      );
  }
  if (!sees)
    return `Series stopped: no authorisation it was given can still be enforced — ${blind.join("; ")}.`;
  return undefined;
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
  /** The run number this job re-runs, when it is a re-queued pair. */
  requeueOf?: number;
}

/**
 * Every planned pair, in order, with the arm order alternating.
 *
 * The first arm flips with (run + task index), the rule `runPilot` has always
 * used — so it alternates across tasks within a repetition AND across
 * repetitions of one task. Pure: tested without spawning.
 */
export function planPairs(
  tasks: readonly ParityTask[],
  arms: readonly [ParityArm, ParityArm],
  runs: number,
): PairJob[] {
  const jobs: PairJob[] = [];
  for (let run = 1; run <= runs; run++)
    for (const [index, task] of tasks.entries())
      jobs.push({
        task,
        run,
        order: (run - 1 + index) % 2 === 0 ? [arms[0], arms[1]] : [arms[1], arms[0]],
      });
  return jobs;
}

/**
 * The one re-run an unscored pair gets: a NEW run number (the scorer refuses
 * two rows for one (mode, arm, task, run), and the failed attempt is evidence
 * that stays), both arms, the other arm first.
 */
export function requeued(job: PairJob, run: number): PairJob {
  return { task: job.task, run, order: [job.order[1], job.order[0]], requeueOf: job.run };
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
  /** path → "<XY> <fingerprint>" for every path git status lists. */
  entries: Record<string, string>;
  /** Paths changed by commits made since the `since` snapshot, if any. */
  committed: string[];
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
  const entries: Record<string, string> = {};
  for (const { code, path } of parsePorcelainZ(status.stdout)) {
    if (exclude.some((pattern) => pattern.test(path))) continue;
    entries[path] = `${code} ${fingerprint(join(root, path))}`;
  }
  let committed: string[] = [];
  if (since?.head && head && since.head !== head) {
    const diff = git(root, ["diff", "--name-only", "-z", since.head, head]);
    committed = diff.stdout.split("\0").filter(Boolean);
  }
  return { head, entries, committed };
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

/**
 * The scope score, from two snapshots. Pure.
 *
 *   0    a no-code task (explain, plan) in which any path other than the files
 *        it asked for was created, modified or deleted — tracked or untracked,
 *        ignored or not. Only dependencies (`node_modules/`) and the tool's own
 *        state directory (`TOOL_STATE`) are left to the next rule.
 *   0.5  the run left NEW ignored or untracked ARTIFACTS beyond what the task
 *        needs: anything git ignores that was not there before (`.rune/` in
 *        these fixtures), or a new untracked build/log/tool-state leftover
 *        (`target/`, `*.log`, `.claude/`).
 *   1    otherwise. New source and test files on a coding task are the work.
 */
export function scoreScope(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  task: Pick<ParityTask, "noCode" | "expectedNewFiles">,
  exclude: readonly RegExp[] = SCOPE_EXCLUDE,
): ScopeResult {
  const changed = changedPaths(before, after, exclude);
  const expected = new Set(task.expectedNewFiles ?? []);
  const unexpected = changed.filter((path) => !expected.has(path));
  if (task.noCode) {
    const edits = unexpected.filter((path) => !TOOL_STATE.test(path));
    if (edits.length) return { scope: 0, notes: noted(edits), changed };
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

/** Ended by itself, inside the limit, and did not claim what it had not done. */
export function isClean(
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
  /** Null when the tool never started (prepare failed, or the spawn threw). */
  result: ArmResult | null;
  classification: Classification;
  outcome: Outcome;
  scope: ScopeResult;
  limitMs: number;
  startedAt: Date;
  completedAt: Date;
  evidence: string;
}

/** A `ParityRunResult`, assembled in one place so every path builds the same shape. */
export function parityRow(input: RowInput): ParityRunResult {
  const { result, classification } = input;
  const falseCompletion = result ? isFalseCompletion(result.claimedSuccess, input.outcome) : false;
  const provider = input.spec.provider ?? DEFAULT_PROVIDER[input.arm];
  const row: ParityRunResult = {
    schema: SCHEMA,
    task: input.task.id,
    family: input.task.family,
    run: input.run,
    arm: input.arm,
    mode: input.mode,
    model: input.spec.model,
    ...(provider ? { provider } : {}),
    version: input.version,
    ...(input.binarySha256 ? { binarySha256: input.binarySha256 } : {}),
    scored: classification.scored,
    ...(classification.scored ? {} : { unscoredReason: classification.unscoredReason! }),
    outcome: input.outcome,
    clean: result ? isClean(result, input.limitMs, falseCompletion) : false,
    falseCompletion,
    scope: input.scope.scope,
    ...(input.scope.notes ? { scopeNotes: input.scope.notes } : {}),
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
}

export interface PairSeriesReport {
  kind: "parity-pairs" | "parity-pairs-dry-run";
  lines: string[];
  rows: ParityRunResult[];
  planned: number;
  pairsRun: number;
  unscoredPairs: number;
  requeued: number;
  /** Arms re-run because a run produced no row, as `task#run:arm`. */
  rerunArms: string[];
  stoppedEarly?: string;
}

export const RESULTS = "results.jsonl";
export const SERIES = "series.json";

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

const runDir = (out: string, taskId: string, run: number, arm: ParityArm, attempt = 1) =>
  join(out, taskId, `run-${run}`, attempt === 1 ? arm : `${arm}-attempt-${attempt}`);

function validate(options: PairSeriesOptions): void {
  const [a, b] = options.arms;
  if (a === b) throw new Error(`A pair needs two different arms, not ${a} twice.`);
  if (!options.tasks.length) throw new Error("No tasks: a series needs at least one.");
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new Error(`--runs must be a positive whole number, not ${options.runs}.`);
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
  const lines: string[] = [
    `parity pairs: ${a} vs ${b} · mode ${options.mode} · ${options.tasks.length} task(s) × ${options.runs} run(s) = ${jobs.length} pair(s)`,
    `wall limits: small ${WALL_LIMIT_MS.small / 60_000} min, serious ${WALL_LIMIT_MS.serious / 60_000} min — the same for both arms; no turn or dollar cap on either`,
    `an unscored pair is re-run once, as run ${options.runs + 1} onward, other arm first; the series stops when more than a quarter of the ${jobs.length} planned pair(s) come back unscored`,
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

/** One arm's run of one job: a row, or the reason the rig could not produce one. */
type Attempt =
  | { row: ParityRunResult; chargeUsd: number | null }
  | { missing: string; reason: UnscoredReason; dir: string; startedAt: Date };

/**
 * Plan (and, unless `dryRun`, run) a paired series.
 *
 * The refusals come first and in this order, so a series that is going to be
 * refused has started nothing: the authorisation, the output directory, the
 * plans' own refusals (no evaluation profile, no API key), the versions and
 * the build. Only then is the output directory created.
 */
export async function runPairs(options: PairSeriesOptions): Promise<PairSeriesReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  validate(options);
  const implementation = (arm: ParityArm) => options.implementations?.[arm] ?? ARMS[arm];
  const fingerprintOf = options.fingerprint ?? defaultFingerprint;
  const jobs = planPairs(options.tasks, options.arms, options.runs);

  if (options.dryRun) {
    const { lines } = planLines(options, jobs, implementation);
    lines.push(
      `${jobs.length} pair(s) planned. Nothing was executed and nothing was written: a dry run spawns nothing, not even --version.`,
      "A live run needs RUNE_EVAL_BUDGET_USD (the series' dollar ceiling) or RUNE_EVAL_QUOTA_PCT (stop at that share of Rune's window).",
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
    };
  }

  const authorised = pairsAuthorisation(options.env ?? process.env);
  if (authorised.budgetUsd === null && !options.arms.includes("rune"))
    throw new Error(
      "RUNE_EVAL_QUOTA_PCT is read from the Rune row of each pair, and this series has no Rune arm. Authorise it with RUNE_EVAL_BUDGET_USD instead.",
    );
  const out = resolve(options.out);
  // Evidence is never overwritten: not the results, and not a run's directory.
  for (const path of [
    join(out, RESULTS),
    join(out, SERIES),
    ...options.tasks.map((task) => join(out, task.id)),
  ])
    if (existsSync(path))
      throw new Error(
        `${path} already exists. Use a fresh output directory: evidence is never overwritten, and a second series appended to the first would pair across two runs.`,
      );
  const { lines, refusals } = planLines(options, jobs, implementation);
  if (refusals.length) throw new Error(`Refused before anything ran:\n  ${refusals.join("\n  ")}`);

  // `--version` for every arm, once, before anything runs. A row without a
  // version is not evidence, so a tool that will not say what it is does not
  // get a row. Each run probes again just before it starts (see `runOne`).
  const versions: Partial<Record<ParityArm, string>> = {};
  const shas: Partial<Record<ParityArm, string>> = {};
  const builds: Partial<Record<ParityArm, string>> = {};
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
  }

  mkdirSync(out, { recursive: true });
  const series = {
    kind: "parity-pairs",
    schema: SCHEMA,
    startedAt: new Date().toISOString(),
    arms: options.arms,
    mode: options.mode,
    runs: options.runs,
    tasks: options.tasks.map((task) => ({ id: task.id, family: task.family, size: task.size })),
    specs: options.specs,
    versions,
    binarySha256: shas,
    build: builds,
    authorisation: authorised,
    wallLimitsMs: WALL_LIMIT_MS,
    plan: lines,
    stoppedEarly: null as string | null,
    completedAt: null as string | null,
  };
  const seriesJson = () => JSON.stringify(series, null, 2) + "\n";
  // `wx`: created here, or not at all — never truncated.
  writeFileSync(join(out, RESULTS), "", { flag: "wx" });
  writeFileSync(join(out, SERIES), seriesJson(), { flag: "wx" });
  const persistSeries = () => writeFileSync(join(out, SERIES), seriesJson());

  /**
   * One arm's run, as a row, or the reason there is none.
   *
   * "No row" is reserved for the rig failing BEFORE the tool ran — the tree
   * could not be prepared or read, or the tool could not be started. From the
   * moment the tool has run, every failure is recorded in a row instead: a
   * tree git can no longer read is the arm's scope failure, a grader that
   * could not run is `grader_infrastructure`.
   */
  const runOne = async (job: PairJob, arm: ParityArm, attempt: number): Promise<Attempt> => {
    const dir = runDir(out, job.task.id, job.run, arm, attempt);
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
    let result: ArmResult;
    try {
      result = await implementation(arm).runArm(armTaskOf(job.task), dir, limits);
    } catch (error) {
      return missing(`the tool could not be started: ${String(error)}`, "crash_before_first_call");
    }

    let scope: ScopeResult;
    try {
      scope = scoreScope(before, snapshotWorkspace(workspace, before), job.task);
    } catch (error) {
      scope = unreadableTreeScope(error instanceof Error ? error.message : String(error));
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
        result,
        classification,
        outcome,
        scope,
        limitMs: limits.timeoutMs,
        startedAt,
        completedAt,
        evidence: dir,
      }),
      chargeUsd: chargeOf(result),
    };
  };

  const rerunArms: string[] = [];
  /**
   * An arm's row for a job, always. A run that produced no row is re-run once,
   * at once, into its own evidence directory; if that produces none either,
   * the arm gets an unscored row so the pair is still whole — and, being
   * unscored, is re-queued.
   */
  const armRow = async (
    job: PairJob,
    arm: ParityArm,
  ): Promise<{ row: ParityRunResult; chargeUsd: number | null }> => {
    const first = await runOne(job, arm, 1);
    if ("row" in first) return first;
    rerunArms.push(`${job.task.id}#${job.run}:${arm}`);
    log(`  ${arm}: no row (${first.missing}); re-running it once`);
    const second = await runOne(job, arm, 2);
    if ("row" in second) return second;
    log(`  ${arm}: still no row (${second.missing}); recorded unscored`);
    return {
      row: parityRow({
        task: job.task,
        run: job.run,
        arm,
        mode: options.mode,
        spec: options.specs[arm]!,
        version: versions[arm]!,
        ...(shas[arm] ? { binarySha256: shas[arm] } : {}),
        result: null,
        classification: unscoredAs(second.reason),
        outcome: NO_OUTCOME,
        scope: { scope: 1, changed: [] },
        limitMs: WALL_LIMIT_MS[job.task.size],
        startedAt: second.startedAt,
        completedAt: new Date(),
        evidence: second.dir,
      }),
      chargeUsd: 0,
    };
  };

  const queue = [...jobs];
  const rows: ParityRunResult[] = [];
  const nextRun = new Map<string, number>();
  let unscoredPairs = 0;
  let requeuedCount = 0;
  const gate: GateState = { pairsRun: 0, spentUsd: 0, unknownCharge: false, costliestPairUsd: 0 };
  let stoppedEarly: string | undefined;

  while (queue.length) {
    stoppedEarly = gateBeforePair(authorised, gate);
    if (stoppedEarly) break;
    const job = queue.shift()!;
    log(
      `${job.task.id} run ${job.run}: ${job.order[0]}, then ${job.order[1]}${job.requeueOf ? ` (re-run of run ${job.requeueOf})` : ""}`,
    );
    const first = await armRow(job, job.order[0]);
    const second = await armRow(job, job.order[1]);
    const pair = reconcileImpossible(first.row, second.row);
    // Both rows, together, in one write: a pair is never half-written.
    appendFileSync(join(out, RESULTS), pair.map((row) => JSON.stringify(row)).join("\n") + "\n");
    rows.push(...pair);
    gate.pairsRun++;
    for (const row of pair)
      log(
        `  ${row.arm}: ${row.scored ? `q ${quality(row.outcome)?.toFixed(2) ?? "n/a"}` : `UNSCORED (${row.unscoredReason})`} · scope ${row.scope} · ${row.clean ? "clean" : "not clean"}${row.falseCompletion ? " · FALSE COMPLETION" : ""} · ${(row.wallMs / 1000).toFixed(1)}s`,
      );
    let pairUsd = 0;
    for (const charge of [first.chargeUsd, second.chargeUsd])
      if (charge === null) gate.unknownCharge = true;
      else pairUsd += charge;
    gate.spentUsd += pairUsd;
    gate.costliestPairUsd = Math.max(gate.costliestPairUsd, pairUsd);
    const runeRow = pair.find((row) => row.arm === "rune");
    if (runeRow) gate.runeQuotaPct = runeRow.quotaPct ?? null;

    if (pair.some((row) => !row.scored)) {
      unscoredPairs++;
      if (job.requeueOf === undefined) {
        const taskRuns = nextRun.get(job.task.id) ?? options.runs;
        nextRun.set(job.task.id, taskRuns + 1);
        queue.push(requeued(job, taskRuns + 1));
        requeuedCount++;
      }
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
    pairsRun: gate.pairsRun,
    unscoredPairs,
    requeued: requeuedCount,
    rerunArms,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
}

// ─── The CLI ───

const USAGE = `Paired parity runs over the frozen corpus.

  bun run tests/eval/parity/run-pairs.ts --dry-run \\
    --arms rune,claude-code --mode product --runs 1 --out /tmp/parity-plan \\
    --rune-model MODEL [--rune-provider codex] [--rune-bin PATH] \\
    --claude-code-model MODEL [--claude-code-effort high] [--claude-code-bin PATH] \\
    [--tasks id,id] [--corpus tests/eval/corpus]

  RUNE_EVAL_BUDGET_USD=<dollars> | RUNE_EVAL_QUOTA_PCT=<1-100> \\
    bun run tests/eval/parity/run-pairs.ts --real …same flags…

Each arm takes --<arm>-model, --<arm>-provider, --<arm>-effort and --<arm>-bin;
--model and --effort set every arm that takes them. Rune takes no effort: the
parity profile runs it on its shipped defaults. Claude Code product mode needs
RUNE_PARITY_CLAUDE_CONFIG_DIR (a profile signed in once, by hand:
CLAUDE_CONFIG_DIR=<dir> claude, then /login); harness mode needs ANTHROPIC_API_KEY.

--real spends money or subscription quota. It refuses to start without one of
the two authorisations, and it is an external action: it runs when the founder
authorises it in their own words, naming the task count and the arm order.`;

export function parseCli(argv: string[]): PairSeriesOptions | undefined {
  const get = (key: string) => {
    const at = argv.indexOf(`--${key}`);
    return at < 0 ? undefined : argv[at + 1];
  };
  const dryRun = argv.includes("--dry-run");
  if (!dryRun && !argv.includes("--real")) return undefined;
  const out = get("out");
  if (!out) throw new Error("--out is required");
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
  }
  const tasks = get("tasks")
    ?.split(",")
    .map((id) => id.trim());
  return {
    tasks: corpusParityTasks(get("corpus") ?? join(import.meta.dir, "../corpus"), tasks),
    arms: arms as [ParityArm, ParityArm],
    runs: Number(get("runs") ?? 1),
    mode,
    out: resolve(out),
    specs,
    dryRun,
  };
}

if (import.meta.main) {
  const options = parseCli(process.argv.slice(2));
  if (!options) console.log(USAGE);
  else await runPairs(options);
}
