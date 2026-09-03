import { describe, test, expect } from "bun:test";

import { contextLedger } from "../../../packages/orchestrator/src/bin/audit-cli";

// P10.8: `gear audit` reports how full the context window ran, turn by turn,
// and what each compaction took out of it — from the persisted usage rows, not
// from a live counter. The ledger is pure over the session log, so it is
// tested without a database.

let seq = 0;
const next = () => ++seq;

function cost(p: Record<string, unknown>) {
  return { seq: next(), event: { type: "cost", payload: p } };
}

function compaction(p: Record<string, unknown>, type = "auto_compaction") {
  return { seq: next(), event: { type, payload: p } };
}

describe("contextLedger", () => {
  test("occupancy is fresh + warm + written input against the model's window", () => {
    seq = 0;
    const led = contextLedger([
      cost({
        model: "claude-sonnet-4-6",
        inputTokens: 1_000,
        cacheReadTokens: 9_000,
        cacheCreationTokens: 500,
      }),
    ]);
    expect(led.turns).toHaveLength(1);
    const t = led.turns[0];
    expect(t.used).toBe(10_500);
    expect(t.limit).toBe(1_000_000); // the current Sonnet window
    expect(t.assumed).toBe(false);
    expect(t.cacheShare).toBeCloseTo(9_000 / 10_500, 5);
    expect(led.peak).toBe(t);
    expect(led.last).toBe(t);
  });

  test("a turn whose provider reported nothing is null, never zero", () => {
    seq = 0;
    const led = contextLedger([
      cost({ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 }),
    ]);
    expect(led.turns[0].used).toBeNull();
    expect(led.turns[0].cacheShare).toBeNull();
    // …and it cannot become the peak or the last measured turn.
    expect(led.peak).toBeNull();
    expect(led.last).toBeNull();
  });

  test("a model no table rule recognizes is marked as an assumed window", () => {
    seq = 0;
    const led = contextLedger([cost({ model: "stealth/ox-alpha", inputTokens: 50_000 })]);
    expect(led.turns[0].assumed).toBe(true);
    const none = contextLedger([cost({ inputTokens: 50_000 })]);
    expect(none.turns[0].assumed).toBe(true);
  });

  test("the peak is the fullest window share, not the largest token count", () => {
    seq = 0;
    const led = contextLedger([
      // 150k of a 1M window (15%)…
      cost({ model: "claude-sonnet-4-6", inputTokens: 150_000 }),
      // …against 90k of a 128k window (70%). Fewer tokens, a fuller window.
      cost({ model: "gpt-4o", inputTokens: 90_000 }),
    ]);
    expect(led.peak!.model).toBe("gpt-4o");
    expect(led.last!.model).toBe("gpt-4o");
  });

  test("compaction rows carry what was dropped and what asked for it", () => {
    seq = 0;
    const led = contextLedger([
      compaction({
        beforeTokens: 33_046,
        afterTokens: 15_401,
        summarizedCount: 0,
        tier: "tool_results",
        trigger: "auto",
      }),
      compaction({
        beforeTokens: 20_000,
        afterTokens: 4_500,
        summarizedCount: 13,
        tier: "summarized",
        trigger: "requested",
      }),
    ]);
    expect(led.compactions).toHaveLength(2);
    expect(led.compactions[0]).toMatchObject({
      before: 33_046,
      after: 15_401,
      tier: "tool_results",
      trigger: "auto",
    });
    expect(led.compactions[1]).toMatchObject({ summarized: 13, trigger: "requested" });
  });

  test("a pre-P10.8 row reports no tier and no trigger rather than guessing one", () => {
    seq = 0;
    const led = contextLedger([
      compaction({ beforeTokens: 100, afterTokens: 50, summarizedCount: 4 }),
    ]);
    expect(led.compactions[0].tier).toBeNull();
    expect(led.compactions[0].trigger).toBeNull();
    expect(led.compactions[0].summarized).toBe(4);
  });

  test("the /compress row is read through its own field names", () => {
    seq = 0;
    const led = contextLedger([
      compaction(
        { sourceTokens: 9_000, summaryTokens: 900, originalMessages: 30, trigger: "manual" },
        "compaction",
      ),
    ]);
    expect(led.compactions[0]).toMatchObject({
      before: 9_000,
      after: 900,
      summarized: 30,
      trigger: "manual",
    });
  });

  test("a session with neither usage nor compaction yields an empty ledger", () => {
    seq = 0;
    const led = contextLedger([{ seq: next(), event: { type: "user_msg", payload: {} } }]);
    expect(led.turns).toHaveLength(0);
    expect(led.compactions).toHaveLength(0);
    expect(led.peak).toBeNull();
    expect(led.last).toBeNull();
  });
});
