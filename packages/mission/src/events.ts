// ─── Gear · the mission event vocabulary ───
// The single most important rule in this design: **no component parses model prose.**
// The runtime emits the typed events below into an append-only log; a reducer folds
// them into mission state; the surface projects that state into rows. A model that
// hangs, lies, or returns malformed output cannot make the UI claim the work
// succeeded, because the UI never reads what the model said — it reads this.
//
// Adding an event here is adding a fact the product can state. If a screen wants to
// say something, there must be an event that carries it.

/** How strong a claim is. The last column of every row in the product. */
export type Rung =
  /** a hypothesis. no evidence yet. it may be wrong. */
  | "suspected"
  /** a tool returned it. it is on disk or on the wire. */
  | "observed"
  /** made to happen on demand, more than once. */
  | "reproduced"
  /** a test asserts it — and that test failed before the change. */
  | "verified";

export const RUNGS: readonly Rung[] = ["suspected", "observed", "reproduced", "verified"];

/** Ordering, so a claim can be weakened but never silently promoted. */
export const rungOrder = (r: Rung): number => RUNGS.indexOf(r);

/**
 * Evidence is the price of a `verified` rung. A criterion cannot flip and a `✓`
 * cannot print without one, and the only kind that buys `verified` is a test that
 * was **red on the baseline commit** — which is why `baselineFailed` is not optional
 * on that shape. There is no rung for "probably".
 */
export type Evidence =
  | {
      kind: "test";
      /** what ran, verbatim */
      command: string;
      passed: number;
      total: number;
      /** the commit the same tests were run against with the change removed */
      baseline: string;
      /** true when every one of them failed there — the whole point of the exercise */
      baselineFailed: boolean;
    }
  | { kind: "reproduction"; command: string; runs: number; hits: number }
  | { kind: "file"; path: string; line?: number; note?: string }
  | { kind: "review"; actor: string; blockers: number; minors: number }
  | { kind: "tool"; verb: string; exit: number; note?: string };

export interface Criterion {
  id: string;
  /** the sentence you agreed to at minute zero, unchanged */
  text: string;
}

export interface PlanStep {
  index: string;
  title: string;
  dependsOn: string[];
  /** set when the step exists only because a finding created it */
  from?: string;
}

export interface DecisionOption {
  key: string;
  title: string;
  /** the shape of the change: files, +/−, rough time — facts, never a percentage */
  cost: string;
  body: string[];
  reversible: boolean;
}

export type PhaseOutcome = "met" | "missed" | "skipped";
export type AgentResult = "returned" | "killed" | "starved";

interface Base {
  /** monotonic, assigned by the log on append — never by the emitter */
  seq: number;
  /** ms since epoch, assigned by the log */
  at: number;
}

export type MissionEvent = Base &
  (
    | {
        type: "MISSION_OPENED";
        id: string;
        objective: string;
        scope: string[];
        exclusions: string[];
        criteria: Criterion[];
        /** plain words. "no cap set · I stop and ask at 45 minutes" is a budget. */
        budget: string;
        /**
         * The commit every "it was red before" claim is judged against. Fixed at minute
         * zero so it cannot drift to whatever happens to make the tests look good later.
         */
        baseline: string;
      }
    | { type: "PLAN_SET"; revision: number; steps: PlanStep[]; cause?: string }
    | { type: "PHASE_OPENED"; index: string; title: string }
    | {
        type: "PHASE_CLOSED";
        index: string;
        outcome: PhaseOutcome;
        summary: string;
        rung: Rung;
        elapsedMs: number;
      }
    | {
        type: "TOOL_STARTED";
        id: string;
        verb: string;
        args: string;
        actor: string;
        phase?: string;
      }
    /**
     * The only event that may advance the pulse. A tool that starts and never reports
     * renders flat and says `quiet Ns` — which is the entire point, and is why no clock
     * is allowed anywhere near it.
     */
    | { type: "TOOL_PROGRESS"; id: string; bytes: number; detail?: string }
    | {
        type: "TOOL_ENDED";
        id: string;
        exit: number;
        detail: string;
        bytes: number;
        elapsedMs: number;
        rung: Rung;
      }
    | {
        type: "AGENT_SPAWNED";
        id: string;
        role: string;
        objective: string;
        scope: string[];
        tools: string;
        budgetTokens: number;
        phase?: string;
      }
    | {
        type: "AGENT_RETURNED";
        id: string;
        result: AgentResult;
        summary: string;
        rung: Rung;
        elapsedMs: number;
        tokens: number;
      }
    | {
        type: "FINDING_OPENED";
        id: string;
        claim: string;
        body: string[];
        evidence: Evidence[];
        rung: Rung;
        /** what it changes: a plan step it creates, criteria it bears on */
        creates?: string;
        criteria: string[];
        /** true when it is real, proven, and deliberately outside the agreed scope */
        outOfScope?: boolean;
      }
    | {
        type: "CHANGE_APPLIED";
        path: string;
        hunks: number;
        added: number;
        removed: number;
        /** the finding this change cites as its cause. changes without one are suspect. */
        cause?: string;
        tests: string[];
        newFile?: boolean;
      }
    | {
        type: "CHECK_RESULT";
        kind: string;
        runner: string;
        passed: number;
        total: number;
        /** the commit the same check was run against with the change removed */
        baseline?: string;
        baselineFailed?: boolean;
        elapsedMs: number;
        rung: Rung;
        failures?: string[];
      }
    | {
        type: "DECISION_OPENED";
        id: string;
        question: string;
        options: DecisionOption[];
        recommendation: string;
        reasoning: string[];
        /** what sits idle while a human thinks. counted, never hidden. */
        idleAgents: number;
        queuedMs: number;
      }
    | {
        type: "DECISION_TAKEN";
        id: string;
        chosen: string;
        by: "human" | "default";
        heldMs: number;
        note?: string;
      }
    | { type: "DECISION_WITHDRAWN"; id: string; why: string }
    | {
        type: "CONSTRAINT_ADDED";
        id: string;
        text: string;
        source: "human";
        affects: string[];
        reverts: string;
        cost: string[];
      }
    | {
        type: "CRITERION_MET";
        id: string;
        /** the only way a ✓ appears anywhere in this product */
        evidence: Evidence;
        detail: string;
      }
    | {
        type: "RISK_OPENED";
        id: string;
        statement: string;
        severity: "low" | "medium" | "high";
        mitigation: string;
      }
    | { type: "RISK_CLOSED"; id: string; how: string }
    /** never silent: what was summarised away is itself an event in the log */
    | { type: "COMPACTED"; summarised: string; fromSeq: number; toSeq: number; tokensFreed: number }
    | { type: "MISSION_CONCLUDED"; outcome: "concluded" | "abandoned"; elapsedMs: number }
    | {
        type: "CHECKPOINT";
        treeSha: string;
        planRevision: number;
        openAgents: string[];
      }
  );

export type MissionEventType = MissionEvent["type"];

/** What an emitter hands the log: everything but the fields the log owns. */
export type DraftEvent = DistributiveOmit<MissionEvent, keyof Base>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * `verified` is the one rung the product cannot take on trust. Anything claiming it
 * has to carry a test that was red on the baseline — the rule that makes the claim
 * column worth reading, enforced here rather than in a code review.
 */
export function evidenceSupportsVerified(evidence: Evidence): boolean {
  return (
    evidence.kind === "test" &&
    evidence.baselineFailed &&
    evidence.total > 0 &&
    evidence.passed === evidence.total
  );
}
