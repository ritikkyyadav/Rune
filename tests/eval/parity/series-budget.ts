// ─── What a series may use, decided before the first pair ───
//
// A paired series spends two things nobody can take back: the founder's
// subscription windows and an evening. Before this file the only bound on
// either was a gate that could not act until a pair had already run — "the
// first pair always starts" — and a quota check that read one arm's meter and
// had nothing to say about the other account at all. A series started with
// Rune's window 99% used, authorised to stop at 90%, ran its first pair
// (review of 2026-09-30).
//
// So the bound is now stated up front and checked before EVERY arm run, the
// first included:
//
//   limits      at most this many pairs, this many arm runs, this much wall
//               time. Counted by the rig, so they hold whatever a tool reports.
//               These are the only hard stops there are.
//   accounts    for each arm: what its window read before the series, and the
//               share at which to stop. Enforced wherever the figure is known.
//   dollars     RUNE_EVAL_BUDGET_USD, as before — and labelled for what it is:
//               a stop that is evaluated on an ESTIMATE of the next pair.
//
// What cannot be watched is said, not assumed. Only Rune's rows report a
// window meter; a comparator's account cannot be read while the series runs.
// A series with an account it cannot watch needs the operator's explicit
// `bounded` — "the run count and the clock are the bound, and I know it" —
// and every line it prints says which figure is a cap and which is not.
//
// Pure: no clock, no disk, no process. The runner supplies the state.

import type { ParityArm } from "./types";

/** One arm's account: what was read of its window, and where to stop. */
export interface AccountBudget {
  /** The share of the window already used, as the operator read it before the series. Null: not read. */
  usedPct: number | null;
  /** Stop before any run of this arm once its window is this full. Null: no reserve was set. */
  stopAtPct: number | null;
}

/** The hard stops: counted by the rig, checked before every run. */
export interface SeriesLimits {
  maxPairs: number;
  /** Arm runs, every one: a re-run after a missing row and a retry of an unscored arm included. */
  maxAttempts: number;
  wallAllowanceMs: number;
}

export interface SeriesBudget {
  /** RUNE_EVAL_BUDGET_USD. An estimate-gated stop, never a spend cap (`budgetLines`). */
  budgetUsd: number | null;
  accounts: Partial<Record<ParityArm, AccountBudget>>;
  limits: SeriesLimits;
  /**
   * The operator accepted that something cannot be watched — an account's
   * window, or what a run cost — and that the limits are then the only bound.
   */
  bounded: boolean;
}

/**
 * The arms whose rows report the share of their window used. Today that is
 * Rune alone, and only when its provider sends a meter (rune.ts); no
 * comparator reports one.
 */
export const METERED_ARMS: ReadonlySet<ParityArm> = new Set<ParityArm>(["rune"]);

/** What the gates know when a run is about to start. */
export interface BudgetState {
  pairsStarted: number;
  attempts: number;
  elapsedMs: number;
  /** The sum of every charge that could be counted. */
  spentUsd: number;
  /** Some run's charge could not be counted. */
  unknownCharge: boolean;
  /** The most any one pair has cost so far: the estimate for the next one. */
  costliestPairUsd: number;
  /** The last share each arm's own rows reported. Absent or null: none yet. */
  reported: Partial<Record<ParityArm, number | null>>;
}

export const NEW_BUDGET_STATE = (): BudgetState => ({
  pairsStarted: 0,
  attempts: 0,
  elapsedMs: 0,
  spentUsd: 0,
  unknownCharge: false,
  costliestPairUsd: 0,
  reported: {},
});

const armLabel = (arm: ParityArm): string => (arm === "rune" ? "Rune" : arm);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const isPct = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/** What is known of an arm's window now, and where the figure came from. */
export function readingOf(
  budget: SeriesBudget,
  state: Pick<BudgetState, "reported">,
  arm: ParityArm,
): { pct: number; source: "reported" | "preflight" } | null {
  const reported = state.reported[arm];
  if (typeof reported === "number") return { pct: reported, source: "reported" };
  const read = budget.accounts[arm]?.usedPct;
  return typeof read === "number" ? { pct: read, source: "preflight" } : null;
}

/** Why an arm's account cannot be held to a percentage. Empty: it can. */
export function unwatched(budget: SeriesBudget, arm: ParityArm): string[] {
  const account = budget.accounts[arm];
  const why: string[] = [];
  if (account?.stopAtPct == null) why.push("no reserve was set for its account");
  if (account?.usedPct == null) why.push("its window was not read before the series");
  if (!METERED_ARMS.has(arm)) why.push("its window cannot be read while the series runs");
  return why;
}

/**
 * Why a live series may not start as configured. Empty: it may. Pure.
 *
 * Refused here, before anything is prepared or probed: limits that are not
 * limits, a plan larger than its own pair limit (never silently cut short),
 * and an account nobody can watch without the operator having said so.
 */
export function budgetProblems(
  budget: SeriesBudget,
  arms: readonly [ParityArm, ParityArm],
  plannedPairs: number,
): string[] {
  const problems: string[] = [];
  const { maxPairs, maxAttempts, wallAllowanceMs } = budget.limits;
  if (!Number.isInteger(maxPairs) || maxPairs < 1)
    problems.push(`--max-pairs must be a whole number of at least 1, not ${maxPairs}`);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 2)
    problems.push(
      `--max-attempts must be a whole number of at least 2 (one pair is two arm runs), not ${maxAttempts}`,
    );
  if (!Number.isFinite(wallAllowanceMs) || wallAllowanceMs <= 0)
    problems.push(`--wall-allowance-min must be a positive number of minutes`);
  if (Number.isInteger(maxPairs) && plannedPairs > maxPairs)
    problems.push(
      `the plan is ${plannedPairs} pair(s) and --max-pairs allows ${maxPairs}: raise it or select fewer tasks — a series is never cut short silently`,
    );
  for (const arm of arms) {
    const account = budget.accounts[arm];
    for (const [name, value] of [
      ["used", account?.usedPct],
      ["stop-at", account?.stopAtPct],
    ] as const)
      if (value != null && !isPct(value))
        problems.push(`${arm}: its ${name} share must be a number from 0 to 100, not ${value}`);
  }
  if (!budget.bounded) {
    const blind = arms
      .map((arm) => ({ arm, why: unwatched(budget, arm) }))
      .filter((entry) => entry.why.length > 0);
    if (blind.length > 0)
      problems.push(
        ...blind.map(({ arm, why }) => `${armLabel(arm)}: ${why.join("; ")}`),
        "an account that cannot be watched needs --bounded: the run count and the wall allowance are then the only bound, and the record says so",
      );
  }
  return problems;
}

/**
 * Whether one more run of `arm` may start. A reason to stop, or undefined.
 * Pure.
 *
 * Asked before every arm run — the first of the series, the second of a pair,
 * a re-run, a retry. `wallLimitMs` is what this run may take: the series does
 * not start a run it could not finish inside its allowance.
 */
export function gateBeforeArm(
  budget: SeriesBudget,
  state: BudgetState,
  arm: ParityArm,
  wallLimitMs: number,
): string | undefined {
  const { maxAttempts, wallAllowanceMs } = budget.limits;
  if (state.attempts >= maxAttempts)
    return `Series stopped: ${state.attempts} of ${maxAttempts} allowed arm run(s) used.`;
  if (state.elapsedMs + wallLimitMs > wallAllowanceMs)
    return `Series stopped: the next run may take up to ${minutes(wallLimitMs)} and ${minutes(Math.max(0, wallAllowanceMs - state.elapsedMs))} of the ${minutes(wallAllowanceMs)} allowance are left.`;
  const stopAt = budget.accounts[arm]?.stopAtPct;
  const reading = readingOf(budget, state, arm);
  if (stopAt != null && reading && reading.pct >= stopAt)
    return `Series stopped: ${armLabel(arm)}'s window is ${reading.pct}% used (${reading.source === "reported" ? "its last row's meter" : "the operator's reading before the series"}), at or past its stop at ${stopAt}%.`;
  return undefined;
}

/**
 * Whether the next pair may start. A reason to stop, or undefined. Pure.
 *
 * A pair is started only when BOTH of its runs may start, and could both
 * finish: half a pair is a row nothing can be compared with. The first pair
 * is asked like any other.
 */
export function gateBeforePair(
  budget: SeriesBudget,
  state: BudgetState,
  order: readonly [ParityArm, ParityArm],
  wallLimitMs: number,
): string | undefined {
  const { maxPairs, maxAttempts, wallAllowanceMs } = budget.limits;
  if (state.pairsStarted >= maxPairs)
    return `Series stopped: ${state.pairsStarted} of ${maxPairs} allowed pair(s) started.`;
  if (state.attempts + 2 > maxAttempts)
    return `Series stopped: ${Math.max(0, maxAttempts - state.attempts)} of ${maxAttempts} allowed arm run(s) left, and a pair needs two.`;
  if (state.elapsedMs + 2 * wallLimitMs > wallAllowanceMs)
    return `Series stopped: the next pair may take up to ${minutes(2 * wallLimitMs)} and ${minutes(Math.max(0, wallAllowanceMs - state.elapsedMs))} of the ${minutes(wallAllowanceMs)} allowance are left.`;
  if (budget.budgetUsd !== null) {
    if (state.unknownCharge) {
      if (!budget.bounded)
        return `Series stopped: a run reported no cost, so spend against RUNE_EVAL_BUDGET_USD $${budget.budgetUsd} can no longer be counted.`;
    } else if (state.spentUsd + state.costliestPairUsd > budget.budgetUsd)
      return `Series stopped: $${state.spentUsd.toFixed(4)} spent, and the next pair is estimated at up to $${state.costliestPairUsd.toFixed(4)} (the costliest so far), past the authorised $${budget.budgetUsd}.`;
  }
  for (const arm of order) {
    const stop = gateBeforeArm(budget, state, arm, wallLimitMs);
    if (stop) return stop;
  }
  return undefined;
}

/**
 * What bounds the series and what does not, in words that cannot be read as
 * more than they are. Printed with the plan and kept in the record. Pure.
 */
export function budgetLines(
  budget: SeriesBudget,
  arms: readonly [ParityArm, ParityArm],
  needs: { pairs: number; armRuns: number; worstCaseWallMs: number },
): string[] {
  const { maxPairs, maxAttempts, wallAllowanceMs } = budget.limits;
  const lines = [
    `hard stops, counted by the rig and checked before every arm run: at most ${maxPairs} pair(s), ${maxAttempts} arm run(s), ${minutes(wallAllowanceMs)} of wall time`,
    `the plan needs ${needs.pairs} pair(s), ${needs.armRuns} arm run(s) before any retry, and up to ${minutes(needs.worstCaseWallMs)} if every run uses its whole wall limit`,
  ];
  if (needs.armRuns > maxAttempts || needs.worstCaseWallMs > wallAllowanceMs)
    lines.push(
      "these limits are smaller than the plan: the series will stop when it reaches them, and say which pairs it did not run",
    );
  lines.push(
    budget.budgetUsd === null
      ? "dollars: no dollar figure was authorised, and nothing here bounds spend in dollars"
      : `dollars: $${budget.budgetUsd} is an estimate-gated stop, NOT a spend cap — a pair's cost is known only after it ran, so the series stops when what was spent plus the costliest pair so far would pass it, the first pair starts with nothing known, and the total can pass $${budget.budgetUsd} by up to one pair`,
  );
  for (const arm of arms) {
    const account = budget.accounts[arm];
    const read =
      account?.usedPct == null
        ? "window not read"
        : `${account.usedPct}% of its window used (the operator's reading)`;
    const reserve = account?.stopAtPct == null ? "no reserve set" : `stop at ${account.stopAtPct}%`;
    const watch = METERED_ARMS.has(arm)
      ? account?.stopAtPct == null
        ? "its rows report a meter, and with no reserve set nothing reads it"
        : account.usedPct == null
          ? "its rows report a meter when its provider sends one: the stop is checked from its first row on, and NOT before its first run, which starts unread"
          : "its rows report a meter when its provider sends one, so the stop is checked before each of its runs"
      : account?.stopAtPct != null && account.usedPct != null
        ? `NO METER: checked once, against the reading above, and not a cap after that — its window cannot be read while the series runs`
        : "NO METER: nothing about this account is watched";
    lines.push(`${armLabel(arm)}: ${read} · ${reserve} · ${watch}`);
  }
  const blind = arms.filter((arm) => unwatched(budget, arm).length > 0);
  if (blind.length > 0)
    lines.push(
      budget.bounded
        ? `bounded mode, accepted by the operator: for ${blind.map(armLabel).join(" and ")} the run count and the wall allowance are the only bound; no percentage of a window is a cap`
        : `NOT RUNNABLE LIVE as configured: ${blind.map(armLabel).join(" and ")} cannot be held to a percentage, and --bounded was not given`,
    );
  return lines;
}
