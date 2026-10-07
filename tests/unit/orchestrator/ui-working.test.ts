/**
 * The working row: what the run is doing, in words.
 *
 * This file pins the WORDS of the row above the composer -- the stage, the
 * voice, the fact, the clock, how they are fitted to a window -- and that the
 * renderer reaches each of them from the event that should produce it. The
 * row's mark, and everything that moves, is ui-waveform.test.ts's.
 *
 * It used to pin a great deal more, and what it no longer pins is the history
 * of this row (2026-09-15 to 2026-10-02):
 *
 *   - `the curve`, `the paint clock`, `the mark`: a one-cell bar breathing on a
 *     raised cosine. On the rung it moved on a wall clock, so a fast stream
 *     and a hung call drew the same bar; kept for each sub-agent it was "just
 *     a deterministic behaviour ... I don't want that in Rune, just that one
 *     Glyph as the animation" (founder, 2026-10-02). Deleted, with its tests.
 *   - `the shimmer`: a glow sweeping the phrase. A second thing moving on a row
 *     meant to be watched for an hour. Deleted, with its tests.
 *
 * What is asserted in their place is their ABSENCE: this module exports
 * nothing that draws a frame, and the rung takes its mark from the glyph.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  BREATH_MS,
  FRAME_MS,
  MAX_FPS,
  ROW_MAX_COLS,
  elapsedWord,
  fitPhrase,
  fitSaid,
  isBreathing,
  stageWord,
  stagedRow,
  workingKindForTool,
  workingRowCells,
  workingPhrase,
  type WorkStage,
  type WorkingKind,
  type WorkingState,
} from "../../../packages/orchestrator/src/bin/ui/working";
import {
  GLYPH_DEFINITIONS,
  PULSE_GLYPHS,
  glyph,
} from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { OPENING, VOICE, address } from "../../../packages/orchestrator/src/bin/ui/voice";

/** Whether a rung carries one of a voice set's lines. A bare kind (working,
 *  answering, waiting, compacting) shows Rune's voice in place of the word --
 *  see ui/voice.ts -- so the word itself is no longer what the rung says. */
const voiced = (rung: string, set: readonly string[]): boolean =>
  set.some((line) => rung.includes(address(line, "")));

const RAMP = PULSE_GLYPHS.map((g) => g.utf8);
/** A one-cell stand-in for the rung's mark. The row's words are this file's
 *  business; the mark's motion is ui-waveform.test.ts's. */
const MARK = "▄";
const row = (state: WorkingState & { stage: WorkStage }, opts?: Parameters<typeof stagedRow>[2]) =>
  stripAnsi(stagedRow(MARK, state, opts));
const ALL_KINDS: WorkingKind[] = [
  "working",
  "reading",
  "editing",
  "running",
  "delegating",
  "answering",
  "waiting",
  "compacting",
  "done",
];

describe("the frame rate", () => {
  it("is 90ms a frame -- 11.1fps, under the 12fps ceiling", () => {
    expect(FRAME_MS).toBe(90);
    expect(1000 / FRAME_MS).toBeLessThanOrEqual(MAX_FPS);
    // The calm period: 4.32s, fourteen to the minute -- a person breathing at
    // rest. 2.16s was twenty-eight a minute, and the founder read it as "too
    // fast, not soothing, totally jittery" (2026-09-15). The breath that
    // number belonged to is gone; the mark's silent sweep and the tab's pill
    // still keep it (ui-waveform.test.ts, ui-title.test.ts).
    expect(BREATH_MS).toBe(4320);
    expect(BREATH_MS).toBeGreaterThanOrEqual(3750);
    expect(BREATH_MS).toBeLessThanOrEqual(5000);
  });

  it("is the same clock the repaint tick runs on", () => {
    // The mark takes one frame of motion per paint, so a tick slower than the
    // frame is a slower mark -- which is what a hard-coded 125ms tick beside a
    // 90ms frame would be. Asserted on the source because there is no way to
    // observe an interval's period from inside the interval.
    const tui = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/bin/ui/tui.ts"),
      "utf8",
    );
    expect(tui).toContain("}, FRAME_MS);");
    expect(tui).not.toMatch(/\}, 125\);/);
  });
});

describe("the mark is not this module's", () => {
  it("draws nothing that moves: no breath, no clock, no ramp", async () => {
    // The one-cell breath lived here and was the last animation outside the
    // glyph. A name that comes back is a breath that came back.
    // (`BREATH_MS` is a number, the calm period, and stays; what must not
    // return is a FUNCTION that draws a frame.)
    const module: Record<string, unknown> =
      await import("../../../packages/orchestrator/src/bin/ui/working");
    expect(
      Object.keys(module).filter(
        (name) =>
          typeof module[name] === "function" &&
          /breath(?!ing)|ramp|tint|paintclock|workingmark|workingrest/i.test(name),
      ),
    ).toEqual([]);
  });

  it("is the glyph, on the rung and for every sub-agent", () => {
    // The row a person actually watches is turn.ts's. Its mark is struck by
    // the turn's own output and by each member's, and keeps its own frame
    // clock (./waveform.ts). Asserted on the source, like the frame rate.
    const source = (name: string) =>
      readFileSync(
        join(import.meta.dir, `../../../packages/orchestrator/src/bin/ui/${name}`),
        "utf8",
      );
    const turn = source("turn.ts");
    expect(turn).toContain("new WorkGlyph()");
    expect(turn).toContain("this.glyph.step(");
    expect(turn).toContain("this.glyph.feed(");
    for (const file of ["turn.ts", "tui.ts", "tui-frame.ts", "agents-panel.ts"]) {
      expect(source(file), file).not.toMatch(/createPaintClock|breathFrame|workingMark|rampAt\(/);
    }
  });

  it("is never the borrowed one", () => {
    // The florette is gone from the alphabet entirely, so it cannot come back
    // by a call site typing its name.
    expect(Object.keys(GLYPH_DEFINITIONS)).not.toContain("working");
    expect(
      Object.values(GLYPH_DEFINITIONS).some((d) => d.utf8 === "✻"),
      "the borrowed florette is still in the alphabet",
    ).toBe(false);
  });
});

describe("the stillness", () => {
  it("says its word and stops for done and waiting", () => {
    // `done` is finished and `waiting` is waiting on a person. A row still
    // describing work through either would report activity that is not
    // happening.
    for (const kind of ["done", "waiting"] as WorkingKind[]) {
      expect(isBreathing(kind), kind).toBe(false);
    }
    for (const kind of ALL_KINDS.filter((k) => k !== "done" && k !== "waiting")) {
      expect(isBreathing(kind), kind).toBe(true);
    }
  });

  it("says its stage and nothing else when there is no clock and nothing in flight", () => {
    // The opening, before anything has been called or timed.
    const idle = row({ kind: "working", stage: "start" });
    expect(idle).toBe(`${MARK} starting`);
    expect(row({ kind: "working", stage: "start" })).toBe(idle);
  });
});

describe("the words hold still", () => {
  it("has no sweep left in it: nothing in this module moves a phrase", async () => {
    const module = await import("../../../packages/orchestrator/src/bin/ui/working");
    expect(Object.keys(module).filter((name) => /shimmer|paintPhrase/i.test(name))).toEqual([]);
    const source = readFileSync(
      join(import.meta.dir, "../../../packages/orchestrator/src/bin/ui/working.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/shimmer/i);
  });

  it("paints the same row for the same state, whenever it is drawn", () => {
    // The mark is the caller's and is the only thing that moves. Hand the row
    // the same mark and the same state and it is the same bytes -- there is
    // no clock in here for a phrase to animate on.
    const state = {
      kind: "reading",
      stage: "understand",
      target: "turn.ts",
      elapsedMs: 40_000,
    } as const;
    const first = stagedRow(MARK, state);
    for (let i = 0; i < 20; i++) expect(stagedRow(MARK, state)).toBe(first);
    expect(stripAnsi(first)).toBe(`${MARK} looking · reading turn.ts · 40s`);
  });
});

describe("the measure", () => {
  // 200 characters, the shape the verifier used: a real path with a real
  // filename on the end of it.
  const PATH_200 =
    ("/Users/someone/project/packages/orchestrator/src/bin/ui/" + "x".repeat(200)).slice(0, 177) +
    "/a-generated-fixture.ts";
  const vis = (row: string) => visLen(stripAnsi(row));

  it("fits the row to the terminal it is drawn in", () => {
    // The old row emitted 215 cells for this state and left every call site
    // to clamp it -- and the clamp cuts from the RIGHT, which takes the
    // filename (verifier pass 3, finding 31's reprise).
    expect(PATH_200.length).toBe(200);
    // The rung's real mark is twelve cells, and the row is fitted around it.
    const GLYPH = "▁".repeat(12);
    for (const width of [60, 80, 120, 400]) {
      const fitted = stagedRow(
        GLYPH,
        { kind: "reading", stage: "understand", target: PATH_200, elapsedMs: 800 },
        { width },
      );
      expect(vis(fitted), `at ${width} columns`).toBeLessThanOrEqual(Math.min(width, ROW_MAX_COLS));
    }
    // A caller-composed phrase (turn.ts's live tool label) is fitted too.
    expect(
      vis(
        stagedRow(
          GLYPH,
          {
            kind: "running",
            stage: "verify",
            phrase: `Checking with ${"a".repeat(186)}`,
            elapsedMs: 800,
          },
          { width: 120 },
        ),
      ),
    ).toBeLessThanOrEqual(120);
    // And what the caller sets down after the row is paid for inside it.
    const reserved = stagedRow(
      GLYPH,
      { kind: "reading", stage: "understand", target: PATH_200, elapsedMs: 800 },
      { width: 100, reserve: 20 },
    );
    expect(vis(reserved)).toBeLessThanOrEqual(100 - 2 - 20);
    expect(stripAnsi(reserved).endsWith("· 0s")).toBe(true);
  });

  it("keeps the verb and the filename and takes the middle out", () => {
    const fitted = row(
      { kind: "reading", stage: "understand", target: PATH_200, elapsedMs: 800 },
      { width: 120 },
    );
    expect(fitted).toContain("reading /Users/someone/project/");
    expect(fitted).toContain("a-generated-fixture.ts");
    expect(fitted).toContain(glyph("elision"));
    // The clock is never the thing that gives way: a duration cut in half is a
    // duration that says nothing.
    expect(fitted.endsWith("· 0s")).toBe(true);
  });

  it("drops the voice whole before it takes the middle out of a fact", () => {
    const state = {
      kind: "reading",
      stage: "understand",
      phrase: "Reading src/auth/session.ts",
      elapsedMs: 40_000,
      voice: "seeing how this fits together",
    } as const;
    // Room for both: both.
    expect(row(state, { width: 120 })).toBe(
      `${MARK} looking · seeing how this fits together · reading src/auth/session.ts · 40s`,
    );
    // Not room for both: the fact, whole, and no voice -- never the voice and
    // half a file name.
    expect(row(state, { width: 56 })).toBe(`${MARK} looking · reading src/auth/session.ts · 40s`);
    // And a voice with no fact beside it is said whole or not at all.
    const bare = {
      kind: "working",
      stage: "act",
      elapsedMs: 12_000,
      voice: "making the change",
    } as const;
    expect(row(bare, { width: 60 })).toBe(`${MARK} building · making the change · 12s`);
    expect(row(bare, { width: 28 })).toBe(`${MARK} building · 12s`);
  });

  it("keeps the fact when the window is too narrow for the voice as well", () => {
    // turn.ts's rule, applied to the row: the voice is what makes it Rune's,
    // the fact is what a developer reads, and when only one fits it is the
    // fact.
    const wide = fitSaid("having a look around", "reading turn.ts", 60);
    expect(wide).toEqual({ voice: "having a look around", fact: "reading turn.ts" });
    const narrow = fitSaid("having a look around", "reading turn.ts", 28);
    expect(narrow.voice).toBe("");
    expect(narrow.fact).toContain("reading");
    const tight = fitSaid("having a look around", "reading packages/orchestrator/turn.ts", 44);
    expect(tight.voice).toBe("having a look around");
    expect(visLen(`${tight.voice} · ${tight.fact}`)).toBeLessThanOrEqual(44);
    expect(tight.fact).toContain("turn.ts");
  });

  it("leaves a phrase that already fits exactly alone", () => {
    expect(fitPhrase("reading turn.ts", 40)).toBe("reading turn.ts");
    expect(fitPhrase("reading turn.ts", 15)).toBe("reading turn.ts");
    expect(workingPhrase({ kind: "reading", target: "turn.ts" })).toBe("reading turn.ts");
    // A budget under a subject's worth of cells spends what is left on the
    // verb rather than on an elision.
    expect(visLen(fitPhrase("reading some/very/long/path.ts", 12))).toBeLessThanOrEqual(12);
  });

  it("holds the words to a reading column however wide the terminal is", () => {
    // The measure is a reading column, not a window width: a 400-column
    // terminal does not get a 400-cell sentence.
    expect(workingRowCells(400)).toBeLessThanOrEqual(ROW_MAX_COLS);
    for (const width of [120, 200, 400]) {
      const fitted = row(
        { kind: "reading", stage: "understand", target: PATH_200, elapsedMs: 800 },
        { width },
      );
      expect(visLen(fitted), `at ${width} columns`).toBeLessThanOrEqual(ROW_MAX_COLS);
    }
  });
});

describe("the fallbacks", () => {
  it("is seven-bit clean on a seven-bit terminal", () => {
    const seven = stripAnsi(
      stagedRow(
        "_-_",
        { kind: "running", stage: "verify", target: "checks", elapsedMs: 65_000 },
        { mode: "ascii" },
      ),
    );
    expect(seven).toContain("running checks");
    expect(seven).toContain("1m 05s");
    expect(seven).not.toMatch(/[^\x00-\x7f]/);
  });
});

describe("the voice", () => {
  it("speaks Rune's lower-case strip voice, and never the borrowed one", () => {
    const stages: WorkStage[] = ["start", "understand", "plan", "act", "verify"];
    for (const kind of ALL_KINDS) {
      for (const stage of stages) {
        const said = row({ kind, stage, target: "turn.ts", elapsedMs: 12_000 });
        expect(said).not.toContain("Thinking");
        expect(said).not.toContain("✻");
        // Everything after the mark and its space is lower-case: a capital in
        // a chrome row is a title, and this row is a sentence.
        const words = said.slice(2);
        expect(words, said).toBe(words.toLowerCase());
      }
    }
  });

  it("names the stage in plain words, and steps aside for the four states that are not one", () => {
    expect(stageWord("start", "working")).toBe("starting");
    expect(stageWord("understand", "reading")).toBe("looking");
    expect(stageWord("plan", "working")).toBe("planning");
    expect(stageWord("act", "editing")).toBe("building");
    expect(stageWord("verify", "running")).toBe("checking");
    // Not stages of the work: writing the answer, rewriting its own context,
    // waiting on a person, finished.
    for (const stage of ["start", "understand", "plan", "act", "verify"] as WorkStage[]) {
      expect(stageWord(stage, "answering")).toBe("answering");
      expect(stageWord(stage, "compacting")).toBe("housekeeping");
      expect(stageWord(stage, "waiting")).toBe("over to you");
      expect(stageWord(stage, "done")).toBe("done");
    }
  });

  it("reads the way the founder asked: the stage, then what is happening, then how long", () => {
    // A bare kind is the stage alone -- `building · working` says it twice.
    expect(row({ kind: "working", stage: "act", elapsedMs: 12_000 })).toBe(
      `${MARK} building · 12s`,
    );
    expect(
      row({ kind: "reading", stage: "understand", target: "turn.ts", elapsedMs: 40_000 }),
    ).toBe(`${MARK} looking · reading turn.ts · 40s`);
    expect(row({ kind: "editing", stage: "act", target: "composer.ts", elapsedMs: 40_000 })).toBe(
      `${MARK} building · editing composer.ts · 40s`,
    );
    expect(row({ kind: "running", stage: "verify", target: "checks", elapsedMs: 65_000 })).toBe(
      `${MARK} checking · running checks · 1m 05s`,
    );
    // The one state that is about the reader, not the machine -- and the one
    // with no clock, because how long it has been true of YOU is not news. A
    // voice handed to a still state is not said: the word is the sentence.
    expect(row({ kind: "waiting", stage: "act", elapsedMs: 9_000, voice: "over to you" })).toBe(
      `${MARK} over to you`,
    );
    expect(row({ kind: "done", stage: "verify", elapsedMs: 118_000 })).toBe(
      `${MARK} done · 1m 58s`,
    );
  });

  it("every phrase is reachable from a real event, and nothing else is", () => {
    // The closed set, and the event that produces each one. A phrase with no
    // event is a phrase that will eventually be produced by everything.
    const table: Array<[WorkingKind, string, string]> = [
      ["working", "working", "no tool, no fleet, no prose -- the resting state"],
      ["reading", "reading turn.ts", "tool_call_start: read_file / grep / glob / web_fetch"],
      ["editing", "editing turn.ts", "tool_call_start: edit_file / write_file / apply_patch"],
      ["running", "running turn.ts", "tool_call_start: bash, or the verification notice"],
      ["delegating", "delegating turn.ts", "tool_call_start: task / worker, or a live fleet"],
      ["answering", "answering", "text_delta -- prose is streaming"],
      ["waiting", "waiting for you", "tool_call_start: ask_user"],
      ["compacting", "compacting", "the harness notice that it is rewriting context"],
      ["done", "done", "turn_complete"],
    ];
    for (const [kind, phrase] of table) {
      expect(workingPhrase({ kind, target: "turn.ts" }), kind).toBe(phrase);
      expect(phrase).toBe(phrase.toLowerCase());
    }
    const covered = new Set(table.map(([kind]) => kind));
    expect([...covered].sort()).toEqual([...ALL_KINDS].sort());
    expect(covered.size).toBe(9);
  });

  it("takes the caller's own phrase, down-cased at the first letter only", () => {
    // `liveToolLabel` has been writing these for a year, including the one
    // that matters most: the placeholder that stops a half-arrived command
    // being typed out letter by letter. The strip speaks lower-case, so the
    // first letter folds -- and ONLY the first, or a path and a command would
    // be destroyed by the row that reports them.
    expect(workingPhrase({ kind: "running", phrase: "Running the necessary command" })).toBe(
      "running the necessary command",
    );
    expect(workingPhrase({ kind: "running", phrase: "Checking with npx vitest run" })).toBe(
      "checking with npx vitest run",
    );
    expect(
      workingPhrase({ kind: "editing", target: "a.ts", phrase: "Updating src/UI/App.ts" }),
    ).toBe("updating src/UI/App.ts");
    // An empty one falls through to the closed table rather than blanking the row.
    expect(workingPhrase({ kind: "working", phrase: "   " })).toBe("working");
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
    // `working on turn.ts` would be a claim about what the model is working
    // on, which nothing on the wire can support at that moment.
    for (const kind of ["working", "answering", "waiting", "done"] as WorkingKind[]) {
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
    expect(row({ kind: "working", stage: "start" })).toBe(`${MARK} starting`);
    expect(row({ kind: "waiting", stage: "act", elapsedMs: 600_000 })).not.toContain("m ");
  });
});

// ─── the wiring: every phrase, from the event that produces it ───
//
// The table above proves the phrase set is closed. This proves it is REACHED
// -- that each phrase comes out of the renderer when the corresponding event
// goes in, and not from a heuristic, a timer, or the model's prose. A closed
// set nothing can produce is as useless as an open one.

import { TurnRenderer, type TurnSink } from "../../../packages/orchestrator/src/bin/ui/turn";

/** The live rung, as the frame tick would paint it. */
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
  it("opens on working, with nothing in flight", () => {
    const h = rungHarness();
    expect(h.turn.workingState().kind).toBe("working");
    expect(voiced(h.rung(), OPENING)).toBe(true);
    // And it opens on Rune's mark, not the borrowed one: the glyph, twelve
    // cells on one base, and the stage after it.
    expect(h.rung()).not.toContain("✻");
    expect(h.rung()).toMatch(/^ {2}[▁▂▃▄▅▆▇█]{12} starting/);
  });

  it("reads, edits, runs and checks -- each from its own tool_call_start", async () => {
    const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
      ["read_file", { path: "src/bin/ui/turn.ts" }, "reading src/bin/ui/turn.ts"],
      ["edit_file", { path: "src/bin/ui/turn.ts" }, "updating src/bin/ui/turn.ts"],
      ["bash", { command: "bun test" }, "checking with bun test"],
      ["bash", { command: "git status" }, "running git status"],
      ["task", undefined, "scouting"],
    ];
    for (const [toolName, args, phrase] of cases) {
      const h = rungHarness();
      for (const event of call("c1", toolName, args)) h.turn.onEvent(event as never);
      await sleep(DWELL + 60);
      expect(h.rung(), `${toolName}`).toContain(phrase);
      // Never a capital, and never the borrowed mark.
      expect(h.rung(), `${toolName}`).not.toContain(phrase[0]!.toUpperCase() + phrase.slice(1));
      expect(h.rung()).not.toContain("✻");
    }
  });

  it("says waiting for you when the agent asked a question", async () => {
    const h = rungHarness();
    for (const event of call("q1", "ask_user", { question: "which provider?" })) {
      h.turn.onEvent(event as never);
    }
    await sleep(DWELL + 60);
    // `asking` was a fragment hanging off `working`. This is the sentence --
    // in Rune's voice, because the state is about the reader.
    expect(h.turn.workingState().kind).toBe("waiting");
    expect(voiced(h.rung(), VOICE.waiting)).toBe(true);
    expect(h.rung()).not.toContain("asking");
    // ...and the mark is flat and holds still while a person is the one
    // holding things up.
    expect(h.rung()).toContain("▁".repeat(12));
    await sleep(FRAME_MS * 3);
    expect(h.rung()).toContain("▁".repeat(12));
  });

  it("says compacting only while the harness says it is compacting", async () => {
    const h = rungHarness();
    h.turn.onEvent({
      type: "notice",
      message: "provider rejected the prompt as over-limit — force-compacting (attempt 1)",
    } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).toBe("compacting");
    expect(voiced(h.rung(), VOICE.compacting)).toBe(true);
    // The compaction LANDING ends the state. Nothing else does -- no timer,
    // no guess about how long a compaction ought to take.
    h.turn.onEvent({
      type: "compaction",
      beforeTokens: 120_000,
      afterTokens: 40_000,
      limitTokens: 200_000,
    } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).not.toBe("compacting");
    expect(voiced(h.rung(), VOICE.compacting)).toBe(false);
  });

  it("says answering only once prose has actually streamed", async () => {
    const h = rungHarness();
    expect(h.turn.workingState().kind).not.toBe("answering");
    h.turn.onEvent({ type: "text_delta", text: "The loop breaks on the wrong event." } as never);
    await sleep(DWELL + 60);
    expect(h.turn.workingState().kind).toBe("answering");
    expect(voiced(h.rung(), VOICE.answering)).toBe(true);
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
    // The members themselves, each in its own block -- which is the count, so
    // the row does not also say `delegating 3 sub-agents`.
    const head = h.rung().split("\n")[0]!;
    expect(head.match(/\[[^\]]+\]/g)).toHaveLength(3);
    expect(head).not.toContain("delegating 3 sub-agents");
    expect(h.turn.workingState().kind).toBe("delegating");
  });

  it("carries the elapsed clock inline, and the stall in words beside it", async () => {
    const h = rungHarness();
    for (const event of call("c1", "read_file", { path: "a.ts" })) h.turn.onEvent(event as never);
    await sleep(DWELL + 60);
    // Under the elapsed floor the row is the phrase alone; the clock arrives
    // when there is something to report, and it is a fact, not an estimate.
    expect(h.rung()).toContain("reading a.ts");
    expect(h.rung()).not.toMatch(/\d+m \d\ds/);
  });

  it("moves while it works: the mark is struck by the call, and the words hold", async () => {
    const h = rungHarness();
    for (const event of call("c1", "read_file", { path: "a.ts" })) h.turn.onEvent(event as never);
    await sleep(DWELL + 60);
    // Same state, different moments: the phrase holds and the mark does not.
    // The call opening is real output, so it lands as a stroke and falls.
    const marks = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const first = h.rung().split("\n")[0]!;
      marks.add(first.trim().slice(0, 12));
      expect(first).toContain("reading a.ts");
      await sleep(FRAME_MS);
    }
    expect(marks.size).toBeGreaterThan(1);
  });

  it("says the run is going back over its work, in words", async () => {
    const h = rungHarness();
    h.turn.onEvent({
      type: "step_check",
      passed: false,
      report: "$ bun test (exit 1)\n1 fail",
    } as never);
    expect(h.rung()).toContain("second pass");
    h.turn.onEvent({
      type: "step_check",
      passed: false,
      report: "$ bun test (exit 1)\n1 fail",
    } as never);
    expect(h.rung()).toContain("third pass");
    // A check passing ends it.
    h.turn.onEvent({ type: "step_check", passed: true, report: "$ bun test (ok)" } as never);
    expect(h.rung()).not.toContain("pass");
  });
});
