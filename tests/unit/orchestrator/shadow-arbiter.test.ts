/**
 * The shadow lane's own bounds: S6 (bounded logging), the sanitiser that keeps
 * prose and credentials out of every row, the per-step ladder, and the
 * summary's arithmetic.
 *
 * Nothing here runs a loop. The arbiter is handed events directly, because the
 * properties being asserted — 200 rows then a cap, no row over 2 KB, no string
 * that is not an enum word — must hold whatever drove it.
 */

import { describe, expect, test } from "bun:test";

import {
  OMITTED,
  SHADOW_ROW_CAP,
  SHADOW_ROW_MAX_BYTES,
  ShadowArbiter,
  sanitizeInputs,
  shadowSummaryLines,
  type ShadowDecisionRow,
  type ShadowRow,
  type ShadowSummaryRow,
} from "../../../packages/orchestrator/src/shadow-arbiter";
import { makeRunState } from "../../../packages/orchestrator/src/run-state";

function rig(cap?: number) {
  const rows: ShadowRow[] = [];
  const arbiter = new ShadowArbiter({
    runId: "s1#1",
    emit: (row) => rows.push(row),
    now: () => "2026-09-14T00:00:00.000Z",
    ...(cap === undefined ? {} : { cap }),
  });
  return { rows, arbiter };
}

const state = (turn: number) => makeRunState("s1#1", "working", { budget: { turn } });

const decisions = (rows: ShadowRow[]): ShadowDecisionRow[] =>
  rows.filter((r): r is ShadowDecisionRow => r.type === "shadow_decision");

const summaryOf = (rows: ShadowRow[]): ShadowSummaryRow =>
  rows.find((r): r is ShadowSummaryRow => r.type === "shadow_summary")!;

// ─── S6 — bounded logging ───

describe("S6 — the ledger is bounded", () => {
  test("1,000 events write 200 decision rows, one capped row and one summary", () => {
    const { rows, arbiter } = rig();
    for (let i = 0; i < 1000; i++) {
      arbiter.observe("G0", { pending: true }, "working", state(i));
    }
    arbiter.finish();

    expect(decisions(rows).length).toBe(SHADOW_ROW_CAP);
    expect(rows.filter((r) => r.type === "shadow_capped").length).toBe(1);
    expect(rows.filter((r) => r.type === "shadow_summary").length).toBe(1);

    const summary = summaryOf(rows);
    expect(summary.events).toBe(1000);
    expect(summary.capped).toBe(1000 - SHADOW_ROW_CAP);
    expect(summary.agreements).toBe(1000);
  });

  test("no row exceeds 2 KB, even when a site hands over a wall of inputs", () => {
    const { rows, arbiter } = rig();
    const fat: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) fat[`counter_with_a_long_name_${i}`] = i;
    arbiter.observe("G0", { pending: true, ...fat }, "working", state(1));
    arbiter.finish();

    for (const row of rows) {
      expect(JSON.stringify(row).length).toBeLessThanOrEqual(SHADOW_ROW_MAX_BYTES);
    }
    expect(decisions(rows)[0]!.inputs.truncated).toBe(true);
  });

  test("a throwing sink cannot break the run", () => {
    const arbiter = new ShadowArbiter({
      runId: "s1#1",
      emit: () => {
        throw new Error("the database is gone");
      },
    });
    expect(() => {
      arbiter.observe("G0", { pending: true }, "working", state(1));
      arbiter.finish();
    }).not.toThrow();
  });
});

// ─── The rows carry no prose ───

describe("no row carries message text, tool arguments or credentials", () => {
  test("the sanitiser keeps booleans, numbers and allowlisted enum words only", () => {
    const clean = sanitizeInputs({
      pending: true,
      turn: 4,
      verdictKind: "met",
      stopReason: "end_turn",
      // Everything below is exactly what must never reach a row.
      haltReason: "the supervisor flagged `curl https://example.com/key?token=sk-live-9`",
      command: "rm -rf /",
      apiKey: "sk-ant-api03-REDACTED-LOOKING-BUT-REAL",
      path: "/Users/someone/.rune/config.toml",
      verdictKind2: "met",
      blob: { nested: "object" },
      list: [1, 2, 3],
      absent: undefined,
    });
    expect(clean).toEqual({
      pending: true,
      turn: 4,
      verdictKind: "met",
      stopReason: "end_turn",
      haltReason: OMITTED,
      command: OMITTED,
      apiKey: OMITTED,
      path: OMITTED,
      verdictKind2: OMITTED,
      blob: OMITTED,
      list: OMITTED,
      absent: null,
    });
  });

  test("an enum key still rejects a value outside its set", () => {
    expect(sanitizeInputs({ verdictKind: "met but actually the key is sk-123" })).toEqual({
      verdictKind: OMITTED,
    });
  });

  test("a row built from a poisoned site carries none of it", () => {
    const { rows, arbiter } = rig();
    arbiter.observe(
      "E3",
      {
        halted: true,
        reportGranted: false,
        reason: "SECRET-CANARY-7f2a",
        args: { file: "/etc/passwd" },
      },
      "blocked(halt)",
      state(1),
    );
    arbiter.finish();
    const json = JSON.stringify(rows);
    expect(json).not.toContain("SECRET-CANARY-7f2a");
    expect(json).not.toContain("/etc/passwd");
  });
});

// ─── The ladder, per step ───

describe("events in one step resolve by class", () => {
  test("a halt beside a failing gate wins, and the loser is recorded as superseded", () => {
    const { rows, arbiter } = rig();
    arbiter.observe(
      "G4",
      {
        anyWritesThisRun: true,
        executedSinceWrite: false,
        projectChecksPassed: false,
        planSettled: false,
        fired: 0,
      },
      "verifying",
      state(3),
    );
    arbiter.observe("E3", { halted: true, reportGranted: false }, "blocked(halt)", state(3));
    arbiter.finish();

    const written = decisions(rows);
    expect(written.length).toBe(2);
    const gate = written.find((r) => r.guard === "G4")!;
    const halt = written.find((r) => r.guard === "E3")!;
    expect(halt.decision).toBe("blocked(halt)");
    expect(halt.supersededBy).toBeUndefined();
    // The loser keeps its OWN proposal — erasing it would hide what the gate
    // would have done — and names the winner's decision id (`d:${runId}:${seq}`).
    expect(gate.decision).toBe("verifying");
    expect(gate.supersededBy).toBe(`d:s1#1:${halt.seq}`);
    expect(summaryOf(rows).superseded).toBe(1);
  });

  test("a terminal winner absorbs every later step", () => {
    const { rows, arbiter } = rig();
    arbiter.observe("E2", { aborted: true }, "abandoned(user_abort)", state(1));
    // A later step: the run is over as far as the arbiter is concerned.
    arbiter.observe("VERDICT", { hasVerdict: true, verdictKind: "met" }, "complete(met)", state(2));
    arbiter.finish();

    const written = decisions(rows);
    expect(written[0]!.decision).toBe("abandoned(user_abort)");
    expect(written[1]!.decision).toBe("unknown");
    expect(written[1]!.reason).toBe("run already terminal");
    expect(summaryOf(rows).unknowns).toBe(1);
  });
});

// ─── The summary ───

describe("the summary counts what happened", () => {
  test("agreements, disagreements and unknowns are disjoint and total the events", () => {
    const { rows, arbiter } = rig();
    // agree
    arbiter.observe("G0", { pending: true }, "working", state(1));
    // disagree: G9 with nothing standing, accepted as a finish anyway
    arbiter.observe("G9", { workStands: false, hasVerdict: false }, "complete(end_turn)", state(2));
    // unknown: a site that could not read its input
    arbiter.observe("E1", {}, "abandoned(budget)", state(3));
    arbiter.finish();

    const s = summaryOf(rows);
    expect(s.events).toBe(3);
    expect(s.agreements).toBe(1);
    expect(s.disagreements).toBe(1);
    expect(s.unknowns).toBe(1);
    expect(s.agreements + s.disagreements + s.unknowns).toBe(s.events);
    expect(s.disagreementList).toEqual([
      { guard: "G9", expected: "abandoned(environment)", actual: "complete(end_turn)" },
    ]);
  });

  test("overhead is measured per event and reported, not asserted away", () => {
    const { rows, arbiter } = rig();
    for (let i = 0; i < 5; i++) arbiter.observe("G0", { pending: true }, "working", state(i));
    arbiter.finish();
    const s = summaryOf(rows);
    expect(s.overheadUs.total).toBeGreaterThan(0);
    expect(s.overheadUs.p95).toBeGreaterThanOrEqual(s.overheadUs.p50);
    for (const row of decisions(rows)) expect(row.overheadUs).toBeGreaterThanOrEqual(0);
  });

  test("a guard that cannot be shadowed is named, once", () => {
    const { rows, arbiter } = rig();
    arbiter.unshadowed("E9");
    arbiter.unshadowed("E9");
    arbiter.unshadowed("E11");
    // Not on the list: not recorded, so the summary cannot invent coverage.
    arbiter.unshadowed("G4");
    arbiter.finish();
    expect(summaryOf(rows).unshadowed).toEqual(["E11", "E9"]);
  });

  test("every decision row says it applied nothing", () => {
    const { rows, arbiter } = rig();
    arbiter.observe("G0", { pending: true }, "working", state(1));
    arbiter.finish();
    for (const row of decisions(rows)) expect(row.applied).toBe(false);
  });

  test("the summary renders as a block a person can read", () => {
    const { rows, arbiter } = rig();
    arbiter.observe("G9", { workStands: false, hasVerdict: false }, "complete(end_turn)", state(1));
    arbiter.finish();
    const lines = shadowSummaryLines(summaryOf(rows));
    expect(lines[0]).toContain("disagree 1");
    expect(lines[1]).toContain("overhead p50");
    expect(lines.some((l) => l.startsWith("G9:"))).toBe(true);
  });

  test("finish is idempotent — one summary per run", () => {
    const { rows, arbiter } = rig();
    arbiter.observe("G0", { pending: true }, "working", state(1));
    arbiter.finish();
    arbiter.finish();
    arbiter.observe("G0", { pending: true }, "working", state(2));
    expect(rows.filter((r) => r.type === "shadow_summary").length).toBe(1);
    expect(decisions(rows).length).toBe(1);
  });
});

describe("the summary is a row like every other row (V6 finding 18)", () => {
  // S6 asserted "no row > 2 KB" and drove ONE agreeing event, so its summary
  // was near-empty and the assertion held vacuously. Forty recorded
  // disagreements made a 3,135-byte `shadow_summary`: `disagreementList` was
  // the one growing field that never went through `bound`.
  function fortyFiveDisagreements(): ShadowRow[] {
    const rows: ShadowRow[] = [];
    const arbiter = new ShadowArbiter({
      runId: "s1#1",
      emit: (row) => rows.push(row),
      now: () => "2026-09-14T00:00:00.000Z",
    });
    for (let turn = 0; turn < 45; turn++) {
      arbiter.observe(
        "G6",
        { required: true, reviewed: false, fired: 0 },
        "abandoned(environment)",
        makeRunState("s1#1", "working", { budget: { turn } }),
      );
    }
    arbiter.finish();
    return rows;
  }

  test("every row is under the ceiling, the one that grows included", () => {
    const rows = fortyFiveDisagreements();
    const oversized = rows.filter((r) => JSON.stringify(r).length > SHADOW_ROW_MAX_BYTES);
    expect(oversized.map((r) => r.type)).toEqual([]);
  });

  test("the list is trimmed to fit and the true count survives", () => {
    // The verifier's own test asserted `disagreementList.length === 40` AND
    // the 2 KB ceiling. Those cannot both hold — forty entries of this shape
    // are ~3.1 KB — so the ceiling wins and the LIST is what gives way. The
    // count is not lost: `disagreements` still says 45, and a list shorter
    // than the count says plainly that it was trimmed. Named here because it
    // is a deliberate change to what the red test asked for.
    const summary = fortyFiveDisagreements().find(
      (r): r is ShadowSummaryRow => r.type === "shadow_summary",
    )!;
    expect(summary.disagreements).toBe(45);
    expect(summary.disagreementList.length).toBeGreaterThan(0);
    expect(summary.disagreementList.length).toBeLessThan(40);
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(SHADOW_ROW_MAX_BYTES);
  });
});

describe("overheadUs is the arbiter's own cost (V6 finding 19)", () => {
  const spin = (ms: number) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      /* the loop doing its own work between two guard triggers */
    }
  };

  test("the loop's own time between two steps is not billed to the arbiter", () => {
    // `startedUs` was stamped in `observe()` and read in `record()`, which runs
    // at the NEXT step's flush — so everything the LOOP did in between was
    // inside the window, and `rune audit` printed it as the arbiter's cost.
    const rows: ShadowRow[] = [];
    const arbiter = new ShadowArbiter({
      runId: "s1#1",
      emit: (row) => rows.push(row),
      now: () => "2026-09-14T00:00:00.000Z",
    });
    arbiter.observe("G0", { pending: true }, "working", state(1));
    spin(120); // a turn of real work; the arbiter is doing nothing at all
    arbiter.observe("G0", { pending: true }, "working", state(2)); // flushes step 1
    arbiter.finish();

    const decisions = rows.filter((r): r is ShadowDecisionRow => r.type === "shadow_decision");
    expect(decisions[0]!.overheadUs).toBeLessThan(10_000);
  });

  test("what the row sink costs is reported, as the sink's own number", () => {
    // The verifier asked for the sink to be folded INTO `overheadUs`. It is
    // reported beside it instead — a 50 ms `appendEvent` is the embedder's
    // cost, and billing it to the arbiter would report a slow database as a
    // slow arbiter — but reporting it nowhere was the other half of the same
    // dishonesty, so `sinkUs` exists and `rune audit` prints it.
    const rows: ShadowRow[] = [];
    const arbiter = new ShadowArbiter({
      runId: "s1#1",
      emit: (row) => {
        spin(50); // stands in for the Engine's synchronous appendEvent
        rows.push(row);
      },
      now: () => "2026-09-14T00:00:00.000Z",
    });
    arbiter.observe("G0", { pending: true }, "working", state(1));
    arbiter.finish();

    const summary = rows.find((r): r is ShadowSummaryRow => r.type === "shadow_summary")!;
    expect(summary.sinkUs).toBeGreaterThan(40_000);
    expect(summary.overheadUs.total).toBeLessThan(10_000);
    expect(shadowSummaryLines(summary).join(" ")).toContain("row sink");
  });
});
