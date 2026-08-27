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
    expect(l.record(0, "observed", { source: "curl -i localhost/x", detail: "HTTP 429" }).ok).toBe(true);
    expect(l.record(1, "reproduced", { source: "bun test --rerun 2", detail: "failed twice" }).ok).toBe(true);
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
    expect(new BriefLedger(brief()).record(9, "verified", { source: "x", parentCommitFailed: true }).ok).toBe(false);
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
    const tool = createReadBackTool(() => undefined, () => "req", () => {});
    expect(tool.validate({ reading: "I think you want X" }).valid).toBe(false);
    expect(tool.validate({ reading: "", done_when: ["x"] }).valid).toBe(false);
    expect(tool.validate({ reading: "I think you want X", done_when: ["tests pass"] }).valid).toBe(true);
  });

  test("headless still records the brief rather than skipping it", async () => {
    let captured: Brief | null = null;
    const tool = createReadBackTool(() => undefined, () => "the ask", (b) => (captured = b));
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
      () => async (b) => ({ accepted: true, edited: { ...b, reading: "You want the p99 on /search" } }),
      () => "make it faster",
      (b) => (captured = b),
    );
    await tool.execute({
      callId: "c1", toolName: "read_back",
      args: { reading: "You want the cold start fixed", done_when: ["under 1s"] },
    } as any);
    expect(captured!.reading).toBe("You want the p99 on /search");
  });
});
