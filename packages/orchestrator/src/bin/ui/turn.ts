// ─── TurnRenderer: the Gear customizer's visible activity stream ───
// The reference deliberately shows Plan → Read/Search → Command → Edit/Diff →
// Complete → Answer. Keep private reasoning private, but never hide the actual
// actions or evidence that explain what the agent did.

import { accent, between, bold, faint, muted, ok, stripAnsi, text, warn } from "./theme";
import { truncate, wrap } from "./render";
import * as F from "./flow";
import {
  renderToolActivity,
  renderTranscript,
  runningLabel,
  planBlock,
  stepBlock,
  isVerificationCommand,
  type ToolActivityView,
  type TranscriptLineView,
} from "./activity";
import { formatError, formatEvent, fmtTokens } from "./events";
import { renderMarkdown } from "./markdown";
import { renderUnifiedDiff } from "../diff-render";

export { isVerificationCommand };

/** Column budget for a turn. The flow measure is the single source of truth —
 *  a wide terminal gets whitespace, not a 110-column sentence. */
export function turnWidth(): number {
  return F.measure();
}

export interface TurnSink {
  /** Append a finished block to terminal scrollback. */
  commit(block: string): void;
  /** Replace the small live focus above the composer. */
  preview?(lines: string[] | null): void;
}

export interface TurnRendererOpts {
  model?: string;
  getCost?: () => number;
  /** Retained for API compatibility. Work is now quiet on every surface. */
  streamWork?: boolean;
}

export type WorkPhase = "understand" | "plan" | "act" | "verify";

interface TodoItem {
  content: string;
  status: string;
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

const PHASE_DEFAULT: Record<WorkPhase, string> = {
  understand: "Reading the task and gathering context",
  plan: "Shaping a reliable approach",
  act: "Making the change",
  verify: "Checking the result against real evidence",
};

/** The stable signal glyph used for the current phase. */
export const HEX = "◆";

// ─── The pace of the live rung ───
// Everything below is about *time*, not ink, and all of it exists to answer one
// complaint: watched from outside, the agent looked like it was rushing. It was
// not — the work took exactly as long as it took. What rushed was the reporting.
// A turn can open and close four tool calls in the time it takes to focus on a
// line, and a status line that honours every one of those transitions is not
// informative, it is a strobe. Reading a strobe feels like watching someone who
// is late.

/** The floor on how long one live-rung frame stays up: roughly the time it
 *  takes to read four words. Below this the line stops being language. */
const DWELL_MS = 700;

/** How long a state that says *less* than what is already up must persist
 *  before it may replace it. Quiet frames — `thinking` with nothing under it,
 *  `answering` on the strength of one stray token — are the ones that turn out
 *  not to have been true a moment later, so they are asked to prove themselves.
 *  A frame that names real work is not: making it wait would mean the rung goes
 *  quiet precisely when the agent is busiest. Roughly one tick. */
const SETTLE_MS = 120;

/** How long after a tool ends the agent is still considered mid-burst. Between
 *  one call finishing and the next beginning there is a beat where nothing is in
 *  flight, and taken literally that beat is "thinking" — but a 5ms hole in the
 *  middle of obvious work is an artefact of event granularity, not a state
 *  anyone is in. Left alone it also defeats the settle above, because the
 *  candidate flips away and back and never accumulates the time it needs to
 *  earn the screen: the rung ends up saying "thinking" through half a second of
 *  visible work. Inside this window the rung simply holds. */
const GAP_MS = 300;

/** One breath of the live mark, and the number of steps it is quantised into.
 *  Quantising earns its keep twice: consecutive repaints inside a step are
 *  byte-identical, so the rung is not redrawn on every streamed token, and a
 *  256-colour terminal gets a ramp it can actually represent. */
const BREATH_MS = 2600;
const BREATH_STEPS = 16;

/**
 * Position along the breath, 0.3…1. Eased by a cosine so the mark lingers at
 * each end instead of sweeping evenly past it, and floored well above zero so
 * it never goes dark — a mark that disappears, however briefly, is a mark that
 * blinks, and a blink is the terminal's way of saying something is wrong.
 */
function breathAt(elapsedMs: number): number {
  const step = Math.floor(((elapsedMs % BREATH_MS) / BREATH_MS) * BREATH_STEPS);
  return 0.3 + ((1 - Math.cos((step / BREATH_STEPS) * 2 * Math.PI)) / 2) * 0.7;
}

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
  return "…/" + parts.slice(-3).join("/");
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
      return pattern ? `Searching for “${truncate(pattern, 48)}”` : "Searching the codebase";
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
      return query ? `Researching “${query}”` : "Researching current information";
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
 * What the streaming tool-call arguments say *so far* — but only where they
 * have finished saying it. The closing quote in each pattern is the whole
 * point: matching an unterminated value meant the live rung typed the path out
 * letter by letter (`Reading s` → `Reading src/b` → `Reading …/ui/turn.ts`),
 * reshaping itself on every token as the string grew past what shortPath elides.
 * That stutter is a large part of what made the agent look frantic while it was
 * doing something perfectly ordinary. Waiting for the closing quote costs a few
 * hundred milliseconds of vagueness and buys one clean transition: the generic
 * phrase, then the real target, and nothing in between. When a value is escaped
 * or spans lines no partial match is offered at all — the full parse above will
 * supply it a moment later, and a calm "Running the necessary command" is a
 * better placeholder than a half-typed one.
 */
function partialArgs(raw: string): Record<string, unknown> {
  const parsed = tryJson(raw);
  if (parsed) return parsed;
  const result: Record<string, unknown> = {};
  for (const key of ["path", "pattern", "command", "query", "q"]) {
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
 * What you asked, at the left margin. No bar, no fill, no receipt — the message
 * is the strongest landmark in scrollback precisely because nothing decorates
 * it, and the turn number is already in the header.
 */
export function userBlock(raw: string, _meta: UserBlockMeta = {}): string {
  return F.asked(raw);
}

export function responseHead(): string {
  return "";
}

const BLOCK_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||(?:-{3,}|\*{3,}|_{3,})$)/;
const HEADLINE_MAX = 200;

/**
 * Split an opening paragraph into the v2 response headline (its first
 * sentence) and the detail that follows. Sentence ends are found outside
 * inline code and after common abbreviations are skipped; a paragraph with no
 * boundary is a headline only when it is short enough to read as one.
 */
export function splitHeadline(paragraph: string): { headline: string; rest: string } | null {
  let inCode = false;
  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i]!;
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (ch !== "." && ch !== "!" && ch !== "?")) continue;
    // A decimal point or dotted version (v0.2.0) is not a sentence end.
    if (ch === "." && /\d/.test(paragraph[i + 1] ?? "")) continue;
    if (/\b(e\.g|i\.e|etc|vs|cf|approx|fig|no)$/i.test(paragraph.slice(0, i))) continue;
    let j = i + 1;
    while (j < paragraph.length && /[)"'*_\]]/.test(paragraph[j]!)) j++;
    const next = paragraph.slice(j);
    if (next.length > 0 && !/^\s+["'(`\[*_A-Z0-9]/.test(next)) continue;
    const headline = paragraph.slice(0, j).trim();
    if (headline.length > HEADLINE_MAX) return null;
    return { headline, rest: next.trim() };
  }
  return paragraph.length <= HEADLINE_MAX ? { headline: paragraph, rest: "" } : null;
}

/**
 * The final answer, in the agent's voice: one dot, then the sentence that
 * actually answers the question, then the detail. Authored Markdown structure
 * (headings, lists, code) is preserved — only a plain opening paragraph is
 * promoted to the dot, because that is the line the reader came for.
 */
export function responseBlock(markdown: string): string {
  const width = F.proseWidth();
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
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
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
 * `typecheck clean`, `lint clean`, `build ok` — or the command itself. */
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
  private narratedPlan = false;
  private verificationRunning = false;
  private readonly startedAt = Date.now();
  /** The live rung's current frame and when it went up — see steadyFrame. */
  private frame: { label: string; detail: string } = { label: "thinking", detail: "" };
  private frameAt = 0;
  /** The state the rung is *trying* to move to, and when it first appeared. */
  private want: { label: string; detail: string } = { label: "thinking", detail: "" };
  private wantSince = 0;
  /** When the last tool call ended — the near side of a possible burst gap. */
  private lastToolEndAt = 0;
  /** The last rung actually pushed to the sink, so an event that changes
   *  nothing visible does not schedule a repaint. */
  private lastLive = "";
  /** Rows in the last committed block — drives the blank-line rhythm. */
  private lastBlockRows = 0;
  // v2 turn metadata: provider-reported download tokens, accumulated thinking
  // wall-clock, live context %, the agent-loop turn number, and the latest
  // durable checkpoint — all fed by structured events, never invented.
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
      `  ${bold(text("Work details"))} ${faint(`· ${plural(this.toolCalls, "action")}`)}`,
      ...this.workLog.map((entry) => entry.line),
    ].join("\n");
  }

  get worked(): boolean {
    return this.toolCalls > 0 || this.workLog.length > 0 || this.todos.length > 0;
  }

  /**
   * The live rung above the composer: the same dot the agent speaks with, and an
   * honest receipt beside it. One row, plus a faint second row naming what is
   * actually in flight — never a fake progress bar, because the agent does not
   * know how far along it is either.
   *
   * The mark breathes between the secondary grey and the agent's own identity
   * colour. It used to alternate hard between `accent` and `faint` every 400ms,
   * which was wrong twice over: a hard alternation is a blink, and `accent` is
   * the colour this palette reserves for errors — so the calmest moment of a
   * turn, waiting, was rendered in the vocabulary of a fault. Breathing in the
   * identity colour says the opposite, and says it about the right subject:
   * this is the agent, still here.
   *
   * Nothing here slows the work down. Only the reporting is paced — the elapsed
   * receipt beside the mark is the honest clock, and it never waits.
   */
  liveLines(): string[] {
    const { label, detail } = this.steadyFrame();
    const mark = between("muted", "info", breathAt(Date.now() - this.startedAt))("●");
    const lines = [`  ${mark} ${muted(label)}  ${faint(this.receipt().join(" · "))}`];
    if (detail) lines.push(`${F.BODY}${faint(truncate(detail, F.proseWidth()))}`);
    lines.push(...this.streamingProseTail());
    return lines;
  }

  /**
   * The last few lines of the answer AS IT STREAMS — the agent's voice, live.
   * The rung says "answering"; these lines say WHAT. This is the single change
   * that separates "a spinner ran for 40 seconds and a wall of text appeared"
   * from watching an engineer talk while they work: mid-turn narration
   * ("Found it: …") is visible the moment it is written, not retroactively.
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
    if (clipped) lines[0] = "…" + lines[0].slice(1);
    return lines.map((l) => `${F.BODY}${text(l)}`);
  }

  /** True in the beat between one tool call ending and the next beginning —
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
    if (this.currentTool) return "working";
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
   * what is up — `thinking` with nothing under it — to still be true a moment
   * later before it takes the screen; a candidate that names real work goes up
   * as soon as the dwell allows, because making it wait would leave the rung
   * silent exactly while the agent is busiest.
   *
   * Label and detail move as one pair rather than independently, because
   * releasing them separately would put `answering` above a stale tool target —
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
    // information, so do not evaluate a transition at all — hold what is up.
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
    if (this.currentTool) {
      const base = liveToolLabel(this.currentTool.name, this.currentTool.args);
      // A long call's own heartbeat (worker: "edit_file src/x.ts") rides
      // beside its label. The callId guard self-cleans on the next call.
      if (this.toolProgressNote?.callId === this.currentTool.callId) {
        return `${base} · ${this.toolProgressNote.note}`;
      }
      return base;
    }
    const active = this.todos.find((item) => item.status === "in_progress");
    if (active) {
      const done = this.todos.filter((item) => item.status === "completed").length;
      return `${active.content} · ${done}/${this.todos.length} steps`;
    }
    // While the answer streams the intent is stale context — stay quiet.
    if (this.prose.trim()) return "";
    if (this.intent && this.intent !== PHASE_DEFAULT.understand) return this.intent;
    return "";
  }

  /** Elapsed · provider-reported ↓ tokens · reasoning wall-clock — never invented. */
  private receipt(): string[] {
    const parts = [duration(this.startedAt)];
    if (this.downTokens > 0) parts.push(`↓ ${fmtTokens(this.downTokens)} tokens`);
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
   * a run of one-line calls stays tight, and anything with a body — a diff, an
   * output rail, a call with a note — gets air on both sides. Blank-lining every
   * row would double the cost of a thirty-file read for no added meaning.
   */
  private commitTimeline(block: string): void {
    if (!stripAnsi(block).trim()) return;
    const rows = block.split("\n").filter((row) => stripAnsi(row).trim()).length;
    const tight = rows === 1 && this.lastBlockRows === 1;
    this.lastBlockRows = rows;
    this.sink.commit(tight ? block : `\n${block}`);
  }

  /** Retained as the ordering hook the event handlers already call: work is
   *  committed as it lands, so there is nothing left to flush. */
  private flushRoutine(): void {
    if (this.routineQueue.length === 0) return;
    for (const view of this.routineQueue.splice(0)) this.commitTimeline(renderToolActivity(view));
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
    if (!success) {
      this.commitErrorOnce(rendered);
    } else {
      this.commitTimeline(rendered);
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
            : [...all.slice(0, 42), `… ${all.length - 54} lines omitted …`, ...all.slice(-12)];
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
    const key = oneLine(stripAnsi(block), 180);
    if (!key || this.committedErrors.has(key)) return;
    this.committedErrors.add(key);
    this.commitTimeline(block);
  }

  onEvent(event: any): void {
    switch (event.type) {
      case "thinking_delta": {
        // Reasoning remains private. The UI communicates intent and evidence
        // instead — but the time SPENT reasoning is honest turn metadata
        // ("thought for 2.3s"), so accumulate wall-clock across delta bursts.
        const now = Date.now();
        if (this.lastThinkingAt > 0 && now - this.lastThinkingAt < 3000) {
          this.thinkingMs += now - this.lastThinkingAt;
        }
        this.lastThinkingAt = now;
        return;
      }

      case "text_delta": {
        this.activity = null;
        this.prose += event.text;
        // The voice streams LIVE (see streamingProseTail) — but a repaint per
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
        this.prose = "";
        this.currentTool = null;
        this.activity = null;
        this.updateLive();
        return;

      case "tool_progress":
        // Sub-agent/worker heartbeat: shown on the rung, never committed.
        this.toolProgressNote = { callId: event.callId, note: String(event.note ?? "") };
        this.updateLive();
        return;

      case "tool_call_start": {
        this.captureProseAsIntent();
        this.currentTool = {
          callId: String(event.callId ?? ""),
          name: String(event.toolName ?? "tool"),
          argsJson: "",
          args: {},
        };
        this.activity = runningLabel(this.currentTool.name);
        this.setPhase(phaseForTool(this.currentTool.name, {}));
        return;
      }

      case "tool_call_args_delta":
        if (this.currentTool && (!event.callId || event.callId === this.currentTool.callId)) {
          this.currentTool.argsJson += String(event.partialJson ?? "");
          this.currentTool.args = partialArgs(this.currentTool.argsJson);
          this.activity = liveToolLabel(this.currentTool.name, this.currentTool.args);
          this.setPhase(phaseForTool(this.currentTool.name, this.currentTool.args));
        }
        return;

      case "tool_call_end": {
        this.captureProseAsIntent();
        const phase = phaseForTool(String(event.output?.toolName ?? ""), event.args ?? {});
        this.setPhase(phase);
        this.recordTool(event);
        const failedCheck = this.checks.at(-1)?.status === "failed" && phase === "verify";
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
        const plan = F.checklist(
          "plan",
          this.todos.map((item) => ({
            status:
              item.status === "completed"
                ? ("ok" as const)
                : item.status === "in_progress"
                  ? ("active" as const)
                  : ("none" as const),
            label: item.content,
          })),
          { tone: "muted" },
        ).join("\n");
        this.addLog(plan);
        this.commitTimeline(plan);
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

      case "verification_started":
        this.captureProseAsIntent();
        this.flushRoutine();
        this.currentTool = null;
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
        const verification = `  ${event.passed && event.ran ? ok("✓") : event.ran ? accent("✕") : faint("○")} ${muted(
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
        // Authoritative provider counts: drive the "↓ tokens" meta and the
        // live context percentage without a transcript line.
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

      case "fallback": {
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
        // A run that hit a ceiling is NOT a finished run — remember why so
        // the closing row can say so. Before this, `stopReason` was read by
        // nothing: an 80-turn cap death rendered identically to success.
        if (event.stopReason === "max_turns" || event.stopReason === "max_tokens") {
          this.stoppedEarly = event.stopReason;
        }
        return;

      default: {
        const block = formatEvent(event, { cost: this.opts.getCost?.() });
        if (block) {
          this.flushRoutine();
          this.addLog(block);
          this.commitTimeline(block);
        }
        this.updateLive();
      }
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

  /** Why the run ended before finishing, when a ceiling ended it. */
  private stoppedEarly: "max_turns" | "max_tokens" | null = null;

  /** Last live repaint driven by streaming prose (throttled to ~80ms). */
  private lastProseLiveAt = 0;

  /** Latest heartbeat from a long tool call (sub-agent/worker), rung-only. */
  private toolProgressNote: { callId: string; note: string } | null = null;

  /**
   * A turn that worked says so by showing what it changed, not by announcing
   * that it finished — so this row exists only when the ending itself is the
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
          ? "ran out of turns — the task is not finished"
          : "hit the output limit — the response is incomplete";
      const meta = [...this.receipt(), "send a follow-up to continue"];
      return `  ${warn("■")} ${text(label)}  ${faint(meta.join(" · "))}`;
    }
    if (!aborted && !failed) return null;
    const mark = aborted ? warn("■") : accent("✗");
    const label = aborted ? "interrupted" : "stopped on an error";
    const meta = aborted ? [...this.receipt(), "partial work kept"] : this.receipt();
    return `  ${mark} ${text(label)}  ${faint(meta.join(" · "))}`;
  }

  /**
   * What the turn actually did to the tree, as a checklist, plus one faint
   * receipt row. A file the turn deliberately left alone still gets a row and a
   * reason — work that did not happen is information too.
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
          `${accent("✗")} ${text(truncate(latest.label, 44))}${latest.detail ? ` ${faint("· " + latest.detail)}` : ""}`,
        ),
      );
    } else if (latest?.status === "passed") {
      const badges = ran
        .filter((check) => check.status === "passed")
        .slice(-3)
        .map((check) => `${ok("✓")} ${muted(checkBadge(check))}`);
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
      ...this.receipt(),
      this.reroutes > 0 ? plural(this.reroutes, "model switch", "model switches") : "",
      // Honest wording: /rewind rolls back the CONVERSATION log; it never
      // reads checkpoint snapshots (they're a separate write-only store).
      this.checkpoint ? `/rewind to roll back` : "",
    ].filter(Boolean);
    if (receipt.length > 0 && (edits.length > 0 || this.toolCalls > 0)) {
      lines.push(`${F.BODY}${faint(receipt.join(" · "))}`);
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /** Live context occupancy (0–100) from the last provider report, if any. */
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
    if (this.worked || this.errored || aborted || this.verificationRunning || this.stoppedEarly) {
      const closing = this.completionBlock(aborted);
      if (closing) this.commitTimeline(closing);
    }
    if (answer) this.sink.commit(responseBlock(answer));
    else if (aborted)
      this.sink.commit(`\n ${accent("■")} ${muted("stopped before a result was ready")}\n`);
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
  return `${F.BODY}${faint(metrics.join(" · "))}`;
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
    if (line.role === "note") output.push(`  ${faint(`— ${line.text} —`)}`);
    index++;
  }
  return output.join("\n");
}
