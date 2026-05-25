import { describe, test, expect } from "bun:test";
import { CostTracker, BudgetExceededError } from "../../../packages/llm-gateway/src/cost-tracker";

describe("CostTracker", () => {
  test("estimates cost for known models", () => {
    const tracker = new CostTracker();
    const cost = tracker.estimate("claude-sonnet-4-20250514", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeGreaterThan(0);
  });

  test("returns 0 for unknown models", () => {
    const tracker = new CostTracker();
    const cost = tracker.estimate("unknown-model", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBe(0);
  });

  test("records entries and tracks total", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-20250514", "anthropic", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    const ledger = tracker.getLedger();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.totalCostUsd).toBeGreaterThan(0);
  });

  test("throws BudgetExceededError when over session budget", () => {
    const tracker = new CostTracker({
      budgets: [{ scope: "session", limitUsd: 0.001 }],
    });
    expect(() => {
      tracker.record("claude-sonnet-4-20250514", "anthropic", {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
    }).toThrow(BudgetExceededError);
  });

  test("getBreakdown groups by provider and model", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-20250514", "anthropic", { inputTokens: 100, outputTokens: 50 });
    tracker.record("gpt-4o", "openai", { inputTokens: 100, outputTokens: 50 });
    const breakdown = tracker.getBreakdown();
    expect(Object.keys(breakdown.byProvider).length).toBe(2);
    expect(Object.keys(breakdown.byModel).length).toBe(2);
  });

  test("reset clears the ledger", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-20250514", "anthropic", { inputTokens: 100, outputTokens: 50 });
    expect(tracker.getLedger().entries.length).toBe(1);
    tracker.reset();
    expect(tracker.getLedger().entries.length).toBe(0);
    expect(tracker.getLedger().totalCostUsd).toBe(0);
  });

  test("estimateToolCost returns positive values", () => {
    const tracker = new CostTracker();
    expect(tracker.estimateToolCost("bash")).toBeGreaterThan(0);
    expect(tracker.estimateToolCost("read_file")).toBeGreaterThan(0);
    expect(tracker.estimateToolCost("unknown_tool")).toBeGreaterThan(0);
  });

  test("estimateToolCost returns higher cost for bash than read", () => {
    const tracker = new CostTracker();
    expect(tracker.estimateToolCost("bash")).toBeGreaterThan(tracker.estimateToolCost("read_file"));
  });

  test("preExecutionCheck passes when no budget set", () => {
    const tracker = new CostTracker();
    expect(tracker.preExecutionCheck(10)).toBe(true);
  });

  test("preExecutionCheck fails when budget would be exceeded", () => {
    const tracker = new CostTracker({
      budgets: [{ scope: "session", limitUsd: 0.01 }],
    });
    // Record some cost first
    tracker.record("claude-sonnet-4-20250514", "anthropic", {
      inputTokens: 100,
      outputTokens: 50,
    });
    // Check if adding a large cost would exceed
    expect(tracker.preExecutionCheck(1.0)).toBe(false);
  });

  test("preExecutionCheck passes when within budget", () => {
    const tracker = new CostTracker({
      budgets: [{ scope: "session", limitUsd: 10.0 }],
    });
    expect(tracker.preExecutionCheck(0.001)).toBe(true);
  });
});
