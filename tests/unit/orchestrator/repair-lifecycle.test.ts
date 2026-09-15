/**
 * M4 — the durable half of "limits are shared and durable".
 *
 * `inheritedRepairTurns` reads a killed run's own `decision` rows. Everything
 * subtle about it is in this file, because the SIGKILL rig proves the count
 * survives and cannot cheaply prove WHICH count it should be.
 *
 * Three rules, each with its own failure if it is wrong:
 *
 *   1. **Scoped to the last run.** Rows before the most recent
 *      `session_started` belong to runs that already handed their count
 *      forward; counting them again compounds the allowance downward.
 *   2. **Only a SPENT transition counts.** A `verifying` decision is the bound
 *      being enforced, not a turn being spent — counting it would charge a run
 *      for the limit that stopped it.
 *   3. **The row's own number, floored at one more.** Counting rows alone
 *      drops the allowance the killed run had itself inherited, and the loss
 *      compounds one per crash (V6 finding 12, on `inheritedEmptyCompletions`).
 */

import { describe, expect, test } from "bun:test";

import { inheritedRepairTurns } from "../../../packages/orchestrator/src/lifecycle";

type Row = { event: { type: string; payload: Record<string, unknown> } };

function decision(
  guard: string,
  transition: string,
  inputs: Record<string, unknown> = {},
  applied = true,
): Row {
  return { event: { type: "decision", payload: { guard, transition, applied, inputs } } };
}

const STARTED: Row = { event: { type: "checkpoint", payload: { summary: "session_started" } } };

describe("inheritedRepairTurns", () => {
  test("an empty log inherits nothing", () => {
    expect(inheritedRepairTurns([])).toEqual({});
  });

  test("each class counts its own spent transition", () => {
    const rows = [
      decision("REPAIR_TRANSPORT", "working", { attempts: 1 }),
      decision("REPAIR_TRANSPORT", "working", { attempts: 2 }),
      decision("REPAIR_CHECK", "repairing", { repairTurns: 0 }),
      decision("REPAIR_ACCEPTANCE", "repairing", { repromptsUsed: 0 }),
      decision("REPAIR_PROGRESS", "working", { nudges: 0 }),
    ];
    expect(inheritedRepairTurns(rows)).toEqual({
      transport: 2,
      check_failed: 1,
      acceptance: 1,
      no_progress: 1,
    });
  });

  test("a transition that ENFORCED the bound is not a turn spent", () => {
    const rows = [
      decision("REPAIR_CHECK", "verifying", { repairTurns: 1 }),
      decision("REPAIR_ACCEPTANCE", "complete(partial)", { repromptsUsed: 1 }),
      decision("REPAIR_TRANSPORT", "abandoned(environment)", { attempts: 3 }),
      decision("REPAIR_PROGRESS", "abandoned(no_progress)", { nudges: 1 }),
    ];
    expect(inheritedRepairTurns(rows)).toEqual({});
  });

  test("`missing_dependency` and `denied` have no counter — they buy nothing", () => {
    const rows = [
      decision("REPAIR_DEPENDENCY", "verifying", { missingRunner: true }),
      decision("REPAIR_DENIED", "blocked(ask)", { denied: true }),
    ];
    expect(inheritedRepairTurns(rows)).toEqual({});
  });

  test("a row that was never applied is not a spend", () => {
    expect(inheritedRepairTurns([decision("REPAIR_CHECK", "repairing", {}, false)])).toEqual({});
  });

  test("a later `session_started` resets the count — an earlier run handed it on", () => {
    const rows = [
      decision("REPAIR_PROGRESS", "working", { nudges: 0 }),
      decision("REPAIR_PROGRESS", "working", { nudges: 1 }),
      STARTED,
      decision("REPAIR_PROGRESS", "working", { nudges: 0 }),
    ];
    expect(inheritedRepairTurns(rows)).toEqual({ no_progress: 1 });
  });

  test("the ROW'S own number wins — the allowance does not shrink one per crash", () => {
    // Run A spent one and wrote one row. Run B inherited 1, spent one more,
    // and wrote ONE row whose `repairTurns` correctly reads 1. Counting rows
    // alone would tell run C it had spent one, not two.
    const rows = [decision("REPAIR_CHECK", "repairing", { repairTurns: 1 })];
    expect(inheritedRepairTurns(rows)).toEqual({ check_failed: 2 });
  });

  test("a row with no number still advances the count by one", () => {
    const rows = [decision("REPAIR_CHECK", "repairing", {}), decision("REPAIR_CHECK", "repairing")];
    expect(inheritedRepairTurns(rows)).toEqual({ check_failed: 2 });
  });

  test("a guard with no repair rule is ignored, not guessed at", () => {
    expect(inheritedRepairTurns([decision("E4", "working", { emptyCompletions: 2 })])).toEqual({});
  });
});
