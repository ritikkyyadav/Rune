// ─── Turn refunds: the harness does not spend the model's budget on itself ───
//
// Every gate in the loop is individually defensible, and each one costs a
// completion: a refused step completion, an evidence or product-sight
// refusal, a skipped batch after a stuck nudge. Those completions counted
// against the turn ceiling exactly like productive ones, so the more the
// harness policed a run the more certain it was to end at the ceiling — nine
// runs did, three of them in one afternoon, and the second wind never fired
// once because the same nudges also vetoed it (see agent-loop.ts, second wind).
//
// The rule: a completion the harness DISCARDED — refused, skipped, or held —
// is refunded: the ceiling moves up by one, at most once per turn and up to a
// quarter of the base ceiling. Advisory notes (a batch nudge riding along
// with real results, an art-direction question) are not refunds: the turn
// still did its work. The refund is applied in the loop's incident funnel
// against the exported set below, so a new gate that reports one of these
// classes is refunded without anyone remembering to wire it.
//
// A clocked sub-agent (one running under a turn-budget notice) gets no
// refunds: its ceiling is a deadline it was told to watch, and a refund
// would move the clock it is reading — found by the scout budget test the
// first time this shipped.

import type { IncidentClass } from "@rune/shared";

/** Incident classes that mean "this completion went to the harness, not the task". */
export const REFUNDABLE_INCIDENTS: ReadonlySet<IncidentClass> = new Set<IncidentClass>([
  // A step completion the ledger refused: the todo_write is re-issued.
  "loop.step_refused",
  // A finish the gates refused: the model's closing completion is discarded.
  "loop.evidence_gate",
  "loop.product_sight_gate",
  "loop.fix_verified_gate",
  "loop.delegation_gate",
  "loop.open_steps_gate",
  // Calls the loop skipped or refused outright instead of executing.
  "loop.stuck_nudge",
  "loop.result_loop",
  "loop.repeated_call_refused",
  "loop.same_shape_refused",
  // Two whole turns of refusals, then the corrective note.
  "loop.barren_nudge",
]);

/** Share of the base ceiling that may be refunded in one run. */
export const REFUND_SHARE = 0.25;

export class TurnRefunds {
  readonly cap: number;
  private granted = 0;
  private lastRefundedTurn = -1;

  constructor(baseMaxTurns: number) {
    this.cap = Math.max(0, Math.ceil(Math.max(0, baseMaxTurns) * REFUND_SHARE));
  }

  /** Refunds granted so far this run. */
  get count(): number {
    return this.granted;
  }

  /**
   * Decide whether an incident earns the current turn back. True at most once
   * per turn (two refusals inside one completion are still one completion)
   * and never past the cap.
   */
  tryRefund(cls: IncidentClass, turn: number): boolean {
    if (!REFUNDABLE_INCIDENTS.has(cls)) return false;
    if (this.granted >= this.cap) return false;
    if (turn === this.lastRefundedTurn) return false;
    this.granted++;
    this.lastRefundedTurn = turn;
    return true;
  }
}
