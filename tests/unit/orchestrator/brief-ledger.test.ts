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
    expect(Object.keys(props).sort()).toEqual(["done_when", "leave", "reading", "touch"]);
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
      expect(v.rung).toBe("reproduced");
      expect(v.evidence.parentCommitFailed).toBeUndefined();
    }
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
    expect(Object.keys(props).sort()).toEqual(["command", "criterion"]);

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
    expect(out.result).toContain("reproduced");
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

  test("without a brief there is nothing to record against", async () => {
    const tool = createRecordEvidenceTool(
      () => undefined,
      () => logWith([["bun test", true]]),
    );
    const out = await tool.execute({
      callId: "c1",
      toolName: "record_evidence",
      args: { criterion: 0, command: "bun test" },
    } as any);
    expect(out.result).toContain("read_back first");
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
