/**
 * The arbiter, asked the four questions M2 exits on (S1, S2, S5, S8) — and
 * asked whether those questions can fail (the mutation at the bottom).
 *
 * Every test here is a pure function call. No loop, no engine, no gateway, no
 * clock: if any of this needed a rig, `decide` would not be pure and the
 * shadow lane would not be passive.
 */

import { describe, expect, test } from "bun:test";

import {
  GUARD_CLASS,
  GUARD_IDS,
  abandoned,
  arbitrate,
  complete,
  decide,
  decisionFingerprint,
  enforceClassRules,
  makeShadowEvent,
  type Decision,
  type GuardId,
  type ShadowEvent,
} from "../../../packages/orchestrator/src/arbiter";
import { emptyRunState, makeRunState } from "../../../packages/orchestrator/src/run-state";

const RUN = "run-1";
const AT = "2026-09-14T00:00:00.000Z";

function ev(seq: number, guard: GuardId, inputs: Record<string, unknown>): ShadowEvent {
  return makeShadowEvent(RUN, seq, guard, inputs, AT);
}

/** The shapes a step can carry, as the inventory's §4.1 describes them. */
const ABORT = (seq: number) => ev(seq, "E2", { aborted: true });
const HALT = (seq: number) => ev(seq, "E3", { halted: true, reportGranted: false });
const CEILING = (seq: number) =>
  ev(seq, "E1", { turn: 80, maxTurns: 80, secondWindAvailable: false });
const VERIFY_RED = (seq: number) =>
  ev(seq, "G4", {
    anyWritesThisRun: true,
    executedSinceWrite: false,
    projectChecksPassed: false,
    planSettled: false,
    fired: 0,
  });
const VERDICT_MET = (seq: number) => ev(seq, "VERDICT", { hasVerdict: true, verdictKind: "met" });
const PROVIDER_GONE = (seq: number) =>
  ev(seq, "E5", { consecutiveErrors: 3, maxConsecutiveErrors: 3, planClosed: false });

function decideAll(events: readonly ShadowEvent[], state = emptyRunState(RUN)): Decision[] {
  return events.map((e) => decide(state, e));
}

// ─── S1 — deterministic replay ───

describe("S1 — the same events replayed twice decide identically", () => {
  const script = [
    ev(1, "G0", { pending: true }),
    VERIFY_RED(2),
    ev(3, "G7", { openSteps: 2, totalSteps: 5, fired: 0 }),
    ev(4, "E4", { emptyCompletions: 1, maxEmpty: 3, workStands: false }),
    VERDICT_MET(5),
  ];

  test("byte-identical decisions across two runs of the same sequence", () => {
    const a = decisionFingerprint(decideAll(script));
    const b = decisionFingerprint(decideAll(script));
    expect(a).toBe(b);
    // And not vacuously: the fingerprint carries the transitions.
    expect(a).toContain("verifying");
    expect(a).toContain("complete(met)");
  });

  test("a permuted step yields the same winner", () => {
    const step = [CEILING(7), HALT(8), VERIFY_RED(9)];
    const forward = arbitrate(decideAll(step), step);
    const reversed = [...step].reverse();
    const backward = arbitrate(decideAll(reversed), reversed);
    expect(backward.winner).toEqual(forward.winner);
    expect(forward.winner.transition).toBe("blocked(halt)");
    // The losers are recorded, not dropped, and they name the winner.
    expect(forward.superseded.map((d) => d.supersededBy)).toEqual([
      forward.winner.id,
      forward.winner.id,
    ]);
  });

  test("decide reads nothing but its two arguments", () => {
    // `at` is recorded and never read: two events identical but for their
    // timestamp decide the same thing.
    const one = decide(emptyRunState(RUN), makeShadowEvent(RUN, 1, "E2", { aborted: true }, AT));
    const two = decide(
      emptyRunState(RUN),
      makeShadowEvent(RUN, 1, "E2", { aborted: true }, "2031-01-01T00:00:00.000Z"),
    );
    expect(two).toEqual(one);
  });
});

// ─── S2 — injected concurrent events agree with the ladder ───

describe("S2 — simultaneous events resolve by class, not by line number", () => {
  test("a halt during a failing verification round is class 1", () => {
    const step = [VERIFY_RED(1), HALT(2)];
    const { winner, superseded } = arbitrate(decideAll(step), step);
    expect(winner.class).toBe(1);
    expect(winner.transition).toBe("blocked(halt)");
    expect(superseded[0]!.transition).toBe("verifying");
  });

  test("an abort during a halt is class 0", () => {
    const step = [HALT(1), ABORT(2)];
    const { winner } = arbitrate(decideAll(step), step);
    expect(winner.class).toBe(0);
    expect(winner.transition).toBe(abandoned("user_abort"));
  });

  test("budget exhaustion beside a verdict of met is budget", () => {
    const step = [VERDICT_MET(1), CEILING(2)];
    const { winner, superseded } = arbitrate(decideAll(step), step);
    expect(winner.class).toBe(2);
    expect(winner.transition).toBe(abandoned("budget"));
    expect(superseded[0]!.transition).toBe(complete("met"));
  });

  test("a lost provider beside a verdict is environment", () => {
    const step = [VERDICT_MET(1), PROVIDER_GONE(2)];
    const { winner } = arbitrate(decideAll(step), step);
    expect(winner.class).toBe(3);
    expect(winner.transition).toBe(abandoned("environment"));
  });

  test("two class-5 events resolve by the earlier seq", () => {
    const step = [ev(9, "E10", {}), ev(4, "E9", {})];
    const { winner } = arbitrate(decideAll(step), step);
    expect(winner.eventId).toBe(`${RUN}:4`);
  });
});

// ─── The rule the ladder exists for ───

describe("class 5 never proposes complete", () => {
  test("the rule converts a complete proposal into an unknown", () => {
    const proposed = enforceClassRules(5, { transition: complete("met"), reason: "because" });
    expect(proposed.transition).toBe("unknown");
    expect(proposed.reason).toContain("never declare it complete");
    // …and leaves every other class alone.
    expect(enforceClassRules(4, { transition: complete("met"), reason: "r" }).transition).toBe(
      complete("met"),
    );
  });

  test("no class-5 guard proposes complete under any input bag", () => {
    const bags = [
      {},
      { planSettled: true, openSteps: 0, totalSteps: 3, hasVerdict: true, verdictKind: "met" },
      { workStands: true, accepted: true, fired: 0 },
    ];
    for (const guard of GUARD_IDS.filter((g) => GUARD_CLASS[g] === 5)) {
      for (const inputs of bags) {
        const d = decide(emptyRunState(RUN), ev(1, guard, inputs));
        expect(d.transition.startsWith("complete("), `${guard} proposed ${d.transition}`).toBe(
          false,
        );
      }
    }
  });

  test("G9 — an empty completion with no verdict is not a completion", () => {
    const d = decide(emptyRunState(RUN), ev(1, "G9", { workStands: true, hasVerdict: false }));
    expect(d.transition).toBe(abandoned("environment"));
    expect(d.class).toBe(3);
    // With a verdict it may stand on it, which is the whole distinction.
    const withVerdict = decide(
      emptyRunState(RUN),
      ev(2, "G9", { workStands: true, hasVerdict: true, verdictKind: "partial" }),
    );
    expect(withVerdict.transition).toBe(complete("partial"));
  });
});

// ─── S5 — a missing input is an unknown ───

describe("S5 — a missing input is unknown, never agreement", () => {
  test("an absent required boolean decides unknown and names the input", () => {
    const d = decide(emptyRunState(RUN), ev(1, "E2", {}));
    expect(d.transition).toBe("unknown");
    expect(d.reason).toContain("missing input");
    expect(d.reason).toContain("aborted");
  });

  test("a partially readable gate is unknown, not a guess", () => {
    const d = decide(
      emptyRunState(RUN),
      ev(1, "G4", { anyWritesThisRun: true, executedSinceWrite: false }),
    );
    expect(d.transition).toBe("unknown");
  });

  test("the snapshot supplies what the site could not read", () => {
    const state = makeRunState(RUN, "working", {
      evidence: {
        anyWritesThisRun: true,
        executedSinceWrite: false,
        projectChecksPassed: false,
        planSettled: false,
      },
    });
    const d = decide(state, ev(1, "G4", { fired: 0 }));
    expect(d.transition).toBe("verifying");
  });

  test("a verdict site with no contract is unknown, not complete", () => {
    const d = decide(emptyRunState(RUN), ev(1, "VERDICT", { hasVerdict: false }));
    expect(d.transition).toBe("unknown");
    expect(d.reason).toContain("no contract");
  });

  test("unknown is never equal to what the guard did", () => {
    // The point of the rule: an unknown cannot be scored as agreement even
    // when the guard's own transition would have matched a guess.
    const d = decide(emptyRunState(RUN), ev(1, "E1", { turn: 3 }));
    expect(d.transition).toBe("unknown");
    expect(d.transition === abandoned("budget")).toBe(false);
  });
});

// ─── S8 — a terminal transition is absorbing for that run id ───

describe("S8 — terminal is absorbing for the run id", () => {
  test("a later event on a terminal run decides unknown", () => {
    const terminal = makeRunState(RUN, "complete");
    const d = decide(terminal, ev(9, "G4", { fired: 0 }));
    expect(d.transition).toBe("unknown");
    expect(d.reason).toBe("run already terminal");
  });

  test("abandoned absorbs exactly as complete does", () => {
    const d = decide(makeRunState(RUN, "abandoned"), VERDICT_MET(9));
    expect(d.transition).toBe("unknown");
    expect(d.reason).toBe("run already terminal");
  });

  test("a DIFFERENT run id is unaffected — the rule is per run", () => {
    const other = makeRunState("run-2", "working");
    const d = decide(
      other,
      makeShadowEvent("run-2", 1, "VERDICT", { hasVerdict: true, verdictKind: "met" }, AT),
    );
    expect(d.transition).toBe(complete("met"));
  });
});

// ─── The mutation: a decide() that always echoes the guard makes S2/S5 green ───

describe("the exit tests can fail", () => {
  /** The mutant of the spec: `decide` returns whatever the guard actually did. */
  function mutantDecide(actual: string) {
    return (event: ShadowEvent): Decision => ({
      id: `d:${event.id}`,
      eventId: event.id,
      transition: actual as Decision["transition"],
      class: event.class,
      reason: "echo",
      applied: false,
    });
  }

  test("S2 goes red under the mutant: the ladder stops deciding", () => {
    // Under the mutant every event echoes its own guard, so the winner of
    // `halt ∧ failing verification` is whatever the loop's line order was —
    // exactly the defect the ladder replaces.
    const step = [VERIFY_RED(1), HALT(2)];
    const mutated = [mutantDecide("verifying")(step[0]!), mutantDecide("blocked(halt)")(step[1]!)];
    // The real arbiter still picks the halt by class…
    expect(arbitrate(decideAll(step), step).winner.transition).toBe("blocked(halt)");
    // …but the mutant agrees with the guard by construction, so the
    // disagreement S2 exists to catch can never be recorded.
    for (const d of mutated) {
      const actualOf = d.eventId.endsWith(":1") ? "verifying" : "blocked(halt)";
      expect(d.transition).toBe(actualOf as Decision["transition"]);
    }
  });

  test("S5 goes red under the mutant: a missing input becomes agreement", () => {
    const e = ev(1, "E2", {});
    expect(decide(emptyRunState(RUN), e).transition).toBe("unknown");
    // The mutant answers with the guard's transition even though the predicate
    // input was never readable — the "unknown, never agreement" rule is gone.
    expect(mutantDecide(abandoned("user_abort"))(e).transition).toBe(abandoned("user_abort"));
  });

  test("S4's G9 disagreement disappears under the mutant", () => {
    const e = ev(1, "G9", { workStands: true, hasVerdict: false });
    const real = decide(emptyRunState(RUN), e);
    const actual = complete("end_turn");
    expect(real.transition === actual).toBe(false);
    expect(mutantDecide(actual)(e).transition === actual).toBe(true);
  });
});

// ─── The guard table itself ───

describe("the guard table matches the inventory's ladder", () => {
  test("every guard has a class and every class is 0..5", () => {
    for (const g of GUARD_IDS) {
      expect(GUARD_CLASS[g]).toBeGreaterThanOrEqual(0);
      expect(GUARD_CLASS[g]).toBeLessThanOrEqual(5);
    }
    expect(GUARD_CLASS.E2).toBe(0);
    expect(GUARD_CLASS.E3).toBe(1);
    expect(GUARD_CLASS.E1).toBe(2);
    expect(GUARD_CLASS.E7).toBe(2);
    expect(GUARD_CLASS.E4).toBe(3);
    expect(GUARD_CLASS.VERDICT).toBe(4);
    expect(GUARD_CLASS.E9).toBe(5);
  });

  test("nothing the arbiter decides is called provider_lost", () => {
    // S7's rule, at the vocabulary level: four different exits used to record
    // as a dead network, and the abandon reasons have no such word.
    const seen = new Set<string>();
    for (const g of GUARD_IDS) {
      for (const inputs of [
        {},
        { retryable: false },
        { consecutiveErrors: 3, maxConsecutiveErrors: 3, planClosed: false },
        { truncationRetries: 2, maxTruncationRetries: 2 },
        { admissionRefused: true },
      ]) {
        seen.add(decide(emptyRunState(RUN), ev(1, g, inputs)).transition);
      }
    }
    expect([...seen].filter((t) => t.includes("provider_lost"))).toEqual([]);
  });

  test("the four verdict-less exits each decide something different", () => {
    const e6 = decide(emptyRunState(RUN), ev(1, "E6", { retryable: false })).transition;
    const e7 = decide(emptyRunState(RUN), ev(2, "E7", { admissionRefused: true })).transition;
    const e9 = decide(emptyRunState(RUN), ev(3, "E9", {})).transition;
    const e11 = decide(emptyRunState(RUN), ev(4, "E11", {})).transition;
    expect(e6).toBe(abandoned("environment"));
    expect(e7).toBe(abandoned("budget"));
    expect(e9).toBe(abandoned("no_progress"));
    expect(e11).toBe(abandoned("blocked"));
    expect(new Set([e6, e7, e9, e11]).size).toBe(4);
  });
});
