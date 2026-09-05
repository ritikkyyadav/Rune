import { describe, test, expect } from "bun:test";
import {
  DEFAULT_RELIABILITY,
  policyForModel,
} from "../../../packages/orchestrator/src/reliability-policy";

// Every "keep recovering vs give up" bound in one governed place. The
// defaults must be today's shipped behavior verbatim — this suite is the
// tripwire against silent renumbering.

describe("reliability policy", () => {
  test("defaults preserve the shipped bounds exactly", () => {
    expect(DEFAULT_RELIABILITY).toEqual({
      maxConsecutiveErrors: 3,
      maxStuckNudges: 1,
      maxRateWaits: 2,
      maxOverflowCompactions: 2,
      maxEmptyCompletionRetries: 3,
      maxTruncationRetries: 2,
      maxVerifyAttempts: 3,
      readThrashCount: 3,
      editChurnCount: 4,
      maxPlanNudges: 1,
      maxReplanNudges: 1,
      maxStruggleNudges: 1,
      maxGreenfieldNudges: 1,
      // The turn ceiling and its second winds joined the policy on
      // 2026-09-05; they were a constant in engine.ts before.
      maxTurns: 80,
      secondWinds: 2,
    });
  });

  test("frontier models get the defaults untouched", () => {
    expect(policyForModel("claude-sonnet-4-5")).toEqual(DEFAULT_RELIABILITY);
    expect(policyForModel("gpt-5")).toEqual(DEFAULT_RELIABILITY);
    expect(policyForModel("gemini-2.5-pro")).toEqual(DEFAULT_RELIABILITY);
  });

  test("budget/open-weight families get extra retry headroom", () => {
    for (const model of ["qwen/qwen3-coder:free", "glm-4-plus", "deepseek-chat", "llama3"]) {
      const p = policyForModel(model);
      expect(p.maxConsecutiveErrors).toBe(4);
      expect(p.maxStuckNudges).toBe(2);
      // Only the failure-economics fields shift; the rest stay default.
      expect(p.maxRateWaits).toBe(DEFAULT_RELIABILITY.maxRateWaits);
      expect(p.readThrashCount).toBe(DEFAULT_RELIABILITY.readThrashCount);
    }
  });

  test("[reliability] config overrides beat family defaults field-by-field", () => {
    const p = policyForModel("qwen3-coder:480b", {
      maxConsecutiveErrors: 6,
      readThrashCount: 5,
    });
    expect(p.maxConsecutiveErrors).toBe(6); // override wins over family's 4
    expect(p.maxStuckNudges).toBe(2); // family tweak survives for others
    expect(p.readThrashCount).toBe(5);
  });

  test("garbage overrides are ignored (negative, NaN, non-integer floored)", () => {
    const p = policyForModel("claude-sonnet-4-5", {
      maxConsecutiveErrors: -1,
      maxStuckNudges: Number.NaN,
      maxRateWaits: 3.9,
    } as never);
    expect(p.maxConsecutiveErrors).toBe(3);
    expect(p.maxStuckNudges).toBe(1);
    expect(p.maxRateWaits).toBe(3);
  });
});
