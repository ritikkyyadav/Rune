// ─── The Parity Index contract ───
//
// One file every parity lane imports and none of them owns: the arms
// (tests/eval/comparison/arms) write `ParityRunResult` rows, the task sources
// (the frozen corpus, the serious-task miner in tests/eval/serious) implement
// `ParityTask`, and the scorer (tests/eval/parity/score.ts) reads the rows.
// It was frozen before any of them was written so they could be built at the
// same time without drifting (docs/program/parity-index.md, 2026-09-28).
//
// Changing a field here changes what an evidence file means. Bump `SCHEMA`,
// and say why in the Changes section of docs/program/parity-index.md.
//
// Nothing in this file spawns anything or reads the disk.

/** What a row written NOW says it is. */
export const SCHEMA = "parity-run/2" as const;

/**
 * Every schema a report can still READ. A `parity-run/1` row is old evidence,
 * not a malformed row: it was scored by the rules of its day (no coding-task
 * scope, a crash could be `clean`) and never recorded how its run ended or what
 * graded it. It stays readable and is never mixed, unsaid, with rows that did.
 */
export const READABLE_SCHEMAS = ["parity-run/1", "parity-run/2"] as const;
export type RowSchema = (typeof READABLE_SCHEMAS)[number];

/**
 * The seven task families the gate is held to, each on its own floor.
 *
 * F7 is the serious family: real fixes mined from a repository's history,
 * graded by the fix commit's own tests. The others are the frozen corpus's
 * families, plus whatever mined tasks the miner tags with the same shape.
 */
export type Family = "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7";

export const FAMILY_NAMES: Readonly<Record<Family, string>> = {
  F1: "fix",
  F2: "omission-prone feature",
  F3: "multi-file / migration",
  F4: "frontend",
  F5: "no-code (explain / plan)",
  F6: "dirty worktree",
  F7: "serious (mined)",
};

/** The corpus's own `task.json` family labels, mapped onto the gate's. */
export const CORPUS_FAMILY: Readonly<Record<string, Family>> = {
  fix: "F1",
  "omission-prone-feature": "F2",
  migration: "F3",
  frontend: "F4",
  research: "F5",
  "dirty-worktree": "F6",
};

export type ParityArm = "rune" | "claude-code" | "opencode" | "codex";

/**
 * `product`: each tool on its best model on the founder's own accounts — the
 * headline and the release gate. `harness`: both tools on the same model via an
 * API key — attribution only, never a gate.
 */
export type ParityMode = "product" | "harness";

/** Wall-clock limits, the same for every arm. No arm has a turn cap. */
export const WALL_LIMIT_MS: Readonly<Record<"small" | "serious", number>> = {
  small: 20 * 60_000,
  serious: 45 * 60_000,
};

/**
 * Why a run does not count, for EITHER arm. Everything else that goes wrong
 * — a timeout, the tool's own turn or budget limit, a crash after the first
 * model call — is the tool failing the task and stays scored.
 */
export type UnscoredReason =
  | "provider_outage"
  | "provider_quota"
  | "provider_auth"
  | "crash_before_first_call"
  | "grader_infrastructure"
  | "source_changed";

/** What the grader found in the tree the run left behind. */
export interface Outcome {
  /** Runnable hidden fail-to-pass checks that passed / that exist. */
  hiddenPassed: number;
  hiddenTotal: number;
  /** Pass-to-pass checks that passed at base and fail now. */
  regressionsIntroduced: number;
  /** Typecheck or build broken where the base tree was clean. */
  buildBroken: boolean;
  /** Checks pinned impossible in this environment — excluded for every arm. */
  impossible: string[];
}

/**
 * Quality in [0, 1]: the share of hidden checks passed, halved by any
 * regression, zeroed by a broken build. A task with no runnable hidden check
 * has no quality and the pair is excluded, never scored as 0 or 1.
 */
export function quality(o: Outcome): number | null {
  if (o.hiddenTotal <= 0) return null;
  const share = o.hiddenPassed / o.hiddenTotal;
  if (o.buildBroken) return 0;
  return o.regressionsIntroduced > 0 ? share * 0.5 : share;
}

/** 1 = inside the task's scope, 0.5 = artifacts left only, 0 = out of scope. */
export type ScopeScore = 0 | 0.5 | 1;

/**
 * How a run ended, in words every arm can say (`terminalOf`, beside the one
 * classifier in tests/eval/comparison/arms/types.ts).
 *
 *   completed    ended by itself and reported success
 *   incomplete   ended by itself and reported that it had NOT finished: its own
 *                turn or budget ceiling (or the rig's cost watcher standing in
 *                for a ceiling the tool lacks), or its own named stop
 *   stopped      the rig ended it: the wall clock, or any other kill
 *   crashed      ended without saying how: the process died, or its report
 *                held only an error
 *   refused      the provider refused the run (quota, auth, outage)
 *   not_started  the tool never ran
 *
 * It says how the PROCESS ended and what it CLAIMED. Whether the work is right
 * is the grader's, and is `outcome`.
 */
export type Terminal =
  "completed" | "incomplete" | "stopped" | "crashed" | "refused" | "not_started";

export const TERMINALS: readonly Terminal[] = [
  "completed",
  "incomplete",
  "stopped",
  "crashed",
  "refused",
  "not_started",
];

/**
 * What a row was measured WITH, as three digests, so that two rows can be shown
 * to answer the same question instead of being assumed to.
 *
 *   task     the task as the arm was given it: its id, the prompt's bytes, the
 *            seeded tree, the uncommitted work in it, and the wall limit. Null
 *            only when the tree could not be prepared and the tool never ran.
 *   grader   what graded it: the hidden checks and what they are expected to
 *            say (`ParityTask.grader`). It covers what is checked, not the code
 *            that runs the check.
 *   config   the arm's settings: arm, mode, model, provider, reasoning effort.
 *
 * Two rows for one task with different `task` or `grader` digests did not sit
 * the same exam, and no report pairs them.
 */
export interface Fingerprints {
  task: string | null;
  grader: string;
  config: string;
}

/** One arm's run of one task instance — one line of `results.jsonl`. */
export interface ParityRunResult {
  schema: RowSchema;
  task: string;
  family: Family;
  /** Repetition number; a pair is (task, run, mode) across two arms. */
  run: number;
  /**
   * Which try at this (task, run) the row is, when it is not the first: 2 on
   * the one retry an unscored row gets. The LATEST attempt is the row that is
   * paired and scored; an earlier one stays in the file as evidence, is never
   * scored, and is still counted among the arm's attempts. Absent means 1.
   */
  attempt?: number;
  arm: ParityArm;
  mode: ParityMode;
  /** The model the arm was TOLD to run. What it reports having run is `models`. */
  model: string;
  provider?: string;
  /** The reasoning setting the arm was given, where the series named one. */
  reasoningEffort?: string;
  /**
   * Every model the tool reported using, sorted: a sub-agent's, a reviewer's or
   * a fallback's included. Empty when the tool named none. On every
   * `parity-run/2` row.
   */
  models?: string[];
  /** On every `parity-run/2` row. A `parity-run/1` row recorded none. */
  fingerprints?: Fingerprints;
  /** What the tool's own `--version` said. A row without it is not evidence. */
  version: string;
  /** sha256 of the executable measured, when it is a single file. */
  binarySha256?: string;
  /**
   * Fingerprint of the source the tool was run from, when it is not one file:
   * Rune's arm runs its TypeScript, so its rows have no `binarySha256` and every
   * build of one working tree answers the same `--version`. Without this a
   * report could not see that the source had changed between two series.
   */
  sourceBuild?: string;
  /**
   * Every model the arm's configuration names — what it MAY call, sorted, in
   * the names `models` uses. Where a row states one, `models` is held to it
   * rather than to being the same on every row: a configured helper that one
   * run called and another did not is one configuration.
   */
  roster?: string[];

  scored: boolean;
  unscoredReason?: UnscoredReason;

  outcome: Outcome;
  /**
   * How the run ended. On every `parity-run/2` row; a `parity-run/1` row never
   * recorded it and it is not guessed from what that row does hold.
   */
  terminal?: Terminal;
  /**
   * Ended by itself — `completed` or `incomplete` — inside the wall limit, with
   * no false completion. A crash is never clean. (`parity-run/1` asked only
   * that the rig had not stopped it, so a process that died fast was clean.)
   */
  clean: boolean;
  /** The tool reported success while quality < 1. */
  falseCompletion: boolean;
  scope: ScopeScore;
  scopeNotes?: string[];
  /**
   * What the `parity-run/1` rules say of this same run, so the index those
   * rules produce can still be computed beside the current one and the two
   * compared. On every `parity-run/2` row.
   */
  legacy?: { clean: boolean; scope: ScopeScore };

  wallMs: number;
  /** Model calls, counted from the tool's own ledger. Null when it keeps none. */
  calls: number | null;
  /** List-price estimate from Rune's shared pricing table. Not an invoice. */
  listUsd: number | null;
  /** Share of the subscription window used, when the provider reports it. */
  quotaPct?: number | null;

  exitCode: number | null;
  /** "timeout" | "cost limit" | … — why the process was stopped, if it was. */
  stopped?: string;
  startedAt: string;
  completedAt: string;
  /** Directory holding the raw evidence for this run (never published). */
  evidence: string;
}

/**
 * A task any arm can be pointed at.
 *
 * `prepare` seeds a fresh workspace (and installs what the task needs) so the
 * arm starts from identical bytes; `grade` reads only the tree the arm left and
 * never trusts anything the arm said about it.
 */
export interface ParityTask {
  id: string;
  family: Family;
  /** Sent to every arm verbatim. */
  prompt: string;
  size: "small" | "serious";
  /** The task forbids code changes (explain / plan). */
  noCode?: boolean;
  /** Paths the task expects the arm to create (e.g. ANSWER.md, PLAN.md). */
  expectedNewFiles?: string[];
  /**
   * Paths the task's own words put out of bounds ("Do not change money.ts",
   * "window.test.ts must not be edited"): an exact path, or a directory named
   * with a trailing slash. A run that leaves different bytes there is out of
   * scope, on any task. Staging or committing the file as it was is not a
   * change to it.
   */
  protectedPaths?: string[];
  /**
   * A coding task's boundary, where its source states one: the EXISTING paths
   * the work may modify or delete, in the same two spellings. Absent means no
   * boundary was declared and none is enforced. New files are never held to it
   * — a new test or a new module is the work.
   */
  allowedPaths?: string[];
  /**
   * sha256 over what grades this task: its hidden checks and what they are
   * expected to say. Every row it produces carries it (`fingerprints.grader`),
   * so a results file graded by other checks cannot be scored beside this one.
   */
  grader: string;
  prepare(workspace: string): Promise<void>;
  grade(workspace: string, evidenceDir: string): Promise<Outcome>;
}
