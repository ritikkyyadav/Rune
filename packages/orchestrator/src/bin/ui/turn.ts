// --- TurnRenderer: the Gear customizer's visible activity stream ---
// The reference deliberately shows Plan -> Read/Search -> Command -> Edit/Diff ->
// Complete -> Answer. Keep private reasoning private, but never hide the actual
// actions or evidence that explain what the agent did.

import { accent, bold, danger, faint, muted, ok, stripAnsi, text, warn } from "./theme";
import { glyph } from "./glyphs";
import { truncate, wrap } from "./render";
import * as F from "./flow";
import {
  CHAMBER_AT,
  isChamberView,
  isRoutineTool,
  renderChamberDetail,
  renderChamberHead,
  renderToolActivity,
  renderToolDetail,
  renderTranscript,
  runningLabel,
  planBlock,
  stepBlock,
  isVerificationCommand,
  type ToolActivityView,
  type TranscriptLineView,
} from "./activity";
import type { AgentTurnEvent, ResearchEvent } from "@gear/protocol";
import { assertNeverSoft } from "@gear/protocol";
import { formatError, formatEvent, fmtTokens } from "./events";
import { Pulse, PULSE_WEIGHT, pulseGlyph, quietLabel } from "./pulse";
import { renderMarkdown } from "./markdown";
import { renderUnifiedDiff } from "../diff-render";
import { stepReceipt, type TodoItem as SpineTodo } from "../../task-state";

export { isVerificationCommand };

/** Column budget for a turn. The flow measure is the single source of truth --
 *  a wide terminal gets whitespace, not a 110-column sentence. */
export function turnWidth(): number {
  return F.measure();
}

export interface TurnSink {
  /** Append a finished block to terminal scrollback. A block committed with
   *  `detail` holds more than it shows: the detail is the same block opened --
   *  full output, the whole diff, a chamber's per-call record -- and a sink
   *  that owns its buffer (the fixed viewport) offers it as the block's
   *  in-place expansion. A sink that writes to real scrollback ignores it;
   *  ctrl+r's work log still carries everything. */
  commit(block: string, detail?: string): void;
  /** Replace the small live focus above the composer. */
  preview?(lines: string[] | null): void;
}

export interface TurnRendererOpts {
  model?: string;
  getCost?: () => number;
}

export type WorkPhase = "understand" | "plan" | "act" | "verify";

/** The plan as the spine emits it: status plus the harness-measured evidence
 *  and the unproven mark. Loose on `status` because replayed sessions predate
 *  the strict union. */
interface TodoItem {
  content: string;
  status: string;
  evidence?: SpineTodo["evidence"];
  unproven?: SpineTodo["unproven"];
}

interface EditStat {
  added: number;
  removed: number;
  created?: boolean;
}

interface CheckEvidence {
  label: string;
  detail: string;
  status: "passed" | "failed" | "not-run";
  count: number;
  /** Tests the runner reported as passing, when its output carried a tally. */
  tests?: number;
}

interface CurrentTool {
  callId: string;
  name: string;
  argsJson: string;
  args: Record<string, unknown>;
}

/**
 * One member of a delegation fleet, as the panel above the composer sees it.
 *
 * A fan-out used to render as `3 sub-agents running | grep backend` -- a count,
 * and one borrowed heartbeat from whichever of the three reported last. Which
 * one was greping, what the other two were asked, whether any had already come
 * back: none of it was on the screen, for however many minutes the slowest
 * member took. This is the state that makes each of them a row.
 */
interface FleetAgent {
  callId: string;
  /** `task` (read-only scout) or `worker` (write-capable builder). */
  kind: "task" | "worker";
  /** Streamed argument JSON, accumulated per call -- `currentTool` only ever
   *  holds the newest, so a fleet's earlier members would otherwise be
   *  anonymous by the time they start running. */
  argsJson: string;
  /** What this one was sent to do: its `label`, else the head of its prompt. */
  brief: string;
  /** `queued` until the loop actually starts it -- a fan-out wider than the
   *  parallel ceiling waits, and a waiting scout is not a running one. */
  state: "queued" | "running" | "done" | "failed";
  /** When execution began / ended. Absent while queued: an unknown clock is
   *  left blank rather than started at a convenient moment. */
  startedAt?: number;
  endedAt?: number;
  /** The heartbeat on screen, and the one waiting to replace it. Held to the
   *  same dwell as the rung: a row that changes four times a second is not
   *  information, it is a flicker with a name on it. */
  note: string;
  noteAt: number;
  wantNote: string;
  /** Tool calls this member has completed -- one per heartbeat. */
  steps: number;
}

/** How many fleet rows the panel draws before it collapses the remainder into
 *  a `+N more` line. Six is about where a list stops being scannable, and the
 *  footer is not allowed to become the screen. */
const FLEET_ROWS = 6;

/** A worker keys its heartbeats with its own id (`w1 edit_file src/x.ts`) so
 *  the old single-line rung could tell one member of a fleet from another. On
 *  a row that already names the member, that prefix is the same fact twice. */
function stripWorkerId(note: string): string {
  return note.replace(/^w\d+\s+/, "");
}

/**
 * What a fleet member is called on screen.
 *
 * The `label` the model wrote for this call, which is the only part of the row
 * it authors -- else the head of the prompt, which is a whole contract and
 * therefore reads as a paragraph cut in half, which is exactly why `label`
 * exists -- else what kind of thing it is, while the arguments are still
 * streaming and there is genuinely nothing to say yet.
 */
function fleetBrief(agent: FleetAgent): string {
  const args = partialArgs(agent.argsJson);
  const label = typeof args.label === "string" ? oneLine(args.label, 44) : "";
  if (label) return label;
  const prompt = typeof args.prompt === "string" ? oneLine(args.prompt, 44) : "";
  return prompt || agent.brief;
}

/** Elapsed between two marks, in the rung's own words. */
function span(from: number, to: number): string {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const PHASE_DEFAULT: Record<WorkPhase, string> = {
  understand: "Reading the task and gathering context",
  plan: "Shaping a reliable approach",
  act: "Making the change",
  verify: "Checking the result against real evidence",
};

/** The stable signal glyph used for the current phase. */
export const HEX = glyph("phase");

// --- The pace of the live rung ---
// Everything below is about *time*, not ink, and all of it exists to answer one
// complaint: watched from outside, the agent looked like it was rushing. It was
// not -- the work took exactly as long as it took. What rushed was the reporting.
// A turn can open and close four tool calls in the time it takes to focus on a
// line, and a status line that honours every one of those transitions is not
// informative, it is a strobe. Reading a strobe feels like watching someone who
// is late.

/** The floor on how long one live-rung frame stays up: roughly the time it
 *  takes to read four words. Below this the line stops being language. */
const DWELL_MS = 700;

/** How long a state that says *less* than what is already up must persist
 *  before it may replace it. Quiet frames -- `thinking` with nothing under it,
 *  `answering` on the strength of one stray token -- are the ones that turn out
 *  not to have been true a moment later, so they are asked to prove themselves.
 *  A frame that names real work is not: making it wait would mean the rung goes
 *  quiet precisely when the agent is busiest. Roughly one tick. */
const SETTLE_MS = 120;

/** How long after a tool ends the agent is still considered mid-burst. Between
 *  one call finishing and the next beginning there is a beat where nothing is in
 *  flight, and taken literally that beat is "thinking" -- but a 5ms hole in the
 *  middle of obvious work is an artefact of event granularity, not a state
 *  anyone is in. Left alone it also defeats the settle above, because the
 *  candidate flips away and back and never accumulates the time it needs to
 *  earn the screen: the rung ends up saying "thinking" through half a second of
 *  visible work. Inside this window the rung simply holds. */
const GAP_MS = 300;

/** How long a turn runs before its elapsed clock is worth a column. `0s`
 *  beside every step is noise pretending to be data. */
const ELAPSED_AFTER_MS = 2000;

// How long a run of chamber-eligible work has to get before it collapses is
// CHAMBER_AT, owned by ./activity so the live stream and the replay agree.

function oneLine(raw: string, max = 100): string {
  const clean = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(clean, max);
}

function lastNonEmpty(raw: string): string {
  return (
    raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (!path.startsWith("/") && parts.length <= 5) return path;
  if (parts.length <= 3) return path;
  return ".../" + parts.slice(-3).join("/");
}

function tryJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function phaseForTool(name: string, args: Record<string, unknown>): WorkPhase {
  if (
    name === "read_file" ||
    name === "list_dir" ||
    name === "grep" ||
    name === "glob" ||
    name === "symbol_search" ||
    name === "lsp" ||
    name === "web_search" ||
    name === "web_fetch" ||
    name === "task"
  ) {
    return "understand";
  }
  if (name === "todo_write" || name === "create_plan" || name === "update_plan") return "plan";
  if (name === "bash" && isVerificationCommand(String(args.command ?? ""))) return "verify";
  return "act";
}

function liveToolLabel(name: string, args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  switch (name) {
    case "read_file":
      return path ? `Reading ${shortPath(path)}` : "Reading relevant code";
    case "list_dir":
      return path ? `Exploring ${shortPath(path)}` : "Mapping the workspace";
    case "grep": {
      const pattern = String(args.pattern ?? "");
      return pattern ? `Searching for "${truncate(pattern, 48)}"` : "Searching the codebase";
    }
    case "glob":
      return "Finding relevant files";
    case "symbol_search":
    case "lsp":
      return "Tracing code relationships";
    case "write_file":
      return path ? `Creating ${shortPath(path)}` : "Creating the implementation";
    case "edit_file":
    case "multi_edit":
      return path ? `Updating ${shortPath(path)}` : "Applying the change";
    case "bash": {
      const command = oneLine(String(args.command ?? ""), 68);
      if (!command) return "Running the necessary command";
      return isVerificationCommand(command) ? `Checking with ${command}` : `Running ${command}`;
    }
    case "web_search": {
      const query = oneLine(String(args.query ?? args.q ?? ""), 58);
      return query ? `Researching "${query}"` : "Researching current information";
    }
    case "web_fetch":
      return "Reading the primary source";
    case "worker":
      return "Integrating a parallel workstream";
    case "task":
      return "Scouting the relevant subsystem";
    case "todo_write":
      return "Keeping the execution plan current";
    default:
      return runningLabel(name);
  }
}

/**
 * What the streaming tool-call arguments say *so far* -- but only where they
 * have finished saying it. The closing quote in each pattern is the whole
 * point: matching an unterminated value meant the live rung typed the path out
 * letter by letter (`Reading s` -> `Reading src/b` -> `Reading .../ui/turn.ts`),
 * reshaping itself on every token as the string grew past what shortPath elides.
 * That stutter is a large part of what made the agent look frantic while it was
 * doing something perfectly ordinary. Waiting for the closing quote costs a few
 * hundred milliseconds of vagueness and buys one clean transition: the generic
 * phrase, then the real target, and nothing in between. When a value is escaped
 * or spans lines no partial match is offered at all -- the full parse above will
 * supply it a moment later, and a calm "Running the necessary command" is a
 * better placeholder than a half-typed one.
 */
function partialArgs(raw: string): Record<string, unknown> {
  const parsed = tryJson(raw);
  if (parsed) return parsed;
  const result: Record<string, unknown> = {};
  for (const key of ["path", "pattern", "command", "query", "q", "label"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"\\n]*)"`).exec(raw);
    if (match?.[1]) result[key] = match[1].replace(/\\n/g, " ").replace(/\\"/g, '"');
  }
  return result;
}

/** Turn metadata the caller may still pass. The flow header carries the turn
 *  and checkpoint state now, so the message itself stays undecorated. */
export interface UserBlockMeta {
  turn?: number;
  checkpoint?: string;
}

/**
 * What you asked, at the left margin. No bar, no fill, no receipt -- and, since
 * the echo was repainted, no competing with the answer either: the block sits
 * at the muted slot under a single coloured marker. F.asked() carries the
 * reasoning; the turn number is already in the header.
 */
export function userBlock(raw: string, _meta: UserBlockMeta = {}): string {
  return F.asked(raw);
}

export function responseHead(): string {
  return "";
}

const BLOCK_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||(?:-{3,}|\*{3,}|_{3,})$)/;

/* splitHeadline() lived here: it walked model prose looking for a sentence
 * boundary so the first sentence could be laid out as a headline. It was the
 * last place in this file where what the model WROTE decided what the screen
 * DID, which is the seam an unreliable model gets through — see
 * ui/events/log.ts. Prose is printed; it does not choose layout. Deleted in
 * Phase 05 with no caller and no replacement. */

/**
 * The final answer, in the agent's voice: one dot, then the sentence that
 * actually answers the question, then the detail. Authored Markdown structure
 * (headings, lists, code) is preserved -- only a plain opening paragraph is
 * promoted to the dot, because that is the line the reader came for.
 */
export function responseBlock(markdown: string): string {
  // renderMarkdown's `width` is the TOTAL budget for a line, indent included:
  // it takes `indent` off itself. Passing proseWidth() -- which has already had
  // BODY subtracted -- charged for the indent twice, so every paragraph, list
  // and code fence under the headline stopped four columns short of the
  // headline sitting directly above it. The measure is the whole line.
  const width = F.measure();
  const source = markdown.replace(/\r\n/g, "\n").split("\n");
  const first = source.findIndex((line) => line.trim());
  if (
    first >= 0 &&
    !BLOCK_OPENER.test(source[first]!.trim()) &&
    !/^(\*\*|__)/.test(source[first]!.trim())
  ) {
    let end = first;
    while (
      end + 1 < source.length &&
      source[end + 1]!.trim() &&
      !BLOCK_OPENER.test(source[end + 1]!.trim())
    ) {
      end++;
    }
    const paragraph = source
      .slice(first, end + 1)
      .map((line) => line.trim())
      .join(" ");
    const rest = source.slice(end + 1);
    const head = F.said(paragraph);
    const detail = rest.join("\n").trim()
      ? renderMarkdown(rest.join("\n"), { width, indent: F.BODY })
      : [];
    return ["", head, ...(detail.length ? ["", ...detail] : [])].join("\n");
  }
  return ["", ...renderMarkdown(source.join("\n"), { width, indent: F.BODY })].join("\n");
}

function duration(startedAt: number): string {
  return span(startedAt, Date.now());
}

function plural(count: number, singular: string, many = singular + "s"): string {
  return `${count} ${count === 1 ? singular : many}`;
}

function joinedList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function parseCheck(command: string, result: string, toolSuccess: boolean): CheckEvidence | null {
  if (!isVerificationCommand(command)) return null;
  const parsed = tryJson(result);
  const timedOut = parsed?.timed_out === true;
  const exitCode = typeof parsed?.exit_code === "number" ? parsed.exit_code : null;
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
  const passed = toolSuccess && !timedOut && (exitCode == null || exitCode === 0);
  const detail = timedOut
    ? "timed out"
    : exitCode != null && exitCode !== 0
      ? `exit ${exitCode}`
      : oneLine(lastNonEmpty(stdout || stderr), 56) || (passed ? "passed" : "failed");
  // A runner's own tally (`214 pass`, `214 passed`, `Ran 214 tests`) feeds
  // the summary badge; absent a tally the badge stays generic, never invented.
  const tally =
    /^\s*(\d+)\s+pass(?:ed|ing)?\b/m.exec(stdout)?.[1] ??
    /\bRan\s+(\d+)\s+tests?\b/.exec(stdout)?.[1] ??
    /\b(\d+)\s+tests?\s+passed\b/i.exec(stdout)?.[1] ??
    /test result: ok\.\s+(\d+)\s+passed/.exec(stdout)?.[1];
  return {
    label: oneLine(command, 62),
    detail,
    status: passed ? "passed" : "failed",
    count: 1,
    tests: tally != null && passed ? Number(tally) : undefined,
  };
}

/** The v2 summary-strip badge for a passed check: `214 tests pass`,
 * `typecheck clean`, `lint clean`, `build ok` -- or the command itself. */
function checkBadge(check: CheckEvidence): string {
  const cmd = check.label.toLowerCase();
  const detail = check.detail ?? "";
  const count =
    check.tests ??
    /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i.exec(detail)?.[1] ??
    /\b(\d+)\s+passed\b/i.exec(detail)?.[1];
  if (
    /(^|[\s;&|])(test|tests|pytest|vitest|jest|mocha)([\s;&|]|$)|\b(cargo|go|swift)\s+test\b/.test(
      cmd,
    )
  )
    return count ? `${count} tests pass` : "tests pass";
  if (/\b(typecheck|tsc)\b/.test(cmd)) return "typecheck clean";
  if (/\b(lint|eslint|ruff|clippy|mypy)\b/.test(cmd)) return "lint clean";
  if (/\bbuild\b/.test(cmd)) return "build ok";
  return truncate(check.label || check.detail || "project checks", 32);
}

function editCounts(result: string): { added: number; removed: number } {
  const parsed = tryJson(result);
  if (!parsed?.diff) return { added: 0, removed: 0 };
  const rendered = renderUnifiedDiff(String(parsed.diff), "");
  return { added: rendered.added, removed: rendered.removed };
}

export class TurnRenderer {
  private prose = "";
  private workLog: Array<{ line: string; detail: boolean }> = [];
  private todos: TodoItem[] = [];
  private editedFiles = new Map<string, EditStat>();
  private checks: CheckEvidence[] = [];
  private currentTool: CurrentTool | null = null;
  /**
   * Every started-but-unfinished DELEGATION this turn, by callId, in the order
   * the model dispatched them. `currentTool` is the newest streamed call and
   * goes null on the FIRST end -- with several parallel sub-agents in flight
   * that read as "thinking" while four workers were still building. This map
   * keeps the rung honest for the whole fleet, and carries what each member is
   * doing so the panel can show it (see fleetLines).
   */
  private fleet = new Map<string, FleetAgent>();
  private phase: WorkPhase = "understand";
  private intent = PHASE_DEFAULT.understand;
  private toolCalls = 0;
  private reads = 0;
  private searches = 0;
  private webSources = 0;
  private reroutes = 0;
  private failures = 0;
  private errored = false;
  private hardError = false;
  private committedErrors = new Set<string>();
  private routineQueue: ToolActivityView[] = [];
  /** The plan as last committed to scrollback, and as last rendered. The first
   *  version goes to the timeline; the final one goes to the close if it moved.
   *  The revisions in between belong to the live rung. */
  private committedPlan: string | null = null;
  private latestPlan: string | null = null;
  private narratedPlan = false;
  private verificationRunning = false;
  private readonly startedAt = Date.now();
  /** Liveness driven by real output rather than by the clock -- see pulse.ts.
   *  Fed by every scrap of genuine progress: streamed prose, reasoning deltas,
   *  tool arguments, sub-agent heartbeats, calls opening and closing. */
  private readonly pulse = new Pulse();
  /** The provider retry in flight, when there is one. A silent retry is a lie
   *  of omission about how long something took and how reliable it was, so it
   *  rides the rung for as long as it lasts. */
  private retrying: { attempt: number; of: number } | null = null;
  /** The live rung's current frame and when it went up -- see steadyFrame. */
  private frame: { label: string; detail: string } = { label: "thinking", detail: "" };
  private frameAt = 0;
  /** The state the rung is *trying* to move to, and when it first appeared. */
  private want: { label: string; detail: string } = { label: "thinking", detail: "" };
  private wantSince = 0;
  /** When the last tool call ended -- the near side of a possible burst gap. */
  private lastToolEndAt = 0;
  /** The last rung actually pushed to the sink, so an event that changes
   *  nothing visible does not schedule a repaint. */
  private lastLive = "";
  /** Rows in the last committed block -- drives the blank-line rhythm. */
  private lastBlockRows = 0;
  // v2 turn metadata: provider-reported download tokens, accumulated thinking
  // wall-clock, live context %, the agent-loop turn number, and the latest
  // durable checkpoint -- all fed by structured events, never invented.
  private downTokens = 0;
  private thinkingMs = 0;
  private lastThinkingAt = 0;
  private contextPercent: number | null = null;
  private turnCount = 0;
  private checkpoint: { runId: string; version: number } | null = null;

  /** Back-compat for callers that used the old separate activity line. */
  activity: string | null = null;

  constructor(
    private sink: TurnSink,
    private opts: TurnRendererOpts = {},
  ) {
    this.updateLive();
  }

  /** Complete, inspectable mechanics. Never printed unless the user asks. */
  fullLog(): string | null {
    if (this.workLog.length === 0) return null;
    return [
      `  ${bold(text("Work details"))} ${faint(`| ${plural(this.toolCalls, "action")}`)}`,
      ...this.workLog.map((entry) => entry.line),
    ].join("\n");
  }

  get worked(): boolean {
    return this.toolCalls > 0 || this.workLog.length > 0 || this.todos.length > 0;
  }

  /**
   * The live rung above the composer: the same dot the agent speaks with, and an
   * honest receipt beside it. One row, plus a faint second row naming what is
   * actually in flight -- never a fake progress bar, because the agent does not
   * know how far along it is either.
   *
   * The one-cell ramp is sampled from the real-output accumulator. It rises
   * only when bytes or callbacks arrive and falls when they stop; ambiguous
   * width terminals receive its ASCII twin. The quiet word still carries the
   * stall, so shape and colour are never the only evidence.
   *
   * Nothing here slows the work down. Only the reporting is paced -- the elapsed
   * receipt beside the mark is the honest clock, and it never waits.
   */
  /** What the tab title needs from the pulse: how long since real output. The
   *  title turns on this rather than on a timer -- see ./title.ts and ./pulse.ts. */
  beat(): { quietMs: number } {
    return { quietMs: this.pulse.sample().quietMs };
  }

  liveLines(): string[] {
    const { label, detail } = this.steadyFrame();
    const beat = this.pulse.sample();
    const mark = accent(pulseGlyph(beat));
    const lines = [
      F.flowRow(`${F.MARK}${mark} ${muted(label)}`, faint(F.receiptOf(this.receipt()))),
    ];
    if (detail) lines.push(`${F.BODY}${faint(truncate(detail, F.proseWidth()))}`);
    lines.push(...this.fleetLines());
    lines.push(...this.streamingProseTail());
    return lines;
  }

  /**
   * The fleet panel: one row per sub-agent in flight, on the same rail their
   * finished calls will land on.
   *
   *     | > scout  map the deploy surface  grep backend · 1m 2s
   *     | > scout  find the auth store  read_file src/auth.ts · 58s
   *     | . work   build the settings page  done · 12 steps · 41s
   *     |   scout  survey the migration scripts  queued
   *
   * The left half is what each one was SENT to do and does not move; the right
   * half is what it is doing now. That split is the whole point -- a fleet
   * reported as one shared heartbeat (`3 sub-agents running | grep backend`)
   * tells you something is happening and nothing about who, and three minutes
   * of it reads as being locked out of the room the work is in.
   *
   * Rows stay in dispatch order, including after one finishes: a list that
   * re-sorts itself under the eye cannot be tracked, and the point of the panel
   * is that the second row is still the same sub-agent it was a minute ago.
   */
  private fleetLines(): string[] {
    if (this.fleet.size === 0) return [];
    const now = Date.now();
    const agents = [...this.fleet.values()];
    const rows = agents.slice(0, FLEET_ROWS).map((agent) => this.fleetRow(agent, now));
    const hidden = agents.length - Math.min(agents.length, FLEET_ROWS);
    if (hidden > 0) rows.push(F.railRow(faint(`+${hidden} more`)));
    return rows;
  }

  /**
   * Fold one heartbeat -- or one lifecycle marker from the loop -- into the
   * member it belongs to.
   *
   * The two markers are the difference between a panel and a guess. `started`
   * is when the loop actually ran this call, which is not when the model
   * finished writing it: a fan-out wider than the parallel ceiling waits its
   * turn, and drawing a waiting scout as a running one would put a climbing
   * clock next to work that has not begun. `settled` is when it came back, and
   * without it a member that finished early keeps its row saying `running`
   * until the whole batch lands -- which for the fastest of five workers meant
   * minutes of the screen being wrong.
   */
  private trackFleetProgress(
    callId: string,
    note: string,
    state: "started" | "settled" | undefined,
    ok: boolean,
  ): void {
    const agent = this.fleet.get(callId);
    if (!agent) return;
    const now = Date.now();
    if (state === "started") {
      agent.state = "running";
      agent.startedAt = now;
      return;
    }
    if (state === "settled") {
      agent.state = ok ? "done" : "failed";
      agent.endedAt = now;
      // What it was doing a second ago stops being the news the moment it is
      // back; the row reports what it came back AS instead.
      agent.note = "";
      agent.wantNote = "";
      return;
    }
    if (!note) return;
    const clean = stripWorkerId(note);
    // A mid-run model swap arrives as a MARKER rather than a tool name (see
    // subagent.ts): news about the run, not a step the sub-agent took, and
    // counting it would inflate the tally with something it never did. Tool
    // names are ASCII, so a leading non-ASCII cell is what a marker looks like
    // -- named that way rather than by the glyph itself, which belongs to the
    // closed set and not to a literal in here.
    if (!/^[^\x00-\x7f]/.test(clean)) agent.steps++;
    agent.wantNote = truncate(clean, 40);
    if (agent.state === "queued") {
      // A heartbeat is proof it is running, whichever order the markers arrived
      // in -- the panel never needs the loop to agree with itself first.
      agent.state = "running";
      agent.startedAt ??= now;
    }
    // The first note goes up immediately. Only a REPLACEMENT waits its dwell:
    // there is nothing to protect on a row that has said nothing yet.
    if (!agent.note) {
      agent.note = agent.wantNote;
      agent.noteAt = now;
    }
  }

  private fleetRow(agent: FleetAgent, now: number): string {
    // The heartbeat holds for a beat before it is replaced, for the same reason
    // the rung above it does -- see steadyFrame. The 125ms tick re-renders, so
    // a note held here is shown as soon as its predecessor has been read.
    if (agent.wantNote !== agent.note && now - agent.noteAt >= DWELL_MS) {
      agent.note = agent.wantNote;
      agent.noteAt = now;
    }
    // Padded to the longer of the two verbs: a fleet is a LIST, and a list of
    // mixed scouts and workers whose briefs start one column apart reads as
    // ragged rather than as a column. (toolRow's own pad is 4 and never shrinks
    // a name, so this only ever adds the cell `work` is missing.)
    const verb = (agent.kind === "worker" ? "work" : "scout").padEnd(5);
    // A queued member has no clock to show, and `0s` beside one that started a
    // moment ago is noise pretending to be data -- the same floor the rung keeps.
    const until = agent.endedAt ?? now;
    const elapsed =
      agent.startedAt == null || until - agent.startedAt < ELAPSED_AFTER_MS
        ? ""
        : span(agent.startedAt, until);
    switch (agent.state) {
      case "queued":
        return F.toolRow({ name: verb, arg: agent.brief, metric: "queued", status: "none" });
      case "done":
      case "failed": {
        const outcome = agent.state === "done" ? "done" : "failed";
        const steps = agent.steps > 0 ? plural(agent.steps, "step") : "";
        return F.toolRow({
          name: verb,
          arg: agent.brief,
          metric: F.receiptOf([outcome, steps, elapsed]),
          status: agent.state === "done" ? "ok" : "fail",
        });
      }
      default:
        return F.toolRow({
          name: verb,
          arg: agent.brief,
          metric: F.receiptOf([this.fittedNote(agent, elapsed), elapsed]),
          status: "active",
        });
    }
  }

  /**
   * The heartbeat, cut to what is left of the row after everything that
   * outranks it.
   *
   * Order of precedence on a narrow terminal: WHO (the brief), then HOW LONG
   * (the clock, which is how a stuck member is spotted), then what it is doing
   * this second. Letting flowRow truncate the whole line instead put the cut in
   * the wrong place -- it ate the clock and left three letters of a path, which
   * is a row that has given up half its meaning to say `read_f…`. Below a
   * readable remainder the note is dropped whole rather than stubbed.
   */
  private fittedNote(agent: FleetAgent, elapsed: string): string {
    if (!agent.note) return "";
    // rail + mark + verb + the two-space joins around the brief and the receipt.
    const spent = 2 + 5 + 2 + agent.brief.length + 2 + (elapsed ? elapsed.length + 3 : 0);
    const room = F.railWidth() - spent;
    return room >= 12 ? truncate(agent.note, room) : "";
  }

  /**
   * The last few lines of the answer AS IT STREAMS -- the agent's voice, live.
   * The rung says "answering"; these lines say WHAT. This is the single change
   * that separates "a spinner ran for 40 seconds and a wall of text appeared"
   * from watching an engineer talk while they work: mid-turn narration
   * ("Found it: ...") is visible the moment it is written, not retroactively.
   * Committed scrollback still gets the fully-rendered markdown at finish;
   * this is only the live view of the tail.
   */
  private streamingProseTail(): string[] {
    const raw = this.prose.trim();
    if (!raw) return [];
    const width = F.proseWidth();
    const clipped = raw.length > 700;
    const tail = clipped ? raw.slice(-700) : raw;
    const lines = tail
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => wrap(l, width))
      .slice(-4);
    if (lines.length === 0) return [];
    if (clipped) lines[0] = glyph("elision") + lines[0].slice(1);
    return lines.map((l) => `${F.BODY}${text(l)}`);
  }

  /** True in the beat between one tool call ending and the next beginning --
   *  nothing in flight, nothing said yet, and a call only just finished. The
   *  caller also requires the candidate to be empty; this only answers "was a
   *  tool running a moment ago?". */
  private inToolGap(now: number): boolean {
    return (
      !this.currentTool &&
      !this.verificationRunning &&
      !this.prose.trim() &&
      this.lastToolEndAt > 0 &&
      now - this.lastToolEndAt < GAP_MS
    );
  }

  /** What the rung would say if it could change this instant. */
  private liveLabel(): string {
    if (this.currentTool || this.fleet.size > 0) return "working";
    if (this.verificationRunning) return "checking";
    return this.prose.trim() ? "answering" : "thinking";
  }

  /**
   * The rung, held still long enough to be read. Two gates, and they guard
   * different things.
   *
   * The **dwell** protects the frame that is already up: for DWELL_MS it wins
   * against whatever wants to replace it. The **gap** (inToolGap) hides the beat
   * between two calls in a burst, so a 5ms hole in obvious work is not mistaken
   * for a change of state. The **settle** asks a candidate that says *less* than
   * what is up -- `thinking` with nothing under it -- to still be true a moment
   * later before it takes the screen; a candidate that names real work goes up
   * as soon as the dwell allows, because making it wait would leave the rung
   * silent exactly while the agent is busiest.
   *
   * Label and detail move as one pair rather than independently, because
   * releasing them separately would put `answering` above a stale tool target --
   * a frame that was never true of anything.
   *
   * Nothing is lost to any of this. The rail below records every call in full as
   * it lands; the rung is only the current sentence of that account, and a
   * sentence that changes four times a second is not one.
   */
  private steadyFrame(): { label: string; detail: string } {
    const now = Date.now();
    const want = { label: this.liveLabel(), detail: this.liveDetail() };
    // Mid-burst, between two calls, with nothing to say for itself: no new
    // information, so do not evaluate a transition at all -- hold what is up.
    // The emptiness is the test. A gap that *has* something to report (a check
    // came back, a plan step advanced) is not this, and is not held.
    if (!want.detail && this.inToolGap(now)) return this.frame;
    if (want.label !== this.want.label || want.detail !== this.want.detail) {
      this.want = want;
      this.wantSince = now;
    }
    if (want.label === this.frame.label && want.detail === this.frame.detail) return this.frame;
    if (now - this.frameAt < DWELL_MS) return this.frame;
    if (!want.detail && this.frame.detail && now - this.wantSince < SETTLE_MS) return this.frame;
    this.frame = want;
    this.frameAt = now;
    return this.frame;
  }

  /** What the rung is waiting on: the in-flight tool, else the active plan step,
   * else the phase intent the renderer inferred from the stream. */
  private liveDetail(): string {
    // A FLEET of parallel sub-agents reads as one calm sentence -- the count,
    // and how much of it is already back -- instead of whichever call streamed
    // last (or, worse, "thinking" after the first of five workers finished).
    // What each member is DOING is a row of its own now (fleetLines), so this
    // line no longer borrows one member's heartbeat to speak for all of them.
    const fleet = [...this.fleet.values()];
    if (fleet.length >= 2 || (fleet.length === 1 && !this.currentTool)) {
      const noun = fleet.every((a) => a.kind === "worker") ? "worker" : "sub-agent";
      const settled = fleet.filter((a) => a.state === "done" || a.state === "failed").length;
      const queued = fleet.filter((a) => a.state === "queued").length;
      const head = fleet.length === 1 ? noun : `${fleet.length} ${noun}s`;
      if (settled > 0 && settled === fleet.length) return F.receiptOf([head, "all back"]);
      if (settled > 0) return F.receiptOf([head, `${settled} back`]);
      if (queued === fleet.length) return `${head} dispatched`;
      return `${head} running`;
    }
    if (this.currentTool) {
      const base = liveToolLabel(this.currentTool.name, this.currentTool.args);
      // A long call's own heartbeat (worker: "edit_file src/x.ts") rides
      // beside its label. The callId guard self-cleans on the next call.
      if (this.toolProgressNote?.callId === this.currentTool.callId) {
        return `${base} | ${this.toolProgressNote.note}`;
      }
      // Mid-burst, the running tally. Scrollback will keep one collapsed row
      // for the whole run, so this is where the reader gets to watch it climb
      // -- which is the part of a long exploration that reads as progress.
      const held = this.routineQueue.length;
      const name = this.currentTool.name;
      const gathering =
        isRoutineTool(name) || name === "bash" || name === "web_search" || name === "web_fetch";
      if (held >= CHAMBER_AT - 1 && gathering) {
        return `${base} | ${held + 1} so far`;
      }
      return base;
    }
    const active = this.todos.find((item) => item.status === "in_progress");
    if (active) {
      const done = this.todos.filter((item) => item.status === "completed").length;
      return `${active.content} | ${done}/${this.todos.length} steps`;
    }
    // While the answer streams the intent is stale context -- stay quiet.
    if (this.prose.trim()) return "";
    if (this.intent && this.intent !== PHASE_DEFAULT.understand) return this.intent;
    return "";
  }

  /**
   * Elapsed | the stall, in words | retries | provider-reported down tokens |
   * reasoning wall-clock. Every column is a measured fact. There is no
   * percentage here and no estimate of what remains: elapsed time is a fact,
   * remaining time is a guess, and a wrong guess about an agent's runtime is
   * the fastest way to lose trust in everything else on the screen.
   */
  /**
   * The receipt a COMMITTED row is allowed: what the work was, never what the
   * session cost.
   *
   * Elapsed time, token counts and reasoning wall-clock are true, and they are
   * telemetry about the machine rather than facts about the work. On the live
   * rung they earn their place -- you are watching something run and you want
   * to know it is still running. Left on the committed rows they turned the
   * transcript into a performance log: every row ending in a different KIND of
   * number, so the eye never learned what the tail of a row means. They live in
   * the footer now, which is always visible anyway, and in /details.
   */
  private workReceipt(): string[] {
    const parts: string[] = [];
    if (this.retrying) {
      parts.push(`${glyph("retry")} ${this.retrying.attempt} of ${this.retrying.of}`);
    }
    return parts;
  }

  private receipt(): string[] {
    const parts: string[] = [];
    if (Date.now() - this.startedAt >= ELAPSED_AFTER_MS) parts.push(duration(this.startedAt));
    // The pulse can go flat; only this says so. Carried by the word, never by
    // the glyph or the colour, so it survives NO_COLOR and a mono rung.
    const quiet = quietLabel(this.pulse.sample());
    if (quiet) parts.push(quiet);
    if (this.retrying) {
      parts.push(`${glyph("retry")} ${this.retrying.attempt} of ${this.retrying.of}`);
    }
    if (this.downTokens > 0) parts.push(`down ${fmtTokens(this.downTokens)} tokens`);
    if (this.thinkingMs >= 100) parts.push(`thought for ${(this.thinkingMs / 1000).toFixed(1)}s`);
    return parts;
  }

  /** Push the rung, but only when it actually reads differently. Tool arguments
   *  arrive a token at a time and each one used to schedule a full repaint of
   *  the footer; almost all of them rendered the same two lines as the token
   *  before. The animation is the tick's job, not the stream's. */
  private updateLive(): void {
    const lines = this.liveLines();
    const key = lines.join("\n");
    if (key === this.lastLive) return;
    this.lastLive = key;
    this.sink.preview?.(lines);
  }

  private setPhase(phase: WorkPhase, intent?: string): void {
    this.phase = phase;
    if (intent) this.intent = oneLine(intent, 100);
    else if (!this.intent) this.intent = PHASE_DEFAULT[phase];
    this.updateLive();
  }

  private addLog(block: string, detailAfterFirst = false): void {
    block.split("\n").forEach((line, index) => {
      if (stripAnsi(line).trim())
        this.workLog.push({ line, detail: detailAfterFirst && index > 0 });
    });
  }

  /**
   * Vertical rhythm between blocks. A blank line separates *groups*, not rows:
   * a run of one-line calls stays tight, and anything with a body -- a diff, an
   * output rail, a call with a note -- gets air on both sides. Blank-lining every
   * row would double the cost of a thirty-file read for no added meaning.
   *
   * Every commit closes the failure streak first, so a run of suppressed
   * repeats is accounted for before anything newer lands -- see flushFailStreak.
   */
  private commitTimeline(block: string, detail?: string): void {
    this.flushFailStreak();
    this.pushBlock(block, detail);
  }

  private pushBlock(block: string, detail?: string): void {
    if (!stripAnsi(block).trim()) return;
    const rows = block.split("\n").filter((row) => stripAnsi(row).trim()).length;
    const tight = rows === 1 && this.lastBlockRows === 1;
    this.lastBlockRows = rows;
    this.sink.commit(tight ? block : `\n${block}`, detail);
  }

  /**
   * A run of calls dying the same way is one fact, not a column of blocks.
   *
   * Eleven consecutive reads refused by the same rate limit committed eleven
   * two-row failure blocks -- the same sentence eleven times with a different
   * path in it, which is the single least professional screen this product has
   * shipped. Now the FIRST failure of a kind commits in full, repeats are
   * counted instead of printed (the work log still records every one), and the
   * count lands as one closing row the moment anything else commits.
   */
  private failStreak: { key: string; extra: number } | null = null;

  /** What makes two failures "the same": the verb and the reason, with numbers
   *  neutralised -- a retry window that counts down (`after 31075ms`, `after
   *  29001ms`) is one failure, not a parade of novel ones. */
  private static failKey(name: string, reason: string): string {
    return `${name}:${stripAnsi(reason)
      .toLowerCase()
      .replace(/\d[\d,._]*\s*(ms|s|m)\b/g, "n$1")
      .replace(/\d{3,}/g, "n")
      .trim()}`;
  }

  private flushFailStreak(): void {
    const streak = this.failStreak;
    if (!streak) return;
    this.failStreak = null;
    if (streak.extra > 0) {
      this.pushBlock(
        F.toolNote(
          `same failure repeated ${streak.extra} more time${streak.extra === 1 ? "" : "s"}`,
          "fail",
        ),
      );
    }
  }

  /**
   * Set down the context-gathering held since the last thing worth reading.
   *
   * Every handler that is about to commit something with news in it calls this
   * first, which is what keeps the order true: the reads that led to a finding
   * land above the finding, never after it. A short run prints per call --
   * two paths cost two lines and both are worth naming. A long one collapses to
   * a single chamber row, because the twelfth consecutive `read` tells the
   * reader nothing the first eleven did not, and the whole burst is one fact --
   * with its per-call record committed as the row's fold, so the reader who
   * comes back asking "what exactly ran here?" opens it in place.
   *
   * Nothing is discarded either way: `addLog` has already taken the full row
   * for the work log, which is what /details prints.
   */
  private flushRoutine(): void {
    const queued = this.routineQueue.splice(0);
    if (queued.length === 0) return;
    if (queued.length < CHAMBER_AT) {
      for (const view of queued) this.commitTimeline(renderToolActivity(view));
      return;
    }
    this.commitTimeline(renderChamberHead(queued), renderChamberDetail(queued));
  }

  private captureProseAsIntent(): void {
    const raw = this.prose.trim();
    this.prose = "";
    if (!raw) return;
    this.flushRoutine();
    const summary = oneLine(raw, 100);
    if (summary) {
      this.intent = summary;
      const block = (this.narratedPlan ? stepBlock(raw) : planBlock(raw)).join("\n");
      this.narratedPlan = true;
      this.addLog(block);
      this.commitTimeline(block);
    }
  }

  private recordEdit(event: any): void {
    if (!event.output?.success) return;
    const name = event.output.toolName;
    if (name !== "edit_file" && name !== "write_file" && name !== "multi_edit") return;
    const path = String(event.args?.path ?? tryJson(String(event.output.result))?.path ?? "");
    if (!path) return;
    const previous = this.editedFiles.get(path) ?? { added: 0, removed: 0 };
    if (name === "write_file") {
      this.editedFiles.set(path, { ...previous, created: previous.created ?? true });
      return;
    }
    const counts = editCounts(String(event.output.result ?? ""));
    this.editedFiles.set(path, {
      added: previous.added + counts.added,
      removed: previous.removed + counts.removed,
      created: previous.created,
    });
  }

  private recordTool(event: any): void {
    const name = String(event.output?.toolName ?? "");
    const args = (event.args ?? {}) as Record<string, unknown>;
    const result = String(event.output?.result ?? "");
    const success = event.output?.success === true;
    this.toolCalls++;
    if (name === "read_file" || name === "list_dir") this.reads++;
    if (name === "grep" || name === "glob" || name === "symbol_search" || name === "lsp") {
      this.searches++;
    }
    if (name === "web_search" || name === "web_fetch") this.webSources++;
    if (!success) {
      this.failures++;
      this.errored = true;
    }
    this.recordEdit(event);
    if (name === "bash") {
      const check = parseCheck(String(args.command ?? ""), result, success);
      if (check) {
        this.checks.push(check);
        if (check.status === "failed" && success) {
          this.failures++;
          this.errored = true;
        }
      }
    }
    const view: ToolActivityView = {
      toolName: name,
      args,
      result,
      success,
      error: event.output?.error,
      durationMs: event.output?.durationMs,
    };
    const rendered = renderToolActivity(view);
    this.addLog(rendered, name === "edit_file" || name === "multi_edit");
    if (isChamberView(view)) {
      // Context, not news -- gathering, a clean command, a web source. Held
      // until something worth reading lands, then set down as one chamber row
      // -- see flushRoutine. The rung above the composer is already naming
      // this call as it runs, so nothing is invisible meanwhile.
      this.routineQueue.push(view);
      this.updateLive();
      return;
    }
    // Anything with news in it closes the burst that led to it, so the reads
    // land above the result rather than trailing it.
    this.flushRoutine();
    if (!success) {
      const reason = String(event.output?.error ?? "failed").split("\n")[0] ?? "failed";
      const key = TurnRenderer.failKey(name, reason);
      if (this.failStreak?.key === key) {
        // The same failure again: counted, logged, not reprinted. The streak's
        // closing row will say how many the reader was spared.
        this.failStreak.extra++;
      } else {
        this.flushFailStreak();
        this.commitErrorOnce(rendered);
        this.failStreak = { key, extra: 0 };
      }
    } else {
      // The row states the outcome; whatever it held back -- full output, the
      // whole diff, the rest of a new file -- rides behind it as the fold.
      this.commitTimeline(rendered, renderToolDetail(view) ?? undefined);
    }

    // The default stays one line, but review mode must preserve enough command
    // evidence to diagnose a failure or verify a claim.
    if (name === "bash") {
      const parsed = tryJson(result);
      const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
      const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
      const raw = (stdout + (stdout && stderr ? "\n" : "") + stderr).trim();
      if (raw) {
        const all = raw.split("\n");
        const shown =
          all.length <= 60
            ? all
            : [...all.slice(0, 42), `... ${all.length - 54} lines omitted ...`, ...all.slice(-12)];
        this.addLog(
          [
            `    ${faint("command output")}`,
            ...shown.map((line) => `      ${muted(truncate(line, 100))}`),
          ].join("\n"),
          true,
        );
      }
    }
  }

  private commitErrorOnce(block: string): void {
    // Numbers are neutralised in the key the way the streak neutralises them:
    // a retry window that counts down is the same error each time it is
    // reported, and it used to dodge this dedupe by the milliseconds alone.
    const key = oneLine(stripAnsi(block), 180)
      .toLowerCase()
      .replace(/\d[\d,._]*\s*(ms|s|m)\b/g, "n$1")
      .replace(/\d{3,}/g, "n");
    if (!key || this.committedErrors.has(key)) return;
    this.committedErrors.add(key);
    this.commitTimeline(block);
  }

  /**
   * The one choke point where engine events become rows.
   *
   * Typed, and exhaustive: every member of both unions is named and the switch
   * ends in `assertNever`. It took `any` until Phase 2, which is why adding a
   * member to `AgentTurnEvent` compiled clean and rendered nothing — the
   * defect this whole phase exists to make impossible.
   */
  onEvent(event: AgentTurnEvent | ResearchEvent): void {
    switch (event.type) {
      case "thinking_delta": {
        // Reasoning remains private. The UI communicates intent and evidence
        // instead -- but the time SPENT reasoning is honest turn metadata
        // ("thought for 2.3s"), so accumulate wall-clock across delta bursts.
        const now = Date.now();
        this.pulse.feed(String(event.text ?? "").length || PULSE_WEIGHT.token, now);
        if (this.lastThinkingAt > 0 && now - this.lastThinkingAt < 3000) {
          this.thinkingMs += now - this.lastThinkingAt;
        }
        this.lastThinkingAt = now;
        return;
      }

      case "text_delta": {
        this.activity = null;
        this.prose += event.text;
        this.pulse.feed(String(event.text ?? "").length);
        // The voice streams LIVE (see streamingProseTail) -- but a repaint per
        // token is a strobe, so paint at most every ~80ms; the animation tick
        // catches whatever a gate skipped.
        const now = Date.now();
        if (now - this.lastProseLiveAt >= 80) {
          this.lastProseLiveAt = now;
          this.updateLive();
        }
        return;
      }

      case "stream_reset":
        // Re-streaming from scratch is work, not silence.
        this.pulse.feed(PULSE_WEIGHT.callback);
        this.prose = "";
        this.currentTool = null;
        this.fleet.clear();
        this.activity = null;
        this.updateLive();
        return;

      case "tool_progress": {
        // Sub-agent/worker heartbeat: shown live, never committed.
        this.pulse.feed(PULSE_WEIGHT.heartbeat);
        const callId = String(event.callId ?? "");
        const note = String(event.note ?? "");
        if (note) this.toolProgressNote = { callId, note };
        this.trackFleetProgress(callId, note, event.state, event.ok !== false);
        this.updateLive();
        return;
      }

      case "tool_call_start": {
        this.pulse.feed(PULSE_WEIGHT.callback);
        this.captureProseAsIntent();
        this.currentTool = {
          callId: String(event.callId ?? ""),
          name: String(event.toolName ?? "tool"),
          argsJson: "",
          args: {},
        };
        // Fleet tracking is DELEGATION-only: ordinary tools keep the single
        // `currentTool` slot (and its unpaired-event tolerance); task/worker
        // calls are the ones that genuinely run as a concurrent fleet.
        //
        // Dispatched, not running: the model is still streaming this message
        // and the loop has not started a thing yet. The row says so until the
        // loop's `started` marker arrives.
        if (this.currentTool.name === "task" || this.currentTool.name === "worker") {
          this.fleet.set(this.currentTool.callId, {
            callId: this.currentTool.callId,
            kind: this.currentTool.name,
            argsJson: "",
            brief: this.currentTool.name === "worker" ? "building" : "investigating",
            state: "queued",
            note: "",
            noteAt: 0,
            wantNote: "",
            steps: 0,
          });
        }
        this.activity = runningLabel(this.currentTool.name);
        this.setPhase(phaseForTool(this.currentTool.name, {}));
        return;
      }

      case "tool_call_args_delta": {
        if (this.currentTool && (!event.callId || event.callId === this.currentTool.callId)) {
          this.pulse.feed(String(event.partialJson ?? "").length);
          this.currentTool.argsJson += String(event.partialJson ?? "");
          this.currentTool.args = partialArgs(this.currentTool.argsJson);
          this.activity = liveToolLabel(this.currentTool.name, this.currentTool.args);
          this.setPhase(phaseForTool(this.currentTool.name, this.currentTool.args));
        }
        // A fleet member keeps its OWN argument stream. `currentTool` holds
        // only the newest call, so by the time three scouts are running the
        // first two would have had nothing to be identified by.
        const member = this.fleet.get(String(event.callId ?? ""));
        if (member) {
          member.argsJson += String(event.partialJson ?? "");
          member.brief = fleetBrief(member);
        }
        return;
      }

      case "tool_call_end": {
        this.pulse.feed(PULSE_WEIGHT.callback);
        this.captureProseAsIntent();
        const phase = phaseForTool(String(event.output?.toolName ?? ""), event.args ?? {});
        this.setPhase(phase);
        this.recordTool(event);
        const failedCheck = this.checks.at(-1)?.status === "failed" && phase === "verify";
        // The member's row has just been set down in the transcript in full, so
        // the panel gives up its slot rather than reporting the same call twice.
        this.fleet.delete(String(event.callId ?? ""));
        this.currentTool = null;
        this.lastToolEndAt = Date.now();
        this.activity = null;
        if (failedCheck) this.setPhase("act", "Addressing the failed check");
        else this.updateLive();
        return;
      }

      case "todo_updated": {
        this.flushRoutine();
        this.narratedPlan = true;
        this.todos = Array.isArray(event.items) ? event.items : [];
        const active = this.todos.find((item) => item.status === "in_progress");
        // A closed step carries its receipt -- what the harness saw happen
        // while it was open -- and a step closed on nothing wears the
        // suspected-rung tilde instead of a tick. The head counts them.
        const done = this.todos.filter((item) => item.status === "completed").length;
        const unproven = this.todos.filter(
          (item) => item.status === "completed" && !!item.unproven,
        ).length;
        const plan = F.checklist(
          "plan",
          this.todos.map((item) => ({
            status:
              item.status === "completed"
                ? item.unproven
                  ? ("unproven" as const)
                  : ("ok" as const)
                : item.status === "in_progress"
                  ? ("active" as const)
                  : ("none" as const),
            label: item.content,
            metric:
              item.status === "completed" ? stepReceipt(item as SpineTodo) || undefined : undefined,
            metricTone: item.unproven ? ("fail" as const) : ("muted" as const),
          })),
          {
            tone: "muted",
            ...(unproven > 0
              ? {
                  receipt: `${done}/${this.todos.length} ${glyph("observed")} ${unproven} unproven`,
                }
              : {}),
          },
        ).join("\n");
        this.addLog(plan);
        // The shape of the work is committed ONCE, when it is first known --
        // that is the part a reader needs in scrollback, and it is the moment
        // they can still object to it. Every later revision is a tick moving,
        // and a tick moving does not justify reprinting all seven steps: four
        // updates cost twenty-eight rows to convey three state changes. The
        // live rung carries the current step and the ratio while the work runs,
        // and finish() sets down the final state beside the evidence.
        if (this.committedPlan === null) {
          this.committedPlan = plan;
          this.commitTimeline(plan);
        }
        this.latestPlan = plan;
        if (this.editedFiles.size === 0)
          this.setPhase("plan", active?.content ?? "Planning the work");
        else if (active) this.intent = active.content;
        this.updateLive();
        return;
      }

      case "replanning": {
        this.flushRoutine();
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.setPhase("plan", "Adjusting the approach from evidence");
        return;
      }

      case "handoff": {
        // The honest ending for an unfinished run: the state-of-work block.
        this.flushRoutine();
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.addLog(block);
          this.commitTimeline(block);
        }
        return;
      }

      case "step_check": {
        // The harness ran the compile check at a step boundary. It reads like
        // any other check the turn produced: a mark, the command, the verdict.
        this.flushRoutine();
        const report = String(event.report ?? "");
        const command = oneLine(
          (report.split("\n").find((line) => line.startsWith("$ ")) ?? "")
            .replace(/^\$ /, "")
            .replace(/\s+\((ok|exit \d+)\)$/, "") || "project check",
          48,
        );
        const passed = event.passed === true;
        this.checks.push({
          label: command,
          detail: passed ? "passed" : oneLine(lastNonEmpty(report), 56),
          status: passed ? "passed" : "failed",
          count: 1,
        });
        const row =
          `  ${passed ? ok(glyph("verified")) : danger(glyph("failure"))} ` +
          muted(`step check ${glyph("observed")} ${command} ${passed ? "ok" : "failed"}`) +
          (passed ? "" : ` ${faint(oneLine(lastNonEmpty(report), 60))}`);
        this.addLog(row);
        this.commitTimeline(row);
        if (!passed) {
          this.failures++;
          this.setPhase("act", "Fixing what the step check found");
        }
        return;
      }

      case "verification_started":
        this.captureProseAsIntent();
        this.flushRoutine();
        this.currentTool = null;
        // Loop invariant: verification only starts once the turn's tool batch
        // is fully done -- anything still marked pending is a stale leftover.
        this.fleet.clear();
        this.activity = null;
        this.verificationRunning = true;
        this.setPhase("verify", "Running the project checks");
        return;

      case "verification_completed": {
        this.flushRoutine();
        this.verificationRunning = false;
        const report = String(event.report ?? "");
        const commandCount = Math.max(1, (report.match(/^\$ /gm) ?? []).length);
        const command = oneLine(
          report
            .split("\n")
            .find((line) => line.startsWith("$ "))
            ?.replace(/^\$ /, "")
            .replace(/\s+\(ok\)$/, "") ?? "project checks",
          62,
        );
        this.checks.push({
          label: command || "project checks",
          detail: event.ran
            ? event.passed
              ? "passed"
              : oneLine(lastNonEmpty(report), 56)
            : "not run",
          status: !event.ran ? "not-run" : event.passed ? "passed" : "failed",
          count: event.ran ? commandCount : 0,
        });
        const verification = `  ${event.passed && event.ran ? ok(glyph("verified")) : event.ran ? danger(glyph("failure")) : faint("o")} ${muted(
          event.ran
            ? oneLine(report, 100)
            : oneLine(report, 100) || "No project checks were detected",
        )}`;
        this.addLog(verification);
        this.commitTimeline(verification);
        if (event.ran && !event.passed) {
          this.failures++;
          this.setPhase("act", "Fixing what the checks found");
        } else {
          this.setPhase(
            "verify",
            event.ran ? "Project checks passed" : "No automatic checks detected",
          );
        }
        return;
      }

      case "usage": {
        // Authoritative provider counts: drive the "down tokens" meta and the
        // live context percentage without a transcript line.
        this.pulse.feed(Number(event.outputTokens ?? 0) * 4);
        this.downTokens += Number(event.outputTokens ?? 0);
        if (event.context && Number(event.context.percent) > 0) {
          this.contextPercent = Number(event.context.percent);
        }
        this.updateLive();
        return;
      }

      case "checkpoint_saved": {
        // Feeds the task metadata + end-of-turn summary strip; never printed
        // inline (a checkpoint per write would be noise).
        this.checkpoint = {
          runId: String(event.runId ?? ""),
          version: Number(event.version ?? 0),
        };
        this.turnCount = Math.max(this.turnCount, Number(event.turnCount ?? 0));
        this.updateLive();
        return;
      }

      // A provider retry, visible for as long as it runs. The gateway used to
      // back off and re-stream in silence, which understated both how long the
      // turn took and how reliable the run was -- and left the rung looking
      // wedged for the length of the backoff with nothing to explain it.
      case "retry": {
        this.pulse.feed(PULSE_WEIGHT.callback);
        this.retrying = {
          attempt: Math.max(1, Number(event.attempt ?? 1)),
          of: Math.max(1, Number(event.of ?? 1)),
        };
        this.updateLive();
        return;
      }

      case "fallback": {
        this.pulse.feed(PULSE_WEIGHT.callback);
        // Switching provider ends this provider's retry ladder.
        this.retrying = null;
        this.reroutes++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "compaction": {
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "notice":
      case "context_warning": {
        const message = String(event.message ?? "");
        if (/verifying changes/i.test(message)) {
          this.verificationRunning = true;
          this.setPhase("verify", "Running the project checks");
          return;
        }
        if (/verification failed|no execution evidence/i.test(message)) {
          this.captureProseAsIntent();
          this.setPhase("act", "Strengthening the result with real evidence");
        }
        if (/replanning/i.test(message)) this.setPhase("plan", "Adjusting the approach");
        if (/unavailable.*Switching to/s.test(message)) this.reroutes++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      case "error": {
        this.captureProseAsIntent();
        this.flushRoutine();
        this.currentTool = null;
        this.activity = null;
        this.errored = true;
        this.hardError = true;
        this.failures++;
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.addLog(block);
          this.commitErrorOnce(block);
        }
        this.updateLive();
        return;
      }

      case "turn_complete":
        this.turnCount = Math.max(this.turnCount, Number(event.totalTurns ?? 0));
        this.fleet.clear();
        this.retrying = null;
        // A run that hit a ceiling is NOT a finished run -- remember why so
        // the closing row can say so. Before this, `stopReason` was read by
        // nothing: an 80-turn cap death rendered identically to success.
        if (
          event.stopReason === "max_turns" ||
          event.stopReason === "max_tokens" ||
          event.stopReason === "halted"
        ) {
          this.stoppedEarly = event.stopReason;
        }
        return;

      // Research runs stream through the same renderer as a turn (the report
      // IS the answer), so their events are named here and rendered through
      // the shared formatter rather than falling into a default.
      case "research_plan":
      case "research_step_start":
      case "research_source":
      case "research_step_done":
      case "research_synthesizing":
      case "research_report_delta":
      case "research_complete": {
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
        return;
      }

      default:
        // Compile-time exhaustiveness: a new union member is a type error here
        // until it is named above. At runtime an event from a NEWER host is
        // ignored rather than thrown (additive-minor contract).
        assertNeverSoft(event, undefined);
    }
  }

  onError(error: unknown): void {
    this.errored = true;
    this.hardError = true;
    this.failures++;
    this.captureProseAsIntent();
    this.flushRoutine();
    const block = formatError(error instanceof Error ? error.message : String(error));
    this.addLog(block);
    this.commitErrorOnce(block);
  }

  /** Why the run ended before finishing — a ceiling, or a safety halt. */
  private stoppedEarly: "max_turns" | "max_tokens" | "halted" | null = null;

  /** Last live repaint driven by streaming prose (throttled to ~80ms). */
  private lastProseLiveAt = 0;

  /** Latest heartbeat from a long tool call (sub-agent/worker), rung-only. */
  private toolProgressNote: { callId: string; note: string } | null = null;

  /**
   * A turn that worked says so by showing what it changed, not by announcing
   * that it finished -- so this row exists only when the ending itself is the
   * news: interrupted, ended on a failure nothing repaired, or stopped at a
   * ceiling with the task unfinished.
   */
  private completionBlock(aborted: boolean): string | null {
    const latestCheck = [...this.checks].reverse().find((check) => check.status !== "not-run");
    const repaired = this.failures > 0 && latestCheck?.status === "passed";
    const failed = this.hardError && !repaired;
    if (!aborted && !failed && this.stoppedEarly) {
      // Honest ceiling row: the run stopped because it ran OUT, not because
      // it was done. Silence here read as success and cost real trust.
      const label =
        this.stoppedEarly === "max_turns"
          ? "ran out of turns -- the task is not finished"
          : this.stoppedEarly === "halted"
            ? "safety halted the run -- the task is not finished"
            : "hit the output limit -- the response is incomplete";
      // A halt is not resumable by nagging: the broker stopped this run because
      // it may no longer be the user's. Saying "send a follow-up to continue"
      // there would be advice to walk straight back into it.
      const nextStep =
        this.stoppedEarly === "halted" ? "check what it read" : "send a follow-up to continue";
      return F.flowRow(
        `${F.MARK}${warn("!")} ${text(label)}`,
        faint(F.receiptOf([...this.workReceipt(), nextStep])),
      );
    }
    if (!aborted && !failed) return null;
    const mark = aborted ? warn("!") : danger(glyph("failure"));
    const label = aborted ? "interrupted" : "stopped on an error";
    const meta = aborted ? [...this.workReceipt(), "partial work kept"] : this.workReceipt();
    return F.flowRow(`${F.MARK}${mark} ${text(label)}`, faint(F.receiptOf(meta)));
  }

  /**
   * What the turn actually did to the tree, as a checklist, plus one faint
   * receipt row. A file the turn deliberately left alone still gets a row and a
   * reason -- work that did not happen is information too.
   */
  private summaryBlock(): string | null {
    const lines: string[] = [];
    const edits = [...this.editedFiles.entries()];
    if (edits.length > 0) {
      lines.push(
        ...F.checklist(
          "changed",
          edits.map(([path, stat]) => ({
            status: "ok" as const,
            label: shortPath(path),
            metric: stat.created ? "new file" : F.editMetric(stat.added, stat.removed) || undefined,
            metricTone: "ok" as const,
          })),
          {
            caption: `${plural(edits.length, "file")}`,
            receipt: `${edits.length}/${edits.length}`,
          },
        ),
      );
    }

    // Checks are evidence, not decoration. The verdict is the *latest* run: a
    // failure the turn went on to repair is history, and reporting it as the
    // outcome would be a lie about the tree you are holding now.
    const ran = this.checks.filter((check) => check.status !== "not-run");
    const latest = ran.at(-1);
    if (latest?.status === "failed") {
      lines.push(
        F.railRow(
          `${danger(glyph("failure"))} ${text(truncate(latest.label, 44))}${latest.detail ? ` ${faint("| " + latest.detail)}` : ""}`,
        ),
      );
    } else if (latest?.status === "passed") {
      const badges = ran
        .filter((check) => check.status === "passed")
        .slice(-3)
        .map((check) => `${ok(glyph("verified"))} ${muted(checkBadge(check))}`);
      lines.push(F.railRow(badges.join("   ")));
    } else if (edits.length > 0) {
      lines.push(F.railRow(`${warn("!")} ${muted("no check was run on this change")}`));
    }

    // One faint receipt: elapsed, what the provider counted, and the checkpoint
    // that makes this turn undoable. Nothing here is estimated.
    const reviewed =
      edits.length === 0
        ? [
            this.reads > 0 ? plural(this.reads, "file") + " reviewed" : "",
            this.searches > 0 ? plural(this.searches, "search", "searches") : "",
            this.webSources > 0 ? plural(this.webSources, "source") : "",
          ].filter(Boolean)
        : [];
    const receipt = [
      ...reviewed,
      ...this.workReceipt(),
      this.reroutes > 0 ? plural(this.reroutes, "model switch", "model switches") : "",
      // Honest wording: /rewind rolls back the CONVERSATION log; it never
      // reads checkpoint snapshots (they're a separate write-only store).
      this.checkpoint ? `/rewind to roll back` : "",
    ].filter(Boolean);
    if (receipt.length > 0 && (edits.length > 0 || this.toolCalls > 0)) {
      lines.push(`${F.BODY}${faint(F.receiptOf(receipt))}`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /** Live context occupancy (0-100) from the last provider report, if any. */
  get liveContextPercent(): number | null {
    return this.contextPercent;
  }

  finish(options: { aborted?: boolean } = {}): void {
    this.currentTool = null;
    this.activity = null;
    this.sink.preview?.(null);

    const answer = this.prose.trim();
    const aborted = options.aborted === true;
    this.flushRoutine();
    // A run that ends mid-streak still owes the reader the count.
    this.flushFailStreak();
    // The plan's final state, once, if it moved since it was set down. This is
    // the row that answers "did it finish what it said it would" -- and it is
    // the only reprint of the checklist the turn is allowed.
    if (this.latestPlan && this.latestPlan !== this.committedPlan) {
      this.committedPlan = this.latestPlan;
      this.commitTimeline(this.latestPlan);
    }
    if (this.worked || this.errored || aborted || this.verificationRunning || this.stoppedEarly) {
      const closing = this.completionBlock(aborted);
      if (closing) this.commitTimeline(closing);
    }
    if (answer) this.sink.commit(responseBlock(answer));
    else if (aborted)
      this.sink.commit(`\n ${warn("!")} ${muted("stopped before a result was ready")}\n`);
    const summary = this.summaryBlock();
    if (summary) this.sink.commit(`\n${summary}\n`);
    this.prose = "";
  }
}

function replaySummary(lines: TranscriptLineView[]): string | null {
  let reads = 0;
  let searches = 0;
  let sources = 0;
  let failures = 0;
  const edits = new Set<string>();
  let checks = 0;
  for (const line of lines) {
    if (line.role !== "tool") continue;
    const name = line.toolName ?? line.text;
    if (name === "read_file" || name === "list_dir") reads++;
    if (name === "grep" || name === "glob" || name === "symbol_search" || name === "lsp")
      searches++;
    if (name === "web_search" || name === "web_fetch") sources++;
    if (name === "edit_file" || name === "write_file" || name === "multi_edit") {
      const path = String(line.args?.path ?? tryJson(line.result ?? "")?.path ?? "");
      if (path) edits.add(path);
    }
    if (
      name === "bash" &&
      isVerificationCommand(String(line.args?.command ?? "")) &&
      !line.isError
    ) {
      checks++;
    }
    if (line.isError) failures++;
  }
  if (reads + searches + sources + edits.size + checks + failures === 0) return null;
  const metrics: string[] = [];
  if (edits.size > 0) metrics.push(plural(edits.size, "file") + " changed");
  if (checks > 0) metrics.push(plural(checks, "check") + " passed");
  if (edits.size === 0 && reads > 0) metrics.push(plural(reads, "file") + " reviewed");
  if (searches > 0) metrics.push(plural(searches, "search", "searches"));
  if (sources > 0) metrics.push(plural(sources, "source"));
  if (failures > 0) metrics.push(plural(failures, "failure"));
  // A replay's receipt is a receipt, not a verdict: it counts what the session
  // did and says nothing about whether that was the right thing.
  return `${F.BODY}${faint(F.receiptOf(metrics))}`;
}

/** Replayed sessions preserve the same inspectable chronology as a live turn. */
export function renderReplay(lines: TranscriptLineView[]): string {
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.role === "user") {
      output.push(userBlock(line.text));
      index++;
      const turn: TranscriptLineView[] = [];
      while (index < lines.length && lines[index]!.role !== "user") turn.push(lines[index++]!);
      if (turn.length) output.push(renderTranscript(turn));
      const summary = replaySummary(turn);
      if (summary) output.push("", summary);
      continue;
    }
    if (line.role === "note") output.push(`  ${faint(`-- ${line.text} --`)}`);
    index++;
  }
  return output.join("\n");
}
