// ─── The pane title: the one moving thing a terminal will actually show us ───
//
// Warp gives a branded icon and a live status badge to the CLI agents it knows,
// and it knows them by the launched command — claude, codex, gemini and the
// rest — from a list compiled into the app. `gear` is not on that list, so Warp
// opens no agent session for this pane, and the OSC 777 events in ./warp.ts,
// correct as they are, arrive with nothing to attach to. Getting on the list is
// a request to Warp, not a sequence this process can emit.
//
// The title is the half that is ours. Every terminal worth the name renames a
// tab on OSC 0, Warp included, and precisely because Warp has *not* classified
// this pane as an agent there is nothing on its side competing to rewrite it.
// So the tab carries the run: a turning mark while output flows, the stall in
// words when it stops, and a plain ask when the agent is waiting on a person.
//
// ASCII throughout, for the reason ./warp.ts is ASCII: this string is drawn by
// another program, in a tab strip, in that program's UI font — not in our grid.
// The one-cell glyph budget governs what we paint on the terminal, and a title
// is not that. The classic four-frame rung renders identically everywhere.
//
// It turns on the pulse, not on the clock — the same rule as ./pulse.ts, for
// the same reason. A mark driven by a timer goes on turning through a wedged
// tool call, and a tab promising work that isn't happening is worse than a tab
// that says nothing at all.

const ESC = "\x1b";
const BEL = "\x07";

/** The rung. Four frames: a tab is glanced at, not watched. */
const FRAMES = ["|", "/", "-", "\\"] as const;

/** The mark for a turn that has gone silent. Deliberately still — the stall is
 *  said in words beside it, and a moving glyph would contradict them. */
const STALLED = ".";

/** How long without real output before the tab stops claiming work. Matches
 *  QUIET_AFTER_MS in ./pulse.ts; the tab and the rung must not disagree. */
export const TITLE_QUIET_AFTER_MS = 4000;

export type TitleState =
  /** No turn in flight. */
  | { kind: "idle" }
  /** Mid-turn. `quietMs` is how long since real output — see ./pulse.ts. */
  | { kind: "working"; frame: number; quietMs: number }
  /** Stopped on an approval or a question. The state a background tab is for. */
  | { kind: "waiting" };

/**
 * The title for a state.
 *
 * Pure and exported so the wording can be asserted without a terminal. The mark
 * leads because a vertical tab is narrow and truncates from the right — the one
 * character that has to survive the ellipsis is the one that moves.
 */
export function titleText(state: TitleState, project: string): string {
  const name = project ? `Gear - ${project}` : "Gear";
  switch (state.kind) {
    case "idle":
      return name;
    case "waiting":
      return "? Gear - waiting for you";
    case "working": {
      // Past the threshold the mark stops and the wait is stated. Below it, the
      // ragged gaps between token bursts are not worth reporting.
      if (state.quietMs >= TITLE_QUIET_AFTER_MS) {
        return `${STALLED} Gear - quiet ${Math.floor(state.quietMs / 1000)}s`;
      }
      const i = ((state.frame % FRAMES.length) + FRAMES.length) % FRAMES.length;
      return `${FRAMES[i]!} ${name}`;
    }
  }
}

/**
 * OSC 0 — icon name and window title together, which is the pair Warp reads.
 *
 * Control characters are stripped rather than escaped: unlike ./warp.ts there is
 * no JSON layer here to neutralise them, and a raw BEL inside a title would end
 * the sequence early and spray the remainder across the screen. Project names
 * come off the filesystem, so this is reachable.
 */
export function titleSeq(text: string): string {
  return `${ESC}]0;${text.replace(/[\x00-\x1f\x7f]/g, "")}${BEL}`;
}

/** Write one, best-effort. Chrome must never be able to interrupt a session. */
export function setTitle(state: TitleState, project: string): void {
  try {
    process.stdout.write(titleSeq(titleText(state, project)));
  } catch {
    // The terminal is gone; there is nothing to name.
  }
}

/**
 * Hand the tab back.
 *
 * An empty title, not a remembered one: we never saw what was there before, and
 * every terminal treats empty as "resume naming this yourself", which is the
 * actual intent. Same argument as not asserting a background colour — inherit,
 * do not assert.
 */
export function clearTitle(): void {
  try {
    process.stdout.write(titleSeq(""));
  } catch {
    /* terminal already gone */
  }
}
