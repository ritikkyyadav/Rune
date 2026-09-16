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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, Criterion } from "../../../packages/protocol/src/index";
import {
  amendContract,
  briefDrift,
  acceptanceCriteria,
  acceptanceDidNotRun,
  discardStagedAcceptance,
  stageAcceptance,
  stagedAcceptanceDrift,
  accepted,
  carryForward,
  computeVerdict,
  contractDigest,
  contractShape,
  createContract,
  criterionStatus,
  inheritContract,
  parseAcceptanceSpecs,
  priorContract,
  uncoveredCriteria,
  verdictLine,
  type TaskContract,
  type TaskShape,
} from "../../../packages/orchestrator/src/contract";
import type { CheckRun } from "../../../packages/orchestrator/src/brief";

const INTENT = "Fix the exporter — it drops the last row.";

function contract(intent = INTENT, fixShaped = true): TaskContract {
  return createContract({ intent, fixShaped, turns: 80, secondWinds: 2 });
}

/**
 * A criterion with the evidence `BriefLedger.record` would have stamped on it.
 *
 * M1: evidence carries the EXECUTION it was priced from, what the verifier
 * saw, and the revision it was taken at. All three are what `criterionStatus`
 * reads, and a hand-built receipt that carries none of them is — correctly —
 * `needs_review`, which is its own test below rather than the shape every
 * other test in this file is written in.
 */
function criterion(text: string, rung: Criterion["rung"] = null, source?: string): Criterion {
  return {
    text,
    rung,
    ...(source
      ? {
          evidence: {
            source,
            parentCommitFailed: true,
            executionId: `chk-${source.length}`,
            verifier: "check-log@1",
            result: "passed" as const,
            head: HEAD,
            dirty: false,
            digest: DIGEST,
          },
        }
      : {}),
  };
}

/** The tree every stamped receipt in this file was taken against. */
const HEAD = "4a91c2ee0000000000000000000000000000beef";
const DIGEST = "d16e57a10c9b2f40";
const NOW = { head: HEAD, dirty: false, digest: DIGEST };

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
    revision?: { head: string | null; dirty: boolean; digest?: string } | null;
    stopReason?: string;
  } = {},
) {
  return computeVerdict({
    criteria,
    checks: over.checks ?? [],
    openSteps: over.openSteps ?? 0,
    totalSteps: over.totalSteps ?? 0,
    stopReason: over.stopReason ?? "end_turn",
    ...(over.shape ? { shape: over.shape } : {}),
    ...(over.wrote === undefined ? {} : { wrote: over.wrote }),
    revision: over.revision === undefined ? NOW : over.revision,
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
    // M1: the count is of ACCEPTED criteria, not of `verified` rungs, and the
    // regression attribution rides beside it instead of being the policy.
    expect(verdictLine(v)).toBe("[verdict] met — 2 of 2 accepted (2 regression-attributed)");
  });

  test("THE AUDIT'S EXAMPLE: green checks, one criterion never settled → `partial`, named", () => {
    const v = verdictOf(
      [
        criterion("the exporter writes every row", "verified", "bun test export.test.ts"),
        // Never cited: the audit's silent case. Green project checks, and
        // nothing anywhere saying this criterion was ever measured.
        criterion("the CSV header is unchanged"),
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
      { criterion: "the CSV header is unchanged", why: "no check bound" },
    ]);
    expect(verdictLine(v)).toContain("1 of 2 accepted");
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

// ─── M1: acceptance is DERIVED, and the rung is not the policy ───
//
// The defect this closes (`guarantees-plan-review-20260914.md` §3): one fact —
// the rung — answered three questions at once, so `verified` (which requires a
// FAILURE on the parent commit) was the acceptance policy. A legitimate new
// feature could never be `met`, because there is nothing to fail on a parent
// commit that never had the feature; and an unrelated green command could be.
//
// Every status below is derived from a fact the runtime recorded: an execution
// id off its own check log, what the verifier saw, and the revision the claim
// was taken at. Nothing the model wrote reaches any of them.

/** Evidence as `BriefLedger.record` stamps it after M1: dated and identified. */
function stamped(over: Partial<NonNullable<Criterion["evidence"]>> = {}) {
  return {
    source: "bun test export.test.ts",
    executionId: "chk-1",
    verifier: "check-log@1",
    result: "passed" as const,
    head: HEAD,
    dirty: false,
    digest: DIGEST,
    ...over,
  };
}

describe("criterionStatus — the derivation, line by line", () => {
  test("no evidence at all is `unassessed`, and it is not a failure", () => {
    expect(criterionStatus({ text: "a", rung: null }, [], NOW)).toBe("unassessed");
  });

  test("T3: a citation the runtime SET ASIDE moves nothing — `unassessed`", () => {
    // F-5B's gate records the refusal on the criterion rather than dropping
    // it. A status derivation that read the receipt and ignored the refusal
    // would hand the forged citation back the acceptance the gate took away.
    const c: Criterion = {
      text: "the CSV header is unchanged",
      rung: null,
      evidence: stamped({ unrelated: "it never reads header.csv" }),
    };
    expect(criterionStatus(c, [], NOW)).toBe("unassessed");
  });

  test("a verifier that recorded a failure is `failed`, with its receipt", () => {
    const c: Criterion = {
      text: "the CSV header is unchanged",
      rung: null,
      evidence: stamped({ result: "failed", verifier: "acceptance-command@1", detail: "exit 1" }),
    };
    expect(criterionStatus(c, [], NOW)).toBe("failed");
  });

  test("a green run superseded by a red one is `failed` — by execution id", () => {
    // The evidence names an EXECUTION, so the log can be asked what that same
    // command did afterwards. With only a command string on the receipt this
    // criterion read `satisfied` while its own check was red.
    const checks: CheckRun[] = [
      {
        command: "bun test export.test.ts",
        passed: true,
        at: 1,
        kind: "check",
        executionId: "chk-1",
      },
      {
        command: "bun test export.test.ts",
        passed: false,
        at: 2,
        kind: "check",
        executionId: "chk-2",
      },
    ];
    const c: Criterion = { text: "a", rung: "observed", evidence: stamped() };
    expect(criterionStatus(c, checks, NOW)).toBe("failed");
  });

  test("T5: the tree moved under the claim → `stale`", () => {
    const c: Criterion = { text: "a", rung: "verified", evidence: stamped() };
    expect(criterionStatus(c, [], { head: HEAD, dirty: false, digest: "0000000000000000" })).toBe(
      "stale",
    );
    // A different HEAD says the same thing, and so does a clean tree gone dirty.
    expect(criterionStatus(c, [], { head: "beef0000", dirty: false, digest: DIGEST })).toBe(
      "stale",
    );
    expect(criterionStatus(c, [], { head: HEAD, dirty: true, digest: DIGEST })).toBe("stale");
  });

  test("T5: evidence that cannot be dated at all → `needs_review`", () => {
    // No head AND no digest: the receipt is about some tree, and there is no
    // way left to say which. "Probably still true" is exactly the sentence the
    // rung ladder exists to make unwritable.
    const c: Criterion = {
      text: "a",
      rung: "verified",
      evidence: { source: "bun test", executionId: "chk-1", result: "passed" },
    };
    expect(criterionStatus(c, [], NOW)).toBe("needs_review");
  });

  test("an execution receipt cannot satisfy a criterion", () => {
    // `echo done` exits 0. So does `git status`. Neither could have FAILED for
    // the criterion it is cited against, and a criterion is settled only by a
    // check that could have. Before M1 the cap held by accident — an execution
    // was capped at `observed` and `met` required `verified` — which is why
    // F-5B left executions out of the relatedness gate. M1 made acceptance a
    // separate fact, so this rule has to carry that weight instead.
    const checks: CheckRun[] = [
      {
        command: "echo done",
        passed: true,
        at: 1,
        kind: "execution",
        exitCode: 0,
        executionId: "chk-1",
      },
    ];
    const cited: Criterion = {
      text: "the exporter writes every row",
      rung: "observed",
      evidence: stamped({
        source: "echo done",
        verifier: "execution-receipt@1",
        detail: "execution receipt only — ran, exit 0, not a recognised check",
      }),
    };
    // The log's `kind` is authoritative while the run is live…
    expect(criterionStatus(cited, checks, NOW)).toBe("needs_review");
    // …and the verifier name is what survives on a saved row read back with no
    // check log behind it, which is exactly what `rune audit` holds.
    expect(criterionStatus(cited, [], NOW)).toBe("needs_review");
    // The log alone is enough even for a row that carries no verifier at all.
    const bare: Criterion = {
      text: "the exporter writes every row",
      rung: "observed",
      evidence: stamped({ source: "echo done", verifier: "check-log@1" }),
    };
    expect(criterionStatus(bare, checks, NOW)).toBe("needs_review");
    // And it cannot be accepted, so the run cannot be `met` on it.
    expect(accepted(cited, "needs_review")).toBe(false);
    expect(verdictOf([cited], { checks }).kind).toBe("partial");
  });

  test("a `review` method is never satisfied by the runtime", () => {
    const c: Criterion = {
      text: "the copy reads well",
      rung: "verified",
      method: { kind: "review" },
      evidence: stamped(),
    };
    expect(criterionStatus(c, [], NOW)).toBe("needs_review");
  });

  test("no revision in hand: nothing can be shown to have moved", () => {
    const c: Criterion = { text: "a", rung: "observed", evidence: stamped() };
    expect(criterionStatus(c, [], null)).toBe("satisfied");
  });

  test("T2: a bound, fresh, passing check settles it whatever the rung says", () => {
    // `observed` — one passing run, the parent probe not applicable, which is
    // every new feature. Accepted, and the outcome says the attribution is
    // `none` rather than pretending a regression was measured.
    const c: Criterion = { text: "version() is exported", rung: "observed", evidence: stamped() };
    expect(criterionStatus(c, [], NOW)).toBe("satisfied");
    expect(accepted(c, "satisfied")).toBe(true);
  });
});

describe("legacy rows are mapped conservatively, never upgraded", () => {
  /** Evidence as a session saved BEFORE M1 holds it: dated, but nothing else. */
  const old = (over: Record<string, unknown> = {}) => ({
    source: "bun test export.test.ts",
    head: HEAD,
    dirty: false,
    digest: DIGEST,
    ...over,
  });

  test("`verified` and `reproduced` still mean the check passed → `satisfied`", () => {
    expect(criterionStatus({ text: "a", rung: "verified", evidence: old() }, [], NOW)).toBe(
      "satisfied",
    );
    expect(criterionStatus({ text: "a", rung: "reproduced", evidence: old() }, [], NOW)).toBe(
      "satisfied",
    );
  });

  test("`observed` might be an execution receipt → `needs_review`, not `satisfied`", () => {
    // A1 caps a bare shell execution at `observed`, so a saved `observed` row
    // is either a check that ran once or a command that merely exited 0 — and
    // the row does not say which. The review's rule is to map conservatively.
    expect(criterionStatus({ text: "a", rung: "observed", evidence: old() }, [], NOW)).toBe(
      "needs_review",
    );
  });

  test("`suspected` and an unmoved criterion are `unassessed`", () => {
    expect(criterionStatus({ text: "a", rung: "suspected", evidence: old() }, [], NOW)).toBe(
      "unassessed",
    );
    expect(criterionStatus({ text: "a", rung: null, evidence: old() }, [], NOW)).toBe("unassessed");
  });

  test("a legacy row whose tree moved is `stale` before it is anything else", () => {
    expect(
      criterionStatus({ text: "a", rung: "verified", evidence: old() }, [], {
        head: "beef0000",
        dirty: false,
      }),
    ).toBe("stale");
  });
});

describe("the verdict reads the status, not the rung", () => {
  test("T2: a new feature reaches `met` with no failing parent anywhere", () => {
    const c: Criterion = {
      text: "version() is exported",
      rung: "observed",
      evidence: stamped({ detail: "1 pass, 0 fail" }),
    };
    const v = verdictOf([c]);
    expect(v.kind).toBe("met");
    expect(v.criteria[0]!.status).toBe("satisfied");
    expect(v.criteria[0]!.attribution).toBe("none");
    expect(verdictLine(v)).toBe("[verdict] met — 1 of 1 accepted");
  });

  test("an optional criterion cannot hold a run back", () => {
    const required: Criterion = { text: "it ships", rung: "observed", evidence: stamped() };
    const optional: Criterion = {
      text: "it is pretty",
      rung: null,
      required: false,
      source: "user",
    };
    const v = verdictOf([required, optional]);
    expect(v.kind).toBe("met");
    expect(v.criteria[1]!.required).toBe(false);
    expect(verdictLine(v)).toBe("[verdict] met — 2 of 2 accepted");
  });

  test("a failed criterion names its receipt in the gap", () => {
    const failing: Criterion = {
      text: "the CSV header is unchanged",
      rung: null,
      source: "evaluator",
      method: { kind: "command", command: "node check-header.mjs" },
      evidence: stamped({
        source: "node check-header.mjs",
        verifier: "acceptance-command@1",
        result: "failed",
        detail: "exit 1",
      }),
    };
    const v = verdictOf([
      criterion("the exporter writes every row", "verified", "bun test"),
      failing,
    ]);
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps[0]).toEqual({
      criterion: "the CSV header is unchanged",
      why: "failed: exit 1",
    });
    expect(verdictLine(v)).toBe(
      // The evaluator clause is new (V6 finding 21): the oracle's own count,
      // beside the acceptance count and never folded into it.
      "[verdict] partial — 1 of 2 accepted (1 regression-attributed); " +
        "evaluator 0 of 1 satisfied; gap: the CSV header is unchanged (failed: exit 1)",
    );
  });

  test("a set-aside citation is uncovered, and the gap says which command was refused", () => {
    const c: Criterion = {
      text: "the CSV header is unchanged",
      rung: null,
      evidence: stamped({ source: "node check.mjs", unrelated: "it never reads header.csv" }),
    };
    const v = verdictOf([criterion("the exporter writes every row", "verified", "bun test"), c]);
    expect(v.kind).toBe("partial");
    expect(v.kind === "partial" && v.gaps[0]!.why).toContain("no check bound");
    expect(v.kind === "partial" && v.gaps[0]!.why).toContain("node check.mjs");
    expect(uncoveredCriteria(v)).toEqual(["the CSV header is unchanged"]);
  });

  test("execution rides every verdict, separate from what was achieved", () => {
    // A run cut off at its turn ceiling with one criterion satisfied is
    // `partial` AND `max_turns`. A consumer given only the first scores it as
    // a task that fell a little short rather than a run that was stopped.
    const v = verdictOf([criterion("a", "verified", "bun test"), criterion("b")], {
      stopReason: "max_turns",
    });
    expect(v.execution).toEqual({ stopReason: "max_turns", status: "max_turns" });
    expect(verdictOf([]).execution).toEqual({ stopReason: "end_turn", status: "end_turn" });
  });

  test("`uncovered` names only REQUIRED criteria nothing measured", () => {
    const v = verdictOf([
      criterion("a", "verified", "bun test"),
      { text: "b", rung: null },
      { text: "c", rung: null, required: false, source: "user" },
    ]);
    expect(uncoveredCriteria(v)).toEqual(["b"]);
  });
});

// ─── M1: what an amendment may and may not do ───
//
// The model proposes criteria; it does not get to shorten the task. A
// read-back that omits a `user` or `evaluator` criterion has that criterion
// put back, and the attempt recorded — because a contract that successfully
// refused to shrink is otherwise byte-identical to one nobody attacked.

describe("amendments keep what the user and the evaluator stated", () => {
  const userCriterion = (text: string): Criterion => ({ text, rung: null, source: "user" });

  test("a `user` criterion the read-back omitted is kept, and the attempt recorded", () => {
    const stated = amendContract(
      contract(),
      brief({ criteria: [userCriterion("the CSV header is unchanged")] }),
      "user",
    );
    const narrowed = amendContract(
      stated,
      brief({ criteria: [criterion("the exporter writes every row")] }),
      "model",
    );
    expect(narrowed.criteria.map((c) => c.text)).toEqual([
      "the exporter writes every row",
      "the CSV header is unchanged",
    ]);
    expect(narrowed.criteria[1]!.source).toBe("user");
    const last = narrowed.amendments.at(-1)!;
    expect(last.origin).toBe("model");
    expect(last.kept).toEqual(["the CSV header is unchanged"]);
    expect(last.removed).toEqual([]);
    expect(narrowed.revision).toBe(stated.revision + 1);
  });

  test("an `evaluator` criterion is protected the same way", () => {
    const evaluator: Criterion = {
      text: "the exported CSV still has three columns",
      rung: null,
      source: "evaluator",
      method: { kind: "command", command: "node check-columns.mjs" },
    };
    const stated = amendContract(contract(), brief({ criteria: [evaluator] }), "runtime");
    const narrowed = amendContract(stated, brief({ criteria: [criterion("a")] }), "model");
    const kept = narrowed.criteria.find((c) => c.source === "evaluator");
    expect(kept?.method).toEqual({ kind: "command", command: "node check-columns.mjs" });
    expect(narrowed.amendments.at(-1)!.kept).toEqual([evaluator.text]);
  });

  test("only a `user` amendment removes one", () => {
    const stated = amendContract(
      contract(),
      brief({ criteria: [userCriterion("the CSV header is unchanged")] }),
      "user",
    );
    const removed = amendContract(stated, brief({ criteria: [criterion("a")] }), "user");
    expect(removed.criteria.map((c) => c.text)).toEqual(["a"]);
    expect(removed.amendments.at(-1)!.removed).toContain("the CSV header is unchanged");
  });

  test("the model may reword its OWN criteria, and its ids do not collide", () => {
    const first = amendContract(contract(), brief({ criteria: [criterion("drops the last row")] }));
    const second = amendContract(first, brief({ criteria: [criterion("writes every row")] }));
    expect(second.criteria.map((c) => c.text)).toEqual(["writes every row"]);
    expect(second.amendments.at(-1)!.removed).toEqual(["drops the last row"]);
    expect(new Set(second.criteria.map((c) => c.id)).size).toBe(second.criteria.length);
    expect(second.criteria[0]!.id).not.toBe(first.criteria[0]!.id);
  });

  test("a criterion restated word for word keeps its id, source and strength", () => {
    // Without this the protection lasted exactly one turn: a read-back that
    // repeated a user-stated criterion verbatim downgraded it to the model's,
    // and the NEXT read-back could drop it freely.
    const optional: Criterion = {
      text: "the CSV header is unchanged",
      rung: null,
      source: "user",
      required: false,
    };
    const stated = amendContract(contract(), brief({ criteria: [optional] }), "user");
    const restated = amendContract(
      stated,
      brief({ criteria: [{ text: "the CSV header is unchanged", rung: null }] }),
      "model",
    );
    expect(restated.criteria[0]!.source).toBe("user");
    expect(restated.criteria[0]!.required).toBe(false);
    expect(restated.criteria[0]!.id).toBe(stated.criteria[0]!.id);
  });

  test("constraints are a union: the `leave` list plus everything a person stated", () => {
    const stated = amendContract(
      contract(),
      brief({ leave: ["src/import.ts"], criteria: [userCriterion("the CSV header is unchanged")] }),
      "user",
    );
    expect(stated.constraints).toEqual(["src/import.ts", "the CSV header is unchanged"]);
    // A later read-back that names a different `leave` list ADDS to them; a
    // constraint the person gave is not the model's to forget by omission.
    const later = amendContract(stated, brief({ leave: ["docs/"], criteria: [criterion("a")] }));
    expect(later.constraints).toContain("src/import.ts");
    expect(later.constraints).toContain("the CSV header is unchanged");
    expect(later.constraints).toContain("docs/");
  });

  test("the ledger's list IS the contract's list, so a kept criterion is citable", () => {
    // The criteria the contract holds and the criteria `record_evidence`
    // indexes into must be one array. A criterion protected on the record and
    // invisible to the run is worse than no protection: the record says it held.
    const stated = amendContract(
      contract(),
      brief({ criteria: [userCriterion("the CSV header is unchanged")] }),
      "user",
    );
    const next = brief({ criteria: [criterion("the exporter writes every row")] });
    const narrowed = amendContract(stated, next, "model");
    expect(next.criteria).toBe(narrowed.criteria);
    expect(next.criteria.map((c) => c.text)).toContain("the CSV header is unchanged");
  });

  test("an amendment that changes nothing and keeps nothing bumps no revision", () => {
    const stated = amendContract(contract(), brief());
    const again = amendContract(stated, brief({ criteria: stated.criteria as Criterion[] }));
    expect(again.revision).toBe(stated.revision);
    expect(again.amendments.length).toBe(stated.amendments.length);
  });
});

describe("what a restarted run inherits from the contract it is continuing", () => {
  test("constraints, revision and the amendment history survive", () => {
    const died = amendContract(
      contract(),
      brief({
        leave: ["src/notes.md"],
        criteria: [{ text: "keep it", rung: null, source: "user" }],
      }),
      "user",
    );
    const fresh = createContract({
      intent: "Carry on — same task.",
      fixShaped: false,
      turns: 40,
      secondWinds: 1,
    });
    expect(fresh.revision).toBe(1);
    expect(fresh.constraints).toEqual([]);

    const resumed = inheritContract(fresh, died);
    expect(resumed.intent).toBe("Carry on — same task.");
    expect(resumed.constraints).toContain("src/notes.md");
    expect(resumed.constraints).toContain("keep it");
    expect(resumed.revision).toBe(died.revision);
    expect(resumed.amendments).toEqual(died.amendments);
  });

  test("with no prior contract nothing is invented", () => {
    const fresh = contract();
    expect(inheritContract(fresh, null)).toEqual(fresh);
  });

  test("`priorContract` reads the newest version-1 row and defaults the M1 fields", () => {
    const legacy = {
      version: 1,
      intent: "an older session's contract",
      scope: { touch: [], leave: [] },
      shape: "fix",
      criteria: [],
      budget: { turns: 80, secondWinds: 2, costUsd: null, deadlineMs: null },
      stop: { onHalt: true, onSpendCap: true, onCriteriaMet: false },
      createdAt: new Date().toISOString(),
    };
    const found = priorContract([
      { event: { type: "brief", payload: {} } },
      { event: { type: "contract", payload: { version: 1, contract: legacy } } },
      { event: { type: "turn_complete", payload: {} } },
    ]);
    expect(found?.intent).toBe("an older session's contract");
    // A row saved before M1 carries none of these; they are defaulted, never
    // guessed at, and never rewritten back onto the saved session.
    expect(found?.revision).toBe(1);
    expect(found?.constraints).toEqual([]);
    expect(found?.amendments).toEqual([]);
    expect(priorContract([{ event: { type: "contract", payload: { version: 2 } } }])).toBeNull();
    expect(priorContract([])).toBeNull();
  });
});

// ─── M1: the acceptance the model never sees ───

describe("the acceptance spec", () => {
  test("a JSON array and a `{ criteria: [...] }` object both parse", () => {
    const rows = [{ text: "a", command: "node a.mjs" }];
    expect(parseAcceptanceSpecs(JSON.stringify(rows))).toEqual(
      parseAcceptanceSpecs(JSON.stringify({ criteria: rows })),
    );
  });

  test("a malformed file is a hard refusal, never an empty list", () => {
    // The worst possible failure of this feature is a file that silently loads
    // nothing: the run then reports `met` against no criteria at all, and the
    // file's author cannot tell that from a run that passed.
    expect(() => parseAcceptanceSpecs("{oops")).toThrow(/not valid JSON/);
    expect(() => parseAcceptanceSpecs('{"nope": 1}')).toThrow(/must be a JSON array/);
    expect(() => parseAcceptanceSpecs("[]")).toThrow(/states no criteria/);
    expect(() => parseAcceptanceSpecs('[{"command":"x"}]')).toThrow(/has no `text`/);
  });

  test("criteria default to evaluator, required, and an `a<n>` id", () => {
    const [first, second] = acceptanceCriteria(
      parseAcceptanceSpecs(
        JSON.stringify([
          { text: "the CSV has a total column", command: "node check.mjs" },
          { text: "the copy reads well", source: "user", required: false },
        ]),
      ),
    );
    expect(first).toEqual({
      text: "the CSV has a total column",
      rung: null,
      id: "a1",
      source: "evaluator",
      method: { kind: "command", command: "node check.mjs" },
    });
    // No command means only a person can settle it — `review`, which derives
    // `needs_review` and is never `satisfied` by the runtime.
    expect(second!.method).toEqual({ kind: "review" });
    expect(second!.source).toBe("user");
    expect(second!.required).toBe(false);
    expect(criterionStatus(second!, [], NOW)).toBe("needs_review");
  });

  test("ids never collide with the read-back's own `c<n>`", () => {
    const acceptance = acceptanceCriteria([{ text: "a", command: "true" }]);
    const c = amendContract(contract(), brief({ criteria: acceptance }), "runtime");
    const both = amendContract(
      c,
      brief({ criteria: [criterion("the exporter writes every row")] }),
    );
    expect(new Set(both.criteria.map((x) => x.id)).size).toBe(both.criteria.length);
  });
});

describe("did the acceptance command actually RUN?", () => {
  test("a runner that collected nothing did not run", () => {
    expect(acceptanceDidNotRun("0 pass\n0 fail\n", 0)).toBe(true);
    expect(acceptanceDidNotRun("collected 0 items", 0)).toBe(true);
    expect(acceptanceDidNotRun("No tests found", 0)).toBe(true);
  });

  test("a runner that is not installed did not run", () => {
    expect(acceptanceDidNotRun("bash: pytest: command not found", 127)).toBe(true);
    expect(acceptanceDidNotRun("anything at all", 127)).toBe(true);
    expect(acceptanceDidNotRun("missing script: acceptance", 1)).toBe(true);
  });

  test("a runner that ran and FAILED is left alone — that is the finding", () => {
    expect(acceptanceDidNotRun("(fail) the total column is missing\n1 fail", 1)).toBe(false);
    expect(acceptanceDidNotRun("3 pass, 0 fail", 0)).toBe(false);
  });
});

describe("staging the acceptance out of the workspace (V6 finding 1)", () => {
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "stage-ws-"));
    mkdirSync(join(dir, ".rune-acceptance"), { recursive: true });
    writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), "console.log('1 pass, 0 fail');\n");
    return dir;
  }

  test("the pin survives the run: a later stage does not re-seed from a rewritten workspace", () => {
    // V7 finding 3. The stage itself is discarded at the end of a run, so the
    // in-workspace copy of the oracle was the seed of every future stage:
    // session 1 rewrote `check.mjs`, session 2 staged the rewrite, and the run
    // that built nothing read `met`. The vault keeps the bytes and the digest
    // outside the workspace, and a workspace copy that no longer hashes to the
    // pin is not staged at all.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const spec = [
      {
        text: "it holds",
        command: "node .rune-acceptance/check.mjs",
        source: "evaluator" as const,
      },
    ];
    const first = stageAcceptance(spec, { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      expect(first.notes).toEqual([]);
      expect(first.pins.map((p) => p.path)).toEqual([".rune-acceptance/check.mjs"]);

      // The model rewrites the workspace copy between runs.
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), "console.log('forged');\n");
      const second = stageAcceptance(spec, { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(readFileSync(second.staged[0]!.to, "utf8")).toBe("console.log('1 pass, 0 fail');\n");
        expect(second.notes.join("\n")).toContain(
          "acceptance script changed in workspace — pinned copy used",
        );
        // The digest pinned at the FIRST intake is unchanged, and is the one
        // the contract row carries.
        expect(second.pins).toEqual(first.pins);
      } finally {
        discardStagedAcceptance(second);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unchanged workspace copy is staged from the workspace, silently", () => {
    // The control: the pin is not a second oracle, it is the same one. A run
    // that touched nothing stages exactly what it always did and says nothing.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const spec = [
      {
        text: "it holds",
        command: "node .rune-acceptance/check.mjs",
        source: "evaluator" as const,
      },
    ];
    const first = stageAcceptance(spec, { workspaceRoot: dir, vault: { dir: vaultDir } });
    const second = stageAcceptance(spec, { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      expect(second.notes).toEqual([]);
      expect(readFileSync(second.staged[0]!.to, "utf8")).toBe("console.log('1 pass, 0 fail');\n");
    } finally {
      discardStagedAcceptance(first);
      discardStagedAcceptance(second);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an in-workspace script is copied out and the command names the copy", () => {
    const dir = workspace();
    const staged = stageAcceptance(
      [{ text: "it holds", command: "node .rune-acceptance/check.mjs", source: "evaluator" }],
      { workspaceRoot: dir },
    );
    try {
      expect(staged.root.startsWith(dir)).toBe(false);
      expect(staged.staged.map((r) => r.from)).toEqual([join(".rune-acceptance", "check.mjs")]);
      expect(staged.specs[0]!.command).toBe(
        `node ${join(staged.root, ".rune-acceptance", "check.mjs")}`,
      );
      expect(Object.keys(staged.digests)).toHaveLength(1);
    } finally {
      discardStagedAcceptance(staged);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an edit inside the workspace after intake changes nothing the runtime will run", () => {
    const dir = workspace();
    const staged = stageAcceptance(
      [{ text: "it holds", command: "node .rune-acceptance/check.mjs", source: "evaluator" }],
      { workspaceRoot: dir },
    );
    try {
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), "console.log('forged');\n");
      const copy = readFileSync(staged.staged[0]!.to, "utf8");
      expect(copy).toBe("console.log('1 pass, 0 fail');\n");
      // And the pin agrees: nothing the gate will run has moved.
      expect(stagedAcceptanceDrift(staged)).toEqual([]);
    } finally {
      discardStagedAcceptance(staged);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a staged file that changes anyway is reported, so the gate can refuse to measure with it", () => {
    const dir = workspace();
    const staged = stageAcceptance(
      [{ text: "it holds", command: "node .rune-acceptance/check.mjs", source: "evaluator" }],
      { workspaceRoot: dir },
    );
    try {
      writeFileSync(staged.staged[0]!.to, "console.log('forged');\n");
      expect(stagedAcceptanceDrift(staged)).toEqual([staged.staged[0]!.to]);
    } finally {
      discardStagedAcceptance(staged);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`files` stages what the command cannot name, and a path outside the workspace is left alone", () => {
    const dir = workspace();
    writeFileSync(join(dir, ".rune-acceptance", "util.mjs"), "export const n = 1;\n");
    const outside = "/opt/acceptance/check.mjs";
    const staged = stageAcceptance(
      [
        {
          text: "it holds",
          command: "node .rune-acceptance/check.mjs",
          files: [".rune-acceptance/util.mjs"],
          source: "evaluator",
        },
        { text: "the other", command: `node ${outside}`, source: "evaluator" },
      ],
      { workspaceRoot: dir },
    );
    try {
      expect(staged.staged.map((r) => r.from).sort()).toEqual(
        [join(".rune-acceptance", "check.mjs"), join(".rune-acceptance", "util.mjs")].sort(),
      );
      expect(staged.specs[1]!.command).toBe(`node ${outside}`);
    } finally {
      discardStagedAcceptance(staged);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a staging base inside the workspace is refused — that would defeat the whole point", () => {
    const dir = workspace();
    const staged = stageAcceptance(
      [{ text: "it holds", command: "node .rune-acceptance/check.mjs", source: "evaluator" }],
      { workspaceRoot: dir, stagingBase: join(dir, "stage") },
    );
    try {
      expect(staged.root.startsWith(dir)).toBe(false);
    } finally {
      discardStagedAcceptance(staged);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the vault fails closed (V8 critical 3, findings 12 and 13)", () => {
  const REAL = "console.log('1 pass, 0 fail');\n";
  const FAKE = "console.log('forged');\n";
  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "stage-ws-"));
    mkdirSync(join(dir, ".rune-acceptance"), { recursive: true });
    writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), REAL);
    return dir;
  }
  const spec = (command = "node .rune-acceptance/check.mjs") => [
    { id: "c1", text: "it holds", command, source: "evaluator" as const },
  ];

  test("the pinned bytes are gone and the workspace copy is a rewrite — nothing is staged", () => {
    // Promoted from `tests/verification/v8-acceptance-vault.test.ts`. Removing
    // only `<vault>/files` and KEEPING the manifest was the worst shape in the
    // whole pin: the code computed `here !== pinned`, knew the script had been
    // rewritten, found no pinned copy to fall back to, and staged the rewrite
    // anyway with an empty `notes` — a fail-open on the one branch that exists
    // to fail closed.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const first = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), FAKE);
      rmSync(join(vaultDir, "files"), { recursive: true, force: true });
      const second = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(second.staged).toEqual([]);
        expect(second.notes.join("\n")).toContain("acceptance pin missing");
        expect(second.unmeasurable).toEqual([
          { criterion: "c1", path: ".rune-acceptance/check.mjs" },
        ]);
        // And the command was not rewritten to a stage that does not exist:
        // the criterion is skipped by the gate, not run against the workspace.
        expect(second.specs[0]!.command).toBe("node .rune-acceptance/check.mjs");
      } finally {
        discardStagedAcceptance(second);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a vault removed WHOLESALE is caught by the pin the contract row remembers", () => {
    // The manifest cannot report its own removal, so the record is the second
    // witness: `installAcceptance` hands the pins off the restored contract row
    // back to the vault, and a path the row names that the manifest has
    // forgotten is a pin whose bytes were removed — not a first intake.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const first = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), FAKE);
      rmSync(vaultDir, { recursive: true, force: true });
      const second = stageAcceptance(spec(), {
        workspaceRoot: dir,
        vault: { dir: vaultDir, knownPins: first.pins },
      });
      try {
        expect(second.staged).toEqual([]);
        expect(second.notes.join("\n")).toContain("acceptance pin missing");
      } finally {
        discardStagedAcceptance(second);
      }
      // V9 finding 15. This assertion used to read `blind.staged.length === 1`:
      // with no contract row there was nothing to know the removal by, so a
      // brand-new session staged the rewrite as a happy first intake with no
      // note at all — reachable from inside a run by removing the vault. The
      // index beside the vault is the witness the manifest cannot be, so the
      // answer no longer depends on which session is asking.
      const blind = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(blind.staged).toEqual([]);
        expect(blind.notes.join("\n")).toContain("acceptance pin missing");
        expect(blind.unmeasurable.length).toBe(1);
      } finally {
        discardStagedAcceptance(blind);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(`${vaultDir}.pins.json`, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the index is the witness when the contract row is gone too (V9 finding 15)", () => {
    // The person's way back is unchanged and is one level up: removing the
    // PINS ROOT takes the index with the vault, which is a guardrail change in
    // 4th gear rather than an ordinary write, and re-pins from the workspace.
    const dir = workspace();
    const root = mkdtempSync(join(tmpdir(), "stage-pins-root-"));
    const vaultDir = join(root, "ws");
    const first = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), FAKE);
      rmSync(root, { recursive: true, force: true });
      const after = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(after.staged.length).toBe(1);
        expect(after.notes).toEqual([]);
      } finally {
        discardStagedAcceptance(after);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second task reusing the path takes its own pin (V8 finding 12)", () => {
    // The manifest was keyed by workspace-relative path, forever, so task B's
    // entirely legitimate `check.mjs` was staged from task A's pin and the note
    // reported the revision as tampering.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const a = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir, taskKey: "task-a" } }); // prettier-ignore
    try {
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), "// task B, a different task\n");
      const b = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir, taskKey: "task-b" } }); // prettier-ignore
      try {
        expect(readFileSync(b.staged[0]!.to, "utf8")).toContain("task B");
        expect(b.notes).toEqual([]);
        // The row still reads as a path, not as a manifest key.
        expect(b.pins.map((p) => p.path)).toContain(".rune-acceptance/check.mjs");
      } finally {
        discardStagedAcceptance(b);
      }
      // And task A's own pin is untouched by task B having run.
      writeFileSync(join(dir, ".rune-acceptance", "check.mjs"), FAKE);
      const a2 = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir, taskKey: "task-a" } }); // prettier-ignore
      try {
        expect(readFileSync(a2.staged[0]!.to, "utf8")).toBe(REAL);
      } finally {
        discardStagedAcceptance(a2);
      }
    } finally {
      discardStagedAcceptance(a);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workspace symlink pointing out of the workspace is not staged (V8 finding 13)", () => {
    // `inside()` is a string test over `resolve()`d paths and `resolve` does not
    // follow links, so `check.mjs -> /outside/real.mjs` read as in-workspace: it
    // was staged and pinned on bytes the workspace does not own, and the target
    // stayed where the run could still edit it under a pin saying it was copied.
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-"));
    const outside = mkdtempSync(join(tmpdir(), "stage-outside-"));
    writeFileSync(join(outside, "real.mjs"), "console.log('OUTSIDE');\n");
    rmSync(join(dir, ".rune-acceptance", "check.mjs"), { force: true });
    symlinkSync(join(outside, "real.mjs"), join(dir, ".rune-acceptance", "check.mjs"));
    const staged = stageAcceptance(spec(), { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      expect(staged.staged).toEqual([]);
      expect(staged.pins).toEqual([]);
      // Nothing was rewritten either: the command names what the author wrote.
      expect(staged.specs[0]!.command).toBe("node .rune-acceptance/check.mjs");
    } finally {
      discardStagedAcceptance(staged);
      rmSync(outside, { recursive: true, force: true });
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ─── V9 finding 16: what the check LOADS, and never says it loads ───
  //
  // `files:` pins what the author named. A check that imports a sibling helper
  // the author did not list was not staged, not pinned, and rewriting that
  // helper — which is rewriting what the oracle measures — produced no note at
  // all. Static resolution is a real limit and it is stated in the code: a path
  // the check builds at runtime is not here.
  test("a sibling the check imports is pinned even though nobody named it", () => {
    const dir = workspace();
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-dep-"));
    writeFileSync(join(dir, ".rune-acceptance", "helper.mjs"), "export const LIMIT = 1;\n");
    writeFileSync(
      join(dir, ".rune-acceptance", "check.mjs"),
      "import { LIMIT } from './helper.mjs';\nconsole.log(LIMIT);\n",
    );
    const bare = [
      {
        id: "c1",
        text: "the limit holds",
        command: "node .rune-acceptance/check.mjs",
        source: "evaluator" as const,
      },
    ];
    const first = stageAcceptance(bare, { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      expect(first.pins.map((p) => p.path).sort()).toEqual([
        ".rune-acceptance/check.mjs",
        ".rune-acceptance/helper.mjs",
      ]);
      expect(first.notes).toEqual([]);
      // Rewriting the dependency is rewriting the oracle, and it is said.
      writeFileSync(join(dir, ".rune-acceptance", "helper.mjs"), "export const LIMIT = 9999;\n");
      const second = stageAcceptance(bare, { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(second.notes.join("\n")).toContain("helper.mjs");
        // …and the check is run against the PINNED helper, not the rewrite.
        expect(readFileSync(join(second.root, ".rune-acceptance", "helper.mjs"), "utf8")).toContain(
          "LIMIT = 1",
        );
      } finally {
        discardStagedAcceptance(second);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(`${vaultDir}.pins.json`, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fixture the check reads through a link is witnessed, not staged", () => {
    // The link points out of the tree, so the bytes are not the workspace's to
    // stage (V8 finding 13) — but they ARE what the oracle grades against, so
    // the digest is pinned as a witness and a change is reported.
    const dir = workspace();
    const outside = mkdtempSync(join(tmpdir(), "stage-outside-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "stage-vault-fx-"));
    writeFileSync(join(outside, "fixture.json"), '{"expected":1}\n');
    symlinkSync(join(outside, "fixture.json"), join(dir, ".rune-acceptance", "fixture.json"));
    writeFileSync(
      join(dir, ".rune-acceptance", "check.mjs"),
      "import f from './fixture.json' with { type: 'json' };\nprocess.exit(f.expected === 1 ? 0 : 1);\n",
    );
    const bare = [
      {
        id: "c1",
        text: "the fixture says 1",
        command: "node .rune-acceptance/check.mjs",
        source: "evaluator" as const,
      },
    ];
    const first = stageAcceptance(bare, { workspaceRoot: dir, vault: { dir: vaultDir } });
    try {
      expect(first.pins.map((p) => p.path)).toContain(".rune-acceptance/fixture.json");
      // Witnessed, never copied: nothing outside the workspace is staged.
      expect(first.staged.map((r) => r.from)).not.toContain(".rune-acceptance/fixture.json");
      writeFileSync(join(outside, "fixture.json"), '{"expected":999}\n');
      const second = stageAcceptance(bare, { workspaceRoot: dir, vault: { dir: vaultDir } });
      try {
        expect(second.notes.join("\n")).toContain("fixture.json");
        expect(second.notes.join("\n")).toContain("does not own");
      } finally {
        discardStagedAcceptance(second);
      }
    } finally {
      discardStagedAcceptance(first);
      rmSync(vaultDir, { recursive: true, force: true });
      rmSync(`${vaultDir}.pins.json`, { force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a check the run authored (V6 finding 3)", () => {
  const cited = (over: Record<string, unknown> = {}): Criterion => ({
    text: "the exporter writes every row",
    rung: "observed",
    evidence: {
      source: "sh verify-header.sh",
      executionId: "chk-1",
      verifier: "check-log@1",
      result: "passed",
      head: "abc123",
      dirty: true,
      digest: "d0",
      ...over,
    },
  });
  const run = (over: Record<string, unknown> = {}) => [
    {
      command: "sh verify-header.sh",
      passed: true,
      at: 1,
      kind: "check" as const,
      executionId: "chk-1",
      ...over,
    },
  ];
  const now = { head: "abc123", dirty: true, digest: "d0" };

  test("a check nobody authored still settles its criterion", () => {
    expect(criterionStatus(cited(), run(), now)).toBe("satisfied");
  });

  test("a check whose program this run wrote cannot settle one", () => {
    expect(criterionStatus(cited(), run({ authoredBy: "verify-header.sh" }), now)).toBe(
      "needs_review",
    );
  });

  test("the verifier name carries the same refusal onto a saved row with no log behind it", () => {
    expect(criterionStatus(cited({ verifier: "self-authored-check@1" }), [], now)).toBe(
      "needs_review",
    );
  });
});

describe("an acceptance command that could not have failed (V6 finding 25)", () => {
  test("`true`, `:` and `exit 0` did not run a check", () => {
    // They exit 0 and print nothing, so no runner-shaped "0 tests" line exists
    // for the false-positive defence to read, and the criterion used to derive
    // `satisfied` on the strength of an exit code nothing produced.
    expect(acceptanceDidNotRun("", 0, "true")).toBe(true);
    expect(acceptanceDidNotRun("", 0, ":")).toBe(true);
    expect(acceptanceDidNotRun("", 0, "exit 0")).toBe(true);
    expect(acceptanceDidNotRun("", 0, "true && true")).toBe(true);
  });

  test("a real command is untouched, whatever it prints", () => {
    expect(acceptanceDidNotRun("1 pass, 0 fail", 0, "node check.mjs")).toBe(false);
    expect(acceptanceDidNotRun("3 pass", 0, "bun test")).toBe(false);
    // `exit 1` is a FAILING check, not an absent one.
    expect(acceptanceDidNotRun("(fail) missing", 1, "exit 1")).toBe(false);
  });
});

describe("the evaluator count is reported beside the kind (V6 finding 21)", () => {
  const evaluator = (status: "satisfied" | "failed"): Criterion => ({
    text: status === "satisfied" ? "the endpoint answers" : "the header has a total column",
    rung: status === "satisfied" ? "observed" : null,
    source: "evaluator",
    method: { kind: "command", command: "node check.mjs" },
    evidence: {
      source: "node check.mjs",
      executionId: "chk-1",
      verifier: "acceptance-command@1",
      result: status === "satisfied" ? "passed" : "failed",
      head: "abc123",
      dirty: true,
      digest: "d0",
    },
  });
  const inputs = (criteria: Criterion[]) => ({
    criteria,
    checks: [],
    openSteps: 0,
    totalSteps: 0,
    stopReason: "end_turn",
    revision: { head: "abc123", dirty: true, digest: "d0" },
  });

  test("the oracle's own count rides every kind, and does not change `met`", () => {
    const met = computeVerdict(inputs([evaluator("satisfied")]));
    expect(met.kind).toBe("met");
    expect(met.evaluators).toEqual({ satisfied: 1, total: 1 });
    expect(verdictLine(met)).toContain("evaluator 1 of 1 satisfied");

    const partial = computeVerdict(inputs([evaluator("satisfied"), evaluator("failed")]));
    expect(partial.kind).toBe("partial");
    expect(partial.evaluators).toEqual({ satisfied: 1, total: 2 });
  });

  test("a run with no acceptance configured says nothing about evaluators", () => {
    const v = computeVerdict(inputs([{ text: "it works", rung: null }]));
    expect(v.evaluators).toBeUndefined();
    expect(verdictLine(v)).not.toContain("evaluator");
  });
});
