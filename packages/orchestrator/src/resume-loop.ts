// ─── The resume loop: run, and if a provider wall stops it, wait and continue ───
//
// The orchestration around one headless session, with everything that touches
// the world injected: the clock, the sleep, the run itself, the spend and the
// provider's window. The CLI passes the real ones; a test passes a fake clock
// and plays a whole night in milliseconds.
//
// The waiting sleeps in short slices and re-reads the clock after each one, so
// a laptop that slept through the window wakes up, sees the time, and either
// resumes at once or — past the deadline — expires instead.

import type { HeadlessResult } from "./headless";
import { afterRun, claimIfDue, type ResumePlan, type RunEnding } from "./resume-plan";

/** What a resume says to the session. The handoff carries the rest. */
export const RESUME_PROMPT = "continue";

/** The longest single sleep between clock checks. */
const SLEEP_SLICE_MS = 60_000;

/** The gateway's own words when a plan/quota cap stops a run (llm-gateway, quotaStopError). */
const QUOTA_STOP_RE = /quota exceeded/i;
/** Failures a person has to fix: waiting will not produce a key or a permission. */
const BLOCKED_RE =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid (?:api )?key|api key (?:is )?(?:missing|invalid|not set)|no credentials?|not logged in|authentication failed|permission denied by (?:policy|the user)/i;

/**
 * How a headless run ended, as a resume plan needs to know it.
 *
 * Only a provider wall is resumable: the gateway's quota stop, or the loop's
 * own `provider_lost`. A finished run is done. Everything the run decided for
 * itself — a turn cap, a halt, a cancel, open steps — stays its decision.
 */
export function classifyEnding(result: HeadlessResult, providerUntil: number | null): RunEnding {
  if (result.ok) return { kind: "finished" };
  const error = result.error ?? "";
  if (QUOTA_STOP_RE.test(error) || result.stopReason === "provider_lost") {
    return { kind: "wall", providerUntil };
  }
  if (BLOCKED_RE.test(error)) {
    return { kind: "blocked", why: `a person has to fix this first: ${error.split("\n")[0]}` };
  }
  return { kind: "stopped", stopReason: result.stopReason ?? "error" };
}

export interface ResumeLoopDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One headless run of this session. */
  run(prompt: string): Promise<HeadlessResult>;
  /** The session's cumulative list cost, rehydrated across processes. */
  spentUsd(): number;
  /** True when a model this session used has no list price. */
  unpriced(): boolean;
  /** The provider's known window (the gateway's persisted cap), or null. */
  providerUntil(): number | null;
  /**
   * Record `next` only if the stored plan is still `prev`. False when
   * something else moved it first: a cancel, or another process's claim.
   */
  save(next: ResumePlan, prev: ResumePlan): boolean;
  /** The plan as stored now, for when a save was refused. */
  stored(sessionId: string): ResumePlan | null;
  log(line: string): void;
}

/**
 * Run `prompt`, then keep resuming while the plan says wait. Returns the last
 * run's result and the plan as it ended. A plan that is already terminal is
 * returned untouched without running anything.
 */
export async function runWithResume(
  prompt: string,
  initial: ResumePlan,
  deps: ResumeLoopDeps,
): Promise<{ result: HeadlessResult | null; plan: ResumePlan }> {
  if (initial.status !== "active") return { result: null, plan: initial };
  let plan: ResumePlan = initial;
  // Every transition is a compare-and-swap against the plan this loop last
  // saw. When the stored plan has moved on without it — a person cancelled
  // it, or a scheduled `missions run` claimed it — the loop adopts what is
  // stored and stops: one plan is resumed by one process.
  const advance = (from: ResumePlan, to: ResumePlan): { moved: boolean; plan: ResumePlan } => {
    if (deps.save(to, from)) return { moved: true, plan: to };
    const stored = deps.stored(from.sessionId) ?? from;
    deps.log(`resume: the plan moved on without this process (${stored.status}); stopping here`);
    return { moved: false, plan: stored };
  };
  let next = prompt;
  for (;;) {
    const started = deps.now();
    const result = await deps.run(next);
    let ending = classifyEnding(result, deps.providerUntil());
    // A budget cannot be held on a model with no price: its spend reads $0.
    if (ending.kind === "wall" && plan.policy.budgetUsd !== null && deps.unpriced()) {
      ending = {
        kind: "blocked",
        why: "the budget cannot be enforced: this session used a model with no list price",
      };
    }
    const ended = advance(
      plan,
      afterRun(
        plan,
        ending,
        { spentUsd: deps.spentUsd(), activeMs: deps.now() - started },
        deps.now(),
      ),
    );
    plan = ended.plan;
    if (!ended.moved) return { result, plan };
    if (plan.status !== "waiting") {
      if (plan.reason && plan.status !== "done")
        deps.log(`resume: ${plan.status} — ${plan.reason}`);
      return { result, plan };
    }
    deps.log(
      `resume: provider wall — next attempt at ${new Date(plan.nextAt!).toISOString()} ` +
        `(${plan.hint}; resume ${plan.attempts + 1} of ${plan.policy.maxAttempts}, ` +
        `deadline ${new Date(plan.policy.deadlineAt).toISOString()}, spent $${plan.spentUsd.toFixed(4)})`,
    );
    for (;;) {
      const claim = claimIfDue(plan, deps.now());
      if (claim.plan !== plan) {
        const claimed = advance(plan, claim.plan);
        plan = claimed.plan;
        if (!claimed.moved) return { result, plan };
      }
      if (claim.claimed) break;
      if (plan.status !== "waiting") {
        if (plan.reason) deps.log(`resume: ${plan.status} — ${plan.reason}`);
        return { result, plan };
      }
      await deps.sleep(Math.max(1, Math.min(plan.nextAt! - deps.now(), SLEEP_SLICE_MS)));
    }
    deps.log(`resume: attempt ${plan.attempts} — continuing the session`);
    next = RESUME_PROMPT;
  }
}
