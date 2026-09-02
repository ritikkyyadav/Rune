/**
 * The pure halves of M2–M4: the held-step state machine and the fleet reducer.
 *
 * Both exist as pure functions for the same reason the TUI's do — the defaults
 * are pinned by tests rather than by folklore, and the two surfaces can be
 * checked against each other. `heldAction` here is a port of
 * `bin/ui/held.ts`'s, and these tests are deliberately the same shape.
 */

import { describe, expect, test } from "bun:test";

import {
  heldAction,
  nextUndecided,
  type HeldOutcome,
} from "../../../apps/desktop/src/components/Cards";
import {
  INITIAL_FLEET,
  fleetReducer,
  fleetRows,
  projectChild,
} from "../../../apps/desktop/src/lib/fleet";
import type { AgentTurnEvent } from "../../../packages/protocol/src/index";

const view = (outcomes: Array<HeldOutcome | null>, selected = 0) => ({
  steps: outcomes.map((_, i) => ({ id: `s${i}` })),
  outcomes,
  selected,
});

describe("the held-step panel's state machine", () => {
  test("enter runs the selected step", () => {
    expect(heldAction("Enter", view([null, null], 1))).toEqual({ kind: "run", index: 1 });
  });

  test("a digit picks AND runs — the one-keystroke fast path", () => {
    expect(heldAction("2", view([null, null, null]))).toEqual({ kind: "run", index: 1 });
  });

  test("a digit past the end does nothing", () => {
    expect(heldAction("9", view([null]))).toEqual({ kind: "ignore" });
  });

  test("a decided step cannot be re-run by a stray key", () => {
    // A step cannot be un-run. The second press of a key is exactly when
    // someone re-runs a publish they already approved.
    expect(heldAction("1", view(["ran", null]))).toEqual({ kind: "ignore" });
    expect(heldAction("Enter", view(["ran", null], 0))).toEqual({ kind: "ignore" });
    expect(heldAction("s", view(["ran", null], 0))).toEqual({ kind: "ignore" });
  });

  test("s leaves a step unrun; esc closes and leaves the rest", () => {
    expect(heldAction("s", view([null, null], 0))).toEqual({ kind: "skip", index: 0 });
    expect(heldAction("Escape", view([null, null]))).toEqual({ kind: "leave" });
  });

  test("the arrows wrap", () => {
    expect(heldAction("ArrowDown", view([null, null, null], 2))).toEqual({
      kind: "move",
      selected: 0,
    });
    expect(heldAction("ArrowUp", view([null, null, null], 0))).toEqual({
      kind: "move",
      selected: 2,
    });
  });

  test("an empty ledger closes rather than trapping the keyboard", () => {
    expect(heldAction("Enter", view([]))).toEqual({ kind: "leave" });
  });

  test("nextUndecided wraps and reports -1 when everything is decided", () => {
    expect(nextUndecided(["ran", null, null], 0)).toBe(1);
    expect(nextUndecided([null, "ran", "ran"], 1)).toBe(0);
    expect(nextUndecided(["ran", "skipped"], 0)).toBe(-1);
  });
});

// ─── The fleet ───

const child = (agentId: string, event: AgentTurnEvent, label?: string): AgentTurnEvent => ({
  type: "tool_progress",
  callId: "c1",
  note: "…",
  child: { agentId, label, event },
});

describe("the fleet reads child events, not prose", () => {
  test("a new agent opens a row in dispatch order", () => {
    let f = INITIAL_FLEET;
    f = fleetReducer(
      f,
      child("b", { type: "tool_call_start", callId: "x", toolName: "bash" }, "B"),
    );
    f = fleetReducer(
      f,
      child("a", { type: "tool_call_start", callId: "y", toolName: "read" }, "A"),
    );
    // Arrival order is whichever worker happened to speak first; the panel must
    // not reorder itself while someone is reading it.
    expect(fleetRows(f).map((r) => r.agentId)).toEqual(["b", "a"]);
    expect(fleetRows(f).map((r) => r.label)).toEqual(["B", "A"]);
  });

  test("turn_complete finishes a row and error fails it", () => {
    let f = INITIAL_FLEET;
    f = fleetReducer(f, child("a", { type: "tool_call_start", callId: "x", toolName: "bash" }));
    expect(fleetRows(f)[0]!.state).toBe("running");
    f = fleetReducer(
      f,
      child("a", { type: "turn_complete", stopReason: "end_turn", totalTurns: 1 }),
    );
    expect(fleetRows(f)[0]!.state).toBe("done");
    expect(fleetRows(f)[0]!.endedAt).toBeDefined();

    let g = INITIAL_FLEET;
    g = fleetReducer(g, child("z", { type: "error", error: "boom", recoverable: false }));
    expect(fleetRows(g)[0]!.state).toBe("failed");
    expect(fleetRows(g)[0]!.note).toContain("boom");
  });

  test("a silent child event never blanks the row's last real line", () => {
    // Token deltas would strobe a one-line rung. Ignoring them is the point;
    // ignoring them by writing an empty string over the last note is a bug.
    let f = INITIAL_FLEET;
    f = fleetReducer(f, child("a", { type: "tool_call_start", callId: "x", toolName: "bash" }));
    const before = fleetRows(f)[0]!.note;
    f = fleetReducer(f, child("a", { type: "text_delta", text: "thinking…" }));
    expect(fleetRows(f)[0]!.note).toBe(before);
  });

  test("tool calls are tallied per agent", () => {
    let f = INITIAL_FLEET;
    for (const t of ["bash", "read_file", "glob"]) {
      f = fleetReducer(f, child("a", { type: "tool_call_start", callId: t, toolName: t }));
    }
    expect(fleetRows(f)[0]!.tools).toBe(3);
  });

  test("a tool_progress with no child is not a fleet event", () => {
    // The lead's own heartbeats come through the same member. Only a child
    // makes a row.
    const f = fleetReducer(INITIAL_FLEET, { type: "tool_progress", callId: "c", note: "working" });
    expect(f.rows).toHaveLength(0);
  });

  test("the projection is silent on exactly the members that would strobe", () => {
    expect(projectChild({ type: "text_delta", text: "x" })).toBeNull();
    expect(projectChild({ type: "thinking_delta", text: "x" })).toBeNull();
    expect(projectChild({ type: "tool_progress", callId: "c", note: "n" })).toBeNull();
    expect(projectChild({ type: "tool_call_start", callId: "c", toolName: "bash" })).toBe("bash");
  });
});
