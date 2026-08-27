// ─── The turn log, and the reducer over it ───
//
//     runtime → typed append-only event log → reducer → state → surface
//
// The point of this shape is a single guarantee: **no component parses model
// prose to decide what the screen says.** A model that hangs, hallucinates, or
// returns malformed output cannot make the UI claim success, because the UI
// never read what the model said — it read what the runtime observed.
//
// That distinction is the whole file. Prose is still *printed*; it is the
// agent's voice and belongs on screen. What it may no longer do is decide
// STATE: which phase we are in, whether a check passed, how many files changed,
// whether the turn succeeded. Every one of those comes from a typed event
// carrying a fact the runtime witnessed — a command it ran, an exit code it
// read, a file it wrote.
//
// The log is append-only and the reducer is pure, which buys two things beyond
// truthfulness. Replay is not a special case — it is the reducer over the log.
// And crash recovery falls out for free: the log IS the session, everything
// else is derived and can be thrown away.

/** Everything the runtime can witness. Nothing here is model prose. */
export type TurnEvent =
  | { t: "turn_started"; at: number; request: string }
  | { t: "phase"; at: number; phase: WorkPhase }
  /** The agent's voice. Printed verbatim; never parsed for state. */
  | { t: "said"; at: number; text: string }
  | { t: "tool_started"; at: number; callId: string; tool: string; label?: string }
  | { t: "tool_output"; at: number; callId: string; bytes: number }
  | { t: "tool_ended"; at: number; callId: string; ok: boolean; detail?: string }
  | { t: "file_changed"; at: number; path: string; added: number; removed: number }
  /** A check the runtime ran, with the exit code it actually read. */
  | { t: "check"; at: number; command: string; passed: boolean; summary?: string }
  | { t: "retry"; at: number; attempt: number; of: number; provider?: string }
  | { t: "provider_switched"; at: number; from: string; to: string }
  | { t: "usage"; at: number; outputTokens: number; contextPercent?: number }
  | { t: "criterion_moved"; at: number; index: number; rung: string; source: string }
  | { t: "error"; at: number; message: string; fatal: boolean }
  | { t: "turn_ended"; at: number; aborted: boolean };

export type WorkPhase = "understand" | "plan" | "act" | "verify";

/** Everything the surface is allowed to render, and nothing else. */
export interface TurnState {
  startedAt: number | null;
  endedAt: number | null;
  aborted: boolean;
  request: string;
  phase: WorkPhase;
  /** The agent's voice, joined. Rendered as prose; never inspected. */
  said: string;
  openCalls: Map<string, { tool: string; label?: string; startedAt: number }>;
  toolCalls: number;
  files: Map<string, { added: number; removed: number }>;
  checks: Array<{ command: string; passed: boolean; summary?: string }>;
  retries: { attempt: number; of: number } | null;
  switches: number;
  outputTokens: number;
  contextPercent: number | null;
  criteria: Map<number, { rung: string; source: string }>;
  errors: Array<{ message: string; fatal: boolean }>;
  /** Bytes of real output, for the pulse. A measurement, never a timer. */
  outputUnits: number;
  lastOutputAt: number | null;
}

export function emptyState(): TurnState {
  return {
    startedAt: null,
    endedAt: null,
    aborted: false,
    request: "",
    phase: "understand",
    said: "",
    openCalls: new Map(),
    toolCalls: 0,
    files: new Map(),
    checks: [],
    retries: null,
    switches: 0,
    outputTokens: 0,
    contextPercent: null,
    criteria: new Map(),
    errors: [],
    outputUnits: 0,
    lastOutputAt: null,
  };
}

/**
 * Fold one event into the state. Pure and total: an event it does not know is
 * ignored rather than thrown on, because a log written by a newer build must
 * still replay in an older one — a crash-recovery path that can itself crash is
 * not a recovery path.
 */
export function apply(state: TurnState, e: TurnEvent): TurnState {
  switch (e.t) {
    case "turn_started":
      state.startedAt = e.at;
      state.request = e.request;
      return state;
    case "phase":
      state.phase = e.phase;
      return state;
    case "said":
      state.said += e.text;
      state.outputUnits += e.text.length;
      state.lastOutputAt = e.at;
      return state;
    case "tool_started":
      state.openCalls.set(e.callId, { tool: e.tool, label: e.label, startedAt: e.at });
      state.toolCalls += 1;
      state.outputUnits += 400;
      state.lastOutputAt = e.at;
      if (e.tool === "run_command") state.phase = "act";
      return state;
    case "tool_output":
      state.outputUnits += Math.max(0, e.bytes);
      state.lastOutputAt = e.at;
      return state;
    case "tool_ended":
      state.openCalls.delete(e.callId);
      state.outputUnits += 400;
      state.lastOutputAt = e.at;
      return state;
    case "file_changed": {
      const prev = state.files.get(e.path) ?? { added: 0, removed: 0 };
      state.files.set(e.path, { added: prev.added + e.added, removed: prev.removed + e.removed });
      return state;
    }
    case "check":
      // The exit code the runtime read. Not the model's opinion of it.
      state.checks.push({ command: e.command, passed: e.passed, summary: e.summary });
      state.phase = "verify";
      return state;
    case "retry":
      state.retries = { attempt: e.attempt, of: e.of };
      state.outputUnits += 400;
      state.lastOutputAt = e.at;
      return state;
    case "provider_switched":
      state.switches += 1;
      state.retries = null; // switching ends that provider's ladder
      return state;
    case "usage":
      state.outputTokens += e.outputTokens;
      if (typeof e.contextPercent === "number") state.contextPercent = e.contextPercent;
      return state;
    case "criterion_moved":
      state.criteria.set(e.index, { rung: e.rung, source: e.source });
      return state;
    case "error":
      state.errors.push({ message: e.message, fatal: e.fatal });
      return state;
    case "turn_ended":
      state.endedAt = e.at;
      state.aborted = e.aborted;
      state.retries = null;
      state.openCalls.clear();
      return state;
    default:
      return state;
  }
}

/** The whole log, folded. Replay and first-render are the same code path. */
export function reduce(events: readonly TurnEvent[]): TurnState {
  let s = emptyState();
  for (const e of events) s = apply(s, e);
  return s;
}

/**
 * The append-only log itself. `append` is the only mutator, and it returns the
 * derived state so a caller never has to hold both and keep them in sync — the
 * classic way a "derived" value stops being derived.
 */
export class TurnLog {
  private readonly events: TurnEvent[] = [];
  private state: TurnState = emptyState();

  append(e: TurnEvent): TurnState {
    this.events.push(e);
    this.state = apply(this.state, e);
    return this.state;
  }

  get current(): TurnState {
    return this.state;
  }

  get entries(): readonly TurnEvent[] {
    return this.events;
  }

  /** Rebuild from scratch. Must equal `current` — that equality is the test
   *  that proves the state is genuinely derived and nothing wrote to it
   *  behind the reducer's back. */
  replay(): TurnState {
    return reduce(this.events);
  }

  /** Serialise for crash recovery. The log IS the session. */
  toJSON(): TurnEvent[] {
    return [...this.events];
  }

  static fromJSON(events: TurnEvent[]): TurnLog {
    const log = new TurnLog();
    for (const e of events) log.append(e);
    return log;
  }
}

/** Did every check the runtime ran actually pass? The only honest source for
 *  "it works", and it cannot be reached by anything the model wrote. */
export function checksPassed(state: TurnState): boolean {
  return state.checks.length > 0 && state.checks.every((c) => c.passed);
}
