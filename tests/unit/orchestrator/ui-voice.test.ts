/**
 * Rune's inner voice: the sentence on the working row (bin/ui/voice.ts).
 *
 * The founder's brief, 2026-09-15 night: not `working` / `answering` but a
 * phrase "as per the task the agent is doing", in Rune's own voice, to the
 * user, personalised, and calm -- and coordinated with the work rather than
 * "preprogrammed". What is pinned here is exactly that:
 *
 *   1. the line is chosen by the KIND, and changes when the kind changes;
 *   2. within a kind it moves only every ROTATE_MS, off the turn's own clock;
 *   3. a turn opens on an opening line, a long phase falls back to patience;
 *   4. the whole register is lower-case, unhurried, and short enough for the
 *      row; the address slot is filled by the callsign or dropped cleanly;
 *   5. the row puts the voice first and keeps the fact beside it, so the
 *      developer's information survives the personality.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { workingRow, type WorkingKind } from "../../../packages/orchestrator/src/bin/ui/working";
import {
  LONG_PHASE_MS,
  OPENING,
  OPENING_MS,
  PATIENCE,
  ROTATE_MS,
  VOICE,
  YOU,
  address,
  everyVoiceLine,
  setVoiceCallsign,
  voiceCallsign,
  voiceLine,
  voicePick,
} from "../../../packages/orchestrator/src/bin/ui/voice";

const KINDS: readonly WorkingKind[] = [
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

afterEach(() => setVoiceCallsign(""));

describe("the register", () => {
  it("has a set for every kind, and every line is calm, lower-case and short", () => {
    for (const kind of KINDS) expect(VOICE[kind].length, kind).toBeGreaterThan(0);
    for (const line of everyVoiceLine("")) {
      // Lower case apart from the pronoun: a capital in a chrome row is a title.
      expect(line.replace(/\bI\b/g, "i"), line).toBe(line.replace(/\bI\b/g, "i").toLowerCase());
      expect(line, line).not.toMatch(/!/); // nothing that asks the reader to hurry
      expect(line.length, line).toBeLessThanOrEqual(34); // it shares a row with the fact
      expect(line, line).not.toContain(YOU); // every slot resolved
      expect(line.trim(), line).toBe(line);
    }
  });

  it("never borrows another product's indicator words", () => {
    for (const line of everyVoiceLine("")) {
      expect(line).not.toMatch(/thinking\.\.\.|^thinking$/i);
      expect(line).not.toContain("✻");
    }
  });
});

describe("the address", () => {
  it("fills the slot with the callsign, and drops it cleanly without one", () => {
    expect(address(`on it, ${YOU}`, "boss")).toBe("on it, boss");
    expect(address(`on it, ${YOU}`, "")).toBe("on it");
    expect(address(`slow is smooth, ${YOU}`, "")).toBe("slow is smooth");
    expect(address("no slot here", "boss")).toBe("no slot here");
  });

  it("is what Rune calls the reader, at most sixteen cells, and never a control byte", () => {
    setVoiceCallsign("  chief  ");
    expect(voiceCallsign()).toBe("chief");
    setVoiceCallsign("a name that is far too long for a row");
    expect(voiceCallsign().length).toBe(16);
    setVoiceCallsign("bo\x1b[31mss");
    expect(voiceCallsign()).not.toContain("\x1b");
    setVoiceCallsign(undefined);
    expect(voiceCallsign()).toBe("");
  });

  it("reaches the line by default once set", () => {
    setVoiceCallsign("boss");
    const lines = new Set<string>();
    for (let step = 0; step < OPENING.length; step++) {
      lines.add(voiceLine({ kind: "working", elapsedMs: 0, phaseMs: 0, seed: step * 1000 }));
    }
    expect([...lines].some((l) => l.endsWith(", boss"))).toBe(true);
  });
});

describe("the walk", () => {
  const at = (kind: WorkingKind, phaseMs: number, seed = 7_000) =>
    voicePick({ kind, elapsedMs: OPENING_MS + phaseMs, phaseMs, seed });

  it("opens the turn on an opening line, then hands over to the kind", () => {
    expect(voicePick({ kind: "working", elapsedMs: 0, phaseMs: 0, seed: 1 }).set).toBe(OPENING);
    expect(voicePick({ kind: "working", elapsedMs: OPENING_MS - 1, phaseMs: 0, seed: 1 }).set).toBe(
      OPENING,
    );
    expect(voicePick({ kind: "working", elapsedMs: OPENING_MS, phaseMs: 0, seed: 1 }).set).toBe(
      VOICE.working,
    );
    // A tool call in the first seconds is already the kind's own voice: the
    // opening is for the pause before anything happens, not for the work.
    expect(voicePick({ kind: "reading", elapsedMs: 100, phaseMs: 100, seed: 1 }).set).toBe(
      VOICE.reading,
    );
  });

  it("changes with the kind -- the work -- and not otherwise", () => {
    const read = at("reading", 0);
    const edit = at("editing", 0);
    expect(read.set).toBe(VOICE.reading);
    expect(edit.set).toBe(VOICE.editing);
    // Same kind, same phase clock, any wall clock: the same line.
    expect(at("reading", 4_000)).toEqual(at("reading", 4_000));
    expect(at("reading", 0).index).toBe(at("reading", ROTATE_MS - 1).index);
  });

  it("moves one line every ROTATE_MS, visiting every line before repeating one", () => {
    const seen: number[] = [];
    for (let step = 0; step < VOICE.reading.length; step++) {
      seen.push(at("reading", step * ROTATE_MS).index);
    }
    expect(new Set(seen).size).toBe(VOICE.reading.length);
    expect(at("reading", VOICE.reading.length * ROTATE_MS).index).toBe(seen[0]);
  });

  it("is seeded per turn, so two turns do not open on the same line", () => {
    const opens = new Set<number>();
    for (let seed = 0; seed < OPENING.length * 1000; seed += 1000) {
      opens.add(voicePick({ kind: "working", elapsedMs: 0, phaseMs: 0, seed }).index);
    }
    expect(opens.size).toBe(OPENING.length);
  });

  it("falls back to patience once one kind has run long", () => {
    expect(at("running", LONG_PHASE_MS - 1).set).toBe(VOICE.running);
    expect(at("running", LONG_PHASE_MS).set).toBe(PATIENCE);
    // ...and a change of kind resets it: the phase clock is the kind's.
    expect(at("editing", 0).set).toBe(VOICE.editing);
  });

  it("holds still for the states that hold still", () => {
    for (const phase of [0, ROTATE_MS * 3, LONG_PHASE_MS * 2]) {
      expect(at("waiting", phase)).toEqual({ set: VOICE.waiting, index: 0 });
      expect(at("done", phase)).toEqual({ set: VOICE.done, index: 0 });
    }
  });
});

describe("the row", () => {
  const row = (state: Parameters<typeof workingRow>[0]) => stripAnsi(workingRow(state));

  it("puts the voice first and keeps the fact beside it", () => {
    const out = row({
      kind: "reading",
      target: "turn.ts",
      elapsedMs: 40_000,
      voice: "having a look around",
    });
    expect(out).toMatch(/^. having a look around · reading turn\.ts · 40s$/);
  });

  it("is exactly the old row when there is no voice", () => {
    expect(row({ kind: "reading", target: "turn.ts", elapsedMs: 40_000 })).toMatch(
      /^. reading turn\.ts · 40s$/,
    );
  });
});
