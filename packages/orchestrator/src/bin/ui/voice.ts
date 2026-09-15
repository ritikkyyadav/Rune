// ─── Rune's inner voice: the sentence on the working row ───
//
// Founder, 2026-09-15 night: the working row said `working` and `answering`,
// and "it just feels preprogrammed ... there are words like working, answering
// appear, I want you to do something unique — a phrase as per the task the
// agent is doing, like `on the way boss`, `okay now I'm geared up` — those
// phrases show Rune's identity, that inner voice of Rune talking to the user,
// personalised, and soothing, calm."
//
// So the row now has two parts, and they answer two different questions:
//
//   ▅ having a look around · reading turn.ts · 40s
//     ^ the voice              ^ the fact       ^ the clock
//
// The FACT is what the row always said -- the kind and its subject, derived
// from a real event (see working.ts). It does not change here. The VOICE is
// new: a short sentence in Rune's own register, chosen by the SAME kind, and
// by how long that kind has been true. It is what a person working beside you
// says while they work -- not a status, a presence.
//
// Three rules keep it from becoming the thing the founder was tired of:
//
//   1. It moves with the WORK, not with a timer. The line changes when the
//      kind changes (a read becomes an edit), and otherwise only every
//      ROTATE_MS -- long enough to be read twice. A phrase that changed every
//      second would be a second spinner.
//   2. It is seeded per turn. Two turns in a row do not open on the same
//      line, and within a turn the walk through a set never repeats until the
//      set is exhausted. Deterministic off the turn's own clock, so a test can
//      state the line at 0s, 9s and 18s without a fake timer.
//   3. It is calm. Lower case, no exclamation marks, nothing that asks the
//      reader to hurry. Wry is allowed; anxious is not. The one address
//      (`{you}`) is filled by the callsign the user chose in `[ui] callsign`
//      -- `boss`, `chief`, their name -- and dropped, comma and all, when
//      they chose none.

import { getCallsign, setCallsign } from "@rune/shared";
import type { WorkingKind } from "./working";

/** How long one line stays up before the walk moves on. */
export const ROTATE_MS = 9_000;

/** How long a turn counts as just having started, for the opening lines. */
export const OPENING_MS = ROTATE_MS;

/** After this long in ONE kind, the patience set takes over: the row stops
 *  describing the work and starts reassuring the reader, which is by then the
 *  more useful thing to say. */
export const LONG_PHASE_MS = 75_000;

/** The address slot. Filled by the callsign, removed with its comma when
 *  there is none: `on it, {you}` is `on it, boss` or `on it`. */
export const YOU = "{you}";

/** The first thing Rune says in a turn, before any tool has been called. */
export const OPENING: readonly string[] = [
  `on it, ${YOU}`,
  "on my way",
  "okay, geared up",
  "right, let's see",
  "got it, starting now",
  "leave it with me",
];

/** What Rune says once a kind has been true for a long time. */
export const PATIENCE: readonly string[] = [
  "still on it, this one's chunky",
  "taking my time so it's right",
  "not stuck, just thorough",
  `slow is smooth, ${YOU}`,
  "nearly, don't go anywhere",
  "still here, still working",
];

/** The voice for each kind, in the order the walk visits them. */
export const VOICE: Record<WorkingKind, readonly string[]> = {
  working: [
    "thinking this through",
    "connecting the dots",
    `give me a second, ${YOU}`,
    "lining it up in my head",
    "working it out quietly",
    "one thought at a time",
  ],
  reading: [
    "having a look around",
    "getting the lay of the land",
    "reading before I touch anything",
    "taking it all in",
    "following the thread",
    "seeing how this fits together",
  ],
  editing: [
    "making the change",
    "writing it in, carefully",
    "shaping this up",
    `here goes, ${YOU}`,
    "small, steady edits",
    "leaving it better than I found it",
  ],
  running: [
    "letting it run",
    "let's see what it says",
    "waiting on the machine",
    "running it for real",
    "proof, not promises",
    "watching the output",
  ],
  delegating: [
    "sending the crew out",
    "splitting the work up",
    "the crew is on it",
    `many hands, ${YOU}`,
    "keeping an eye on everyone",
  ],
  answering: [
    "putting it into words",
    "writing this up for you",
    "nearly there",
    `wrapping it up, ${YOU}`,
    "saying it plainly",
  ],
  // About the reader, not the machine, and it does not rotate: the row is
  // still while it waits, and a sentence that changed under a question would
  // pull the eye off the question.
  waiting: ["over to you"],
  compacting: ["tidying my notes", "folding the story so far", "making room to think"],
  done: ["all yours"],
};

// ─── The callsign ───

/**
 * What Rune calls the reader, from `[ui] callsign`. The value lives in
 * `@rune/shared` (ui-callsign.ts) so the engine can change it live for
 * `/config callsign` without importing this layer; these two names are the
 * terminal side of that one store.
 */
export function setVoiceCallsign(value: string | undefined | null): void {
  setCallsign(value);
}

export function voiceCallsign(): string {
  return getCallsign();
}

/** Fill or drop the address slot. */
export function address(line: string, who: string = getCallsign()): string {
  if (!line.includes(YOU)) return line;
  if (who) return line.split(YOU).join(who);
  // Drop the slot and the comma that introduced it -- `on it, {you}` reads
  // `on it`, and `{you}, on it` reads `on it`.
  return line
    .replace(new RegExp(`,\\s*${YOU.replace(/[{}]/g, "\\$&")}`), "")
    .replace(new RegExp(`${YOU.replace(/[{}]/g, "\\$&")},?\\s*`), "")
    .trim();
}

// ─── The walk ───

export interface VoiceState {
  kind: WorkingKind;
  /** Milliseconds since the turn started. */
  elapsedMs: number;
  /** Milliseconds since the kind last changed. */
  phaseMs: number;
  /** Anything stable for the turn -- its start time -- so two turns do not
   *  open on the same line. */
  seed: number;
}

/** Which set a state reads from, and which line of it. Exported so a test can
 *  say WHY a line was chosen, not only that it was. */
export function voicePick(state: VoiceState): { set: readonly string[]; index: number } {
  const kind = state.kind;
  const elapsed = Math.max(0, state.elapsedMs);
  const phase = Math.max(0, Math.min(elapsed, state.phaseMs));
  const still = kind === "waiting" || kind === "done";
  const set =
    !still && kind === "working" && elapsed < OPENING_MS
      ? OPENING
      : !still && phase >= LONG_PHASE_MS
        ? PATIENCE
        : VOICE[kind];
  if (set.length <= 1 || still) return { set, index: 0 };
  // The walk: a per-turn, per-kind start, then one step every ROTATE_MS of
  // the phase. Modulo the set, so it visits every line before it repeats one.
  const ordinal = KIND_ORDINAL[kind] ?? 0;
  const start = Math.abs(Math.floor(state.seed / 1000) + ordinal * 7) % set.length;
  const step = Math.floor(phase / ROTATE_MS);
  return { set, index: (start + step) % set.length };
}

const KIND_ORDINAL: Record<WorkingKind, number> = {
  working: 0,
  reading: 1,
  editing: 2,
  running: 3,
  delegating: 4,
  answering: 5,
  waiting: 6,
  compacting: 7,
  done: 8,
};

/** The line, addressed. */
export function voiceLine(state: VoiceState, who: string = getCallsign()): string {
  const { set, index } = voicePick(state);
  return address(set[index] ?? set[0] ?? "", who);
}

/** Every line the voice can ever say, addressed with `who`, for the tests
 *  that hold the whole register to one standard. */
export function everyVoiceLine(who: string = ""): string[] {
  return [...OPENING, ...PATIENCE, ...Object.values(VOICE).flat()].map((line) =>
    address(line, who),
  );
}
