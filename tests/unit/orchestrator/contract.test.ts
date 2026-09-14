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
  type TaskShape,
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
  over: {
    checks?: CheckRun[];
    openSteps?: number;
    totalSteps?: number;
    shape?: TaskShape;
    wrote?: boolean;
  } = {},
) {
  return computeVerdict({
    criteria,
    checks: over.checks ?? [],
    openSteps: over.openSteps ?? 0,
    totalSteps: over.totalSteps ?? 0,
    stopReason: "end_turn",
    ...(over.shape ? { shape: over.shape } : {}),
    ...(over.wrote === undefined ? {} : { wrote: over.wrote }),
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

// ─── A different command must not erase another one's failure ───
//
// Review finding 1 (guarantees-plan-review, 2026-09-14): `failingChecks`
// collapsed whitespace blindly, so two DIFFERENT commands could share one
// identity and the later pass erased the earlier failure.

describe("which recorded checks are the same check", () => {
  test("a pass of a DIFFERENT quoted path does not erase a red check", () => {
    const v = verdictOf([criterion("a", "verified", "node --test checks/")], {
      checks: [
        { command: 'node --test "checks/a  b.test.js"', passed: false, at: 1, kind: "check" },
        { command: 'node --test "checks/a b.test.js"', passed: true, at: 2, kind: "check" },
      ],
    });
    // One verified criterion, no open steps — and still not `met`, because a
    // check is red and nothing re-ran it.
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps).toEqual([
      { criterion: "the checks", why: '`node --test "checks/a  b.test.js"` last failed' },
    ]);
  });

  test("re-running the SAME command does supersede its earlier failure", () => {
    const v = verdictOf([criterion("a", "verified", "node --test checks/")], {
      checks: [
        { command: 'node --test "checks/a  b.test.js"', passed: false, at: 1, kind: "check" },
        { command: 'node   --test  "checks/a  b.test.js"', passed: true, at: 2, kind: "check" },
      ],
    });
    // Same quoted path, different spacing between the arguments: one command,
    // fixed. That is what a green re-run means.
    expect(v.kind).toBe("met");
  });
});

// ─── The shape classifier reads instructions as instructions ───
//
// Review finding 2. Every row of that table is here, plus the cases it
// implied: a mixed ask has a deliverable in it, a steering follow-up is shaped
// by its own words, and text that says nothing either way is `unknown` rather
// than a guess.

describe("contractShape", () => {
  test("a politely phrased instruction is work, not a question", () => {
    expect(contractShape("Can you implement login?", false)).toBe("feature");
    expect(contractShape("could you please add a --json flag?", false)).toBe("feature");
  });

  test("a noun in the thing being built does not select planning", () => {
    expect(contractShape("Implement a design system", false)).toBe("feature");
    expect(contractShape("write the migration strategy module", false)).toBe("feature");
  });

  test("a plan is asked for by the verb or by the object, and only then", () => {
    expect(contractShape("Plan the migration off the old scheduler", false)).toBe("plan");
    expect(contractShape("Propose an approach for the exporter rewrite.", false)).toBe("plan");
    expect(contractShape("give me a rough plan for the rewrite", false)).toBe("plan");
  });

  test("an instruction is never an acknowledgement", () => {
    expect(contractShape("ship it", false)).toBe("feature");
    expect(contractShape("ok, now delete the cache", false)).toBe("feature");
    // What `chat` is actually for: a turn with no deliverable in it at all.
    expect(contractShape("thanks, that looks right", false)).toBe("chat");
    expect(contractShape("perfect, nice one", false)).toBe("chat");
  });

  test("asking to be told something is a question, however imperatively phrased", () => {
    expect(contractShape("Explain how the parser works", false)).toBe("question");
    expect(contractShape("describe the retry policy", false)).toBe("question");
    expect(contractShape("walk me through the exporter", false)).toBe("question");
    expect(contractShape("what does the exporter do?", false)).toBe("question");
  });

  test("a mixed ask is work — the deliverable is the half a contract must hold", () => {
    expect(contractShape("explain the parser, then fix the off-by-one", false)).toBe("feature");
    expect(contractShape("tell me why it fails and add a regression test", false)).toBe("feature");
  });

  test("a follow-up is shaped by its own words, never by its position", () => {
    // The same three messages a person sends after a clean finish.
    expect(contractShape("now also update the README", false)).toBe("feature");
    expect(contractShape("revert that", false)).toBe("feature");
    expect(contractShape("why did that fail?", false)).toBe("question");
  });

  test("text that says nothing either way is `unknown`, not a guess", () => {
    expect(contractShape("the exporter", false)).toBe("unknown");
    expect(contractShape("TypeError: undefined is not a function", false)).toBe("unknown");
    expect(contractShape("   ", false)).toBe("unknown");
  });
});

// ─── A request with no deliverable gets `none`, not `unmet` ───
//
// V-5B, F4. The shape is advisory and cannot flatter a run: `none` needs zero
// criteria AND zero files written, and it never applies to a shape that asked
// for a deliverable.

describe("the verdict on a run that stated no criteria", () => {
  test("a question that wrote nothing is `none`, with its reason", () => {
    const v = verdictOf([], { shape: "question" });
    expect(v.kind).toBe("none");
    if (v.kind === "none") {
      expect(v.reason).toContain("a question, answered");
      expect(verdictLine(v)).toBe(`[verdict] none — ${v.reason}`);
    }
  });

  test("a plan and an acknowledgement are the same case", () => {
    expect(verdictOf([], { shape: "plan" }).kind).toBe("none");
    expect(verdictOf([], { shape: "chat" }).kind).toBe("none");
  });

  test("a question that WROTE a file is back to `unmet` — work with no criteria", () => {
    const v = verdictOf([], { shape: "question", wrote: true });
    expect(v.kind).toBe("unmet");
    expect(v.kind === "unmet" && v.missing).toEqual(["no criteria stated"]);
  });

  test("a shape that asked for a deliverable still owes criteria", () => {
    for (const shape of ["fix", "feature", "unknown"] as TaskShape[]) {
      expect(verdictOf([], { shape }).kind).toBe("unmet");
    }
    // And a caller with no shape at all reads exactly what it read before.
    expect(verdictOf([]).kind).toBe("unmet");
  });

  test("`none` is unreachable once a criterion exists", () => {
    expect(verdictOf([criterion("the answer is written down")], { shape: "question" }).kind).toBe(
      "unmet",
    );
  });
});
