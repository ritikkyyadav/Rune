/**
 * The spend ceiling.
 *
 * Two things this pins, both of which the original cap got wrong:
 *
 * 1. It tests METERED-EQUIVALENT cost, not actual spend. A cap on spend can
 *    never fire on a subscription or free route — where this agent spends most
 *    of its life — so it would guard only the runs least in need of guarding.
 *
 * 2. The response that trips it is still RECORDED. The provider already served
 *    and billed it; refusing to count it would make the ledger understate
 *    precisely the run that overspent. The cap governs the NEXT request.
 */
import { describe, expect, test } from "bun:test";
import { BudgetExceededError, CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";

describe("session spend ceiling", () => {
  test("fires on a subscription route, where actual spend is always zero", () => {
    const t = new CostTracker({ budgets: [{ scope: "session", limitUsd: 1 }] });
    // gpt-5.6-sol on Codex: $0 spent, ~$1.25 of metered value.
    expect(() =>
      t.record("gpt-5.6-sol", "codex", { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toThrow(BudgetExceededError);
    // The point of the whole design: spend is zero and the cap still worked.
    expect(t.getLedger().totalCostUsd).toBe(0);
  });

  test("the response that trips the cap is still counted", () => {
    const t = new CostTracker({ budgets: [{ scope: "session", limitUsd: 1 }] });
    try {
      t.record("claude-sonnet-5", "anthropic", { inputTokens: 1_000_000, outputTokens: 0 });
    } catch {
      /* expected */
    }
    const led = t.getLedger();
    expect(led.entries.length).toBe(1);
    expect(led.totalListCostUsd).toBeCloseTo(2, 6);
  });

  test("stays quiet below the limit", () => {
    const t = new CostTracker({ budgets: [{ scope: "session", limitUsd: 5 }] });
    expect(() =>
      t.record("claude-sonnet-5", "anthropic", { inputTokens: 1_000_000, outputTokens: 0 }),
    ).not.toThrow();
  });

  test("accumulates across calls rather than testing each in isolation", () => {
    const t = new CostTracker({ budgets: [{ scope: "session", limitUsd: 3 }] });
    const one = { inputTokens: 1_000_000, outputTokens: 0 };
    expect(() => t.record("claude-sonnet-5", "anthropic", one)).not.toThrow(); // $2
    expect(() => t.record("claude-sonnet-5", "anthropic", one)).toThrow(BudgetExceededError); // $4
  });

  test("no budget configured means no cap — the default must not surprise anyone", () => {
    const t = new CostTracker();
    for (let i = 0; i < 50; i++) {
      t.record("claude-opus-5", "anthropic", { inputTokens: 1_000_000, outputTokens: 100_000 });
    }
    expect(t.getLedger().totalListCostUsd).toBeGreaterThan(100);
  });

  test("the error carries what a user needs to act on", () => {
    const t = new CostTracker({ budgets: [{ scope: "session", limitUsd: 1 }] });
    try {
      t.record("claude-sonnet-5", "anthropic", { inputTokens: 1_000_000, outputTokens: 0 });
      throw new Error("expected the cap to fire");
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      const e = err as BudgetExceededError;
      expect(e.limitUsd).toBe(1);
      expect(e.projectedUsd).toBeCloseTo(2, 6);
      expect(e.scope).toBe("session");
    }
  });
});
