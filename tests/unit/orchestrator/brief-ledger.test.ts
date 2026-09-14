/**
 * The point of the brief is that "done" stops being something the model can
 * assert. These tests are that guarantee. If any of them can be made to pass
 * by a model writing a confident sentence, the guarantee is gone.
 */

import { describe, test, expect } from "bun:test";
import {
  BriefLedger,
  briefFromArgs,
  createReadBackTool,
  READ_BACK_SCHEMA,
  RUNG_GLYPH,
  CLAIM_RUNGS,
  type Brief,
} from "../../../packages/orchestrator/src/brief";
import { computeVerdict } from "../../../packages/orchestrator/src/contract";

function brief(): Brief {
  return briefFromArgs(
    {
      reading: "You want a 429 to surface instead of disappearing into the retry loop.",
      touch: ["src/http/retry.ts"],
      leave: ["the rate-limit budget in config.ts — you said don't"],
      done_when: ["a 429 raises RateLimitError", "suite green on 3 runs"],
    },
    "fix the retry thing, it's swallowing rate limits",
    "2026-08-27T00:00:00.000Z",
  );
}

describe("the brief", () => {
  test("criteria always arrive unmet — the model cannot pre-declare success", () => {
    const b = brief();
    expect(b.criteria).toHaveLength(2);
    for (const c of b.criteria) {
      expect(c.rung).toBeNull();
      expect(c.evidence).toBeUndefined();
    }
    expect(new BriefLedger(b).complete).toBe(false);
  });

  test("the schema does not offer the model any way to set a rung", () => {
    const props = (READ_BACK_SCHEMA.inputSchema as any).properties;
    // `kind` (P11.1) is the model's one revision of the task kind — it picks a
    // layout and touches no criterion. Everything else here is the read-back.
    expect(Object.keys(props).sort()).toEqual(["done_when", "kind", "leave", "reading", "touch"]);
    expect(props.kind.enum).toContain("investigate");
    // done_when is a list of plain strings — no object with a status field.
    expect(props.done_when.items).toEqual({ type: "string" });
  });

  test("`leave` survives verbatim — it is the field that proves the boundary", () => {
    expect(brief().leave).toEqual(["the rate-limit budget in config.ts — you said don't"]);
  });

  test("the verbatim request is kept, so drift is checkable later", () => {
    expect(brief().request).toBe("fix the retry thing, it's swallowing rate limits");
  });
});

describe("the ledger — what it takes to move a criterion", () => {
  test("evidence without a source is prose wearing a struct, and is refused", () => {
    const l = new BriefLedger(brief());
    const r = l.record(0, "observed", { source: "   " });
    expect(r.ok).toBe(false);
    expect(l.met).toBe(0);
  });

  test("`verified` is refused without a parent-commit failure", () => {
    const l = new BriefLedger(brief());
    const r = l.record(0, "verified", {
      source: "bun test tests/http/retry.test.ts",
      detail: "44/44 passing",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("parent commit");
    expect(l.met).toBe(0);
    expect(l.complete).toBe(false);
  });

  test("`verified` is granted once the check is shown to have failed on the parent", () => {
    const l = new BriefLedger(brief());
    const r = l.record(0, "verified", {
      source: "bun test tests/http/retry.test.ts",
      detail: "44/44 passing",
      parentCommitFailed: true,
      parentCommit: "4a91c2e",
    });
    expect(r.ok).toBe(true);
    expect(l.met).toBe(1);
    expect(l.total).toBe(2);
    expect(l.complete).toBe(false); // one criterion still open
  });

  test("weaker rungs need evidence but not a parent commit", () => {
    const l = new BriefLedger(brief());
    expect(l.record(0, "observed", { source: "curl -i localhost/x", detail: "HTTP 429" }).ok).toBe(
      true,
    );
    expect(
      l.record(1, "reproduced", { source: "bun test --rerun 2", detail: "failed twice" }).ok,
    ).toBe(true);
    // …but neither counts as done.
    expect(l.met).toBe(0);
    expect(l.complete).toBe(false);
  });

  test("a criterion cannot quietly weaken", () => {
    const l = new BriefLedger(brief());
    l.record(0, "reproduced", { source: "bun test --rerun 2" });
    const down = l.record(0, "suspected", { source: "hmm" });
    expect(down.ok).toBe(false);
    // An explicit downgrade is allowed — silence is what's banned.
    expect(l.record(0, "suspected", { source: "hmm" }, true).ok).toBe(true);
  });

  test("an unknown criterion cannot be invented mid-run", () => {
    expect(
      new BriefLedger(brief()).record(9, "verified", { source: "x", parentCommitFailed: true }).ok,
    ).toBe(false);
  });

  test("complete means every criterion verified — nothing else", () => {
    const b = brief();
    const l = new BriefLedger(b);
    const ev = { source: "bun test", parentCommitFailed: true, parentCommit: "4a91c2e" };
    l.record(0, "verified", ev);
    expect(l.complete).toBe(false);
    l.record(1, "verified", ev);
    expect(l.complete).toBe(true);
    expect(l.met).toBe(2);
  });

  test("the verdict is `met` exactly when the ledger is complete and no step is open", () => {
    // Phase 5B: `complete` computed the completion question from the day it
    // was written and NO terminal path consulted it. This is that wiring, as
    // an equivalence — the verdict may not be looser than the ledger, and it
    // may not be `met` on a plan the run walked away from.
    const b = brief();
    // M1: the ledger is given the revision function the Engine always gives
    // it. Evidence that cannot be dated to any tree derives `needs_review`,
    // never `satisfied` — which is the T5 rule, tested on its own in
    // `contract.test.ts`, and not what this equivalence is about.
    const at = { head: "4a91c2ee", dirty: false, digest: "d16e57a10c9b2f40" };
    const l = new BriefLedger(b, () => at);
    const ev = {
      source: "bun test",
      parentCommitFailed: true,
      parentCommit: "4a91c2e",
      executionId: "chk-1",
      verifier: "check-log@1",
      result: "passed" as const,
    };
    const verdict = (openSteps = 0) =>
      computeVerdict({
        criteria: l.criteria,
        checks: [],
        openSteps,
        totalSteps: openSteps === 0 ? 0 : openSteps + 1,
        stopReason: "end_turn",
        revision: at,
      });

    expect(l.complete).toBe(false);
    expect(verdict().kind).not.toBe("met");
    l.record(0, "verified", ev);
    expect(l.complete).toBe(false);
    expect(verdict().kind).toBe("partial");
    l.record(1, "verified", ev);
    expect(l.complete).toBe(true);
    expect(verdict().kind).toBe("met");
    // …and the plan still has the last word.
    expect(verdict(1).kind).toBe("partial");
  });

  test("the close mirrors the open — same criteria, same order, with receipts", () => {
    const b = brief();
    const l = new BriefLedger(b);
    l.record(0, "verified", {
      source: "retry.test.ts:88",
      detail: "failed on 4a91c2e, passes here",
      parentCommitFailed: true,
    });
    const close = l.close();
    expect(close.rows.map((r) => r.text)).toEqual(b.criteria.map((c) => c.text));
    expect(close.rows[0]!.receipt).toBe("retry.test.ts:88 — failed on 4a91c2e, passes here");
    expect(close.rows[1]!.receipt).toBe("no evidence yet");
    expect(close.met).toBe(1);
  });
});

describe("the claim ladder", () => {
  test("there is no rung for 'probably'", () => {
    expect(CLAIM_RUNGS).toEqual(["suspected", "observed", "reproduced", "verified"]);
    expect(CLAIM_RUNGS as readonly string[]).not.toContain("probably");
    expect(CLAIM_RUNGS as readonly string[]).not.toContain("likely");
  });

  test("every rung glyph is one cell in both modes", () => {
    for (const rung of CLAIM_RUNGS) {
      const g = RUNG_GLYPH[rung];
      expect([...g.utf8]).toHaveLength(1);
      expect([...g.ascii]).toHaveLength(1);
    }
  });
});

describe("the read_back tool", () => {
  test("refuses a brief with no criteria — a contract with no terms is not one", () => {
    const tool = createReadBackTool(
      () => undefined,
      () => "req",
      () => {},
    );
    expect(tool.validate({ reading: "I think you want X" }).valid).toBe(false);
    expect(tool.validate({ reading: "", done_when: ["x"] }).valid).toBe(false);
    expect(tool.validate({ reading: "I think you want X", done_when: ["tests pass"] }).valid).toBe(
      true,
    );
  });

  test("headless still records the brief rather than skipping it", async () => {
    let captured: Brief | null = null;
    const tool = createReadBackTool(
      () => undefined,
      () => "the ask",
      (b) => (captured = b),
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "read_back",
      args: { reading: "You want X", done_when: ["tests pass"] },
    } as any);
    expect(out.success).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.request).toBe("the ask");
  });

  test("a rejected read-back tells the agent to read back again, not to proceed", async () => {
    const tool = createReadBackTool(
      () => async () => ({ accepted: false, note: "no, the p99, not the cold start" }),
      () => "make it faster",
      () => {},
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "read_back",
      args: { reading: "You want the cold start fixed", done_when: ["under 1s"] },
    } as any);
    expect(out.result).toContain("Read back again");
    expect(out.result).toContain("no, the p99");
    expect(out.result).not.toContain("Accepted");
  });

  test("an edited read-back is what gets recorded, not what the model proposed", async () => {
    let captured: Brief | null = null;
    const tool = createReadBackTool(
      () => async (b) => ({
        accepted: true,
        edited: { ...b, reading: "You want the p99 on /search" },
      }),
      () => "make it faster",
      (b) => (captured = b),
    );
    await tool.execute({
      callId: "c1",
      toolName: "read_back",
      args: { reading: "You want the cold start fixed", done_when: ["under 1s"] },
    } as any);
    expect(captured!.reading).toBe("You want the p99 on /search");
  });
});

// ─── The rung comes from the runtime, never from the model ───
// The first version of this let the model name a rung and made the ledger
// argue. An argument the model can restate more confidently is one it
// eventually wins, so the model no longer names rungs at all: it points at a
// criterion and cites a command, and the log decides what that is worth.

import {
  CheckLog,
  criterionScope,
  rungForCommand,
  createRecordEvidenceTool,
  summarizeCheck,
} from "../../../packages/orchestrator/src/brief";

function logWith(runs: Array<[string, boolean, string?]>): CheckLog {
  const log = new CheckLog();
  runs.forEach(([command, passed, summary], i) => log.record({ command, passed, at: i, summary }));
  return log;
}

describe("what a cited command is worth", () => {
  test("an unclassified execution is observed once without replaying or upgrading it", async () => {
    const command = "bun -e 'console.log(42)'";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", at: 1 });
    log.record({ command, passed: true, kind: "execution", at: 2 });
    log.recordParent({ command, status: "failed" });
    expect(rungForCommand(log, command)).toMatchObject({ ok: true, rung: "observed" });
    const other = new CheckLog();
    other.record({ command, passed: true, kind: "execution", at: 1 });
    let probes = 0;
    const tool = createRecordEvidenceTool(
      () => new BriefLedger(brief()),
      () => other,
      () => {
        probes++;
        return { command, status: "failed" };
      },
    );
    const result = await tool.execute({
      callId: "exec",
      toolName: "record_evidence",
      args: { criterion: 0, command },
      sessionId: "s",
      workspaceRoot: "/tmp",
    });
    expect(probes).toBe(0);
    expect(result.result).toContain("execution receipt only");
    expect(result.result).not.toContain("never ran");
  });
  test("a command that never ran is not evidence", () => {
    const v = rungForCommand(logWith([]), "bun test");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("never ran");
  });

  test("a currently-failing command cannot settle anything", () => {
    const v = rungForCommand(logWith([["bun test", false, "1 failed"]]), "bun test");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("FAILED");
  });

  test("one passing run is `observed` — no more", () => {
    const v = rungForCommand(logWith([["bun test", true, "44/44"]]), "bun test");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("observed");
      expect(v.evidence.parentCommitFailed).toBeUndefined();
    }
  });

  test("two passing runs is `reproduced` — still not done", () => {
    const v = rungForCommand(
      logWith([
        ["bun test", true],
        ["bun test", true],
      ]),
      "bun test",
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rung).toBe("reproduced");
  });

  // The old rule read in-session red→green as the parent-commit rule "met by
  // the log itself". It is not the same claim, and the difference is the most
  // ordinary shape of agent work there is: break a test, fix your own break,
  // watch it go red→green while the parent commit was green throughout.
  test("in-session red→green is NOT `verified` — the agent may have broken it itself", () => {
    const v = rungForCommand(
      logWith([
        ["bun test tests/http", false, "1 failed"],
        ["bun test tests/http", true, "44/44"],
      ]),
      "bun test tests/http",
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("observed");
      expect(v.evidence.detail).not.toContain("passed 2 times");
      expect(v.evidence.parentCommitFailed).toBeUndefined();
    }
  });

  test("a failed run interrupts earlier successful reproductions", () => {
    const log = logWith([
      ["bun test", true],
      ["bun test", true],
      ["bun test", false],
      ["bun test", true],
    ]);
    const recovered = rungForCommand(log, "bun test");
    expect(recovered.ok && recovered.rung).toBe("observed");
    log.record({ command: "bun test", passed: true, at: 5 });
    const repeated = rungForCommand(log, "bun test");
    expect(repeated.ok && repeated.rung).toBe("reproduced");
    expect(repeated.ok && repeated.evidence.detail).toContain("passed 2 times");
  });

  test("a recorded parent-commit FAILURE is what earns `verified`", () => {
    const log = logWith([["bun test tests/http", true, "44/44"]]);
    log.recordParent({
      command: "bun test tests/http",
      status: "failed",
      commit: "4a91c2ef00d1",
      reason: "exit 1 on HEAD",
    });

    const v = rungForCommand(log, "bun test tests/http");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("verified");
      expect(v.evidence.parentCommitFailed).toBe(true);
      // The receipt now carries the commit it actually ran against.
      expect(v.evidence.parentCommit).toBe("4a91c2ef00d1");
      expect(v.evidence.detail).toContain("4a91c2ef");
    }
  });

  test("a parent that PASSED caps the rung and says why in the receipt", () => {
    const log = logWith([
      ["bun test", true, "44/44"],
      ["bun test", true, "44/44"],
    ]);
    log.recordParent({ command: "bun test", status: "passed", commit: "deadbeefcafe" });

    const v = rungForCommand(log, "bun test");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("reproduced");
      expect(v.evidence.detail).toContain("this change is not why it passes");
    }
  });

  test("an inconclusive parent check never yields `verified`, and says so", () => {
    const log = logWith([["bun test", true, "44/44"]]);
    log.recordParent({
      command: "bun test",
      status: "inconclusive",
      commit: "abc123",
      reason: "the HEAD tree is not set up to run this check (exit 127)",
    });

    const v = rungForCommand(log, "bun test");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("observed");
      expect(v.evidence.parentCommitFailed).toBeUndefined();
      expect(v.evidence.detail).toContain("inconclusive");
    }
  });

  test("a command is identified by what ran, not by how it was spaced", () => {
    const v = rungForCommand(logWith([["bun  test   tests/http", true]]), "bun test tests/http");
    expect(v.ok).toBe(true);
  });

  test("quoted whitespace and command-list boundaries are significant to a receipt", () => {
    const log = logWith([
      [`test "two  spaces" = "two  spaces"`, true],
      ["false\ntrue", true],
    ]);
    expect(rungForCommand(log, `test "two spaces" = "two spaces"`).ok).toBe(false);
    expect(rungForCommand(log, "false true").ok).toBe(false);
    expect(rungForCommand(log, `test  "two  spaces"   = "two  spaces"`).ok).toBe(true);
  });

  test("a failed execution receipt is still a failure, not an observation", () => {
    const log = new CheckLog();
    log.record({ command: "bun run build", passed: false, kind: "execution", at: 1 });
    const v = rungForCommand(log, "bun run build");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("FAILED");
  });

  test("citing the same receipt twice does not reproduce it", async () => {
    // Reproduction is two RUNS, not two mentions. The log is written by the
    // runtime when a command executes; record_evidence only reads it, so a
    // model that cites the same pass twice must not climb a rung for it.
    const command = "bun test tests/http";
    const log = logWith([[command, true, "44/44"]]);
    let probes = 0;
    const ledger = new BriefLedger(brief());
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      () => {
        probes++;
        return { command, status: "passed" as const };
      },
    );
    const cite = () =>
      tool.execute({
        callId: "c",
        toolName: "record_evidence",
        args: { criterion: 0, command },
        sessionId: "s",
        workspaceRoot: "/tmp",
      });
    const first = await cite();
    const second = await cite();
    expect(first.result).toContain("observed");
    expect(second.result).toContain("observed");
    expect(second.result).not.toContain("reproduced");
    expect(log.all).toHaveLength(1);
    // The parent tree is measured ONCE per command, however often it is cited.
    expect(probes).toBe(1);
  });

  test("classification and replay eligibility are separate questions", async () => {
    // A classified check earns the parent-commit replay (the isolated
    // detached-worktree probe in parent-check.ts). An unclassified execution
    // is an arbitrary script that can mutate state, so it never gets one —
    // and that refusal costs it only a rung, never its receipt.
    for (const kind of ["check", "execution"] as const) {
      const command = "bun test tests/http";
      const log = new CheckLog();
      log.record({ command, passed: true, kind, at: 1 });
      let probes = 0;
      const tool = createRecordEvidenceTool(
        () => new BriefLedger(brief()),
        () => log,
        () => {
          probes++;
          return { command, status: "failed" as const };
        },
      );
      const result = await tool.execute({
        callId: "c",
        toolName: "record_evidence",
        args: { criterion: 0, command },
        sessionId: "s",
        workspaceRoot: "/tmp",
      });
      expect(probes).toBe(kind === "check" ? 1 : 0);
      expect(result.result).toContain(kind === "check" ? "verified" : "observed");
    }
  });
});

// ─── A1 — the refusal that says what to do next (P3B) ───
//
// Specified by Lane A in `.codex/audit-20260910/handoff/phase3/a1-spec.md`,
// written here because `brief.ts` is Lane C's file. The whole change is PROSE:
// a command that ran and exited 0 but is not a recognised check is still
// `{ ok: true, rung: "observed" }` with no parent replay, exactly as before —
// what moves is that the reply now names what happened and what to do instead,
// so the model stops rewording the same citation. Pilot J spent three
// completions and one supervisor screen on that loop.
//
// One case per example in the spec, asserted on the EXACT sentence, because the
// wording is the deliverable: Lane A's integration script matches on
// `not a recognised check`.

const A1_NEXT_STEP =
  "Not a recognised check: write the assertion as a test file a runner collects " +
  "(`bun test path/to/x.test.ts`), or cite a project check command — a `package.json` script, " +
  "`bunx tsc --noEmit`, `cargo test`. Re-citing this command in other words will get the same answer.";

async function citeIt(
  log: CheckLog,
  command: string,
  opts: { ledger?: boolean; probe?: () => void } = {},
): Promise<string> {
  const ledger = opts.ledger === false ? undefined : new BriefLedger(brief());
  const tool = createRecordEvidenceTool(
    () => ledger,
    () => log,
    opts.probe
      ? () => {
          opts.probe!();
          return { command, status: "failed" as const };
        }
      : undefined,
  );
  const out = await tool.execute({
    callId: "a1",
    toolName: "record_evidence",
    args: { criterion: 0, command },
    sessionId: "s",
    workspaceRoot: "/tmp",
  });
  return out.result ?? "";
}

describe("A1 — an unrecognised check is told what would raise it", () => {
  // Spec example 1: an inline script that only prints. `isVerificationCommand`
  // says no (`inlineCheck` needs an assert/expect/throw/non-zero exit), the
  // native shell recorded exit 0.
  test("example 1 — the receipt names the exit code the record carries", async () => {
    const command = `bun -e 'console.log(parse("a,b,c"))'`;
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1, summary: "ok" });
    const reply = await citeIt(log, command);
    expect(reply).toContain(
      "execution receipt only — ran, exit 0, not a recognised check; not replayed on the parent",
    );
    expect(reply).toContain(A1_NEXT_STEP);
    // The rung the receipt reports is the one the runtime awarded, unchanged.
    expect(reply).toContain("Recorded as observed");
  });

  // Spec example 2: a chain whose final word names no check. Same string; the
  // only difference from example 1 is the criteria count, which is the ledger's.
  test("example 2 — a chained command that names no check gets the same receipt", async () => {
    const command = "node scripts/demo.mjs && cat out.json";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1, summary: "ok" });
    const reply = await citeIt(log, command);
    expect(reply).toContain(
      "execution receipt only — ran, exit 0, not a recognised check; not replayed on the parent",
    );
    expect(reply).toContain("(0 of 2 criteria verified)");
    expect(reply).toContain(A1_NEXT_STEP);
  });

  // Spec example 3: an embedder's result carries no exit code. The reply must
  // not invent `exit 0` for it — "No data is null, never zero" (`CheckRun`).
  test("example 3 — with no exit code on the record the receipt says `ran and passed`", async () => {
    const command = "./run-parser.sh fixtures/sample.csv";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", at: 1 });
    const reply = await citeIt(log, command);
    expect(reply).toContain(
      "execution receipt only — ran and passed, not a recognised check; not replayed on the parent",
    );
    expect(reply).not.toContain("exit 0");
    expect(reply).toContain(A1_NEXT_STEP);
  });

  test("the same sentence arrives when no brief is in play", async () => {
    const command = "node scripts/demo.mjs";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1 });
    const reply = await citeIt(log, command, { ledger: false });
    expect(reply).toContain("No read_back criteria are in play");
    expect(reply).toContain(A1_NEXT_STEP);
  });

  test("a RECOGNISED check is told nothing of the kind", async () => {
    const log = logWith([["bun test", true, "44/44"]]);
    const reply = await citeIt(log, "bun test");
    expect(reply).toContain("Recorded as observed");
    expect(reply).not.toContain("not a recognised check");
    expect(reply).not.toContain("Re-citing this command");
  });

  test("the verdict does not move: observed, no parent replay, no parentCommitFailed", async () => {
    const command = "node scripts/demo.mjs";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1 });
    log.recordParent({ command, status: "failed" });
    const verdict = rungForCommand(log, command);
    expect(verdict).toMatchObject({ ok: true, rung: "observed" });
    if (verdict.ok) expect(verdict.evidence.parentCommitFailed).toBeUndefined();
    // …and the probe is still never spent on an unrecognised execution.
    const fresh = new CheckLog();
    fresh.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1 });
    let probes = 0;
    await citeIt(fresh, command, { probe: () => probes++ });
    expect(probes).toBe(0);
  });

  test("the guidance is in the REPLY, never in the detail the ledger carries every turn", () => {
    const command = "node scripts/demo.mjs";
    const log = new CheckLog();
    log.record({ command, passed: true, kind: "execution", exitCode: 0, at: 1 });
    const verdict = rungForCommand(log, command);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.evidence.detail).toContain("execution receipt only");
      expect(verdict.evidence.detail).not.toContain("Re-citing this command");
      expect(verdict.evidence.detail).not.toContain("bun test path/to/x.test.ts");
    }
  });
});

describe("record_evidence — a citation is never a validation error", () => {
  test("with no brief in play it is acknowledged in one line, against the plan step or the claim", async () => {
    const log = logWith([["bun test", true, "44/44"]]);
    const tool = createRecordEvidenceTool(
      () => undefined,
      () => log,
      undefined,
      () => ({ todos: [{ content: "make the suite green" }] }),
    );
    expect(tool.validate({ criterion: 0, command: "bun test" }).valid).toBe(true);
    expect(tool.validate({ claim: "the suite is green", command: "bun test" }).valid).toBe(true);
    expect(tool.validate({ command: "bun test" }).valid).toBe(false);

    const byStep = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(byStep.success).toBe(true);
    expect(byStep.result).toContain('step 1 "make the suite green"');
    expect(byStep.result).toContain("observed");
    expect(byStep.result).toContain("44/44");
    expect(byStep.result).not.toMatch(/Validation failed|Call read_back first/);

    const byClaim = await tool.execute({
      callId: "c2",
      toolName: "record_evidence",
      args: { claim: "the suite is green", command: "bun test" },
    } as any);
    expect(byClaim.success).toBe(true);
    expect(byClaim.result).toContain('"the suite is green"');
    expect(byClaim.result).toContain("settles no criterion");
  });

  test("a claim in words is matched to a numbered criterion by its text", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([["bun test", true, "44/44"]]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
    );
    const text = ledger.criteria[1]!.text;
    const hit = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { claim: text, command: "bun test" },
    } as any);
    expect(hit.result).toContain("observed");
    expect(ledger.criteria[1]!.rung).toBe("observed");

    const miss = await tool.execute({
      callId: "c2",
      toolName: "record_evidence",
      args: { claim: "the moon is made of cheese", command: "bun test" },
    } as any);
    expect(miss.success).toBe(true);
    expect(miss.result).toContain("numbered 0-1");
  });
});

describe("record_evidence — the model picks the criterion, never the rung", () => {
  test("it cannot upgrade a citation by asking nicely", async () => {
    const b = brief();
    const ledger = new BriefLedger(b);
    const log = logWith([["bun test", true, "44/44"]]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
    );

    // The schema offers no rung field at all — there is nothing to inflate.
    const props = (tool.schema.inputSchema as any).properties;
    expect(Object.keys(props).sort()).toEqual(["claim", "command", "criterion"]);

    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.result).toContain("observed"); // one pass, so: observed
    expect(ledger.met).toBe(0); // and NOT met
    expect(ledger.complete).toBe(false);
  });

  test("the citation becomes `verified` only when the parent probe reports a failure", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([["bun test", true, "44/44"]]);
    let probed = 0;
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => {
        probed++;
        return { command, status: "failed", commit: "0f1e2d3c4b5a", reason: "exit 1 on HEAD" };
      },
    );

    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.result).toContain("verified");
    expect(ledger.met).toBe(1);
    expect(probed).toBe(1);
  });

  test("a green parent leaves the criterion unmet, however many times it passes now", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([
      ["bun test", false, "1 failed"],
      ["bun test", true, "44/44"],
    ]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => ({ command, status: "passed", commit: "0f1e2d3c4b5a" }),
    );

    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    // Red→green in-session, but the parent was green: the change is not why.
    expect(out.result).not.toContain("verified:");
    expect(out.result).toContain("also passed on 0f1e2d3c");
    expect(out.result).toContain("does not request another run");
    expect(ledger.met).toBe(0);
  });

  test("the parent tree is probed once per command, not once per citation", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([["bun test", true, "44/44"]]);
    let probed = 0;
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => {
        probed++;
        return { command, status: "failed", commit: "aaaa1111" };
      },
    );

    const call = (criterion: number) =>
      tool.execute({
        callId: `c${criterion}`,
        toolName: "record_evidence",
        args: { criterion, command: "bun test" },
      } as any);

    await call(0);
    await call(1);
    // Two criteria, one full test run against the parent tree.
    expect(probed).toBe(1);
    expect(ledger.met).toBe(2);
  });

  test("with no probe available (non-git workspace) `verified` is simply out of reach", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([
      ["bun test", false, "1 failed"],
      ["bun test", true, "44/44"],
    ]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      // no probeParent
    );

    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.result).toContain("observed");
    expect(ledger.met).toBe(0);
  });

  test("a failing command is never probed — the run would buy nothing", async () => {
    const ledger = new BriefLedger(brief());
    const log = logWith([["bun test", false, "1 failed"]]);
    let probed = 0;
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => {
        probed++;
        return { command, status: "failed" };
      },
    );

    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.success).toBe(true);
    expect(out.result).toContain("FAILED");
    expect(probed).toBe(0);
  });

  test("citing a command that was never run is refused, however confident the call", async () => {
    const ledger = new BriefLedger(brief());
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => new CheckLog(),
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test --everything-passes" },
    } as any);
    expect(out.result).toContain("never ran");
    expect(ledger.met).toBe(0);
  });

  test("without a brief the citation is acknowledged, and settles nothing", async () => {
    const tool = createRecordEvidenceTool(
      () => undefined,
      () => logWith([["bun test", true]]),
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.success).toBe(true);
    expect(out.result).toContain("No read_back criteria are in play");
    expect(out.result).toContain("settles no criterion");
  });
});

describe("summarizeCheck", () => {
  // The rule is LAST counted line, not first — because a failing runner puts
  // its failure count last, and that is the line a person needs to see.
  test("takes the last line carrying counts", () => {
    expect(summarizeCheck("compiling...\n44 pass\n0 fail")).toBe("0 fail");
    expect(summarizeCheck("running\n43 pass\n1 fail")).toBe("1 fail");
  });

  test("falls back to the tail, where runners put their verdict", () => {
    expect(summarizeCheck("noise\nnoise\nDone.")).toBe("Done.");
  });

  // P11.1 put this string in front of a person: it is the reason a folded
  // branch carries in the Decision Record. "refuted: 1 fail" tells a reader the
  // SHAPE of the evidence and none of it, so a line that names what failed
  // outranks a line that counts how many did.
  test("a named failure outranks the counts", () => {
    const bun = [
      "bun test v1.3.14",
      "error: expect(received).not.toBe(expected)",
      "(fail) the cache TTL changed across the deploy [0.18ms]",
      " 0 pass",
      " 1 fail",
      "Ran 1 test across 1 file. [21.00ms]",
    ].join("\n");
    expect(summarizeCheck(bun)).toBe("(fail) the cache TTL changed across the deploy [0.18ms]");
  });

  test("the error line outranks the counts when nothing is named", () => {
    const tsc = ["compiling", "error TS2345: Argument of type X", "3 errors"].join("\n");
    expect(summarizeCheck(tsc)).toBe("error TS2345: Argument of type X");
  });

  test("empty output summarises to nothing rather than to a lie", () => {
    expect(summarizeCheck("   \n  ")).toBeUndefined();
    expect(summarizeCheck("")).toBeUndefined();
  });

  test("a very long line is clipped, and says so", () => {
    const out = summarizeCheck("x".repeat(200))!;
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith("...")).toBe(true);
  });
});

// ─── A rung moves only for a check that could have failed for it ───
//
// V-5B, F1 and F2. The rung VALUE was never model-authored, but two
// model-controlled inputs reached it: which criterion a command was
// attributed to, and whether the command could have run on the parent tree at
// all. Either one turned an untouched file into `verified`.

describe("a citation that does not speak to its criterion", () => {
  /** The brief above, with a criterion that names a file in `leave`. */
  function scopedBrief(): Brief {
    return briefFromArgs(
      {
        reading: "the export is dropping the last row",
        touch: ["api.ts"],
        leave: ["header.csv"],
        done_when: ["the exporter writes every row", "the CSV header is unchanged"],
      },
      "Fix the exporter — it drops the last row.",
      "2026-09-14T00:00:00.000Z",
    );
  }

  test("criterionScope names only the files the criterion's own words identify", () => {
    const b = scopedBrief();
    expect(criterionScope(b.criteria[0]!.text, b)).toEqual([]);
    expect(criterionScope(b.criteria[1]!.text, b)).toEqual(["header.csv"]);
    // Both halves of the brief's scope are eligible, `touch` included.
    expect(criterionScope("api.ts keeps its default export", b)).toEqual(["api.ts"]);
  });

  test("one green check cited for two criteria settles only the one it reads", async () => {
    const ledger = new BriefLedger(scopedBrief());
    const log = logWith([["node check.mjs", true, "1 pass, 0 fail"]]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => ({ command, status: "failed" as const, commit: "abcdef1234" }),
    );
    const cite = async (criterion: number): Promise<string> =>
      String(
        (
          await tool.execute({
            callId: `c${criterion}`,
            toolName: "record_evidence",
            args: { criterion, command: "node check.mjs" },
          } as any)
        ).result,
      );

    // The criterion that names no artifact of its own keeps the citation.
    expect(await cite(0)).toContain("Recorded as verified");
    // The one that names `header.csv` — a file this check never opens — does
    // not, and the reply says which file it is about.
    const refused = await cite(1);
    expect(refused).toContain("does not speak to");
    expect(refused).toContain("header.csv");
    expect(ledger.criteria[0]!.rung).toBe("verified");
    expect(ledger.criteria[1]!.rung).toBeNull();
  });

  test("a set-aside citation is kept on the criterion with its reason, and is not evidence", () => {
    const ledger = new BriefLedger(scopedBrief());
    const kept = ledger.setAside(
      1,
      { source: "node check.mjs", detail: "1 pass" },
      "it never reads header.csv",
    );
    expect(kept.ok).toBe(true);
    expect(ledger.criteria[1]!.rung).toBeNull();
    expect(ledger.criteria[1]!.evidence?.unrelated).toBe("it never reads header.csv");
    expect(ledger.met).toBe(0);
  });

  test("setAside never overwrites a rung that was earned", () => {
    const ledger = new BriefLedger(scopedBrief());
    ledger.record(0, "verified", {
      source: "node check.mjs",
      detail: "failed on abcdef12, passes now",
      parentCommitFailed: true,
    });
    const refused = ledger.setAside(0, { source: "true" }, "unrelated");
    expect(refused.ok).toBe(false);
    expect(ledger.criteria[0]!.rung).toBe("verified");
    expect(ledger.criteria[0]!.evidence?.unrelated).toBeUndefined();
    expect(ledger.criteria[0]!.evidence?.source).toBe("node check.mjs");
  });

  test("a project-wide check speaks to every criterion, however the brief is scoped", async () => {
    const ledger = new BriefLedger(scopedBrief());
    const log = logWith([["bun test", true, "44 pass"]]);
    const tool = createRecordEvidenceTool(
      () => ledger,
      () => log,
      (command) => ({ command, status: "failed" as const }),
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 1, command: "bun test" },
    } as any);
    expect(String(out.result)).toContain("Recorded as verified");
  });
});

describe("a parent commit the check could not run on", () => {
  test("`not-applicable-on-parent` never yields verified, and the receipt says the measurement was never taken", () => {
    const log = logWith([["bun test forged.test.ts", true, "2 pass"]]);
    log.recordParent({
      command: "bun test forged.test.ts",
      status: "not-applicable-on-parent",
      commit: "abc1234567",
      reason: "forged.test.ts did not exist on HEAD, so the check could not have run there",
    });

    const v = rungForCommand(log, "bun test forged.test.ts");
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.rung).toBe("observed");
      expect(v.evidence.parentCommitFailed).toBeUndefined();
      expect(v.evidence.detail).toContain("not applicable on the parent commit");
      expect(v.evidence.detail).toContain("a failure by absence is not evidence");
    }
  });

  test("it caps a repeated pass at `reproduced` rather than at `verified`", () => {
    const log = logWith([
      ["bun test forged.test.ts", true, "2 pass"],
      ["bun test forged.test.ts", true, "2 pass"],
    ]);
    log.recordParent({
      command: "bun test forged.test.ts",
      status: "not-applicable-on-parent",
      reason: "the check did not run there",
    });
    const v = rungForCommand(log, "bun test forged.test.ts");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.rung).toBe("reproduced");
  });
});
