// ─── Loop reliability policy ───
//
// Every bound that decides "keep recovering vs give up" used to live as a
// magic number at its call site (maxConsecutiveErrors: 3 in the loop config
// default, rateWaits < 2 inline, readThrashCount: 3 in the struggle detector,
// …). Numbers like these are exactly what real-world usage tunes — burying
// them meant no one could adjust them without editing five files, and nobody
// could even SEE the full set. This module is the single place they live:
// defaults preserve today's behavior, model families adjust a few where the
// failure economics differ, and `[reliability]` in config.toml overrides
// everything per-user — so field tuning is an edit, not a rebuild.

export interface ReliabilityPolicy {
  /** Consecutive provider/stream errors before the run fails. */
  maxConsecutiveErrors: number;
  /** Nudges sent to a stuck (silent, tool-less) model before bailing. */
  maxStuckNudges: number;
  /** Bounded all-providers-throttled waits per run (Retry-After honored). */
  maxRateWaits: number;
  /**
   * Seconds a run may go without an answer from its provider before it ends
   * as `provider_lost` — the resumable ending. `maxConsecutiveErrors` bounds
   * how many times a request is re-sent; this bounds how long that may take,
   * which a provider that stalls instead of failing makes very long. 0: off.
   */
  providerDeadlineSecs: number;
  /** Forced compactions after provider over-limit rejections per run. */
  maxOverflowCompactions: number;
  /** Retries of a stream that "succeeded" with no text and no tool calls. */
  maxEmptyCompletionRetries: number;
  /** Retries when the response hit the output-token cap mid-thought. */
  maxTruncationRetries: number;
  /** Verification + re-prompt rounds after failing project checks. */
  maxVerifyAttempts: number;
  /** Same-file reads without an intervening edit → struggle incident. */
  readThrashCount: number;
  /** Edits to the same file in one run → struggle incident. */
  editChurnCount: number;
  /** Plan-discipline nudges per run (multi-file writes with no todo list). */
  maxPlanNudges: number;
  /** Change-approach rounds after verification keeps failing per run. */
  maxReplanNudges: number;
  /** Struggle-signal nudges injected into the live run (edit churn etc.). */
  maxStruggleNudges: number;
  /** Clarify-first nudges when a NEW project starts with zero questions asked. */
  maxGreenfieldNudges: number;
  /**
   * The turn ceiling for a run of real work. 80 agentic rounds: long
   * autonomous builds (scaffold → install → run → fix → verify → polish)
   * legitimately spend 30–50; the cap is a runaway guard, not a work budget.
   * Turns the harness spends on itself are refunded (turn-refunds.ts) and a
   * moving plan earns the ceiling again `secondWinds` times. Conversational
   * turns keep their own small budget (turn-budget.ts).
   *
   * 0: no ceiling. Since 1.4.5 that is what an interactive session runs under
   * unless the person set a number (`turnCeilingOverride`); a headless run
   * keeps 80 unless `--max-turns` says otherwise.
   */
  maxTurns: number;
  /** Second winds granted to a main run of real work; sub-agents get none. */
  secondWinds: number;
  /** See `[reliability] evidenceGate` in config.ts. */
  evidenceGate: "attest" | "refuse";
}

/** Today's shipped behavior, verbatim — the baseline every override starts from. */
export const DEFAULT_RELIABILITY: ReliabilityPolicy = {
  maxConsecutiveErrors: 3,
  maxStuckNudges: 1,
  maxRateWaits: 2,
  // Ten minutes. Long enough for a brown-out the attempt count already rides
  // out; short enough that the sixteen minutes a stalled stream once cost
  // (evolab7: four attempts, each waiting out its own first-byte timeout,
  // three times over) cannot happen again.
  providerDeadlineSecs: 600,
  maxOverflowCompactions: 2,
  maxEmptyCompletionRetries: 3,
  maxTruncationRetries: 2,
  // Three rounds per approach, plus the one bounded replan round below, gives
  // a real fix→test→fix loop up to six checks without opening an infinite run.
  maxVerifyAttempts: 3,
  readThrashCount: 3,
  editChurnCount: 4,
  maxPlanNudges: 1,
  maxReplanNudges: 1,
  maxStruggleNudges: 1,
  maxGreenfieldNudges: 1,
  maxTurns: 80,
  secondWinds: 2,
  evidenceGate: "attest",
};

// Open-weight / budget-tier families fail differently than frontier models:
// their errors skew transient (malformed tool JSON the salvager fixes, empty
// completions, formatting stumbles a nudge cures), so giving up at the
// frontier thresholds abandons runs those models would have finished. One
// extra error and one extra nudge is deliberately conservative — these are
// starting points for field tuning via [reliability], not claims of truth.
const BUDGET_FAMILY = /qwen|glm|deepseek|kimi|llama|mistral|gemma|phi-|starcoder/;

/**
 * Resolve the effective policy: defaults → model-family adjustments →
 * explicit config overrides (highest precedence, applied field-by-field).
 */
export function policyForModel(
  model: string,
  overrides?: Partial<ReliabilityPolicy>,
): ReliabilityPolicy {
  const policy = { ...DEFAULT_RELIABILITY };
  if (BUDGET_FAMILY.test(model.toLowerCase())) {
    policy.maxConsecutiveErrors = 4;
    policy.maxStuckNudges = 2;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key === "evidenceGate") {
      if (value === "attest" || value === "refuse") policy.evidenceGate = value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      (policy as unknown as Record<string, number>)[key] = Math.floor(value);
    }
  }
  return policy;
}

// ─── The turn ceiling belongs to the person (R3.3, decision D7) ───
//
// Five runs between 14 September and 14 October ended at the 80-turn ceiling,
// and evolab7's plan collapsed against it. A ceiling counts turns; it cannot
// tell a run that is stuck from one that is long. What tells them apart — the
// loop detector, the barren-turn breaker, the outage clock, the budget — looks
// at what the turns do, and all of it stays. In an interactive session the
// person is there and Esc ends a run, so the count is theirs to set; a
// headless run has nobody, so it keeps a default.

/**
 * What the loop is handed when there is no ceiling: a bound no run reaches,
 * so its arithmetic (the wrap-up reserve, refunds, second winds) needs no
 * special case.
 */
export const UNBOUNDED_TURNS = 1_000_000;

/** The ceiling the loop runs under: `maxTurns`, or none when it is 0. */
export function loopTurnCeiling(maxTurns: number): number {
  return maxTurns > 0 ? maxTurns : UNBOUNDED_TURNS;
}

/**
 * The `maxTurns` a launch runs under, or undefined to keep the default. A
 * `--max-turns` flag wins; then `[reliability] maxTurns` as the person set it;
 * then the mode decides — none for an interactive session, the default for a
 * headless one.
 */
export function turnCeilingOverride(input: {
  flag?: number;
  configured?: number;
  interactive: boolean;
}): number | undefined {
  if (input.flag !== undefined) return input.flag;
  if (input.configured !== undefined) return input.configured;
  return input.interactive ? 0 : undefined;
}

/**
 * How long a headless run's end-of-turn check may take, per command: five
 * minutes. A headless run's verdict is its output, and on Rune's own source
 * the suite takes about 222 s. Under the 120 s an interactive turn waits it
 * never finished, so `done` never came (the dogfood run of 2026-10-22).
 */
export const HEADLESS_CHECK_TIMEOUT_MS = 300_000;

/**
 * The per-check limit a launch runs under, in ms, or undefined to keep the
 * verifier's own (120 s). `[verify] timeoutSecs` as the person set it wins;
 * then the mode decides. An interactive session keeps 120 s: a person waits
 * at the end of every turn that wrote, and a suite that outlasts it is still
 * stood in for by the test files the change touched.
 */
export function checkTimeoutOverride(input: {
  configuredSecs?: unknown;
  interactive: boolean;
}): number | undefined {
  const secs = input.configuredSecs;
  if (typeof secs === "number" && secs > 0) return Math.floor(secs * 1000);
  return input.interactive ? undefined : HEADLESS_CHECK_TIMEOUT_MS;
}

/**
 * `--max-turns`: a whole number, 0 for no ceiling. Undefined when absent; an
 * error naming the flag when it is not a count.
 */
export function parseMaxTurnsFlag(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return {
      error: `--max-turns takes a whole number of turns, or 0 for no ceiling (got "${text}")`,
    };
  }
  return Number(text);
}

/** `--max-budget-usd`: a positive amount in dollars. */
export function parseMaxBudgetFlag(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim().replace(/^\$/, "");
  const n = Number(text);
  if (!text || !Number.isFinite(n) || n <= 0) {
    return {
      error: `--max-budget-usd takes an amount in dollars above zero (got "${String(raw).trim()}")`,
    };
  }
  return n;
}
