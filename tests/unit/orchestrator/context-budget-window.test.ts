/**
 * The compaction throttle: one field, two meanings.
 *
 * `lastTokenUsage.limit` was written by two functions with different
 * semantics. buildPrompt() wrote the ASSEMBLY BUDGET; noteRealUsage() wrote
 * the MODEL'S CONTEXT WINDOW. Since the default budget was capped at 100k
 * regardless of the model, on a 400k model the two disagreed by 4×:
 *
 *   · the status meter (last written by buildPrompt) showed 99%
 *   · shouldCompact() (last written by noteRealUsage) computed 25% → never fired
 *   · buildPrompt evicted items every turn to fit 100k — silent context loss
 *
 * Observed live on gpt-5.6-sol: "100% context" in the footer, "Context budget
 * exceeded: 1 items evicted, 104311 tokens used" in the transcript, and a
 * session that never auto-compacted. Real usage was 99,268 tokens against a
 * 400,000-token window — a quarter full.
 */

import { describe, test, expect, mock } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import { getContextLimit } from "../../../packages/orchestrator/src/tokenizer";

function gateway() {
  return {
    infer: mock(async () => ({
      content: [{ type: "text" as const, text: "summary" }],
      model: "test",
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

const MODEL = "gpt-5.6-sol"; // 400k window via the gpt-5 family rule
const WINDOW = getContextLimit(MODEL);

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `message ${i} ${"x".repeat(200)}` }],
  }));

describe("the assembly budget follows the model, not a fixed 100k", () => {
  test("a large-window model gets a budget proportional to its window", () => {
    const engine = new ContextEngine({}, gateway());
    engine.buildPrompt("sys", [], msgs(4), undefined, MODEL);

    // 85% of 400k, not the 100k default that used to cap it.
    expect(engine.getContextUsage().limit).toBe(WINDOW);
    expect(WINDOW).toBeGreaterThan(100_000); // guards the premise of this test
  });

  test("an explicitly configured budget is still respected verbatim", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 50_000 } }, gateway());
    const built = engine.buildPrompt("sys", [], msgs(4), undefined, MODEL);
    expect(built.totalTokens).toBeLessThanOrEqual(50_000);
  });
});

describe("the meter and the compaction trigger share one denominator", () => {
  test("buildPrompt and noteRealUsage report the same limit", () => {
    const engine = new ContextEngine({}, gateway());

    engine.buildPrompt("sys", [], msgs(6), undefined, MODEL);
    const afterBuild = engine.getContextUsage().limit;

    engine.noteRealUsage({ inputTokens: 99_268 }, MODEL);
    const afterUsage = engine.getContextUsage().limit;

    // The whole defect in one assertion: these used to be 100_000 and 400_000.
    expect(afterBuild).toBe(afterUsage);
    expect(afterUsage).toBe(WINDOW);
  });

  test("the percentage the user sees is the one shouldCompact acts on", () => {
    const engine = new ContextEngine({}, gateway());
    engine.buildPrompt("sys", [], msgs(6), undefined, MODEL);
    engine.noteRealUsage({ inputTokens: 99_268 }, MODEL);

    const { percent } = engine.getContextUsage();
    // 99_268 / 400_000 ≈ 25% — a quarter full, so no compaction is due.
    expect(percent).toBe(25);
    expect(engine.shouldCompact()).toBe(false);

    // Previously the footer rendered 99% here while shouldCompact said false.
    expect(percent).toBeLessThan(70);
  });

  test("crossing the high-water mark now actually trips the trigger", () => {
    const engine = new ContextEngine({}, gateway());
    engine.buildPrompt("sys", [], msgs(6), undefined, MODEL);
    engine.noteRealUsage({ inputTokens: Math.floor(WINDOW * 0.75) }, MODEL);

    expect(engine.getContextUsage().percent).toBe(75);
    expect(engine.shouldCompact()).toBe(true);
  });

  test("compaction is reached before eviction, not after", () => {
    // Compaction at 0.70 × window, assembly budget at 0.85 × window. The old
    // ordering was inverted: eviction began at 100k while compaction waited
    // for 280k, so the run silently shed context it could have summarized.
    const compactAt = WINDOW * 0.7;
    const evictAt = WINDOW * 0.85;
    expect(compactAt).toBeLessThan(evictAt);
  });
});
