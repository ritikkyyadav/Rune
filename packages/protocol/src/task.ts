// ─── Task-spine wire shapes ───
//
// Canonical here, re-exported by `packages/orchestrator/src/task-state.ts`.
// `todo_updated` and `handoff` carry these across the wire, so a client that
// draws the plan ledger is reading these exact fields.

export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * What the RUNTIME observed while a step was in progress. Every field is a
 * count of something a tool actually did — never model prose — which is what
 * lets a "completed" mark mean something. Zero across the board is the
 * signature of a step that was declared rather than done.
 */
export interface StepEvidence {
  /** Files/listings/searches read. */
  reads: number;
  /** Files written or edited (worker output counts). */
  writes: number;
  /** Non-trivial commands executed, pass or fail. */
  runs: number;
  /** Verification-shaped commands (tests, typecheck, lint, build) that passed. */
  checksPassed: number;
  /** …and that failed. */
  checksFailed: number;
  /** ask_user rounds answered. */
  answers: number;
  /** Sub-agents dispatched. */
  delegations: number;
  /** Times the agent actually LOOKED at something (browser drive, image seen). */
  looks: number;
  /**
   * Writes since the last check. A failed check followed by more edits is a
   * fix in progress, not a failed step — the step check runs again instead.
   */
  writesSinceCheck: number;
  /**
   * The most recent verification-shaped command during this step. `exitCode`
   * and `durationMs` are present for checks the HARNESS ran (it reads both
   * directly) and absent for checks the model ran through `bash`, where the
   * tool result carries a success flag and no code. Absent means "no data",
   * never zero.
   */
  lastCheck?: {
    passed: boolean;
    command?: string;
    summary?: string;
    exitCode?: number;
    durationMs?: number;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Harness-measured evidence; absent on items that never went in progress. */
  evidence?: StepEvidence;
  /**
   * Completed without proof: either nothing ran while the step was open
   * ("no_evidence"), or the last check during it FAILED ("check_failed"). Set
   * only when the model re-submitted a completion the harness had refused
   * once — the mark is what the user sees instead of a clean tick.
   */
  unproven?: "no_evidence" | "check_failed";
  /**
   * Who is doing this step. Absent means the lead, which is every item written
   * before the ledger became multi-writer.
   *
   * The ledger belonged to the lead alone: `taskState` was passed to the lead's
   * loop and to nothing else, so a fleet of four workers building four slices
   * of one feature appeared in the plan as one in-progress item with no way to
   * say which worker held it. An owner is what turns a plan into a queue.
   */
  owner?: string;
  /** When the owner claimed it. Used to reclaim a step whose owner died. */
  claimedAt?: string;
}

// ─── The narrative: how a decision was reached (P11.1) ───
//
// The plan ledger says WHAT was done and on what evidence. It cannot say why
// one approach was taken and two others abandoned — and that is the half a
// person reads when they want to trust the answer. These shapes carry it:
// hypotheses with their verdicts and reasons, decisions bound to the evidence
// that justified them, the artifacts the run produced, and the decisions still
// waiting on a human.
//
// Everything here is recorded by the harness or by two small tools whose
// arguments the harness validates. Nothing on this side of the wire is model
// prose presented as fact: a hypothesis carries the model's sentence, but its
// STATUS comes from a check the runtime ran.

/**
 * What shape of work this task is. Set once per task by the Intent Interpreter
 * at task start and revisable once by the model, because a surface composed
 * for an investigation is the wrong surface for a build.
 */
export type TaskKind = "investigate" | "build" | "analyze" | "research" | "operate" | "write";

/** Every member of `TaskKind`, for validation at a boundary. */
export const TASK_KINDS = [
  "investigate",
  "build",
  "analyze",
  "research",
  "operate",
  "write",
] as const satisfies readonly TaskKind[];

/**
 * A pointer at something the runtime observed, from the evidence a run already
 * records. Deliberately a POINTER and not a copy: the check ledger and the file
 * ledger are the record, and a narrative that copied them could drift from them.
 */
export interface EvidenceRef {
  kind: "check" | "file" | "step" | "artifact" | "answer";
  /** The command, path, step content or artifact id this points at. */
  ref: string;
  /** One quotable line — what came back, clipped. */
  detail?: string;
  /** ISO-8601 of the observation. */
  at?: string;
}

/**
 * How far a hypothesis got. `refuted` and `confirmed` are set by the harness
 * from a check's verdict wherever a plan step was testing one; the model can
 * only move a hypothesis to `testing`, or report the verdict it read.
 */
export type HypothesisStatus = "proposed" | "testing" | "refuted" | "confirmed";

/** One named experiment: what was suspected, what happened to it, and why. */
export interface Hypothesis {
  /** Stable within the task (`h1`, `h2`, …) — what an update refers to. */
  id: string;
  /** The suspicion, in the model's own words. */
  text: string;
  status: HypothesisStatus;
  /** What settled it. Empty while it is only proposed. */
  evidence: EvidenceRef[];
  /** Why it ended where it did — the check's summary for a refutation. */
  reason?: string;
  /** ISO-8601 of the last status change. */
  at: string;
  /** The plan step this hypothesis was being tested by, when one was open. */
  step?: string;
}

/** A commitment the run made, and the evidence it stood on. */
export interface TaskDecision {
  id: string;
  text: string;
  /** What justified it. A decision with an empty list is recorded as unbacked. */
  basedOn: EvidenceRef[];
  at: string;
}

/** What kind of thing a run produced. */
export type ArtifactKind = "file" | "diff" | "report" | "chart" | "table" | "preview";

/** Something the run made that outlives it. */
export interface TaskArtifact {
  id: string;
  kind: ArtifactKind;
  /** A workspace-relative path, a URL, or another locator. */
  ref: string;
  at: string;
}

/** Which round-trip a pending decision came from. */
export type PendingDecisionKind = "held_step" | "question" | "approval" | "review";

/**
 * One decision waiting on a person, from any of the four round-trips. The
 * inbox ("Needs you") reads this list across sessions, which is why the four
 * are unified here rather than left as four shapes in four places.
 */
export interface PendingDecision {
  id: string;
  kind: PendingDecisionKind;
  /** Bounded and secret-scrubbed — the same rule held steps already follow. */
  summary: string;
  createdAt: string;
  /** When it stops waiting, for round-trips that time out. */
  deadline?: string;
  /** Absent while it is still pending. */
  resolution?: { at: string; outcome: string };
}

/**
 * One verification-shaped command, as the runtime observed it.
 *
 * `exitCode` and `durationMs` are present for checks the HARNESS ran (it reads
 * both directly) and absent for checks the model ran through `bash`, where the
 * tool result carries a success flag and no code. Absent means "no data".
 */
export interface CheckRecord {
  at: string;
  command: string;
  passed: boolean;
  /** Who ran it: the harness's own verifier, or the model through `bash`. */
  source: "harness" | "model";
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}

/**
 * The Decision Record: the one artifact a person reads top to bottom.
 *
 * Generated deterministically from the task state — there is no model call in
 * it, and there is nothing in it the run did not record. Every section answers
 * one question: what was asked (objective), what was decided and on what
 * (decision), how the run got there (hypotheses in order, refuted ones kept),
 * what changed (artifacts), what was checked (the evidence ledger), and what
 * is still open (steps and pending decisions).
 */
export interface DecisionRecord {
  /** The session this record belongs to. */
  taskId: string;
  objective: string;
  kind?: TaskKind;
  /** The decision the run committed to: the last one recorded, or null. */
  decision: TaskDecision | null;
  /** Every decision in order — a long task can commit more than once. */
  decisions: TaskDecision[];
  /** Every hypothesis in the order it was raised; refuted ones are kept. */
  hypotheses: Hypothesis[];
  artifacts: TaskArtifact[];
  checks: CheckRecord[];
  remains: {
    /** Plan steps that never closed. */
    openSteps: string[];
    /** Decisions still waiting on a person. */
    pending: PendingDecision[];
  };
  /** Steps closed on evidence over steps. Absent when there is no plan. */
  progress?: number;
  generatedAt: string;
}

/** Why a run ended before its plan was finished. */
export type HandoffReason =
  | "max_turns"
  | "context_exhausted"
  | "aborted"
  | "error"
  /** The safety broker halted the run; the agent reported and stopped. */
  | "halted"
  /** The agent ended its turn with steps still open, after one refusal. */
  | "open_steps"
  /** The run stopped because nothing had changed for many turns. */
  | "stalled"
  /** The provider stopped answering after the retry budget; the work stands where the ledger says. */
  | "provider_lost";
