import { describe, expect, test } from "bun:test";

import {
  EFFORT_BUDGETS,
  checkBudget,
  describeBreach,
  resolveMaxParallel,
  resolveSubagentBudget,
} from "../../../packages/orchestrator/src/subagent-budget";

/**
 * P6B.4 — a sub-agent is bounded by money and by an afternoon, not only by
 * turns.
 *
 * `grep costCap|maxCost|deadline` over the repository returned nothing before
 * this. A fleet of four thorough workers on a heavy tier could spend an
 * unbounded amount over an unbounded time, and the only signal was the session
 * ledger afterwards.
 */

describe("P6B.4 — budget resolution", () => {
  test("effort chooses the default", () => {
    expect(resolveSubagentBudget("quick")).toEqual(EFFORT_BUDGETS.quick);
    expect(resolveSubagentBudget("thorough")).toEqual(EFFORT_BUDGETS.thorough);
    // A quick scout and a thorough worker are different amounts of work; one
    // number for both would strangle the second or fail to bound the first.
    expect(EFFORT_BUDGETS.thorough.costCapUsd!).toBeGreaterThan(EFFORT_BUDGETS.quick.costCapUsd!);
    expect(EFFORT_BUDGETS.thorough.deadlineMs!).toBeGreaterThan(EFFORT_BUDGETS.quick.deadlineMs!);
  });

  test("an unknown effort falls back to standard", () => {
    expect(resolveSubagentBudget(undefined)).toEqual(EFFORT_BUDGETS.standard);
    expect(resolveSubagentBudget("exhaustive")).toEqual(EFFORT_BUDGETS.standard);
  });

  test("a caller's own numbers win", () => {
    const b = resolveSubagentBudget("quick", { costCapUsd: 12, deadlineMs: 1000 });
    expect(b.costCapUsd).toBe(12);
    expect(b.deadlineMs).toBe(1000);
  });

  test("zero and nonsense do not become a cap", () => {
    // "Spend nothing" is not a useful instruction, and NaN silently capping
    // everything at zero would look exactly like a broken sub-agent.
    const b = resolveSubagentBudget("standard", { costCapUsd: 0, deadlineMs: "soon" });
    expect(b).toEqual(EFFORT_BUDGETS.standard);
  });
});

describe("P6B.4 — breach detection", () => {
  test("cost over the cap trips", () => {
    const breach = checkBudget(
      { costCapUsd: 1, deadlineMs: null },
      { spentUsd: 1.5, startedAt: Date.now() },
    );
    expect(breach).toEqual({ kind: "cost", spentUsd: 1.5, capUsd: 1 });
  });

  test("cost exactly at the cap does not trip", () => {
    expect(
      checkBudget({ costCapUsd: 1, deadlineMs: null }, { spentUsd: 1, startedAt: Date.now() }),
    ).toBeNull();
  });

  test("time over the deadline trips", () => {
    const breach = checkBudget(
      { costCapUsd: null, deadlineMs: 100 },
      { spentUsd: 0, startedAt: Date.now() - 500 },
    );
    expect(breach?.kind).toBe("time");
  });

  test("a null cap disables its own check", () => {
    expect(
      checkBudget({ costCapUsd: null, deadlineMs: null }, { spentUsd: 1_000_000, startedAt: 0 }),
    ).toBeNull();
  });

  test("the message names the budget and the numbers", () => {
    // "Re-dispatch with more" has to be actionable, not a guess.
    const msg = describeBreach({ kind: "cost", spentUsd: 2.5, capUsd: 2 });
    expect(msg).toContain("$2.50");
    expect(msg).toContain("$2.00");
    expect(msg).toContain("costCapUsd");
    expect(describeBreach({ kind: "time", elapsedMs: 65_000, deadlineMs: 60_000 })).toContain(
      "deadlineMs",
    );
  });
});

describe("P6B.4 — the concurrency ceiling", () => {
  test("defaults to three concurrent delegates to bound peak spend", () => {
    expect(resolveMaxParallel(undefined)).toBe(3);
    expect(resolveMaxParallel("not a number")).toBe(3);
  });

  test("a configured value is honoured and clamped", () => {
    expect(resolveMaxParallel(4)).toBe(4);
    expect(resolveMaxParallel(100)).toBe(16);
    // Zero means "no delegation at all", which is `[subagents] mode = "off"`.
    expect(resolveMaxParallel(0)).toBe(1);
    expect(resolveMaxParallel(-3)).toBe(1);
  });
});
