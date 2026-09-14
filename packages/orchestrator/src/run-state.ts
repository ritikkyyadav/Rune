/**
 * `RunState` — the typed snapshot a run's decisions could be made FROM.
 *
 * Today every counter named here is a local inside `agent-loop.ts`'s `run()`
 * or a private field on the Engine, and every one of them is lost on process
 * death. The guard inventory (`docs/program/guard-inventory-20260914.md` §4.2)
 * listed them; this file gives them one shape and one version number so a
 * decision function can read them instead of reading the loop.
 *
 * Three rules hold everywhere in this file, and they are the whole point:
 *
 *   1. **It is a READ.** Nothing here is authoritative state. Building a
 *      snapshot cannot move a counter, allocate a budget, or write a row. The
 *      loop keeps every counter it has always kept; this is a copy of the ones
 *      that were legible at the site that took it.
 *   2. **Absent is `undefined`, never invented.** A site that cannot see
 *      `spentUsd` leaves it `undefined`, and the arbiter answers `unknown`
 *      rather than agreeing by accident (M2 exit S5). A zero would be a claim.
 *   3. **It is versioned.** `version: 1` travels with every snapshot, because
 *      the first thing a persisted controller state needs is the ability to
 *      say which shape it is.
 *
 * M2 does not persist this as task state (`docs/program/m2-shadow-controller.md`,
 * non-goals). It exists to be passed to `decide()` and thrown away.
 */

/** The phases a run can be in. `blocked`/`complete`/`abandoned` are terminal shapes. */
export type RunPhase =
  | "intake"
  | "contracted"
  | "working"
  | "verifying"
  | "repairing"
  | "blocked"
  | "complete"
  | "abandoned";

/** Terminal phases — see the absorbing-terminal rule in `arbiter.ts`. */
export const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(["complete", "abandoned"]);

/** A gate's ledger: how many times it fired this run, and how many it may. */
export interface GateCounter {
  readonly fired: number | undefined;
  readonly cap: number | undefined;
}

export interface RunBudgetState {
  readonly turn: number | undefined;
  readonly maxTurns: number | undefined;
  readonly baseMaxTurns: number | undefined;
  readonly refundsGranted: number | undefined;
  readonly refundCap: number | undefined;
  readonly windsUsed: number | undefined;
  readonly maxSecondWinds: number | undefined;
  readonly wrapUpInjected: boolean | undefined;
  readonly quotaWallSighted: boolean | undefined;
  /**
   * List-price spend so far, rehydrated from cost rows by the Engine.
   *
   * `undefined` in every loop that has no cost accessor wired (sub-agents,
   * unit tests driving the loop directly) — and `undefined` is the honest
   * answer there, not 0.
   */
  readonly spentUsd: number | undefined;
}

export interface RunEvidenceState {
  readonly writeCount: number | undefined;
  readonly anyWritesThisRun: boolean | undefined;
  readonly executedSinceWrite: boolean | undefined;
  readonly projectChecksPassed: boolean | undefined;
  readonly planSettled: boolean | undefined;
  readonly openSteps: number | undefined;
  readonly totalSteps: number | undefined;
  readonly delegatedScopes: number | undefined;
  readonly unreadScopes: number | undefined;
  readonly criteriaTotal: number | undefined;
  readonly criteriaVerified: number | undefined;
}

export interface RunHealthState {
  readonly consecutiveErrors: number | undefined;
  readonly emptyCompletions: number | undefined;
  readonly verifyAttempts: number | undefined;
  readonly rateWaits: number | undefined;
  readonly overflowCompactions: number | undefined;
  readonly misencodedCalls: number | undefined;
  readonly truncationRetries: number | undefined;
}

export interface RunProgressState {
  readonly staleTurns: number | undefined;
  readonly barrenTurns: number | undefined;
  readonly toolCallsThisRun: number | undefined;
}

export interface RunSafetyState {
  /** Whether a halt is latched. The REASON is deliberately not carried: it is
   *  broker prose, and no shadow row may carry prose (M2, "no row carries
   *  message text"). */
  readonly halted: boolean | undefined;
  readonly haltReportPending: boolean | undefined;
  readonly haltReportGranted: boolean | undefined;
  readonly aborted: boolean | undefined;
}

export interface RunState {
  readonly version: 1;
  readonly runId: string;
  readonly phase: RunPhase;
  readonly budget: RunBudgetState;
  readonly evidence: RunEvidenceState;
  readonly gates: Readonly<Record<string, GateCounter>>;
  readonly health: RunHealthState;
  readonly progress: RunProgressState;
  readonly safety: RunSafetyState;
}

export const RUN_STATE_VERSION = 1 as const;

const UNKNOWN_BUDGET: RunBudgetState = {
  turn: undefined,
  maxTurns: undefined,
  baseMaxTurns: undefined,
  refundsGranted: undefined,
  refundCap: undefined,
  windsUsed: undefined,
  maxSecondWinds: undefined,
  wrapUpInjected: undefined,
  quotaWallSighted: undefined,
  spentUsd: undefined,
};

const UNKNOWN_EVIDENCE: RunEvidenceState = {
  writeCount: undefined,
  anyWritesThisRun: undefined,
  executedSinceWrite: undefined,
  projectChecksPassed: undefined,
  planSettled: undefined,
  openSteps: undefined,
  totalSteps: undefined,
  delegatedScopes: undefined,
  unreadScopes: undefined,
  criteriaTotal: undefined,
  criteriaVerified: undefined,
};

const UNKNOWN_HEALTH: RunHealthState = {
  consecutiveErrors: undefined,
  emptyCompletions: undefined,
  verifyAttempts: undefined,
  rateWaits: undefined,
  overflowCompactions: undefined,
  misencodedCalls: undefined,
  truncationRetries: undefined,
};

const UNKNOWN_PROGRESS: RunProgressState = {
  staleTurns: undefined,
  barrenTurns: undefined,
  toolCallsThisRun: undefined,
};

const UNKNOWN_SAFETY: RunSafetyState = {
  halted: undefined,
  haltReportPending: undefined,
  haltReportGranted: undefined,
  aborted: undefined,
};

/**
 * A snapshot that knows nothing but its run id and phase.
 *
 * The base every caller builds on, so a field nobody set is `undefined` by
 * construction rather than by remembering to write `undefined`.
 */
export function emptyRunState(runId: string, phase: RunPhase = "working"): RunState {
  return {
    version: RUN_STATE_VERSION,
    runId,
    phase,
    budget: UNKNOWN_BUDGET,
    evidence: UNKNOWN_EVIDENCE,
    gates: {},
    health: UNKNOWN_HEALTH,
    progress: UNKNOWN_PROGRESS,
    safety: UNKNOWN_SAFETY,
  };
}

/** Section-wise merge, so a caller supplies only the fields it can actually see. */
export function makeRunState(
  runId: string,
  phase: RunPhase,
  parts: {
    budget?: Partial<RunBudgetState>;
    evidence?: Partial<RunEvidenceState>;
    gates?: Record<string, GateCounter>;
    health?: Partial<RunHealthState>;
    progress?: Partial<RunProgressState>;
    safety?: Partial<RunSafetyState>;
  } = {},
): RunState {
  return {
    version: RUN_STATE_VERSION,
    runId,
    phase,
    budget: { ...UNKNOWN_BUDGET, ...parts.budget },
    evidence: { ...UNKNOWN_EVIDENCE, ...parts.evidence },
    gates: { ...(parts.gates ?? {}) },
    health: { ...UNKNOWN_HEALTH, ...parts.health },
    progress: { ...UNKNOWN_PROGRESS, ...parts.progress },
    safety: { ...UNKNOWN_SAFETY, ...parts.safety },
  };
}

/** The same snapshot with a different phase — used by the shadow arbiter to
 *  carry its OWN terminal decision forward without touching the run. */
export function withPhase(state: RunState, phase: RunPhase): RunState {
  return { ...state, phase };
}

/**
 * `spentUsd`, rehydrated from the run's cost rows.
 *
 * The persistence definition M2 records (and M3 will enforce): spend is the
 * SUM OF COST ROWS and nothing else. A turn refund moves `maxTurns`; it can
 * never move this, because no cost row is deleted when a turn is given back.
 * List price is the axis, because it is the one a subscription run also has.
 */
export function spentUsdFromCostRows(
  rows: ReadonlyArray<{ listCostUsd?: unknown; costUsd?: unknown }>,
): number {
  let total = 0;
  for (const row of rows) {
    const list = Number(row.listCostUsd);
    if (Number.isFinite(list) && list >= 0) {
      total += list;
      continue;
    }
    const paid = Number(row.costUsd);
    if (Number.isFinite(paid) && paid >= 0) total += paid;
  }
  return total;
}
