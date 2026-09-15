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

/** The marker a CLEAN end appends in its `finally`. A SIGKILL writes none. */
const sessionEnded = (): Row => ({
  event: { type: "checkpoint", payload: { summary: "session_ended" } },
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

// ─── The reset was on the wrong marker (fix lane C, finding 7, unfixed there) ───
//
// `inheritedRepairTurns` was corrected in `7d3d1ca` to clear on `session_ended`;
// this counter kept clearing on `session_started`, which is the marker a RESTART
// writes. The rows above hide it because each carries its own number — but the
// moment a killed run writes NO row of its own, the reset at its
// `session_started` throws the whole inherited count away. That is every
// SIGKILL early in a run, which is the case the allowance exists for.

describe("the allowance clears on the END of a run, not the START of one", () => {
  test("a crash that wrote no row of its own does not hand the allowance back", () => {
    // Run A spent two empty completions and was killed. Run B resumed, was
    // killed before it reached an empty completion of its own, and wrote no E4
    // row. Run C reads this log.
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      decision("working", 2),
      sessionStarted(),
    ];
    expect(inheritedEmptyCompletions(log)).toBe(2);
  });

  test("two such crashes in a row still stand at two", () => {
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      decision("working", 2),
      sessionStarted(),
      sessionStarted(),
    ];
    expect(inheritedEmptyCompletions(log)).toBe(2);
  });

  test("a CLEAN end resets it — that is what the reset was written for", () => {
    // The run reached its `finally`, so it finished and handed nothing forward;
    // the next request in the session is a new task with a new allowance.
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      decision("working", 2),
      sessionEnded(),
      sessionStarted(),
    ];
    expect(inheritedEmptyCompletions(log)).toBe(0);
  });

  test("a clean end then fresh spending counts only what came after it", () => {
    const log: Row[] = [
      sessionStarted(),
      decision("working", 1),
      decision("working", 2),
      decision("working", 3),
      sessionEnded(),
      sessionStarted(),
      decision("working", 1),
    ];
    expect(inheritedEmptyCompletions(log)).toBe(1);
  });

  test("an older row with no stated count still advances across a restart", () => {
    // `Math.max(seen + 1, stated)` is what keeps a log written before the
    // `inputs.emptyCompletions` field existed monotonic.
    const bare = (): Row => ({
      event: {
        type: "decision",
        payload: { guard: "E4", applied: true, transition: "working", inputs: {} },
      },
    });
    const log: Row[] = [sessionStarted(), bare(), bare(), sessionStarted(), bare()];
    expect(inheritedEmptyCompletions(log)).toBe(3);
  });
});
