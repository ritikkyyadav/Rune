// ─── The resume plan: a run that stopped at a provider wall comes back ───
//
// M6, the minimal slice (docs/program/guarantees-plan-review-20260914.md; the
// founder chose it on 2026-09-27 after long runs died on quota at least three
// times). The TUI already had an auto-resume, but it lived in one process's
// memory — a closed terminal or a sleeping laptop ended it, it had no deadline
// and no budget across resumes, and a headless run had none at all.
//
// A plan is opt-in: nothing here resumes a session nobody scheduled. It is
// pure — every function takes `now` — so a 48-hour night runs in a test in
// milliseconds. That proves the transitions, not overnight reliability.
//
// The four quantities are kept apart, because each is a different promise:
//
//   deadline   absolute wall clock, fixed when the plan is made. Sleep counts
//              against it; nothing extends it.
//   spent      the session's cumulative list cost. Only ever grows — waiting
//              refunds nothing.
//   waited     wall time between a stop and the resume that followed it,
//              host sleep included.
//   active     wall time spent running.
//
// Where the wait comes from: the gateway already derives a provider's window
// from `Retry-After` (or its own default for a plan cap) and persists it. When
// that window is known and still ahead, the plan waits for it; otherwise it
// backs off exponentially, bounded. A window that opens after the deadline is
// not waited for at all.

/** Never re-knock sooner than this, whatever a hint says. */
export const RESUME_MIN_WAIT_MS = 60_000;
/** The first backoff step when the provider gave no window. */
export const RESUME_BACKOFF_BASE_MS = 5 * 60_000;
/** The longest single backoff step. */
export const RESUME_BACKOFF_CAP_MS = 4 * 60 * 60_000;
/** Resumes a plan may start unless it says otherwise. */
export const RESUME_DEFAULT_MAX_ATTEMPTS = 12;

export interface ResumePolicy {
  /** Absolute wall-clock deadline, ms since the epoch. */
  deadlineAt: number;
  /** Cumulative list-cost cap for the whole mission, USD. Null = no cap. */
  budgetUsd: number | null;
  /** Resumes allowed after the first run. */
  maxAttempts: number;
}

export type ResumeStatus =
  /** A run is in progress. */
  | "active"
  /** Stopped at a provider wall; due at `nextAt`. */
  | "waiting"
  /** The task finished. */
  | "done"
  /** The run ended on its own terms (a cap, a halt, a cancel, a failure) — not a wall. */
  | "stopped"
  /** The deadline passed, or the provider's window opens after it. */
  | "expired"
  /** The budget or the resume allowance is used up. */
  | "exhausted"
  /** Something a person must fix first: credentials, permissions. */
  | "blocked"
  /** A person cancelled it. */
  | "cancelled";

export const TERMINAL_RESUME_STATUSES: ReadonlySet<ResumeStatus> = new Set<ResumeStatus>([
  "done",
  "stopped",
  "expired",
  "exhausted",
  "blocked",
  "cancelled",
]);

export interface ResumePlan {
  v: 1;
  sessionId: string;
  policy: ResumePolicy;
  createdAt: number;
  status: ResumeStatus;
  /** Resumes started so far. The first run is not a resume. */
  attempts: number;
  /** When a waiting plan becomes due. */
  nextAt: number | null;
  /** Where `nextAt` came from. */
  hint: "provider-window" | "backoff" | null;
  /** When the last run stopped: the start of the current wait. */
  stoppedAt: number | null;
  /** The session's cumulative list cost at the last stop. Monotonic. */
  spentUsd: number;
  waitedMs: number;
  activeMs: number;
  /** Why the plan reached a terminal status, in the user's words. */
  reason?: string;
}

/** How one run ended, as the plan needs to know it. */
export type RunEnding =
  | { kind: "finished" }
  /** A quota cap or a lost provider. `providerUntil` is the known window, if any. */
  | { kind: "wall"; providerUntil: number | null }
  /** The run's own ending — not something waiting fixes. */
  | { kind: "stopped"; stopReason: string }
  /** Waiting cannot fix it either, but a person can. */
  | { kind: "blocked"; why: string };

export function startPlan(sessionId: string, policy: ResumePolicy, now: number): ResumePlan {
  return {
    v: 1,
    sessionId,
    policy,
    createdAt: now,
    status: "active",
    attempts: 0,
    nextAt: null,
    hint: null,
    stoppedAt: null,
    spentUsd: 0,
    waitedMs: 0,
    activeMs: 0,
  };
}

/** Backoff for the n-th resume (1-based) when the provider gave no window: ×3, bounded. */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RESUME_BACKOFF_BASE_MS * 3 ** (n - 1), RESUME_BACKOFF_CAP_MS);
}

/**
 * The plan after a run ends. `run.spentUsd` is the session's cumulative list
 * cost now; `run.activeMs` is how long this run took.
 */
export function afterRun(
  plan: ResumePlan,
  ending: RunEnding,
  run: { spentUsd: number; activeMs: number },
  now: number,
): ResumePlan {
  const next: ResumePlan = {
    ...plan,
    spentUsd: Math.max(plan.spentUsd, Number.isFinite(run.spentUsd) ? run.spentUsd : 0),
    activeMs: plan.activeMs + Math.max(0, run.activeMs),
    nextAt: null,
    hint: null,
    stoppedAt: now,
  };
  if (TERMINAL_RESUME_STATUSES.has(plan.status)) return plan;

  switch (ending.kind) {
    case "finished":
      return { ...next, status: "done", reason: "the task finished" };
    case "stopped":
      return {
        ...next,
        status: "stopped",
        reason: `the run ended on its own terms (${ending.stopReason}); waiting would not change that`,
      };
    case "blocked":
      return { ...next, status: "blocked", reason: ending.why };
    case "wall":
      break;
  }

  // The allowance first: a spent budget or a used-up resume count stops the
  // plan even when the provider is ready again.
  const { budgetUsd, maxAttempts, deadlineAt } = plan.policy;
  if (budgetUsd !== null && next.spentUsd >= budgetUsd) {
    return {
      ...next,
      status: "exhausted",
      reason: `the mission's budget is spent ($${next.spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)})`,
    };
  }
  if (plan.attempts >= maxAttempts) {
    return {
      ...next,
      status: "exhausted",
      reason: `all ${maxAttempts} resumes are used`,
    };
  }

  // Then the wait: the provider's own window when it is known and still
  // ahead, otherwise bounded backoff — and never sooner than the floor.
  const window = ending.providerUntil;
  const fromWindow = window !== null && window > now;
  const nextAt = Math.max(
    fromWindow ? window : now + backoffMs(plan.attempts + 1),
    now + RESUME_MIN_WAIT_MS,
  );
  if (nextAt > deadlineAt) {
    return {
      ...next,
      status: "expired",
      reason: "the provider's window opens after the deadline",
    };
  }
  return { ...next, status: "waiting", nextAt, hint: fromWindow ? "provider-window" : "backoff" };
}

/**
 * Claim a waiting plan whose time has come. Returns the plan to persist, and
 * whether the caller should start a resume now.
 */
export function claimIfDue(plan: ResumePlan, now: number): { plan: ResumePlan; claimed: boolean } {
  if (plan.status !== "waiting" || plan.nextAt === null) return { plan, claimed: false };
  if (now >= plan.policy.deadlineAt) {
    return {
      plan: {
        ...plan,
        status: "expired",
        nextAt: null,
        waitedMs: plan.waitedMs + (plan.stoppedAt === null ? 0 : now - plan.stoppedAt),
        reason: "the deadline passed while waiting for the provider",
      },
      claimed: false,
    };
  }
  if (now < plan.nextAt) return { plan, claimed: false };
  return {
    plan: {
      ...plan,
      status: "active",
      attempts: plan.attempts + 1,
      nextAt: null,
      waitedMs: plan.waitedMs + (plan.stoppedAt === null ? 0 : now - plan.stoppedAt),
    },
    claimed: true,
  };
}

/** A person's "stop": terminal, and recorded as theirs. */
export function cancelPlan(plan: ResumePlan): ResumePlan {
  if (TERMINAL_RESUME_STATUSES.has(plan.status)) return plan;
  return { ...plan, status: "cancelled", nextAt: null, reason: "cancelled by a person" };
}
