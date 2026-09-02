/**
 * Cost and wall-clock budgets for delegated work.
 *
 * `grep costCap|maxCost|deadline` over this repository returned nothing. A
 * sub-agent was bounded by turns and by tokens per turn, which bounds neither
 * of the two things a person actually runs out of: money and an afternoon. A
 * fleet of four thorough workers on a heavy tier could spend an unbounded
 * amount over an unbounded time, and the only signal was the session ledger
 * afterwards.
 *
 * The design keeps two properties that the turn budget already has and that
 * matter more than precision:
 *
 *   1. **A budget never destroys work.** Hitting one ends the sub-agent's loop
 *      and returns what it has, exactly like `max_turns`. It is a stop, not a
 *      failure, and the result says which budget stopped it so the parent can
 *      re-dispatch with more rather than guess.
 *   2. **The default is generous and derived from effort.** A `quick` scout and
 *      a `thorough` worker are different amounts of work, and one number for
 *      both would either strangle the second or fail to bound the first.
 */

export type SubagentEffort = "quick" | "standard" | "thorough";

export interface SubagentBudget {
  /** List-price ceiling for this call's own inference. Null disables the check. */
  costCapUsd: number | null;
  /** Wall-clock ceiling from dispatch. Null disables the check. */
  deadlineMs: number | null;
}

/**
 * Defaults per effort. Deliberately loose: these exist to stop a runaway, not
 * to tune spend. A user who wants a tight budget passes one per call.
 *
 * The wall-clock numbers come from observed runs — a `thorough` worker on a
 * heavy tier routinely takes several minutes and legitimately so — and the cost
 * numbers are set where a single sub-agent overrunning is noticeable but a
 * normal one never touches them.
 */
export const EFFORT_BUDGETS: Record<SubagentEffort, SubagentBudget> = {
  quick: { costCapUsd: 0.5, deadlineMs: 3 * 60_000 },
  standard: { costCapUsd: 2.0, deadlineMs: 10 * 60_000 },
  thorough: { costCapUsd: 6.0, deadlineMs: 25 * 60_000 },
};

export function resolveSubagentBudget(
  effort: SubagentEffort | string | undefined,
  overrides: { costCapUsd?: unknown; deadlineMs?: unknown } = {},
): SubagentBudget {
  const base =
    EFFORT_BUDGETS[(effort as SubagentEffort) in EFFORT_BUDGETS ? (effort as SubagentEffort) : "standard"];
  const cost = Number(overrides.costCapUsd);
  const deadline = Number(overrides.deadlineMs);
  return {
    // A caller-supplied 0 disables nothing and means "spend nothing", which is
    // not a useful instruction; treat only a positive finite number as a cap.
    costCapUsd: Number.isFinite(cost) && cost > 0 ? cost : base.costCapUsd,
    deadlineMs: Number.isFinite(deadline) && deadline > 0 ? deadline : base.deadlineMs,
  };
}

export interface BudgetState {
  spentUsd: number;
  startedAt: number;
}

export type BudgetBreach = { kind: "cost"; spentUsd: number; capUsd: number } | { kind: "time"; elapsedMs: number; deadlineMs: number };

/**
 * Has this sub-agent run past a budget? Checked between turns, never mid-call:
 * aborting a request already in flight pays for it anyway and loses the reply.
 */
export function checkBudget(budget: SubagentBudget, state: BudgetState): BudgetBreach | null {
  if (budget.costCapUsd !== null && state.spentUsd > budget.costCapUsd) {
    return { kind: "cost", spentUsd: state.spentUsd, capUsd: budget.costCapUsd };
  }
  if (budget.deadlineMs !== null) {
    const elapsed = Date.now() - state.startedAt;
    if (elapsed > budget.deadlineMs) {
      return { kind: "time", elapsedMs: elapsed, deadlineMs: budget.deadlineMs };
    }
  }
  return null;
}

/** What the parent is told. Names the budget and the number, so "more" is actionable. */
export function describeBreach(breach: BudgetBreach): string {
  return breach.kind === "cost"
    ? `stopped at its cost budget ($${breach.spentUsd.toFixed(2)} of $${breach.capUsd.toFixed(2)}) — ` +
        `re-dispatch a narrower task, or raise costCapUsd on the call`
    : `stopped at its time budget (${Math.round(breach.elapsedMs / 1000)}s of ` +
        `${Math.round(breach.deadlineMs / 1000)}s) — re-dispatch a narrower task, or raise deadlineMs on the call`;
}

/**
 * How many sub-agents may run at once.
 *
 * `maxParallelTools` was a hard 8 in agent-loop.ts with no config key, which is
 * a reasonable default and an unreasonable ceiling: eight concurrent heavy
 * workers is a lot of money at once, and on a small machine eight worktrees is
 * a lot of disk. Clamped to 1–16 because zero means "no delegation at all",
 * which is what `[subagents] mode = "off"` is for.
 */
export function resolveMaxParallel(configured: unknown, fallback = 8): number {
  const n = Number(configured);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(16, Math.max(1, Math.floor(n)));
}
