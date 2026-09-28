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

export const SCHEMA = "parity-run/1" as const;

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

/** One arm's run of one task instance — one line of `results.jsonl`. */
export interface ParityRunResult {
  schema: typeof SCHEMA;
  task: string;
  family: Family;
  /** Repetition number; a pair is (task, run, mode) across two arms. */
  run: number;
  arm: ParityArm;
  mode: ParityMode;
  model: string;
  provider?: string;
  /** What the tool's own `--version` said. A row without it is not evidence. */
  version: string;
  /** sha256 of the executable measured, when it is a single file. */
  binarySha256?: string;

  scored: boolean;
  unscoredReason?: UnscoredReason;

  outcome: Outcome;
  /** Ended by itself, inside the wall limit, with no false completion. */
  clean: boolean;
  /** The tool reported success while quality < 1. */
  falseCompletion: boolean;
  scope: ScopeScore;
  scopeNotes?: string[];

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
  prepare(workspace: string): Promise<void>;
  grade(workspace: string, evidenceDir: string): Promise<Outcome>;
}
