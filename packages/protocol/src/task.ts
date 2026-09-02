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
  /** The most recent verification-shaped command during this step. */
  lastCheck?: { passed: boolean; command?: string; summary?: string };
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
