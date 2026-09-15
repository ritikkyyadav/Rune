// ─── The empty-completion allowance, across more than one crash ───
//
// V6 finding 12, promoted (reproduced twice red on `8d93987`, and measured end
// to end on the real SIGKILL rig — three `rune` children, loopback mock,
// scratch RUNE_HOME, zero spend; the archive is
// `.codex/audit-20260910/handoff/m0/v6-m3-inherited-count-drift.txt`).
//
// THE CLAIM
//
//   docs/program/m3-first-migration.md, "Migration mechanics" 3:
//     "**Restart does not reset the allowance.** … A run killed after two empty
//      completions that resumes and gets a third abandons; it does not get a
//      fresh three."
//
// WHAT USED TO HAPPEN
//
// `inheritedEmptyCompletions` counted ROWS — `seen += 1` per applied E4
// `working` row — and reset at each `session_started`. A resumed run writes
// rows for its OWN empty completions only: a run that started at an inherited 1
// and spent one more wrote a single row, whose `inputs.emptyCompletions`
// correctly read 2. The next resume counted that one row and inherited 1. The
// allowance survived ONE restart and handed one empty completion back on every
// restart after that:
//
//     run A: 1 empty, SIGKILL     rows [working n=1]
//     run B: 1 empty, SIGKILL     rows [working n=1, working n=2]
//     run C: 2 empties, abandons  rows [… , working n=2, abandoned n=3]
//
// Four empty completions against an allowance of three. The rows already
// carried the truth; the count now reads it.

import { describe, expect, test } from "bun:test";

import { inheritedEmptyCompletions } from "../../../packages/orchestrator/src/lifecycle";

type Row = { event: { type: string; payload: Record<string, unknown> } };

const sessionStarted = (): Row => ({
  event: { type: "checkpoint", payload: { summary: "session_started" } },
});

/** An applied E4 decision row exactly as `decideWithAuthority` writes it. */
const decision = (transition: string, emptyCompletions: number): Row => ({
  event: {
    type: "decision",
    payload: {
      type: "decision",
      version: 1,
      runId: "s#1",
      guard: "E4",
      class: 3,
      applied: true,
      transition,
      inputs: { emptyCompletions, maxEmpty: 3, workStands: false },
      at: "2026-09-14T00:00:00.000Z",
    },
  },
});

describe("the durable empty-completion allowance survives every restart (V6 finding 12)", () => {
  test("a second restart inherits the count the run before it stood at", () => {
    // Run A started clean, spent one empty completion, and was killed.
    // Run B resumed at an inherited 1, spent its own — its row says 2 — and
    // was killed too. This is the log run C reads.
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      sessionStarted(),
      decision("working", 2),
    ];

    // The spec: "a run killed after two empty completions … does not get a
    // fresh three". Two have been spent in a row; the next run must start at 2.
    expect(inheritedEmptyCompletions(log)).toBe(2);
  });

  test("three restarts lose nothing", () => {
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      sessionStarted(),
      decision("working", 2),
      sessionStarted(),
      decision("working", 3),
    ];
    // Three empty completions in a row are on the record, each row saying so.
    expect(inheritedEmptyCompletions(log)).toBe(3);
  });

  test("the first restart is fine — the defect is only from the second on", () => {
    // Pinned as the control, so a fix cannot be mistaken for a change here.
    const log: Row[] = [sessionStarted(), decision("working", 1), decision("working", 2)];
    expect(inheritedEmptyCompletions(log)).toBe(2);
  });
});
