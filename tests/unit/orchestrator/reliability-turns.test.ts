/**
 * The turn ceiling is a reliability bound — `[reliability] maxTurns` and
 * `[reliability] secondWinds` — resolved through the same policy as every
 * other loop limit, and the engine builds the loop from that policy. It was
 * a constant in engine.ts for a month with no knob; nine runs ended at it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RELIABILITY,
  policyForModel,
} from "../../../packages/orchestrator/src/reliability-policy";

describe("turn ceiling as a reliability bound", () => {
  test("defaults: 80 turns, 2 second winds", () => {
    expect(DEFAULT_RELIABILITY.maxTurns).toBe(80);
    expect(DEFAULT_RELIABILITY.secondWinds).toBe(2);
    const p = policyForModel("gpt-5.6-sol");
    expect(p.maxTurns).toBe(80);
    expect(p.secondWinds).toBe(2);
  });

  test("[reliability] overrides both, field by field, integers only", () => {
    const p = policyForModel("gpt-5.6-sol", { maxTurns: 200, secondWinds: 0 });
    expect(p.maxTurns).toBe(200);
    expect(p.secondWinds).toBe(0);
    expect(p.maxStuckNudges).toBe(DEFAULT_RELIABILITY.maxStuckNudges);
    const bad = policyForModel("gpt-5.6-sol", { maxTurns: -1 as number, secondWinds: 1.9 });
    expect(bad.maxTurns).toBe(80);
    expect(bad.secondWinds).toBe(1);
  });

  test("the engine builds the loop from the policy, not a constant", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/engine.ts"),
      "utf8",
    );
    expect(src).toContain("turnBudgetForMessage(userMessage, reliability.maxTurns)");
    expect(src).toContain("reliability.secondWinds");
    expect(src).not.toMatch(/\bMAX_TURNS\b/);
  });
});
