// ─── The lessons lifecycle: candidate → trial → active → retired ───
//
// Before this, "learned" and "believed" were the same thing. One observation in
// one run was written to the notebook and injected into every later run, with
// no measurement in between and no way to tell a lesson that had held from one
// that had merely been recorded. That is the definition of mutation: a change
// in behaviour with no evidence attached.
//
// The stages are the evidence ladder, and each rung costs more than the last:
//
//   candidate  learned once. Stored, never injected. Costs nothing, claims
//              nothing. The backfill path writes ONLY candidates, because
//              deriving a lesson from history is not the same as watching it
//              hold.
//   trial      learned in ≥2 distinct sessions — the same bar the playbook has
//              always used for "a fact about the repository rather than a note".
//              Injected, and every injection is counted.
//   active     ≥5 firings with a win rate above the ambient baseline. Only
//              active lessons reach the playbook, which is the widest automatic
//              action the loop takes.
//   retired    decayed, disused, contradicted, or turned off. Kept and
//              inspectable; revives as a candidate if re-learned.
//
// Nothing here spends a model token. `CostGovernor.allow()` exists for the
// distillation passes that would, and `mayDistil` below is the single gate they
// must call — a learning job that can spend without asking is how a 2% budget
// becomes 30%.

import type { CostGovernor } from "../notebook/governor";
import type { LessonStage, NotebookEntry, NotebookStore } from "../notebook/store";

/** Distinct sessions a lesson must appear in before it is injected at all. */
export const TRIAL_SESSIONS = 2;
/** Injections a lesson needs before its win rate is allowed to mean anything. */
export const ACTIVE_FIRINGS = 5;
/** How far above the ambient win rate a lesson must sit to become active. */
export const ACTIVE_MARGIN = 0.05;
/**
 * The floor under the baseline. With few lessons the ambient rate is noisy and
 * can drift low; a lesson that helps less than half the runs it is injected
 * into is not carrying its token cost whatever the ambient rate says.
 */
export const ACTIVE_FLOOR = 0.5;

/**
 * The ambient win rate: wins over uses, pooled across every entry that has been
 * injected at all.
 *
 * This is the control group the lifecycle has instead of an A/B — the rate at
 * which runs go well WITH lessons injected. A lesson must beat it, not merely
 * coexist with it. Null when nothing has been injected yet, which reads as "no
 * baseline", never as zero.
 */
export function lessonBaseline(entries: NotebookEntry[], excludeId?: string): number | null {
  let uses = 0;
  let wins = 0;
  for (const e of entries) {
    if (excludeId && e.id === excludeId) continue;
    uses += e.uses;
    wins += e.wins;
  }
  return uses > 0 ? wins / uses : null;
}

/** The bar for `active`, given the ambient rate. */
export function activeThreshold(baseline: number | null): number {
  return Math.max(ACTIVE_FLOOR, (baseline ?? 0) + ACTIVE_MARGIN);
}

/**
 * Did this run go well enough to count as a win for the lessons it injected?
 *
 * Three conditions, and each one is a different kind of "it did not work":
 *
 *   · the evidence gate passed — no step closed without evidence, and no
 *     verification command failed. A run that closed steps it could not prove
 *     is not evidence that the advice helped;
 *   · nothing at error severity or worse — represented here by the run's own
 *     error/abort state, which is what the black box's outcome model already
 *     uses to separate a 429 that recovered (noise) from one that killed the
 *     run (signal). A run that hit an error and recovered is a run that
 *     recovered;
 *   · no correction or rephrase — `struggle.*` fired at least once means the
 *     user or the harness had to steer, and a lesson does not get credit for a
 *     run someone else rescued.
 *
 * Deliberately strict. The old signal was `!runError && !aborted`, which counted
 * a run where the user rephrased three times and half the checks failed as a
 * win for whatever happened to be injected.
 */
export interface RunOutcomeSignal {
  aborted: boolean;
  runError: boolean;
  /** Completed steps that closed without evidence, over this run. */
  unprovenSteps: number;
  /** Verification commands that failed. */
  checksFailed: number;
  /** A `struggle.*` signal fired: a correction, a rephrase, thrash. */
  struggled: boolean;
}

export function isWinningRun(s: RunOutcomeSignal): boolean {
  if (s.aborted || s.runError) return false;
  if (s.unprovenSteps > 0 || s.checksFailed > 0) return false;
  if (s.struggled) return false;
  return true;
}

export interface StageTransition {
  id: string;
  title: string;
  from: LessonStage;
  to: LessonStage;
  /** One line a person can disagree with. */
  reason: string;
}

/**
 * Apply the lifecycle rules to one scope's entries and write the transitions.
 *
 * Repo-scoped lessons may advance on live signal — they are cheap to be wrong
 * about and cheap to retire, and the evidence is the repository's own runs.
 * Anything wider (`stack`, `global`) stops at `trial` here: promoting advice
 * across projects on one project's runs is the superstition failure, and it
 * needs the offline A/B, not a counter.
 */
export function advanceLessons(
  store: NotebookStore,
  entries: NotebookEntry[],
  opts: { now?: Date } = {},
): StageTransition[] {
  const out: StageTransition[] = [];
  for (const e of entries) {
    if (e.retired || e.stage === "retired") continue;

    if (e.stage === "candidate") {
      if (e.provenance.sessions.length >= TRIAL_SESSIONS) {
        if (store.setStage(e.id, "trial")) {
          out.push({
            id: e.id,
            title: e.title,
            from: "candidate",
            to: "trial",
            reason: `seen in ${e.provenance.sessions.length} sessions (≥${TRIAL_SESSIONS}) — a repeated observation is a fact about the repository, so it starts being injected and counted`,
          });
        }
      }
      continue;
    }

    if (e.stage === "trial") {
      if (e.scope !== "repo") {
        // Wider than one repository: a counter is not enough evidence to start
        // advising other projects. That needs the offline A/B.
        continue;
      }
      if (e.uses < ACTIVE_FIRINGS) continue;
      const rate = e.wins / e.uses;
      // Leave-one-out: the baseline is how runs go with the OTHER lessons
      // injected. Including the candidate in its own baseline makes the bar
      // move with it, and the first lesson in a fresh store could never clear
      // its own rate plus a margin.
      const baseline = lessonBaseline(entries, e.id);
      const bar = activeThreshold(baseline);
      if (rate >= bar && store.setStage(e.id, "active")) {
        out.push({
          id: e.id,
          title: e.title,
          from: "trial",
          to: "active",
          reason: `${e.wins}/${e.uses} winning runs (${(rate * 100).toFixed(0)}%) against a bar of ${(bar * 100).toFixed(0)}%${baseline === null ? " (no ambient baseline yet; the floor applies)" : ` (ambient ${(baseline * 100).toFixed(0)}% + ${ACTIVE_MARGIN * 100}%)`}`,
        });
      }
      continue;
    }

    if (e.stage === "active" && e.uses >= ACTIVE_FIRINGS) {
      const rate = e.wins / e.uses;
      if (rate < ACTIVE_FLOOR && store.setStage(e.id, "retired")) {
        out.push({
          id: e.id,
          title: e.title,
          from: "active",
          to: "retired",
          reason: `win rate fell to ${(rate * 100).toFixed(0)}%, below the ${ACTIVE_FLOOR * 100}% floor — an active lesson that stops helping is worse than no lesson, because it costs tokens on every run`,
        });
      }
    }
  }
  void opts;
  return out;
}

/**
 * The one gate a model-assisted distillation must pass.
 *
 * `CostGovernor` has been built and never called since the notebook shipped —
 * v1's capture is rule-based and spends nothing, so nothing needed it. Any
 * future pass that asks a model to summarise or generalise a lesson calls this
 * first, and the governor's contract (learning stays under ~2% of session
 * spend) is enforced rather than aspirational.
 */
export function mayDistil(
  governor: CostGovernor,
  estimatedUsd: number,
  sessionSpendUsd: number,
): { allowed: boolean; reason?: string } {
  if (governor.allow(estimatedUsd, sessionSpendUsd)) return { allowed: true };
  return {
    allowed: false,
    reason: `learning budget exhausted: $${governor.spent().toFixed(4)} spent against a session spend of $${sessionSpendUsd.toFixed(4)}. Distillation is skipped, not deferred — a learning job that outbids the work it learns from is the failure the governor exists to prevent.`,
  };
}

/** Counts per stage, for `gear evolve status`. */
export function stageCounts(entries: NotebookEntry[]): Record<LessonStage, number> {
  const counts: Record<LessonStage, number> = {
    candidate: 0,
    trial: 0,
    active: 0,
    retired: 0,
  };
  for (const e of entries) counts[e.retired ? "retired" : e.stage]++;
  return counts;
}
