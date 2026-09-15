/**
 * M4 — the arbiter's six repair rules.
 *
 * `repair-classifier.test.ts` pins what KIND a failure is; this file pins what
 * the arbiter proposes once it knows. One `describe` per class, each asserting
 * the three things the class table promises
 * (`docs/program/m4-repair-and-delegation.md`): the bounded response, the
 * exhausted arm, and the "never" column — the response the class may never
 * propose, whatever the inputs say.
 *
 * The limits are INPUTS. The site passes them in because the site is where
 * they are counted, durably, on the run's own `decision` rows; an arbiter that
 * held a counter would not be a function.
 *
 * Zero model calls.
 */

import { describe, expect, test } from "bun:test";

import {
  GUARD_CLASS,
  decide,
  makeShadowEvent,
  parseAuthority,
  type GuardId,
  type GuardInputs,
} from "../../../packages/orchestrator/src/arbiter";
import { emptyRunState } from "../../../packages/orchestrator/src/run-state";

function ask(guard: GuardId, inputs: GuardInputs) {
  return decide(emptyRunState("r"), makeShadowEvent("r", 1, guard, inputs, "2026-09-15T00:00:00Z"));
}

describe("transport — retry to the bound, then the environment", () => {
  test("inside the bound the run keeps working", () => {
    expect(ask("REPAIR_TRANSPORT", { attempts: 1, maxAttempts: 3 }).transition).toBe("working");
  });

  test("at the bound it is abandoned on the environment, never on the work", () => {
    const d = ask("REPAIR_TRANSPORT", { attempts: 3, maxAttempts: 3 });
    expect(d.transition).toBe("abandoned(environment)");
    expect(d.reason).toContain("the work is not what failed");
  });

  test("it never proposes a different provider — that is `[fallback]`'s decision", () => {
    for (const attempts of [0, 1, 2, 3, 9]) {
      const d = ask("REPAIR_TRANSPORT", { attempts, maxAttempts: 3 });
      expect(["working", "abandoned(environment)"]).toContain(d.transition);
    }
  });

  test("a missing bound is an unknown, never a guess", () => {
    expect(ask("REPAIR_TRANSPORT", { attempts: 1 }).transition).toBe("unknown");
  });

  test("it is class 3 — environment", () => {
    expect(GUARD_CLASS.REPAIR_TRANSPORT).toBe(3);
  });
});

describe("check_failed — one repair turn, then the finish decides", () => {
  test("a red check with the bound unspent buys `repairing`", () => {
    const d = ask("REPAIR_CHECK", { checkFailed: true, repairTurns: 0, maxRepairTurns: 1 });
    expect(d.transition).toBe("repairing");
  });

  test("R7 — with the bound spent it is `verifying`: the finish names the gap", () => {
    const d = ask("REPAIR_CHECK", { checkFailed: true, repairTurns: 1, maxRepairTurns: 1 });
    expect(d.transition).toBe("verifying");
    expect(d.reason).toContain("gap named");
  });

  test("green checks are not a repair at all", () => {
    expect(
      ask("REPAIR_CHECK", { checkFailed: false, repairTurns: 0, maxRepairTurns: 1 }).transition,
    ).toBe("working");
  });

  test("R2 — it never proposes a rerun of anything; the bound is a number, not a suite", () => {
    for (const repairTurns of [0, 1, 2, 5]) {
      const d = ask("REPAIR_CHECK", { checkFailed: true, repairTurns, maxRepairTurns: 1 });
      expect(["repairing", "verifying"]).toContain(d.transition);
    }
  });
});

describe("acceptance_mismatch — one re-prompt, then partial", () => {
  test("the first failure with a turn left buys one re-prompt", () => {
    const d = ask("REPAIR_ACCEPTANCE", {
      failed: true,
      repromptsUsed: 0,
      maxReprompts: 1,
      turnsLeft: 4,
    });
    expect(d.transition).toBe("repairing");
    // The bounded response, named: the criterion's TEXT and the tail of its
    // output. Never the command — that is the oracle, and quoting it teaches
    // the model to satisfy the command instead of the criterion.
    expect(d.reason).toContain("text");
    expect(d.reason).not.toContain("command");
  });

  test("the second failure on the same finish is `partial`, whatever happened", () => {
    const d = ask("REPAIR_ACCEPTANCE", {
      failed: true,
      repromptsUsed: 1,
      maxReprompts: 1,
      turnsLeft: 4,
    });
    expect(d.transition).toBe("complete(partial)");
  });

  test("with no turn left there is no re-prompt at all — straight to partial", () => {
    const d = ask("REPAIR_ACCEPTANCE", {
      failed: true,
      repromptsUsed: 0,
      maxReprompts: 1,
      turnsLeft: 0,
    });
    expect(d.transition).toBe("complete(partial)");
    expect(d.reason).toContain("no turn is left");
  });

  test("it never proposes `complete(met)` — a failed criterion cannot be met", () => {
    for (const repromptsUsed of [0, 1, 2]) {
      for (const turnsLeft of [0, 1, 9]) {
        const d = ask("REPAIR_ACCEPTANCE", {
          failed: true,
          repromptsUsed,
          maxReprompts: 1,
          turnsLeft,
        });
        expect(d.transition).not.toBe("complete(met)");
      }
    }
  });
});

describe("missing_dependency — say so, and retry nothing", () => {
  test("a missing runner falls to the finish; the criterion is left needs_review", () => {
    const d = ask("REPAIR_DEPENDENCY", { missingRunner: true });
    expect(d.transition).toBe("verifying");
    expect(d.reason).toContain("nothing is retried");
    expect(d.reason).toContain("nothing is installed");
  });

  test("R9 — it never proposes `repairing`, so no turn is spent on it", () => {
    expect(ask("REPAIR_DEPENDENCY", { missingRunner: true }).transition).not.toBe("repairing");
  });
});

describe("denied — a boundary, and no route around it", () => {
  test("a halt blocks on the halt", () => {
    expect(ask("REPAIR_DENIED", { halted: true, denied: false }).transition).toBe("blocked(halt)");
  });

  test("R3 — a denial blocks on the ask, and says no alternative is attempted", () => {
    const d = ask("REPAIR_DENIED", { halted: false, denied: true });
    expect(d.transition).toBe("blocked(ask)");
    expect(d.reason).toContain("no alternative route");
  });

  test("it never proposes `working` on a denial, and never `repairing` at all", () => {
    for (const halted of [true, false]) {
      for (const denied of [true, false]) {
        const d = ask("REPAIR_DENIED", { halted, denied });
        expect(d.transition).not.toBe("repairing");
        if (halted || denied) expect(d.transition).not.toBe("working");
      }
    }
  });

  test("it is class 1 — safety outranks every repair", () => {
    expect(GUARD_CLASS.REPAIR_DENIED).toBe(1);
  });
});

describe("no_progress — one nudge, and a re-read is not progress", () => {
  test("movement in the evidence is progress, at any repeat count", () => {
    expect(
      ask("REPAIR_PROGRESS", { evidenceChanged: true, nudges: 9, maxNudges: 1 }).transition,
    ).toBe("working");
  });

  test("the first rut buys one nudge", () => {
    expect(
      ask("REPAIR_PROGRESS", { evidenceChanged: false, nudges: 0, maxNudges: 1 }).transition,
    ).toBe("working");
  });

  test("the spent nudge abandons on no progress", () => {
    expect(
      ask("REPAIR_PROGRESS", { evidenceChanged: false, nudges: 1, maxNudges: 1 }).transition,
    ).toBe("abandoned(no_progress)");
  });

  test("class 5 never completes — the ladder's rule holds for a repair too", () => {
    expect(GUARD_CLASS.REPAIR_PROGRESS).toBe(5);
    for (const nudges of [0, 1, 5]) {
      const d = ask("REPAIR_PROGRESS", { evidenceChanged: false, nudges, maxNudges: 1 });
      expect(d.transition.startsWith("complete(")).toBe(false);
    }
  });
});

describe("the authority keys", () => {
  test("all six ship absent by default — an empty config owns nothing", () => {
    expect(parseAuthority(undefined).size).toBe(0);
    expect(parseAuthority([]).size).toBe(0);
    expect(parseAuthority("").size).toBe(0);
  });

  test("each is parseable, alone and together, from a string or an array", () => {
    const keys = [
      "transport",
      "check_failed",
      "acceptance",
      "missing_dependency",
      "denied",
      "no_progress",
    ];
    for (const key of keys) expect(parseAuthority([key]).has(key as never)).toBe(true);
    expect(parseAuthority(keys.join(",")).size).toBe(6);
    expect(parseAuthority(keys).size).toBe(6);
  });

  test("an unknown token is still dropped, not thrown — a typo may not fail a run", () => {
    expect(parseAuthority(["no_progres", "transport"]).size).toBe(1);
    expect(parseAuthority(4 as unknown).size).toBe(0);
  });
});
