/**
 * Turn refunds: a completion the harness discarded — a refused step, a
 * refused finish, a skipped batch — does not count against the turn ceiling.
 * Once per turn, capped at a quarter of the base ceiling, and decided from a
 * single exported set so the rule cannot drift gate by gate.
 */

import { describe, expect, test } from "bun:test";
import {
  REFUNDABLE_INCIDENTS,
  REFUND_SHARE,
  TurnRefunds,
} from "../../../packages/orchestrator/src/turn-refunds";

describe("TurnRefunds", () => {
  test("the refundable set is the discarded-completion gates, not advisory notes", () => {
    for (const cls of [
      "loop.step_refused",
      "loop.evidence_gate",
      "loop.product_sight_gate",
      "loop.fix_verified_gate",
      "loop.delegation_gate",
      "loop.open_steps_gate",
      "loop.stuck_nudge",
      "loop.result_loop",
      "loop.repeated_call_refused",
      "loop.same_shape_refused",
      "loop.barren_nudge",
    ] as const) {
      expect(REFUNDABLE_INCIDENTS.has(cls)).toBe(true);
    }
    // The turn still did its work under these; nothing to give back.
    for (const cls of [
      "loop.batch_nudge",
      "loop.art_direction_nudge",
      "loop.plan_nudge",
      "loop.wrapup_reserve",
      "loop.max_turns",
      "loop.second_wind",
      "loop.infinite_loop",
      "tool.exec_failure",
      "provider.rate_limit",
    ] as const) {
      expect(REFUNDABLE_INCIDENTS.has(cls)).toBe(false);
    }
  });

  test("the cap is a quarter of the base ceiling, rounded up", () => {
    expect(REFUND_SHARE).toBe(0.25);
    expect(new TurnRefunds(80).cap).toBe(20);
    expect(new TurnRefunds(8).cap).toBe(2);
    expect(new TurnRefunds(4).cap).toBe(1);
    expect(new TurnRefunds(0).cap).toBe(0);
    expect(new TurnRefunds(-5).cap).toBe(0);
  });

  test("one refund per turn: two refusals inside one completion are one completion", () => {
    const r = new TurnRefunds(80);
    expect(r.tryRefund("loop.step_refused", 3)).toBe(true);
    expect(r.tryRefund("loop.step_refused", 3)).toBe(false);
    expect(r.tryRefund("loop.evidence_gate", 3)).toBe(false);
    expect(r.tryRefund("loop.evidence_gate", 4)).toBe(true);
    expect(r.count).toBe(2);
  });

  test("the cap holds and non-refundable classes never count", () => {
    const r = new TurnRefunds(4); // cap 1
    expect(r.tryRefund("loop.max_turns", 1)).toBe(false);
    expect(r.tryRefund("loop.batch_nudge", 1)).toBe(false);
    expect(r.count).toBe(0);
    expect(r.tryRefund("loop.stuck_nudge", 1)).toBe(true);
    expect(r.tryRefund("loop.stuck_nudge", 2)).toBe(false);
    expect(r.tryRefund("loop.barren_nudge", 3)).toBe(false);
    expect(r.count).toBe(1);
  });
});
