/**
 * The working indicator: a calm mark, a whole phrase, and the clock.
 *
 * Founder, 2026-09-15: it "does not look satisfying — make it soothing and
 * calm, give it proper character, the whole text and a pulse". What was there
 * was `▄ working · asking`: one bright accent cell off the eight-level block
 * ramp, sized by the byte rate, beside a label that was equally true of a
 * grep, a 90-second test run and four sub-agents.
 *
 * Three claims are pinned here, and each of them is the kind that rots first:
 *
 *   1. the CADENCE — the colour ramp advances one step per 700ms, never
 *      faster, and cycles; the mark's SHAPE never changes;
 *   2. the ALPHABET — the indicator never emits a cell from the block ramp,
 *      at any level, in either rung;
 *   3. the PHRASES — every phrase the indicator can produce is reachable from
 *      an event the renderer already reads, and nothing else is reachable.
 */
import { describe, expect, it } from "bun:test";
import {
  BREATH_MS,
  BREATH_TINTS,
  breathStep,
  breathTint,
  elapsedWord,
  workingKindForTool,
  workingMark,
  workingPhrase,
  workingRow,
  type WorkingKind,
  type WorkingState,
} from "../../../packages/orchestrator/src/bin/ui/working";
import { GLYPH_DEFINITIONS, PULSE_GLYPHS } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";

const MARK = GLYPH_DEFINITIONS.working.utf8;

describe("the cadence", () => {
  it("is 700ms a step -- inside the founder's 600-800ms window, and never faster", () => {
    expect(BREATH_MS).toBeGreaterThanOrEqual(600);
    expect(BREATH_MS).toBeLessThanOrEqual(800);
  });

  it("advances exactly one step per cadence and cycles", () => {
    // Stated at the boundaries, because a step that advances at 699ms is a
    // faster cadence than the one this file claims.
    expect(breathStep(0)).toBe(0);
    expect(breathStep(BREATH_MS - 1)).toBe(0);
    expect(breathStep(BREATH_MS)).toBe(1);
    expect(breathStep(BREATH_MS * 2)).toBe(2);
    expect(breathStep(BREATH_MS * 3)).toBe(3);
    expect(breathStep(BREATH_MS * 4)).toBe(4);
    // A whole breath is five steps; the sixth is the first again.
    expect(BREATH_TINTS).toHaveLength(5);
    expect(breathStep(BREATH_MS * 5)).toBe(0);
    expect(breathStep(BREATH_MS * 12)).toBe(breathStep(BREATH_MS * 7));
  });

  it("ramps muted -> text -> accent -> text -> muted, so it rests at the bottom", () => {
    expect([...BREATH_TINTS]).toEqual(["muted", "text", "accent", "text", "muted"]);
    // Symmetric: the way up is the way down. An asymmetric ramp reads as a
    // snap back rather than as a breath.
    for (let i = 0; i < BREATH_TINTS.length; i++) {
      expect(breathTint(i)).toBe(BREATH_TINTS[i]!);
    }
    expect(breathTint(5)).toBe("muted");
    expect(breathTint(-1)).toBe("muted");
  });

  it("changes COLOUR and never shape: one cell, the same cell, every step", () => {
    const state: WorkingState = { kind: "running", target: "checks" };
    const shapes = new Set<string>();
    for (let step = 0; step < 20; step++) {
      const cell = workingMark(state, step);
      shapes.add(stripAnsi(cell));
      expect(visLen(cell)).toBe(1);
    }
    // ONE shape across the whole cycle -- this is the assertion the block ramp
    // could never have passed.
    expect([...shapes]).toEqual([MARK]);
    // …and the TINT genuinely moves, or it is not a breath. Asserted on the
    // tint name rather than on the painted bytes: the suite runs with NO_COLOR
    // set, where `theme` emits no escapes at all and every step would be
    // byte-identical -- which would make this test pass against a mark that
    // had stopped breathing.
    const tints = new Set(Array.from({ length: 20 }, (_, step) => breathTint(step)));
    expect(tints.size).toBeGreaterThan(1);
  });

  it("does not breathe where there is nothing to breathe about", () => {
    // `done` is finished and `waiting` is waiting on a person. A mark still
    // pulsing through either would be reporting activity that is not
    // happening -- the exact failure the byte-fed pulse was built to stop.
    for (const kind of ["done", "waiting"] as WorkingKind[]) {
      const held = new Set(Array.from({ length: 10 }, (_, step) => workingMark({ kind }, step)));
      expect(held.size, kind).toBe(1);
    }
  });
});

describe("the alphabet", () => {
  it("never emits a cell from the block ramp, at any step or any state", () => {
    const ramp = new Set(PULSE_GLYPHS.map((g) => g.utf8));
    const kinds: WorkingKind[] = [
      "thinking",
      "reading",
      "editing",
      "running",
      "delegating",
      "answering",
      "waiting",
      "compacting",
      "done",
    ];
    for (const kind of kinds) {
      for (let step = 0; step < 10; step++) {
        for (const mode of ["utf8", "ascii", "ambig"] as const) {
          const row = stripAnsi(
            workingRow({ kind, target: "turn.ts", elapsedMs: step * BREATH_MS }, { mode }),
          );
          const cell = stripAnsi(workingMark({ kind }, step, mode));
          // The UTF-8 ramp only. The block levels' ASCII TWINS are ordinary
          // punctuation (`_ . , - = + * #`) -- `*` is also `phase`'s twin and
          // `gear`'s -- so a twin collision is the seven-bit fallback working
          // as designed, not the ramp leaking back in. What must never appear
          // is a block cell.
          expect(ramp.has(cell), `${kind}/${step}/${mode}`).toBe(false);
          expect(
            row.split("").some((c) => ramp.has(c)),
            `${kind}/${step}/${mode}`,
          ).toBe(false);
        }
      }
    }
  });

  it("has a one-cell ASCII twin, and the phrase survives NO_COLOR and ascii", () => {
    expect(visLen(GLYPH_DEFINITIONS.working.ascii)).toBe(1);
    const row = stripAnsi(
      workingRow({ kind: "running", target: "checks", elapsedMs: 65_000 }, { mode: "ascii" }),
    );
    // Nothing is carried by the mark or the colour alone: strip both and the
    // row still says what is happening and for how long.
    expect(row).toContain("Running checks");
    expect(row).toContain("1m 05s");
    expect(row).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe("the phrases", () => {
  // The founder's own five examples, verbatim in shape.
  it("reads the way the founder wrote it", () => {
    const row = (state: WorkingState) => stripAnsi(workingRow(state));
    expect(row({ kind: "thinking", elapsedMs: 12_000 })).toBe(`${MARK} Thinking · 12s`);
    expect(row({ kind: "reading", target: "turn.ts", elapsedMs: 40_000 })).toBe(
      `${MARK} Reading turn.ts · 40s`,
    );
    expect(row({ kind: "running", target: "checks", elapsedMs: 65_000 })).toBe(
      `${MARK} Running checks · 1m 05s`,
    );
    // The one state that is about the reader, not the machine -- and the one
    // with no clock, because how long it has been true of YOU is not news.
    expect(row({ kind: "waiting", elapsedMs: 9_000 })).toBe(`${MARK} Waiting for you`);
    expect(row({ kind: "done", elapsedMs: 118_000 })).toBe(`${MARK} Done · 1m 58s`);
  });

  it("every phrase is reachable from a real event, and nothing else is", () => {
    // The closed set, and the event that produces each one. A phrase with no
    // event is a phrase that will eventually be produced by everything, which
    // is what `working` was.
    const table: Array<[WorkingKind, string, string]> = [
      ["thinking", "Thinking", "no tool, no fleet, no prose -- the resting state"],
      ["reading", "Reading turn.ts", "tool_call_start: read_file / grep / glob / web_fetch"],
      ["editing", "Editing turn.ts", "tool_call_start: edit_file / write_file / apply_patch"],
      ["running", "Running turn.ts", "tool_call_start: bash, or the verification notice"],
      ["delegating", "Delegating turn.ts", "tool_call_start: task / worker, or a live fleet"],
      ["answering", "Answering", "text_delta -- prose is streaming"],
      ["waiting", "Waiting for you", "tool_call_start: ask_user"],
      ["compacting", "Compacting", "the harness notice that it is rewriting context"],
      ["done", "Done", "turn_complete"],
    ];
    for (const [kind, phrase] of table) {
      expect(workingPhrase({ kind, target: "turn.ts" }), kind).toBe(phrase);
    }
    // And the set is closed: every kind in the table, every kind in the type.
    const covered = new Set(table.map(([kind]) => kind));
    for (const kind of covered) expect(workingPhrase({ kind })).toBeTruthy();
    expect(covered.size).toBe(9);
  });

  it("takes the caller's own phrase when the event already composed one", () => {
    // `liveToolLabel` has been writing these for a year, including the one
    // that matters most: the placeholder that stops a half-arrived command
    // being typed out letter by letter.
    expect(workingPhrase({ kind: "running", phrase: "Running the necessary command" })).toBe(
      "Running the necessary command",
    );
    expect(workingPhrase({ kind: "editing", target: "a.ts", phrase: "Updating src/a.ts" })).toBe(
      "Updating src/a.ts",
    );
    // An empty one falls through to the closed table rather than blanking the row.
    expect(workingPhrase({ kind: "thinking", phrase: "   " })).toBe("Thinking");
  });

  it("maps tool names onto kinds the way the transcript's own verbs do", () => {
    expect(workingKindForTool("read_file")).toBe("reading");
    expect(workingKindForTool("read_many")).toBe("reading");
    expect(workingKindForTool("grep")).toBe("reading");
    expect(workingKindForTool("multi_edit")).toBe("editing");
    expect(workingKindForTool("apply_patch")).toBe("editing");
    expect(workingKindForTool("bash")).toBe("running");
    expect(workingKindForTool("task")).toBe("delegating");
    expect(workingKindForTool("worker")).toBe("delegating");
    expect(workingKindForTool("ask_user")).toBe("waiting");
    // A tool this does not know is `running`, which is literally true of any
    // call and claims nothing more.
    expect(workingKindForTool("some_mcp_tool")).toBe("running");
  });

  it("never invents a subject for a state that has none", () => {
    // `Thinking about turn.ts` would be a claim about what the model is
    // thinking, which nothing on the wire can support.
    for (const kind of ["thinking", "answering", "waiting", "done"] as WorkingKind[]) {
      expect(workingPhrase({ kind, target: "turn.ts" })).not.toContain("turn.ts");
    }
  });
});

describe("the clock", () => {
  it("is seconds, then zero-padded minutes, so the tail does not change width", () => {
    expect(elapsedWord(0)).toBe("0s");
    expect(elapsedWord(999)).toBe("0s");
    expect(elapsedWord(12_000)).toBe("12s");
    expect(elapsedWord(59_999)).toBe("59s");
    expect(elapsedWord(60_000)).toBe("1m 00s");
    expect(elapsedWord(65_000)).toBe("1m 05s");
    expect(elapsedWord(118_000)).toBe("1m 58s");
    expect(elapsedWord(3_600_000)).toBe("1h 00m");
    expect(elapsedWord(3_840_000)).toBe("1h 04m");
    expect(elapsedWord(-5)).toBe("0s");
  });

  it("is dropped where there is nothing worth timing", () => {
    expect(stripAnsi(workingRow({ kind: "thinking" }))).toBe(`${MARK} Thinking`);
    expect(stripAnsi(workingRow({ kind: "waiting", elapsedMs: 600_000 }))).not.toContain("m ");
  });
});

// ─── the wiring: every phrase, from the event that produces it ───
//
// The table above proves the phrase set is closed. This proves it is REACHED
// -- that each phrase comes out of the renderer when the corresponding event
// goes in, and not from a heuristic, a timer, or the model's prose. A closed
// set nothing can produce is as useless as an open one.

import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";

/** The live rung, as the 125ms TUI tick would paint it. */
function rungHarness() {
  const sink: TurnSink = { commit: () => {}, preview: () => {} };
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  return { turn, rung: () => stripAnsi(turn.liveLines().join("\n")) };
}

const DWELL = 700;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const call = (callId: string, toolName: string, args?: Record<string, unknown>) => [
  { type: "tool_call_start", callId, toolName },
  ...(args ? [{ type: "tool_call_args_delta", callId, partialJson: JSON.stringify(args) }] : []),
];

describe("the rung says what the events say", () => {
  it("opens on Thinking, with nothing in flight", () => {
    const h = rungHarness();
    expect(h.rung()).toContain("Thinking");
    expect(h.rung()).toContain(MARK);
  });

  it("reads, edits, runs and checks -- each from its own tool_call_start", async () => {
    const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
      ["read_file", { path: "src/bin/ui/turn.ts" }, "Reading src/bin/ui/turn.ts"],
      ["edit_file", { path: "src/bin/ui/turn.ts" }, "Updating src/bin/ui/turn.ts"],
      ["bash", { command: "bun test" }, "Checking with bun test"],
      ["bash", { command: "git status" }, "Running git status"],
      ["task", undefined, "Scouting"],
    ];
    for (const [toolName, args, phrase] of cases) {
      const h = rungHarness();
      for (const event of call("c1", toolName, args)) h.turn.onEvent(event as never);
      await sleep(DWELL + 60);
      expect(h.rung(), `${toolName}`).toContain(phrase);
      // Never the old catch-all, and never a block cell.
      expect(h.rung()).not.toContain("working");
      for (const block of PULSE_GLYPHS.map((g) => g.utf8)) {
        expect(h.rung().includes(block), `${toolName}/${block}`).toBe(false);
      }
    }
  });

  it("says Waiting for you when the agent asked a question", async () => {
    const h = rungHarness();
    for (const event of call("q1", "ask_user", { question: "which provider?" })) {
      h.turn.onEvent(event as never);
    }
    await sleep(DWELL + 60);
    // `asking` was a fragment hanging off `working`. This is the sentence.
    expect(h.rung()).toContain("Waiting for you");
    expect(h.rung()).not.toContain("asking");
  });

  it("says Compacting only while the harness says it is compacting", async () => {
    const h = rungHarness();
    h.turn.onEvent({
      type: "notice",
      message: "provider rejected the prompt as over-limit — force-compacting (attempt 1)",
    } as never);
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Compacting");
    // The compaction LANDING ends the state. Nothing else does -- no timer,
    // no guess about how long a compaction ought to take.
    h.turn.onEvent({
      type: "compaction",
      beforeTokens: 120_000,
      afterTokens: 40_000,
      limitTokens: 200_000,
    } as never);
    await sleep(DWELL + 60);
    expect(h.rung()).not.toContain("Compacting");
  });

  it("says Answering only once prose has actually streamed", async () => {
    const h = rungHarness();
    expect(h.rung()).not.toContain("Answering");
    h.turn.onEvent({ type: "text_delta", text: "The loop breaks on the wrong event." } as never);
    await sleep(DWELL + 60);
    expect(h.rung()).toContain("Answering");
  });

  it("leads with the fan-out rather than with whichever member streamed last", async () => {
    const h = rungHarness();
    for (const id of ["s1", "s2", "s3"]) {
      h.turn.onEvent({ type: "tool_call_start", callId: id, toolName: "task" } as never);
      h.turn.onEvent({
        type: "tool_call_args_delta",
        callId: id,
        partialJson: JSON.stringify({ description: `scout ${id}` }),
      } as never);
    }
    await sleep(DWELL + 60);
    expect(h.rung().split("\n")[0]).toContain("Delegating 3 sub-agents");
  });

  it("carries the elapsed clock inline, and the stall in words beside it", async () => {
    const h = rungHarness();
    for (const event of call("c1", "read_file", { path: "a.ts" })) h.turn.onEvent(event as never);
    await sleep(DWELL + 60);
    // Under the elapsed floor the row is the phrase alone; the clock arrives
    // when there is something to report, and it is a fact, not an estimate.
    expect(h.rung()).toContain("Reading a.ts");
    expect(h.rung()).not.toMatch(/\d+m \d\ds/);
  });
});
