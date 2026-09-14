/**
 * `RunState` — the snapshot's three rules, and the persistence definition M2
 * records for spend (exit S9).
 *
 * The one that matters most is the dullest: **a turn refund moves `maxTurns`
 * and nothing else.** `spentUsd` is the sum of the run's cost rows, and no
 * cost row is deleted when a turn is given back, so a refunded run's spend is
 * exactly the spend of a run that was never refunded.
 */

import { describe, expect, test } from "bun:test";

import {
  RUN_STATE_VERSION,
  TERMINAL_PHASES,
  emptyRunState,
  makeRunState,
  spentUsdFromCostRows,
  withPhase,
} from "../../../packages/orchestrator/src/run-state";
import { TurnRefunds } from "../../../packages/orchestrator/src/turn-refunds";

describe("the snapshot says what it does not know", () => {
  test("every field of an empty snapshot is undefined, not zero", () => {
    const s = emptyRunState("run-1");
    expect(s.version).toBe(RUN_STATE_VERSION);
    expect(s.runId).toBe("run-1");
    expect(s.phase).toBe("working");
    expect(s.budget.spentUsd).toBeUndefined();
    expect(s.budget.turn).toBeUndefined();
    expect(s.evidence.writeCount).toBeUndefined();
    expect(s.health.consecutiveErrors).toBeUndefined();
    expect(s.progress.staleTurns).toBeUndefined();
    expect(s.safety.halted).toBeUndefined();
    expect(s.gates).toEqual({});
  });

  test("a partial snapshot keeps the unread fields undefined", () => {
    const s = makeRunState("run-1", "verifying", {
      budget: { turn: 4, maxTurns: 80 },
      evidence: { writeCount: 2 },
    });
    expect(s.budget.turn).toBe(4);
    expect(s.budget.spentUsd).toBeUndefined();
    expect(s.evidence.openSteps).toBeUndefined();
    expect(s.phase).toBe("verifying");
  });

  test("withPhase copies rather than mutates", () => {
    const s = emptyRunState("run-1");
    const t = withPhase(s, "complete");
    expect(s.phase).toBe("working");
    expect(t.phase).toBe("complete");
    expect(TERMINAL_PHASES.has(t.phase)).toBe(true);
    expect(TERMINAL_PHASES.has(s.phase)).toBe(false);
  });
});

// ─── S9 — a refund never refunds usage ───

describe("S9 — spentUsd is the cost rows and nothing else", () => {
  const COST_ROWS = [
    { listCostUsd: 0.12, costUsd: 0 },
    { listCostUsd: 0.34, costUsd: 0.34 },
    { listCostUsd: 0.04, costUsd: 0.04 },
  ];

  test("spend is the sum of the rows", () => {
    expect(spentUsdFromCostRows(COST_ROWS)).toBeCloseTo(0.5, 10);
  });

  test("a turn refund moves maxTurns and leaves spend exactly where it was", () => {
    const refunds = new TurnRefunds(80);
    let maxTurns = 80;
    const before = makeRunState("run-1", "working", {
      budget: { turn: 10, maxTurns, spentUsd: spentUsdFromCostRows(COST_ROWS) },
    });

    // A gate refused a finish: the completion went to the harness, so the turn
    // comes back. This is exactly what the loop's incident funnel does.
    expect(refunds.tryRefund("loop.evidence_gate", 10)).toBe(true);
    maxTurns += 1;

    const after = makeRunState("run-1", "working", {
      budget: {
        turn: 10,
        maxTurns,
        refundsGranted: refunds.count,
        refundCap: refunds.cap,
        // Re-read from the SAME rows: a refund writes no cost row and deletes
        // none, so rehydration is the whole story.
        spentUsd: spentUsdFromCostRows(COST_ROWS),
      },
    });

    expect(after.budget.maxTurns).toBe(81);
    expect(after.budget.refundsGranted).toBe(1);
    expect(after.budget.spentUsd).toBe(before.budget.spentUsd!);
    expect(after.budget.spentUsd).toBeCloseTo(0.5, 10);
  });

  test("a row with no list price falls back to what was actually paid", () => {
    expect(
      spentUsdFromCostRows([{ costUsd: 0.2 }, { listCostUsd: 0.1, costUsd: 0.05 }]),
    ).toBeCloseTo(0.3, 10);
  });

  test("garbage rows contribute nothing rather than NaN", () => {
    expect(spentUsdFromCostRows([{ listCostUsd: "free" }, {}, { costUsd: -3 }])).toBe(0);
  });
});
