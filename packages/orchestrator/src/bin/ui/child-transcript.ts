// ─── A sub-agent's transcript ───
//
// What opens when you press enter on an agent. It existed before this as three
// cases in turn.ts: a child's prose, its thinking, and -- for every tool it
// ran -- the one word `read`. No path, no command, no result, no failure. A
// person who opened a sub-agent to see what it was doing was shown that it was
// doing something.
//
// The rule this module holds to is that a sub-agent's transcript is A
// TRANSCRIPT: the same rows, from the same renderers, that the lead's own
// transcript is made of. A call is the box `renderToolActivity` draws for the
// lead; prose is `stepBlock`; a provider reroute, a re-plan, a handoff are the
// rows `formatEvent` gives them. Nothing here invents a row. A pane that spoke
// a second dialect for a smaller agent would be the fifth dialect the grammar
// law exists to prevent (tests/unit/orchestrator/ui-grammar.test.ts), and the
// one thing a sub-agent's transcript must be is recognisable as a transcript.
//
// Two producers write through here and they must agree:
//
//   ChildTranscript   a RUNNING child, one event at a time. A call's row lands
//                     the moment it opens, names its target as the arguments
//                     arrive, and becomes its result in place when it returns.
//   fillFromRecord    a FINISHED child, read back from the session log
//                     (delegation-replay.ts) -- including one from a session
//                     that was closed and reopened.

import type { AgentTurnEvent } from "@rune/protocol";
import { verificationOutcome } from "@rune/protocol";
import type { DelegationEntry } from "../../delegation-replay";
import { renderToolActivity, stepBlock, targetOf, verbOf } from "./activity";
import { formatEvent } from "./events";
import * as F from "./flow";
import { glyph } from "./glyphs";
import { truncate, wrap } from "./render";
import { faint, muted, text, warn } from "./theme";

/**
 * How many rendered rows one child's transcript keeps in memory.
 *
 * A live pane is a window on a run. Past this the oldest rows leave, and the
 * transcript says how many did (`ChildLog.trimmed`) rather than pretending its
 * first row is where the run began. The whole run is still in the session log,
 * which is where a finished child is read back from.
 */
export const CHILD_LOG_ROWS = 2000;

/** Trim to this, so a transcript at its ceiling is not re-laid on every row. */
const TRIM_TO_ROWS = Math.floor(CHILD_LOG_ROWS * 0.9);

interface Block {
  /** Set on a block something will replace: an open paragraph, a call in flight. */
  key: string | null;
  rows: string[];
  /** A block with a body -- prose, a box -- gets air on both sides. A one-row
   *  call does not: a run of them reads as a list. */
  body: boolean;
}

/**
 * One child's rows, as blocks.
 *
 * Blocks rather than a flat list because two things in a transcript change
 * after they are written: a paragraph grows as it streams, and a call's row
 * becomes its result. Both are "replace this block", and neither is "replace
 * the last N rows" -- a child runs calls in parallel, so the row that needs
 * replacing is routinely not the last one.
 *
 * `lines` is the flat view and it is the SAME ARRAY for the life of the log. A
 * pane holds it by reference, so a transcript opened mid-run keeps filling as
 * the child reports instead of freezing at the moment you looked.
 */
export class ChildLog {
  readonly lines: string[] = [];
  private blocks: Block[] = [];
  /** The flat row each block starts on, its separator included. */
  private starts: number[] = [];
  /** Rows that left off the front to hold the ceiling. */
  trimmed = 0;
  /** Counts every change. A painter compares it to learn whether to repaint. */
  revision = 0;

  get empty(): boolean {
    return this.blocks.length === 0;
  }

  has(key: string): boolean {
    return this.find(key) >= 0;
  }

  push(rows: string[], opts: { key?: string; body?: boolean } = {}): void {
    if (rows.length === 0) return;
    this.blocks.push({ key: opts.key ?? null, rows, body: opts.body ?? rows.length > 1 });
    this.lay(this.blocks.length - 1, this.lines.length);
  }

  /** Put a block FIRST. What a child was asked belongs above everything it
   *  did, and it is sometimes learned after the child has already started. */
  prepend(rows: string[], opts: { key?: string; body?: boolean } = {}): void {
    if (rows.length === 0) return;
    this.blocks.unshift({ key: opts.key ?? null, rows, body: opts.body ?? rows.length > 1 });
    this.lay(0, 0);
  }

  /** Replace the block holding `key`, or append one when nothing holds it. An
   *  empty replacement removes the block. */
  set(key: string, rows: string[], opts: { body?: boolean } = {}): void {
    const at = this.find(key);
    if (at < 0) {
      this.push(rows, { key, ...opts });
      return;
    }
    const start = this.starts[at]!;
    if (rows.length === 0) this.blocks.splice(at, 1);
    else this.blocks[at] = { key, rows, body: opts.body ?? rows.length > 1 };
    this.lay(at, start);
  }

  drop(key: string): void {
    this.set(key, []);
  }

  clear(): void {
    this.blocks = [];
    this.starts = [];
    this.lines.length = 0;
    this.trimmed = 0;
    this.revision++;
  }

  /** Newest first: what gets replaced is almost always near the tail. */
  private find(key: string): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      if (this.blocks[i]!.key === key) return i;
    }
    return -1;
  }

  /**
   * Set the flat rows down again from block `from`, which starts on `start`.
   *
   * One blank row stands between two blocks when either has a body. Decided
   * here, at layout, and not carried inside a block's own rows: whether a block
   * has a body changes when a call's one row becomes its box, and a separator
   * baked into the rows would be wrong on both sides of that change.
   */
  private lay(from: number, start: number): void {
    this.flatten(from, start);
    this.revision++;
    if (this.lines.length > CHILD_LOG_ROWS) this.trim();
  }

  private flatten(from: number, start: number): void {
    this.lines.length = start;
    this.starts.length = from;
    for (let i = from; i < this.blocks.length; i++) {
      const block = this.blocks[i]!;
      const prior = this.blocks[i - 1];
      this.starts.push(this.lines.length);
      // Air on both sides of a body -- and above the FIRST block when it is
      // one, so a transcript that opens on the brief's band does not open
      // with the band touching the pane's header rule.
      if (prior ? prior.body || block.body : block.body) this.lines.push("");
      for (const row of block.rows) this.lines.push(row);
    }
  }

  /**
   * Whole blocks leave from the front until the rest fits, and the transcript
   * says so in its first row.
   *
   * Never the last block: that is the one being written. The note is a block
   * like any other, re-made with the running count each time -- a transcript
   * whose first row is silently the middle of the run is the same lie as a
   * diff that stops without saying it stopped.
   *
   * `trimmed` counts the rows of the blocks that left, and nothing else: the
   * blank rows between blocks are layout, and the note is not part of the run.
   */
  private trim(): void {
    const before = this.lines.length;
    if (this.blocks[0]?.key === TRIMMED) {
      this.blocks.shift();
      this.starts.shift();
    }
    let keep = 1;
    while (keep < this.blocks.length - 1 && before - this.starts[keep]! > TRIM_TO_ROWS) keep++;
    if (this.blocks.length > 1) {
      for (const gone of this.blocks.splice(0, keep)) this.trimmed += gone.rows.length;
    }
    const first = this.blocks[0];
    // One block alone over the ceiling is a single very long paragraph. Its
    // tail is what is being read.
    if (first && first.rows.length > TRIM_TO_ROWS) {
      this.trimmed += first.rows.length - TRIM_TO_ROWS;
      first.rows = first.rows.slice(-TRIM_TO_ROWS);
    }
    this.blocks.unshift({
      key: TRIMMED,
      rows: [
        `${F.BODY}${faint(
          `${glyph("elision")} ${this.trimmed} earlier row${this.trimmed === 1 ? "" : "s"} not kept in this view`,
        )}`,
      ],
      // A body, so the run's first surviving row never sits flush against it.
      body: true,
    });
    this.flatten(0, 0);
  }
}

/** The block that says rows were dropped off the front. */
const TRIMMED = "trimmed";

// ─── Rows ───

/** A rendered block as rows, without the blank rows it was padded with: the
 *  log decides the air between blocks. */
function rowsOf(block: string | string[]): string[] {
  const rows = Array.isArray(block) ? [...block] : block.split("\n");
  while (rows.length > 0 && rows[0]!.trim() === "") rows.shift();
  while (rows.length > 0 && rows[rows.length - 1]!.trim() === "") rows.pop();
  return rows;
}

/** How much of a brief stands at the top of a transcript before it folds. */
const BRIEF_ROWS = 10;

/**
 * What the child was asked, on the same band the lead's transcript puts a
 * person's words on.
 *
 * In a child's transcript the lead is the one asking, and the grammar is the
 * same either way: a highlighted question, then plain work under it. A
 * delegation's brief is routinely a whole contract, so it is cut to its
 * opening and says how much it cut.
 */
function askedRows(prompt: string): string[] {
  const rows = rowsOf(F.asked(prompt.trim()));
  if (rows.length <= BRIEF_ROWS) return rows;
  const hidden = rows.length - BRIEF_ROWS;
  return [
    ...rows.slice(0, BRIEF_ROWS),
    `${F.BODY}${faint(`${glyph("elision")} ${hidden} more line${hidden === 1 ? "" : "s"} of the brief`)}`,
  ];
}

/** Prose as it STREAMS: wrapped, marked, and not yet parsed as Markdown. A
 *  half-written code fence has no closed form to render. */
function streamingRows(body: string, thinking: boolean): string[] {
  const mark = thinking ? faint(glyph("suspected")) : muted(glyph("live"));
  const paint = thinking ? faint : text;
  return wrap(body.trim(), Math.max(20, F.proseWidth())).map((line, i) =>
    i === 0 ? `${F.MARK}${mark} ${paint(line)}` : `${F.BODY}${paint(line)}`,
  );
}

/** The row a call has while it is in flight: the lead's own provisional row. */
function runningRow(toolName: string, target: string): string {
  return F.toolRow({ name: verbOf(toolName), arg: target, status: "active" });
}

/** What a finished call left, drawn exactly as the lead's transcript draws it. */
function callRows(call: {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  error?: string;
  durationMs?: number;
}): string[] {
  return rowsOf(renderToolActivity(call));
}

/** The head of a call's arguments, as far as they have arrived. */
function headArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Still streaming: read the fields that name a target, and only once a
    // value has closed -- a half-typed path is a worse label than none.
  }
  const out: Record<string, unknown> = {};
  for (const key of ["path", "pattern", "command", "query", "q", "url", "label"]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\\\n]|\\\\.)*)"`).exec(raw);
    if (match?.[1]) out[key] = match[1].replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
  }
  return out;
}

/** Enough of a call's arguments to name its target. The engine forwards no
 *  more than this either (subagent-events CHILD_ARGS_FORWARD_BYTES). */
const ARGS_KEPT = 4 * 1024;

/** Why a child stopped, when it did not simply finish. */
function stopWords(stopReason: string): string {
  switch (stopReason) {
    case "end_turn":
    case "":
      return "";
    case "aborted":
      return "stopped -- interrupted before it finished";
    case "max_turns":
      return "stopped -- out of turns before it finished";
    case "max_tokens":
      return "stopped -- out of output room";
    case "cost_budget":
      return "stopped -- reached its cost ceiling";
    case "time_budget":
      return "stopped -- reached its time ceiling";
    default:
      return `stopped -- ${stopReason.replace(/_/g, " ")}`;
  }
}

// ─── A running child ───

/**
 * One running child's events, written into its log as they arrive.
 *
 * Everything a child's own loop emits is one of the lead's event types, so
 * this is the lead's reducer in miniature -- and every member it draws nothing
 * for is named below rather than defaulted, for the reason every other reducer
 * in the product is: an event added upstream should be a decision here, not an
 * omission.
 */
export class ChildTranscript {
  private stream: { thinking: boolean; text: string; key: string } | null = null;
  private calls = new Map<string, { name: string; json: string; target: string }>();
  private paragraphs = 0;
  /**
   * Every block the message being streamed has written so far.
   *
   * A provider can abandon a message mid-stream and send it again
   * (`stream_reset`), and everything the abandoned one wrote is about to arrive
   * a second time. "The open paragraph and the calls in flight" is not all of
   * it: a paragraph written BEFORE a call in the same message was already
   * closed when that call opened, so it is neither -- and kept, it stood in the
   * transcript twice. So the message's blocks are remembered until the message
   * is known to be whole: its usage has been reported, or its calls have
   * started to answer.
   */
  private message: string[] = [];

  constructor(readonly log: ChildLog) {}

  /** What it was sent to do. Stated once, and first, whenever it is learned. */
  asked(prompt: string): void {
    if (!prompt.trim() || this.log.has("asked")) return;
    this.log.prepend(askedRows(prompt), { key: "asked", body: true });
  }

  absorb(event: AgentTurnEvent): void {
    switch (event.type) {
      case "text_delta":
        this.prose(event.text, false);
        return;
      case "thinking_delta":
        // A child's thinking is visible in its transcript exactly as the lead's
        // is in its own: it is the same kind of evidence, and hiding it for a
        // sub-agent is what made a fan-out feel like a sealed room.
        this.prose(event.text, true);
        return;

      case "stream_reset":
        // The provider abandoned this message and is sending it again. What
        // was written for it is about to arrive a second time.
        for (const key of this.message) this.log.drop(key);
        this.message = [];
        this.stream = null;
        this.calls.clear();
        return;

      case "tool_call_start": {
        this.settle();
        const name = String(event.toolName ?? "tool");
        this.calls.set(event.callId, { name, json: "", target: "" });
        this.message.push(callKey(event.callId));
        this.log.push([runningRow(name, "")], { key: callKey(event.callId), body: false });
        return;
      }

      case "tool_call_args_delta": {
        const call = this.calls.get(event.callId);
        if (!call || call.json.length >= ARGS_KEPT) return;
        call.json += event.partialJson;
        const target = truncate(targetOf(call.name, headArgs(call.json)), 96);
        // Amended when the target CHANGES, which is a few times per call. The
        // arguments arrive a token at a time; the row must not.
        if (!target || target === call.target) return;
        call.target = target;
        this.log.set(callKey(event.callId), [runningRow(call.name, target)], { body: false });
        return;
      }

      case "tool_call_end": {
        this.settle();
        // A call answering means the message that made it arrived whole.
        this.message = [];
        const output = event.output;
        this.calls.delete(event.callId);
        this.log.set(
          callKey(event.callId),
          callRows({
            toolName: output.toolName,
            args: event.args ?? {},
            result: String(output.result ?? ""),
            success: output.success !== false,
            ...(output.error ? { error: output.error } : {}),
            ...(output.durationMs > 0 ? { durationMs: output.durationMs } : {}),
          }),
        );
        return;
      }

      case "retry":
        this.settle();
        this.log.push([
          F.railRow(
            faint(
              F.receiptOf([
                `${glyph("retry")} retrying ${event.attempt} of ${event.of}`,
                event.reason ? truncate(event.reason, 60) : "",
              ]),
            ),
          ),
        ]);
        return;

      case "step_check":
        if (!event.ran) return;
        this.settle();
        this.log.push([
          F.toolRow({
            name: "check",
            arg: truncate(event.step, 60),
            metric: event.passed ? "passed" : "failed",
            status: event.passed ? "pass" : "fail",
          }),
        ]);
        return;

      case "verification_completed": {
        // No verdict, no row: a check that was killed at its deadline is not
        // a failed one, and this row has only the two words.
        const outcome = verificationOutcome(event);
        if (outcome.status === "inconclusive") return;
        const passed = outcome.status === "passed";
        this.settle();
        this.log.push([
          F.toolRow({
            name: "check",
            arg: "verification",
            metric: passed ? "passed" : "failed",
            status: passed ? "pass" : "fail",
          }),
        ]);
        return;
      }

      case "turn_complete": {
        this.close();
        const words = stopWords(String(event.stopReason ?? ""));
        if (words) this.log.push([F.railRow(`${warn("!")} ${muted(words)}`)]);
        return;
      }

      // Rows the lead's transcript already knows how to draw. One reducer, so
      // a reroute reads the same in a child's transcript as in the lead's.
      case "error":
      case "notice":
      case "context_warning":
      case "fallback":
      case "compaction":
      case "replanning":
      case "handoff":
      case "hypothesis":
      case "hypothesis_updated":
      case "decision": {
        const block = formatEvent(event);
        if (!block) return;
        this.settle();
        this.log.push(rowsOf(block));
        return;
      }

      case "usage":
        // The provider's account of a request that has finished: whatever that
        // message wrote is final, and its last paragraph is closed -- the next
        // message opens its own rather than running on from this one. (The
        // tokens themselves are the CARD's.)
        this.settle();
        this.message = [];
        return;

      // ── Named and deliberately not drawn ──
      // Bookkeeping about the child (its checkpoints, its lifecycle
      // projection) is the CARD's, not the transcript's; its plan is on the
      // lead's own surface; a nested heartbeat never crosses at all.
      case "checkpoint_saved":
      case "lifecycle":
      case "todo_updated":
      case "verification_started":
      case "tool_progress":
      case "task_kind":
      case "artifact":
      case "pending_decision":
      case "decision_resolved":
      case "decision_record":
        return;

      default:
        return unreachable(event);
    }
  }

  /**
   * The child has stopped: nothing in its transcript is in flight any more.
   *
   * A call that never got an answer -- the child was interrupted with it
   * outstanding -- loses the mark that says it is running and says instead
   * that nothing came back. Left as it was, a finished agent's last row went on
   * wearing the active mark for as long as the session lasted, which reads as
   * an agent still at work. Safe to call more than once.
   */
  close(): void {
    this.settle();
    this.message = [];
    for (const [callId, call] of this.calls) {
      this.log.set(
        callKey(callId),
        [
          F.toolRow({
            name: verbOf(call.name),
            arg: call.target,
            metric: "no result",
            status: "none",
          }),
        ],
        { body: false },
      );
    }
    this.calls.clear();
  }

  /** Streamed prose, growing in place. */
  private prose(chunk: string, thinking: boolean): void {
    if (!chunk) return;
    if (this.stream && this.stream.thinking !== thinking) this.settle();
    if (!this.stream) {
      this.stream = { thinking, text: "", key: `prose:${++this.paragraphs}` };
      this.message.push(this.stream.key);
    }
    this.stream.text += chunk;
    if (!this.stream.text.trim()) return;
    this.log.set(this.stream.key, streamingRows(this.stream.text, thinking), { body: true });
  }

  /**
   * Close the open paragraph, and set it down as what it IS.
   *
   * While it streams a paragraph is wrapped text. Once it is whole it is
   * Markdown, and it is rendered as the lead's own narration is -- a plan as a
   * list, a path as code -- rather than left as the markup it was typed in.
   */
  private settle(): void {
    const open = this.stream;
    this.stream = null;
    if (!open || open.thinking || !open.text.trim()) return;
    const rows = stepBlock(open.text.trim());
    if (rows.length > 0) this.log.set(open.key, rows, { body: true });
  }
}

const callKey = (callId: string): string => `call:${callId}`;

/** Exhaustive at compile time; an event from a newer host is ignored at
 *  runtime rather than thrown, per the additive-minor contract. */
function unreachable(event: never): void {
  void event;
}

// ─── A finished child, from the record ───

/**
 * Fill a log from a child's stored conversation.
 *
 * The same rows a live transcript ends up holding, from the same renderers --
 * so a child read back tomorrow reads like the child that was watched today.
 * What the record no longer holds, it says: a long tool result cut to its
 * opening carries the checkpoint's own marker, and those pass through verbatim.
 */
export function fillFromRecord(log: ChildLog, entries: readonly DelegationEntry[]): void {
  log.clear();
  for (const entry of entries) {
    switch (entry.kind) {
      case "prompt":
        log.push(askedRows(entry.text), { body: true });
        break;
      case "note":
        // The harness's own lines: part of the record, and not what the child
        // was asked. One quiet row each.
        log.push([
          `${F.BODY}${faint(truncate(entry.text.replace(/\s+/g, " ").trim(), Math.max(20, F.proseWidth())))}`,
        ]);
        break;
      case "text": {
        const rows = stepBlock(entry.text.trim());
        if (rows.length > 0) log.push(rows, { body: true });
        break;
      }
      case "thinking":
        log.push(streamingRows(entry.text, true), { body: true });
        break;
      case "tool":
        if (entry.unanswered) {
          log.push([
            F.toolRow({
              name: verbOf(entry.toolName),
              arg: truncate(targetOf(entry.toolName, entry.args), 96),
              metric: "no result recorded",
              status: "none",
            }),
          ]);
          break;
        }
        log.push(
          callRows({
            toolName: entry.toolName,
            args: entry.args,
            result: entry.result,
            success: !entry.isError,
            ...(entry.isError ? { error: entry.result || "failed" } : {}),
          }),
        );
        break;
    }
  }
}
