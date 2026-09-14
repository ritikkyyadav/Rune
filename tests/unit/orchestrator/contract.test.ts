/**
 * The task contract, and the verdict every exit owes it (Phase 5B).
 *
 * The hole this closes, from the guard inventory: `BriefLedger.complete`
 * already computed the completion question and NO terminal path consulted it,
 * so a run with 0 of 6 criteria verified ended `end_turn`, `ok: true`, exit 0
 * and printed "not done — 0 of 6" underneath. These are the rules that answer
 * it, tested where they are decided rather than through a run.
 *
 * Two invariants hold this together and both are asserted below: `intent` is
 * the user's message VERBATIM and no amendment may rewrite it, and nothing the
 * model wrote reaches the verdict — every rung here comes from `Criterion.rung`,
 * which only `BriefLedger.record` can move and only from the runtime's own
 * check log.
 */

import { describe, expect, test } from "bun:test";
import type { Brief, Criterion } from "../../../packages/protocol/src/index";
import {
  amendContract,
  briefDrift,
  carryForward,
  computeVerdict,
  contractDigest,
  contractShape,
  createContract,
  verdictLine,
  type TaskContract,
} from "../../../packages/orchestrator/src/contract";
import type { CheckRun } from "../../../packages/orchestrator/src/brief";

const INTENT = "Fix the exporter — it drops the last row.";

function contract(intent = INTENT, fixShaped = true): TaskContract {
  return createContract({ intent, fixShaped, turns: 80, secondWinds: 2 });
}

function criterion(text: string, rung: Criterion["rung"] = null, source?: string): Criterion {
  return {
    text,
    rung,
    ...(source ? { evidence: { source, parentCommitFailed: true } } : {}),
  };
}

function brief(over: Partial<Brief> = {}): Brief {
  return {
    reading: "the export is dropping the last row",
    touch: ["src/export.ts"],
    leave: ["src/import.ts"],
    criteria: [criterion("the exporter writes every row")],
    request: INTENT,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function verdictOf(
  criteria: Criterion[],
  over: { checks?: CheckRun[]; openSteps?: number; totalSteps?: number } = {},
) {
  return computeVerdict({
    criteria,
    checks: over.checks ?? [],
    openSteps: over.openSteps ?? 0,
    totalSteps: over.totalSteps ?? 0,
    stopReason: "end_turn",
  });
}

describe("the contract at intake", () => {
  test("intent is the user's message, verbatim", () => {
    const messy = "  fix   the   exporter\n\nit drops the last row  ";
    const c = createContract({ intent: messy, fixShaped: true, turns: 80, secondWinds: 2 });
    // Not trimmed, not collapsed, not summarised: the drift check downstream
    // is only meaningful if one side of it is the untouched original.
    expect(c.intent).toBe(messy);
  });

  test("it exists with no criteria at all — read_back is the model's choice", () => {
    const c = contract();
    expect(c.version).toBe(1);
    expect(c.criteria).toEqual([]);
    expect(c.scope).toEqual({ touch: [], leave: [] });
    expect(c.budget.turns).toBe(80);
    expect(c.budget.secondWinds).toBe(2);
    expect(c.stop.onHalt).toBe(true);
  });

  test("the shape is the mechanical guess, and `fix` is the gate's own predicate", () => {
    expect(contract().shape).toBe("fix");
    expect(contractShape("Add a version() endpoint to src/api.ts", false)).toBe("feature");
    expect(contractShape("What does the exporter do with the last row?", false)).toBe("question");
    expect(contractShape("Plan the migration off the old scheduler", false)).toBe("plan");
    // The loop's predicate decides `fix`, not a second regex that could drift
    // from it: whatever `isFixShaped` answers is what the contract records.
    expect(contractShape("Add a version() endpoint", true)).toBe("fix");
  });
});

describe("the amendment", () => {
  test("the read-back supplies criteria and scope; intent never moves", () => {
    const before = contract();
    const after = amendContract(before, brief());
    expect(after.intent).toBe(before.intent);
    expect(after.shape).toBe(before.shape);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.criteria.map((c) => c.text)).toEqual(["the exporter writes every row"]);
    expect(after.scope).toEqual({ touch: ["src/export.ts"], leave: ["src/import.ts"] });
    // Amended, not replaced: the original object is untouched.
    expect(before.criteria).toEqual([]);
  });

  test("a brief read back from a DIFFERENT request records the drift", () => {
    const before = contract();
    const drifted = brief({ request: "Make the exporter faster." });
    expect(briefDrift(before, drifted)).toBe("Make the exporter faster.");
    const after = amendContract(before, drifted);
    expect(after.drift).toBe("Make the exporter faster.");
    // …and the intent still says what was actually asked.
    expect(after.intent).toBe(INTENT);
  });

  test("a brief read back from the same request declares no drift", () => {
    const after = amendContract(contract(), brief());
    expect(briefDrift(contract(), brief())).toBeNull();
    expect(after.drift).toBeUndefined();
  });

  test("a resumed run inherits the criteria and records no drift", () => {
    // The run it continues died with work open, so its criteria are still in
    // force — and nothing was read back HERE, so there is nothing to drift
    // from. Without this a resume reported "no criteria stated" while the
    // restored ledger held verified ones.
    const resumed = createContract({
      intent: "Now finish the verification step and nothing else.",
      fixShaped: false,
      turns: 40,
      secondWinds: 1,
    });
    const carried = carryForward(resumed, brief());
    expect(carried.criteria.map((c) => c.text)).toEqual(["the exporter writes every row"]);
    expect(carried.intent).toBe("Now finish the verification step and nothing else.");
    expect(carried.drift).toBeUndefined();
  });

  test("the criteria are the LEDGER's objects, so a later rung is on the contract", () => {
    const live = criterion("the exporter writes every row");
    const after = amendContract(contract(), brief({ criteria: [live] }));
    live.rung = "verified";
    live.evidence = { source: "bun test export.test.ts", parentCommitFailed: true };
    expect(after.criteria[0]!.rung).toBe("verified");
  });
});

describe("the digest", () => {
  test("an amendment that changes nothing writes no row", () => {
    const c = contract();
    expect(contractDigest(c)).toBe(contractDigest({ ...c }));
    expect(contractDigest(amendContract(c, brief()))).not.toBe(contractDigest(c));
  });

  test("a rung moving IS a change — the contract's state, not just its text", () => {
    const live = criterion("the exporter writes every row");
    const amended = amendContract(contract(), brief({ criteria: [live] }));
    const before = contractDigest(amended);
    live.rung = "observed";
    expect(contractDigest(amended)).not.toBe(before);
  });
});

describe("the verdict", () => {
  test("no criteria stated is `unmet` — including the run that never read back", () => {
    const v = verdictOf([]);
    expect(v.kind).toBe("unmet");
    expect(v.kind === "unmet" && v.missing).toEqual(["no criteria stated"]);
    expect(verdictLine(v)).toBe("[verdict] unmet — no criteria stated");
  });

  test("criteria stated and not one of them ever moved is `unmet`", () => {
    const v = verdictOf([criterion("a"), criterion("b")]);
    expect(v.kind).toBe("unmet");
    expect(v.kind === "unmet" && v.missing).toEqual(["a", "b"]);
  });

  test("every criterion verified and no open step is `met`", () => {
    const v = verdictOf([
      criterion("a", "verified", "bun test a.test.ts"),
      criterion("b", "verified", "bunx tsc --noEmit"),
    ]);
    expect(v.kind).toBe("met");
    expect(v.criteria.map((c) => c.evidence)).toEqual(["bun test a.test.ts", "bunx tsc --noEmit"]);
    expect(verdictLine(v)).toBe("[verdict] met — 2 of 2 criteria verified");
  });

  test("THE AUDIT'S EXAMPLE: green checks, one criterion short → `partial`, named", () => {
    const v = verdictOf(
      [
        criterion("the exporter writes every row", "verified", "bun test export.test.ts"),
        criterion("the CSV header is unchanged", "observed", "bun test export.test.ts"),
      ],
      {
        checks: [
          { command: "bunx tsc --noEmit", passed: true, at: 1, kind: "check" },
          { command: "bun test", passed: true, at: 2, kind: "check" },
        ],
      },
    );
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps).toEqual([
      { criterion: "the CSV header is unchanged", why: "reached observed, not verified" },
    ]);
    expect(verdictLine(v)).toContain("1 of 2 criteria verified");
    expect(verdictLine(v)).toContain("the CSV header is unchanged");
  });

  test("every criterion verified but the plan left open is NOT `met`", () => {
    const v = verdictOf([criterion("a", "verified", "bun test a.test.ts")], {
      openSteps: 2,
      totalSteps: 5,
    });
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps).toEqual([
      { criterion: "the plan", why: "2 of 5 planned steps still open" },
    ]);
  });

  test("a check whose LATEST run failed is a gap, whatever the criteria say", () => {
    const v = verdictOf([criterion("a", "verified", "bun test a.test.ts")], {
      checks: [
        { command: "bun test", passed: false, at: 1, kind: "check" },
        { command: "bunx tsc --noEmit", passed: true, at: 2, kind: "check" },
      ],
    });
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps).toEqual([
      { criterion: "the checks", why: "`bun test` last failed" },
    ]);
  });

  test("a check that failed and then passed is not a gap", () => {
    const v = verdictOf([criterion("a", "verified", "bun test a.test.ts")], {
      checks: [
        { command: "bun test", passed: false, at: 1, kind: "check" },
        { command: "bun  test", passed: true, at: 2, kind: "check" },
      ],
    });
    expect(v.kind).toBe("met");
  });

  test("an ordinary command that exited non-zero is an action, not a verdict", () => {
    const v = verdictOf([criterion("a", "verified", "bun test a.test.ts")], {
      checks: [{ command: "git status", passed: false, at: 1, kind: "execution" }],
    });
    expect(v.kind).toBe("met");
  });

  test("no model prose can reach it — only rungs and the runtime's own records", () => {
    // A criterion the model would call done, with no rung and no evidence.
    const v = verdictOf([criterion("shipped it, all good")]);
    expect(v.kind).toBe("unmet");
    expect(v.criteria[0]!.evidence).toBeUndefined();
  });
});
