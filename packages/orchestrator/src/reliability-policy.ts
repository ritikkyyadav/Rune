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
