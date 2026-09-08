// ─── The retro: a run's account of itself, in numbers, and what it taught ───
//
// Rune recorded everything and read nothing back. The black box holds every
// failure under a fingerprint, the notebook holds command facts, the spine
// holds every step's evidence — and none of it changed the next run, because
// no organ turned a finished run into a lesson. This is that organ: a
// zero-model-call pass over the run's own session log (the same rows `rune
// audit` reads) that states what happened — outcome, steps by evidence,
// checks, gates, cost — and extracts the few lessons a rule can vouch for.
//
// Precision over recall, like the notebook capture it feeds: a wrong "avoid X
// here" costs turns on every later run; a missed one costs nothing.

import { createHash } from "node:crypto";
import type { SessionEvent } from "@rune/shared";
import type { CallRole } from "@rune/llm-gateway";
import { isGovernanceRole } from "@rune/llm-gateway";
import { isVerificationCommand } from "./brief";
import { categorizeProjectCommand } from "./notebook/capture";
import type { ToolObservation } from "./notebook/capture";
import type { NotebookStore } from "./notebook/store";
import { TaskStateStore } from "./task-state";
import type { HandoffReason, StepLogKind, TaskState } from "./task-state";

/**
 * Prose about the harness rather than the work: the plan ledger, its steps,
 * evidence, resuming, the budget. The transcript diagnosis of 2026-09-05
 * counted 62% of one session's sentences with this pattern; it is a heuristic
 * (the direction is not in doubt, the second decimal is) and it is kept here
 * so the retro, the audit and the eval gate all count the same thing.
 */
export const HARNESS_TALK_RE =
  /\b(open step|unproven|the plan|plan (?:is|was|needs|update|changed|just)|closing .{0,40}step|recording .{0,20}evidence|evidence I|budget|resuming|picking up|continuing (?:from|the)|rewriting the plan|updating the plan)\b/i;

/** The openers weaker models echoed from the task-state block's imperatives. */
export const HARNESS_OPENER_RE = /^\s*(?:picking up|continuing|resuming|plan update)\b/i;

export type EventRow = {
  seq: number;
  event: SessionEvent;
  /** ISO time the row was persisted. Present on rows read from the store;
   *  the silence metric needs it, everything else ignores it. */
  at?: string;
};

/** How a run ended. `finished` is the only clean one; the rest are handoffs. */
export type RunOutcome = "finished" | HandoffReason;

/** One run of the loop, or a whole session's log. */
export type RetroScope = "turn" | "session";

export interface RetroLesson {
  /**
   * check   — a verification command that passed here (beyond the runner
   *           facts the notebook already keeps)
   * pitfall — a command that failed repeatedly with one error and never passed
   * fix     — the same command failing, then passing with different arguments
   * steer   — a tool failure SHAPE with a known remedy, seen twice in one run;
   *           the body is the remedy, never the raw error (TOOL_REMEDIES)
   */
  kind: "check" | "pitfall" | "fix" | "steer";
  /** Notebook dedupe key within the repo scope. */
  title: string;
  /** The advice, ≤ 400 chars — it is injected under the notebook's budget. */
  body: string;
  /** Why the rule believed it, one line. */
  evidence: string;
  /** The exact command the lesson is about (for later contradiction checks). */
  command?: string;
}

export interface RunRetro {
  v: 1;
  at: string;
  outcome: RunOutcome;
  /**
   * What window this retro covers. A `turn` retro is one run of the loop —
   * the engine writes one per turn, so a session holds N of them and none of
   * them is the session. A `session` retro covers a whole log (the backfill
   * path). The scorecard folds N turn retros into one session-shaped sample;
   * without this field it counted a greeting turn as a whole run.
   */
  scope: RetroScope;
  /**
   * The task's goal, clipped — for the scorecard's eye, not for the model.
   * Omitted on turn scope: the goal belongs to the session, and stamping it on
   * every turn is what made a two-word turn read as the whole mission.
   */
  goal?: string;
  /**
   * Steps as a DELTA over the window for the work counters, absolute for the
   * plan's shape:
   *   `done` / `unproven` — how many steps closed (and how many closed without
   *     evidence) inside this window. Summing them across a session's turn
   *     retros reconstructs the session's totals.
   *   `total` / `open` — the plan as it stood when the window closed. Taking
   *     the last turn retro's values gives the session's ending shape.
   * Before this, every turn reported the session's cumulative counts, so a
   * turn that closed one step of eight reported eight done.
   */
  steps: { total: number; done: number; unproven: number; open: number };
  checks: { passed: number; failed: number; lastPassed?: string };
  tools: { calls: number; failed: number; byName: Record<string, number> };
  /** Spine log kinds counted over the run (gate, unproven, dropped, …). */
  gates: Partial<Record<StepLogKind, number>>;
  /** Model completions the run took (assistant messages persisted). */
  completions: number;
  /**
   * `completions.governance` — every model call the run actually made, split
   * by what it was FOR, read from the `cost` rows rather than the transcript.
   *
   * `completions` above counts assistant messages, so it counts the WORK and
   * nothing else: the safety classifier, the compaction summarizer, the intent
   * read and the sub-agent report repair never appear in it. On a metered
   * account that omission is invisible. On a free tier it is the whole story —
   * a free route is priced in requests, not dollars, and 45% of this agent's
   * recorded incidents are the rate limits those uncounted requests caused
   * (measured 2026-09-07 over 3,160 incidents).
   *
   * `fresh` is uncached input tokens, the other half of the same pressure:
   * fewer completions AND fewer fresh tokens per completion is the lane.
   *
   * Absent when the window carried no `cost` rows at all — "not measured",
   * which is not the same fact as zero.
   */
  callsByRole?: {
    /** Every cost row in the window. */
    total: number;
    /** Rows doing the user's work: primary, sub-agents, research. */
    primary: number;
    /** Rows that are Rune's own overhead. THE number this lane moves. */
    governance: number;
    /** Fresh (uncached) input tokens over every row. */
    fresh: number;
    /** Fresh input tokens on the governance rows alone. */
    governanceFresh: number;
    /** Warm share of all input, 0-1, or absent when no input was reported. */
    cacheReadRatio?: number;
  };
  filesWritten: number;
  cost: { usd: number; listUsd: number; inputTokens: number; outputTokens: number };
  durationMs: number;
  lessons: RetroLesson[];
  /**
   * How much of the model's prose was about the harness rather than the work
   * (HARNESS_TALK_RE), and how many messages opened with a step-state echo
   * (HARNESS_OPENER_RE). The transcript diagnosis's first number: 62% on one
   * session. Counted here so the audit, the scorecard and the eval gate all
   * read the same figure.
   */
  talk?: { prose: number; harness: number; openers: number };
  /**
   * Active turn time spent at least 30 s without a new transcript row, under
   * the renderer's contract that a call is a row the moment it starts. The
   * diagnosis's second number: 45% on one session. Absent when the rows
   * carried no clock (an in-memory replay).
   */
  silence?: { activeMs: number; quietMs: number; longestMs: number };
  /** Derived after the fact from a whole session, not written at run end. */
  backfilled?: boolean;
}

// ─── The two transcript measures ───

export interface TalkMeasure {
  prose: number;
  harness: number;
  openers: number;
}

/** Harness talk over a run's rows: every assistant message with words in it,
 *  and how many of those were about the ledger, its steps, evidence, resuming
 *  or the budget. */
export function measureTalk(rows: EventRow[]): TalkMeasure {
  const out: TalkMeasure = { prose: 0, harness: 0, openers: 0 };
  for (const r of rows) {
    if (r.event.type !== "assistant_msg") continue;
    const content = r.event.payload.content;
    const text = typeof content === "string" ? content.trim() : "";
    if (!text) continue;
    out.prose++;
    if (HARNESS_TALK_RE.test(text)) out.harness++;
    if (HARNESS_OPENER_RE.test(text.split("\n")[0] ?? "")) out.openers++;
  }
  return out;
}

export interface SilenceMeasure {
  activeMs: number;
  quietMs: number;
  longestMs: number;
}

/** A stretch this long without a new row is silence the reader notices. */
export const SILENCE_AFTER_MS = 30_000;
/** A gap this long is the user away, not the agent silent, and is excluded. */
export const IDLE_AFTER_MS = 20 * 60_000;

/**
 * Silence over a run's rows, under the renderer's contract: a transcript row
 * lands when the user speaks, when the model's message lands (its prose, and
 * the provisional row of every call it dispatched), when a call's result
 * comes back, and when the plan changes. Everything between consecutive rows
 * inside a turn is measured; a gap of thirty seconds or more counts as quiet
 * and the longest one is kept. Null when the rows carry no clock.
 */
export function measureSilence(rows: EventRow[]): SilenceMeasure | null {
  const stamped = rows.filter((r) => typeof r.at === "string" && !Number.isNaN(Date.parse(r.at!)));
  if (stamped.length === 0) return null;
  const out: SilenceMeasure = { activeMs: 0, quietMs: 0, longestMs: 0 };
  let lastRowAt: number | null = null;
  for (const r of stamped) {
    const type = r.event.type;
    const at = Date.parse(r.at!);
    if (type === "user_msg") {
      lastRowAt = at; // a new turn: the clock starts at its first row
      continue;
    }
    const isRow = type === "assistant_msg" || type === "tool_result" || type === "task_state";
    if (!isRow || lastRowAt === null) continue;
    const gap = at - lastRowAt;
    lastRowAt = at;
    if (gap < 0 || gap >= IDLE_AFTER_MS) continue;
    out.activeMs += gap;
    if (gap >= SILENCE_AFTER_MS) out.quietMs += gap;
    if (gap > out.longestMs) out.longestMs = gap;
  }
  return out;
}

export interface DeriveOptions {
  /** The run was aborted by the user. */
  aborted?: boolean;
  /** The loop threw; the message is not used, only its presence. */
  runError?: string | null;
  /** Only spine log entries at/after this ISO time count — the run's own. */
  sinceAt?: string;
  durationMs?: number;
  /** Set when deriving from a whole session rather than one run. */
  backfilled?: boolean;
  now?: string;
  /**
   * The spine as it stood when this window OPENED. Step counters are reported
   * as a delta against it, so one turn's retro reports the steps that turn
   * closed rather than every step the session ever closed. Omit it (or pass
   * null) for a whole-session window, where the delta is the total.
   */
  priorState?: TaskState | null;
  /** Defaults to `session`; the engine's per-run retro passes `turn`. */
  scope?: RetroScope;
}

// ─── Observations, rebuilt from the log ───
// The engine collects the same shape live; rebuilding it from persisted rows
// means the retro can be derived after the fact for any session, which is
// what lets the scorecard cover history the retro never saw.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function observationsFromRows(rows: EventRow[]): ToolObservation[] {
  const uses = new Map<string, { toolName: string; args: Record<string, unknown> }>();
  const out: ToolObservation[] = [];
  for (const r of rows) {
    const e = r.event;
    if (e.type === "assistant_msg") {
      const list = (
        e.payload as {
          toolUses?: Array<{ callId?: unknown; toolName?: unknown; toolInput?: unknown }>;
        }
      ).toolUses;
      if (!Array.isArray(list)) continue;
      for (const u of list) {
        if (!u || typeof u.callId !== "string" || typeof u.toolName !== "string") continue;
        uses.set(u.callId, {
          toolName: u.toolName,
          args: isRecord(u.toolInput) ? u.toolInput : {},
        });
      }
    } else if (e.type === "tool_result") {
      const p = e.payload as { callId?: unknown; content?: unknown; isError?: unknown };
      const use = typeof p.callId === "string" ? uses.get(p.callId) : undefined;
      if (!use) continue;
      const failed = p.isError === true;
      const content = typeof p.content === "string" ? p.content : "";
      out.push({
        toolName: use.toolName,
        args: use.args,
        success: !failed,
        ...(failed ? { error: content.slice(0, 400) } : {}),
      });
    }
  }
  return out;
}

// ─── The numbers ───

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function bashCommandOf(o: ToolObservation): string | null {
  if (o.toolName !== "bash") return null;
  const c = o.args.command;
  if (typeof c !== "string") return null;
  const cmd = c.trim();
  // Multi-line scripts and monsters are not "a command" a lesson can name.
  if (cmd.length === 0 || cmd.length > 160 || cmd.includes("\n")) return null;
  return cmd;
}

const TERMINATED_RE = /agent loop terminated/i;

/** The seq at which the spine first carried this handoff; -1 when these rows never did. */
function handoffRecordedSeq(rows: EventRow[], at: string): number {
  for (const r of rows) {
    if (r.event.type !== "task_state") continue;
    const state = (r.event.payload as unknown as { state?: { handoff?: { at?: string } } })?.state;
    if (state?.handoff?.at === at) return r.seq;
  }
  return -1;
}

/**
 * How rows ended when the spine's handoff and a termination note disagree.
 * The note wins only when the handoff was recorded in an EARLIER run — before
 * the last user message that precedes the note. evolab7: max_turns at 20:26,
 * "well show me the preview" at 20:27, "agent loop terminated" at 22:08 — the
 * session ended in error. A handoff the dying run itself recorded
 * (provider_lost, error) keeps its reason: it is the more specific record.
 */
export function runEnding(
  rows: EventRow[],
  handoffAt: string | undefined,
): { diedSeq: number; handoffSeq: number; diedWins: boolean } {
  let diedSeq = -1;
  let lastUserBeforeDeath = -1;
  for (const r of rows) {
    if (
      r.event.type === "system_note" &&
      TERMINATED_RE.test(String(r.event.payload?.content ?? ""))
    ) {
      diedSeq = r.seq;
    }
  }
  if (diedSeq >= 0) {
    for (const r of rows) {
      if (r.event.type === "user_msg" && r.seq < diedSeq) lastUserBeforeDeath = r.seq;
    }
  }
  const handoffSeq = handoffAt ? handoffRecordedSeq(rows, handoffAt) : -1;
  const diedWins = diedSeq >= 0 && (handoffSeq < 0 || handoffSeq < lastUserBeforeDeath);
  return { diedSeq, handoffSeq, diedWins };
}

function outcomeOf(state: TaskState | null, rows: EventRow[], opts: DeriveOptions): RunOutcome {
  if (opts.aborted) return "aborted";
  // A handoff older than this run's start (`sinceAt`) was an earlier run's
  // and says nothing about this one; one this run recorded is its own.
  const handoff = state?.handoff;
  const handoffAt = String(handoff?.at ?? "");
  const stale = !!handoff && !!opts.sinceAt && handoffAt < opts.sinceAt;
  const ending = runEnding(rows, handoff && !stale ? handoffAt : undefined);
  const own = !!handoff?.reason && !stale && ending.handoffSeq >= 0 && !ending.diedWins;
  // provider_lost is the loop's own account of the error that follows it.
  if (own && handoff?.reason === "provider_lost") return "provider_lost";
  if (opts.runError) return "error";
  if (own && handoff?.reason) return handoff.reason;
  if (ending.diedWins) return "error";
  return "finished";
}

/**
 * Derive one run's retro from its rows (everything at/after the run's first
 * event). Returns null only when the rows hold nothing a run leaves behind —
 * no completion, no tool call, no spine — so a conversational turn that
 * produced one sentence still gets a (tiny) retro.
 */
export function deriveRunRetro(rows: EventRow[], opts: DeriveOptions = {}): RunRetro | null {
  if (rows.length === 0) return null;
  const observations = observationsFromRows(rows);
  const store = TaskStateStore.fromEvents(rows);
  const state = store?.snapshot() ?? null;
  const completions = rows.filter((r) => r.event.type === "assistant_msg").length;
  if (completions === 0 && observations.length === 0 && !state) return null;

  // Steps over the WINDOW, not over all time. The prior snapshot is the spine
  // as it stood when the window opened; the store rebuilt from these rows is
  // the spine as it stands now. When the window carried no `task_state` event
  // at all, nothing about the plan moved and the prior snapshot IS the ending
  // shape — reporting zeros there is what made real turns look like no-ops.
  const priorStore = opts.priorState ? TaskStateStore.restore(opts.priorState) : null;
  const zero = { done: 0, total: 0, unproven: 0, open: 0 };
  const priorCounts = priorStore?.todoCounts() ?? zero;
  const endCounts = (store ?? priorStore)?.todoCounts() ?? zero;
  const counts = {
    total: endCounts.total,
    open: endCounts.open,
    // Clamped: a plan the model rewrote mid-run can shrink, and a negative
    // "steps done" is a number no scorecard should ever have to explain.
    done: Math.max(0, endCounts.done - priorCounts.done),
    unproven: Math.max(0, endCounts.unproven - priorCounts.unproven),
  };

  let checksPassed = 0;
  let checksFailed = 0;
  let lastPassed: string | undefined;
  const byName: Record<string, number> = {};
  let failed = 0;
  const written = new Set<string>();
  for (const o of observations) {
    byName[o.toolName] = (byName[o.toolName] ?? 0) + 1;
    if (!o.success) failed++;
    const cmd = bashCommandOf(o);
    if (cmd && isVerificationCommand(cmd)) {
      if (o.success) {
        checksPassed++;
        lastPassed = cmd;
      } else checksFailed++;
    }
    if (o.success && WRITE_TOOLS.has(o.toolName) && typeof o.args.path === "string") {
      written.add(o.args.path);
    }
  }

  // Checks the HARNESS ran are on the spine, not in the tool observations: the
  // loop above only sees `bash` commands the MODEL chose to run. The retro
  // therefore reported "checks 0/0" beside a run whose step check had failed on
  // a broken build and then passed on the fix — three real checks, none of them
  // the model's. Model-run checks are already counted above, so only the
  // harness's own are folded in here.
  for (const c of state?.checks ?? []) {
    if (opts.sinceAt && c.at < opts.sinceAt) continue;
    if (c.source !== "harness") continue;
    if (c.passed) {
      checksPassed++;
      lastPassed = c.command;
    } else {
      checksFailed++;
    }
  }

  const gates: Partial<Record<StepLogKind, number>> = {};
  for (const entry of state?.log ?? []) {
    if (opts.sinceAt && entry.at < opts.sinceAt) continue;
    gates[entry.kind] = (gates[entry.kind] ?? 0) + 1;
  }

  const cost = { usd: 0, listUsd: 0, inputTokens: 0, outputTokens: 0 };
  const calls = { total: 0, primary: 0, governance: 0, fresh: 0, governanceFresh: 0 };
  let warmInput = 0;
  let allInput = 0;
  for (const r of rows) {
    if (r.event.type !== "cost") continue;
    const p = r.event.payload;
    cost.usd += Number(p.costUsd ?? 0) || 0;
    cost.listUsd += Number(p.listCostUsd ?? 0) || 0;
    const fresh = Number(p.inputTokens ?? 0) || 0;
    const read = Number(p.cacheReadTokens ?? 0) || 0;
    const written = Number(p.cacheCreationTokens ?? 0) || 0;
    cost.inputTokens += fresh;
    cost.outputTokens += Number(p.outputTokens ?? 0) || 0;
    // A row with no `role` predates P12.1 or came from a caller that did not
    // say. Both are the work — governance is what had to be tagged.
    const governance = isGovernanceRole((p.role ?? "primary") as CallRole);
    calls.total++;
    calls.fresh += fresh;
    if (governance) {
      calls.governance++;
      calls.governanceFresh += fresh;
    } else {
      calls.primary++;
    }
    warmInput += read;
    allInput += fresh + read + written;
  }
  // Sums of list prices carry float dust; the record keeps micro-dollars.
  cost.usd = Math.round(cost.usd * 1e6) / 1e6;
  cost.listUsd = Math.round(cost.listUsd * 1e6) / 1e6;

  const outcome = outcomeOf(state, rows, opts);
  const scope: RetroScope = opts.scope ?? "session";
  const goal = (state?.goal ?? opts.priorState?.goal ?? "").replace(/\s+/g, " ").slice(0, 200);
  const retro: RunRetro = {
    v: 1,
    at: opts.now ?? new Date().toISOString(),
    outcome,
    scope,
    // The goal is the session's, not the turn's.
    ...(scope === "session" ? { goal } : {}),
    steps: { total: counts.total, done: counts.done, unproven: counts.unproven, open: counts.open },
    checks: { passed: checksPassed, failed: checksFailed, ...(lastPassed ? { lastPassed } : {}) },
    tools: { calls: observations.length, failed, byName },
    gates,
    completions,
    filesWritten: written.size,
    cost,
    durationMs: Math.max(0, Math.round(opts.durationMs ?? 0)),
    lessons: retroLessons(observations),
    talk: measureTalk(rows),
    // Absent, not zeroed, when the window held no cost rows: "not measured"
    // and "made no calls" are different facts and the eval gate must not
    // read a missing meter as a perfect score.
    ...(calls.total > 0
      ? {
          callsByRole: {
            ...calls,
            ...(allInput > 0 ? { cacheReadRatio: warmInput / allInput } : {}),
          },
        }
      : {}),
  };
  const silence = measureSilence(rows);
  if (silence) retro.silence = silence;
  // In attest mode the ledger never refuses, so the steer that used to fire
  // on "Plan NOT updated" errors fires on the spine instead: two or more
  // steps closed unproven in one run is the same lesson.
  const unprovenCloses = gates.unproven ?? 0;
  if (
    unprovenCloses >= STEER_THRESHOLD &&
    !retro.lessons.some((l) => l.title === "steer:close-with-evidence")
  ) {
    const remedy = TOOL_REMEDIES.find((r) => r.key === "close-with-evidence");
    if (remedy) {
      retro.lessons.push({
        kind: "steer",
        title: "steer:close-with-evidence",
        body: remedy.body,
        evidence: `${unprovenCloses} steps closed unproven in one run`,
      });
    }
  }
  if (opts.backfilled) retro.backfilled = true;
  return retro;
}

/**
 * Fold a session's turn retros into the one session-shaped retro the scorecard
 * should see.
 *
 * The engine writes a retro per RUN, so a 12-turn session left 12 rows and the
 * scorecard counted 12 "runs" — a two-word greeting weighing exactly as much
 * as an eight-hour build, and every rate computed against an inflated
 * denominator. Folding is what makes a sample a session again.
 *
 * The arithmetic follows the delta contract in `RunRetro.steps`: work counters
 * sum, the plan's ending shape is the last turn's, and the outcome is how the
 * session finished — the last turn's, because that is the one that ended it.
 */
export function foldTurnRetros(retros: RunRetro[], goal?: string): RunRetro | null {
  const parts = retros.filter((r) => r && r.v === 1);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;

  const byName: Record<string, number> = {};
  const gates: Partial<Record<StepLogKind, number>> = {};
  const lessons: RetroLesson[] = [];
  const seenLesson = new Set<string>();
  const folded: RunRetro = {
    v: 1,
    at: last.at,
    // How the session ended is how its last turn ended.
    outcome: last.outcome,
    scope: "session",
    steps: { total: last.steps.total, done: 0, unproven: 0, open: last.steps.open },
    checks: { passed: 0, failed: 0 },
    tools: { calls: 0, failed: 0, byName },
    gates,
    completions: 0,
    filesWritten: 0,
    cost: { usd: 0, listUsd: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: 0,
    lessons,
    talk: { prose: 0, harness: 0, openers: 0 },
  };
  let silence: SilenceMeasure | null = null;
  let calls: RunRetro["callsByRole"] | null = null;
  // Completion-weighted, so a 40-call turn is not averaged against a 1-call one.
  let warmWeighted = 0;
  let warmWeight = 0;

  for (const r of parts) {
    if (r.talk) {
      folded.talk!.prose += r.talk.prose;
      folded.talk!.harness += r.talk.harness;
      folded.talk!.openers += r.talk.openers;
    }
    if (r.silence) {
      silence ??= { activeMs: 0, quietMs: 0, longestMs: 0 };
      silence.activeMs += r.silence.activeMs;
      silence.quietMs += r.silence.quietMs;
      silence.longestMs = Math.max(silence.longestMs, r.silence.longestMs);
    }
    if (r.callsByRole) {
      // Warm share is re-derived from the folded totals below rather than
      // averaged: a mean of ratios over turns of wildly different size is a
      // number that describes no turn.
      calls ??= { total: 0, primary: 0, governance: 0, fresh: 0, governanceFresh: 0 };
      calls.total += r.callsByRole.total;
      calls.primary += r.callsByRole.primary;
      calls.governance += r.callsByRole.governance;
      calls.fresh += r.callsByRole.fresh;
      calls.governanceFresh += r.callsByRole.governanceFresh;
      if (r.callsByRole.cacheReadRatio !== undefined) {
        warmWeighted += r.callsByRole.cacheReadRatio * r.callsByRole.total;
        warmWeight += r.callsByRole.total;
      }
    }
    folded.steps.done += r.steps.done;
    folded.steps.unproven += r.steps.unproven;
    folded.checks.passed += r.checks.passed;
    folded.checks.failed += r.checks.failed;
    if (r.checks.lastPassed) folded.checks.lastPassed = r.checks.lastPassed;
    folded.tools.calls += r.tools.calls;
    folded.tools.failed += r.tools.failed;
    for (const [name, n] of Object.entries(r.tools.byName)) {
      byName[name] = (byName[name] ?? 0) + n;
    }
    for (const [kind, n] of Object.entries(r.gates)) {
      const k = kind as StepLogKind;
      gates[k] = (gates[k] ?? 0) + (n ?? 0);
    }
    folded.completions += r.completions;
    // Turns write disjoint file sets only in the happy case; a file rewritten
    // across two turns is counted twice. The alternative is keeping every path
    // in every retro, which is a bigger record for a number nothing gates on.
    folded.filesWritten += r.filesWritten;
    folded.cost.usd += r.cost.usd;
    folded.cost.listUsd += r.cost.listUsd;
    folded.cost.inputTokens += r.cost.inputTokens;
    folded.cost.outputTokens += r.cost.outputTokens;
    folded.durationMs += r.durationMs;
    for (const l of r.lessons) {
      if (seenLesson.has(l.title)) continue;
      seenLesson.add(l.title);
      lessons.push(l);
    }
  }
  folded.cost.usd = Math.round(folded.cost.usd * 1e6) / 1e6;
  folded.cost.listUsd = Math.round(folded.cost.listUsd * 1e6) / 1e6;
  if (silence) folded.silence = silence;
  if (calls) {
    folded.callsByRole = {
      ...calls,
      ...(warmWeight > 0 ? { cacheReadRatio: warmWeighted / warmWeight } : {}),
    };
  }

  const g = (goal ?? parts.find((r) => r.goal)?.goal ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (g) folded.goal = g;
  if (parts.every((r) => r.backfilled)) folded.backfilled = true;
  return folded;
}

// ─── The lessons ───
// Three rules, each demanding evidence a later run can act on. Anything that
// smells transient (a timeout, a rate limit, a user saying no) is excluded:
// those are the harness's business, or the user's, never the repo's.

const TRANSIENT_RE =
  /timed? ?out|timeout|rate.?limit|\b429\b|econnreset|econnrefused|socket hang up|network is unreachable|temporary failure|killed by signal|\bsigkill\b|\bsigterm\b/i;
const USER_SAID_NO_RE =
  /by the user|user (declined|denied|rejected)|not approved|approval (was )?(denied|declined)|held for approval/i;

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? ""
  );
}

function errorKey(line: string): string {
  return line.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 160);
}

function head(cmd: string): string {
  return (cmd.split(/\s+/)[0] ?? cmd).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24) || "cmd";
}

function hash6(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Runners the notebook's command facts do not already cover. */
const SECONDARY_RUNNER_RE =
  /^(\.\/[\w.-]+|bash|sh|zsh|make|just|tox|poetry|uv|pipenv|bundle|rake|mix|sbt|dotnet|swift|xcodebuild|deno|nx|lerna|mise|ctest|cmake)\b/;

function argDiff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (k === "command") continue;
    if (JSON.stringify(before[k]) === JSON.stringify(v)) continue;
    const shown = typeof v === "string" ? `"${clip(v, 40)}"` : JSON.stringify(v);
    out.push(`${k}: ${shown}`);
  }
  return out.slice(0, 3);
}

// ─── Remedies: the failure shapes a run can be steered away from ───
// The three bash rules above are precise and, measured over 68 retros,
// produced nothing: real runs fail in edit_file and read_file and web_fetch,
// not in one bash command repeated verbatim. Non-bash tools still never
// speak in their own words — a raw error is not advice — but a shape with a
// KNOWN remedy, seen twice in one run, is. The remedy is the lesson.

export interface ToolRemedy {
  /** Dedupe key; the lesson title is `steer:<key>`. */
  key: string;
  tool: RegExp;
  error: RegExp;
  /** The advice, ≤ 400 chars, in the imperative. */
  body: string;
}

export const TOOL_REMEDIES: readonly ToolRemedy[] = [
  {
    key: "edit-old-text",
    tool: /^(?:edit_file|multi_edit|apply_patch)$/,
    error: /old_text not found|could not find (?:the )?old_text|no match for old_text/i,
    body:
      "Before an edit, read the exact current text (read_file or read_many) and paste it verbatim " +
      "as old_text — the file had changed since it was last read, or the quote was from memory.",
  },
  {
    key: "edit-ambiguous",
    tool: /^(?:edit_file|multi_edit|apply_patch)$/,
    error: /matches \d+ times|ambiguous|more than one match/i,
    body:
      "old_text must be unique: include the surrounding lines, or set replace_all when every " +
      "occurrence should change.",
  },
  {
    key: "path-guessed",
    tool: /^(?:read_file|read_many|list_dir|edit_file|multi_edit)$/,
    error: /no such file|ENOENT|does not exist|not found/i,
    body: "Do not guess paths: list_dir or glob first, then read what exists.",
  },
  {
    key: "bash-network",
    tool: /^bash$/,
    error: /sandboxed bash has NO network|network: true/i,
    body:
      "A command that reaches the network needs `network: true` on the bash call; the sandbox " +
      "blocks egress by default and the call would hang until its timeout.",
  },
  {
    key: "ask-user-shape",
    tool: /^ask_user$/,
    error: /each question needs text and 2-6/i,
    body: "ask_user takes questions with text and 2–6 non-empty options; write the options first.",
  },
  {
    key: "fetch-404",
    tool: /^web_fetch$/,
    error: /\b404\b/,
    body: "Search for the page before fetching it; URLs written from memory come back 404.",
  },
  {
    key: "close-with-evidence",
    tool: /^todo_write$/,
    error: /completions? refused|Plan (?:NOT|not) updated|is not closed:/i,
    body: "A step closes only with evidence: run the check or write the file first, then mark it done.",
  },
  // TODO(human): add one remedy for a failure shape you have watched a run
  // repeat — `rune incidents top` lists them. Same fields as above; the
  // tests in tests/unit/orchestrator/retro.test.ts show the contract.
];

/** How many times a shape must recur in one run before it is a lesson. */
const STEER_THRESHOLD = 2;
const STEER_CAP = 3;

export function steerLessons(observations: ToolObservation[]): RetroLesson[] {
  const seen = new Map<string, { remedy: ToolRemedy; tool: string; count: number }>();
  for (const o of observations) {
    if (o.success) continue;
    const line = firstLine(o.error ?? "");
    if (!line || TRANSIENT_RE.test(line) || USER_SAID_NO_RE.test(line)) continue;
    const remedy = TOOL_REMEDIES.find((r) => r.tool.test(o.toolName) && r.error.test(line));
    if (!remedy) continue;
    const hit = seen.get(remedy.key);
    if (hit) hit.count++;
    else seen.set(remedy.key, { remedy, tool: o.toolName, count: 1 });
  }
  return [...seen.values()]
    .filter((h) => h.count >= STEER_THRESHOLD)
    .sort((a, b) => b.count - a.count)
    .slice(0, STEER_CAP)
    .map((h) => ({
      kind: "steer" as const,
      title: `steer:${h.remedy.key}`,
      body: h.remedy.body,
      evidence: `${h.tool} failed this way ${h.count}× in one run`,
    }));
}

export function retroLessons(observations: ToolObservation[]): RetroLesson[] {
  const lessons: RetroLesson[] = [];

  // pitfall — the same command, the same error, twice or more, never a pass
  const failures = new Map<string, { count: number; key: string; line: string }>();
  const passed = new Set<string>();
  // fix — the same command failing, then passing with different arguments
  const failedArgs = new Map<string, Record<string, unknown>>();
  const fixes: RetroLesson[] = [];
  // check — a secondary runner's verification that passed
  let lastCheck: string | undefined;

  for (const o of observations) {
    const cmd = bashCommandOf(o);
    if (!cmd) continue;
    if (o.success) {
      passed.add(cmd);
      const prior = failedArgs.get(cmd);
      if (prior) {
        const diff = argDiff(prior, o.args);
        if (diff.length > 0) {
          fixes.push({
            kind: "fix",
            title: `fix:${head(cmd)}:${hash6(cmd)}`,
            body: `\`${clip(cmd, 80)}\` needs ${diff.join(", ")} here — it failed without.`,
            evidence: `failed, then passed with ${diff.join(", ")} in one run`,
            command: cmd,
          });
        }
        failedArgs.delete(cmd);
      }
      if (
        isVerificationCommand(cmd) &&
        SECONDARY_RUNNER_RE.test(cmd) &&
        !categorizeProjectCommand(cmd)
      ) {
        lastCheck = cmd;
      }
      continue;
    }
    const line = firstLine(o.error ?? "");
    if (!failedArgs.has(cmd)) failedArgs.set(cmd, o.args);
    if (!line || TRANSIENT_RE.test(line) || USER_SAID_NO_RE.test(line)) continue;
    const key = errorKey(line);
    const f = failures.get(cmd);
    if (!f) failures.set(cmd, { count: 1, key, line });
    else if (f.key === key) f.count++;
  }

  for (const [cmd, f] of failures) {
    if (f.count < 2 || passed.has(cmd)) continue;
    lessons.push({
      kind: "pitfall",
      title: `avoid:${head(cmd)}:${hash6(cmd)}`,
      body: `\`${clip(cmd, 80)}\` fails here: ${clip(f.line, 140)}`,
      evidence: `failed ${f.count}× in one run with the same error, never passed`,
      command: cmd,
    });
  }
  lessons.push(...fixes);
  if (lastCheck) {
    lessons.push({
      kind: "check",
      title: "verified-check",
      body: `Verification that passed here: \`${clip(lastCheck, 100)}\``,
      evidence: "passed in this run",
      command: lastCheck,
    });
  }
  lessons.push(...steerLessons(observations));
  return lessons;
}

// ─── Lessons → notebook ───
// Same store, same scope, same budget the model already reads. A pitfall a
// later run contradicts (the command passes as-is) is retired on the spot:
// the notebook must converge on what is true now, not on what once happened.

export function recordLessons(
  store: NotebookStore,
  keys: { repoKey: string; sessionId: string },
  lessons: RetroLesson[],
  observations: ToolObservation[] = [],
  /**
   * The stage a NEW row starts at. Always `candidate` (P7.6): a lesson learned
   * once is stored and not injected. The backfill path — deriving retros for
   * sessions that predate the organ — passes the same thing, and it matters
   * more there: reconstructing a lesson from a log is not the same as having
   * watched it hold, and a backfill that wrote believable lessons would put
   * hundreds of unmeasured claims into the prompt at once.
   */
  stage: "candidate" = "candidate",
): { written: string[]; retired: string[] } {
  const written: string[] = [];
  const retired: string[] = [];
  try {
    const passedNow = new Set<string>();
    for (const o of observations) {
      const cmd = bashCommandOf(o);
      if (cmd && o.success) passedNow.add(cmd);
    }
    for (const e of store.listRepo(keys.repoKey)) {
      if (!e.title.startsWith("avoid:") || e.retired) continue;
      const cmd = e.provenance.note;
      if (cmd && passedNow.has(cmd) && store.retire(e.id)) retired.push(e.id);
    }
    for (const l of lessons) {
      written.push(
        store.upsert({
          kind: l.kind === "check" ? "fact" : "tactic",
          scope: "repo",
          repoKey: keys.repoKey,
          title: l.title,
          body: l.body,
          sessionId: keys.sessionId,
          note: l.command,
          stage,
        }),
      );
    }
  } catch {
    // Learning must never affect the run it learns from.
  }
  return { written, retired };
}

// ─── The scorecard ───
// Per model or per workspace, from retros — the ones runs wrote, and the ones
// derived after the fact for sessions that predate the organ.

export interface RetroSample {
  retro: RunRetro;
  model: string;
  provider?: string | null;
  workspaceRoot: string;
  sessionId: string;
  /**
   * Attribution, from the retro event's envelope (P7.1). Null on every sample
   * derived from a session that predates it — which is most of history, and
   * saying so is the point: a run without these is a run whose configuration
   * cannot be recovered, and it must never be counted into an arm.
   */
  doctrineHash?: string | null;
  configHash?: string | null;
  /** The A/B arm this run belongs to, when it was part of one. */
  arm?: string | null;
}

export interface ScoreRow {
  key: string;
  runs: number;
  finished: number;
  openSteps: number;
  stalled: number;
  errored: number;
  aborted: number;
  /** Runs stopped by the turn ceiling. */
  maxTurns: number;
  /** Runs the supervisor halted. */
  halted: number;
  /** context_exhausted and provider_lost — the residual after the named ones. */
  other: number;
  stepsTotal: number;
  stepsDone: number;
  stepsUnproven: number;
  checksPassed: number;
  checksFailed: number;
  toolCalls: number;
  toolFailed: number;
  /** Gates that refused something: gate + unproven + dropped log lines. */
  gates: number;
  completions: number;
  listUsd: number;
  durationMs: number;
  /** Runs that carried a lesson. */
  lessons: number;
  /** Prose messages, and how many of them were about the harness. */
  proseMsgs: number;
  harnessMsgs: number;
  /** Active turn time, and how much of it passed ≥30 s without a new row. */
  activeMs: number;
  quietMs: number;
}

function emptyRow(key: string): ScoreRow {
  return {
    key,
    runs: 0,
    finished: 0,
    openSteps: 0,
    stalled: 0,
    errored: 0,
    aborted: 0,
    maxTurns: 0,
    halted: 0,
    other: 0,
    stepsTotal: 0,
    stepsDone: 0,
    stepsUnproven: 0,
    checksPassed: 0,
    checksFailed: 0,
    toolCalls: 0,
    toolFailed: 0,
    gates: 0,
    completions: 0,
    listUsd: 0,
    durationMs: 0,
    lessons: 0,
    proseMsgs: 0,
    harnessMsgs: 0,
    activeMs: 0,
    quietMs: 0,
  };
}

export function scorecard(samples: RetroSample[], by: "model" | "workspace"): ScoreRow[] {
  const rows = new Map<string, ScoreRow>();
  for (const s of samples) {
    const key = by === "model" ? s.model || "?" : s.workspaceRoot || "?";
    const row = rows.get(key) ?? emptyRow(key);
    const r = s.retro;
    row.runs++;
    switch (r.outcome) {
      case "finished":
        row.finished++;
        break;
      case "open_steps":
        row.openSteps++;
        break;
      case "stalled":
        row.stalled++;
        break;
      case "error":
        row.errored++;
        break;
      case "aborted":
        row.aborted++;
        break;
      case "max_turns":
        row.maxTurns++;
        break;
      case "halted":
        row.halted++;
        break;
      default:
        row.other++;
    }
    row.stepsTotal += r.steps.total;
    row.stepsDone += r.steps.done;
    row.stepsUnproven += r.steps.unproven;
    row.checksPassed += r.checks.passed;
    row.checksFailed += r.checks.failed;
    row.toolCalls += r.tools.calls;
    row.toolFailed += r.tools.failed;
    row.gates += (r.gates.gate ?? 0) + (r.gates.unproven ?? 0) + (r.gates.dropped ?? 0);
    row.completions += r.completions;
    row.listUsd += r.cost.listUsd;
    row.durationMs += r.durationMs;
    if (r.lessons.length > 0) row.lessons++;
    if (r.talk) {
      row.proseMsgs += r.talk.prose;
      row.harnessMsgs += r.talk.harness;
    }
    if (r.silence) {
      row.activeMs += r.silence.activeMs;
      row.quietMs += r.silence.quietMs;
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

export interface ScoreRates {
  finishedRate: number;
  openStepsRate: number;
  stalledRate: number;
  /** Runs the user stopped by hand. The most common non-clean outcome here. */
  abortedRate: number;
  /** Runs that died rather than finishing. */
  erroredRate: number;
  /** Unproven completions over all completions. */
  unprovenRate: number;
  checkPassRate: number | null;
  toolFailRate: number;
  usdPerRun: number;
  completionsPerRun: number;
  /** Prose about the harness over all prose; null when no prose was counted. */
  harnessTalkRate: number | null;
  /** Quiet time over active time; null when no run carried a clock. */
  silenceRate: number | null;
}

export function scoreRates(row: ScoreRow): ScoreRates {
  const runs = Math.max(1, row.runs);
  const checks = row.checksPassed + row.checksFailed;
  return {
    harnessTalkRate: row.proseMsgs > 0 ? row.harnessMsgs / row.proseMsgs : null,
    silenceRate: row.activeMs > 0 ? row.quietMs / row.activeMs : null,
    finishedRate: row.finished / runs,
    openStepsRate: row.openSteps / runs,
    stalledRate: row.stalled / runs,
    abortedRate: row.aborted / runs,
    erroredRate: row.errored / runs,
    unprovenRate: row.stepsDone > 0 ? row.stepsUnproven / row.stepsDone : 0,
    checkPassRate: checks > 0 ? row.checksPassed / checks : null,
    toolFailRate: row.toolCalls > 0 ? row.toolFailed / row.toolCalls : 0,
    usdPerRun: row.listUsd / runs,
    completionsPerRun: row.completions / runs,
  };
}

// ─── Tuning proposals ───
// Rule-based, printed with their evidence, and now each one names a VARIANT —
// an id in the closed registry (`evolve/variants.ts`) that `rune evolve ab`
// can actually run. Before this the `config` field was prose: a TOML line a
// person retyped by hand, which is why 128 measured runs produced zero
// changes. A proposal is still not an application; it is now a proposal you
// can act on with one command instead of a suggestion.
//
// The rules key on the failure modes that OCCUR. Three of the original four
// keyed on `unproven`, `stalled` and `open_steps` — zero occurrences across
// 601 sessions — while `aborted` (71), `error` (64), `max_turns` (16) and
// `halted` (9) were counted by the scorecard and read by nothing.

export interface TuneProposal {
  key: string;
  signal: string;
  proposal: string;
  /**
   * The variant id to run. `null` where the evidence points at something no
   * variant can express (pinning verification commands is a per-project
   * decision, not a knob in the allowlist) — and saying null is better than
   * inventing a variant to have something to name.
   */
  variant: string | null;
  /** The config line a person would write by hand; kept for the null cases. */
  config: string;
  confidence: "low" | "medium";
}

export function tuneProposals(rows: ScoreRow[], opts: { minRuns?: number } = {}): TuneProposal[] {
  const minRuns = opts.minRuns ?? 5;
  const out: TuneProposal[] = [];
  for (const row of rows) {
    if (row.runs < minRuns) continue;
    const r = scoreRates(row);
    if (row.stepsDone >= 5 && r.unprovenRate >= 0.3) {
      out.push({
        key: row.key,
        signal: `${row.stepsUnproven} of ${row.stepsDone} completed steps had no evidence (${Math.round(r.unprovenRate * 100)}%)`,
        proposal:
          "This model closes steps it did not do. Keep the step check on and route planning-heavy work to a heavier tier.",
        // No variant: the step check is a verify.* gate, which the allowlist
        // deliberately cannot reach, and a tier change is a model choice.
        variant: null,
        config: '[verify] perStep = true · [tiers] heavy = "provider/model"',
        confidence: "medium",
      });
    }
    if (r.stalledRate >= 0.2) {
      out.push({
        key: row.key,
        signal: `${row.stalled} of ${row.runs} runs ended stalled (same results, nothing written)`,
        proposal:
          "The results-side breaker is doing the stopping. Give this model the broad reads up front rather than a longer leash — run the ceiling everywhere instead of a notch below it.",
        variant: "effort_ceiling",
        config: '[llm] effortRouting = "off"',
        confidence: "low",
      });
    }
    if (
      r.checkPassRate !== null &&
      row.checksPassed + row.checksFailed >= 10 &&
      r.checkPassRate < 0.5
    ) {
      out.push({
        key: row.key,
        signal: `${row.checksFailed} of ${row.checksPassed + row.checksFailed} verification commands failed`,
        proposal:
          "Verification fails more than it passes. Pin the checks to the commands that matter, so a flaky default check does not burn the fix loop.",
        // Deliberately unvariantable: which commands verify THIS project is a
        // human judgement, and a loop that could pin its own gates could pin
        // them to something that always passes.
        variant: null,
        config: '[verify] commands = ["<typecheck>", "<test>"]',
        confidence: "medium",
      });
    }
    if (r.openStepsRate >= 0.4 && row.other + row.errored < row.openSteps) {
      out.push({
        key: row.key,
        signal: `${row.openSteps} of ${row.runs} runs ended with planned steps still open`,
        proposal:
          "Runs stop before the plan does. Use sub-agents for the parallel parts and let the open-steps gate keep the resume note.",
        variant: null,
        config: '[subagents] mode = "auto"',
        confidence: "low",
      });
    }

    // ── The failure modes that actually occur ──
    //
    // Across 601 sessions: aborted 71, error 64, max_turns 16, halted 9 —
    // against zero for unproven, stalled and open_steps. The scorecard has
    // always counted these; until now no rule read them, so the tuner was
    // answering questions this system does not ask.

    if (r.abortedRate >= 0.25) {
      out.push({
        key: row.key,
        signal: `${row.aborted} of ${row.runs} runs were aborted by the user (${Math.round(r.abortedRate * 100)}%)`,
        proposal:
          "A quarter of runs are stopped by hand. That is usually the run going somewhere the user did not want, and the cheapest thing to test is whether the situational doctrine arriving up front rather than just in time keeps it on the rails.",
        variant: "doctrine_full",
        config: '[llm] doctrineDelivery = "full"',
        confidence: "low",
      });
    }
    if (r.erroredRate >= 0.2) {
      out.push({
        key: row.key,
        signal: `${row.errored} of ${row.runs} runs ended in an error (${Math.round(r.erroredRate * 100)}%)`,
        proposal:
          "One run in five dies rather than finishing. Before touching the model, measure whether the repository's own learned lessons change the failure rate — that is what the notebook is for and it is off by default.",
        variant: "notebook_on",
        config: "[notebook] enabled = true",
        confidence: "low",
      });
    }
    if (row.maxTurns >= 3 && row.maxTurns / row.runs >= 0.1) {
      out.push({
        key: row.key,
        signal: `${row.maxTurns} of ${row.runs} runs hit the turn ceiling`,
        proposal:
          "Runs are burning the turn budget rather than converging. Running every turn at the reasoning ceiling instead of a notch below it is the arm to measure: if conservative routing latches too late, the turns it saves cost more than they save.",
        variant: "effort_ceiling",
        config: '[llm] effortRouting = "off"',
        confidence: "low",
      });
    }
    if (row.halted >= 2) {
      out.push({
        key: row.key,
        signal: `${row.halted} of ${row.runs} runs were halted by the supervisor`,
        proposal:
          "The supervisor is stopping sessions. This is NOT a tuning question — no variant may touch Auto mode — read `rune audit` for the halt reasons and the false-positive rate in docs/auto-mode.md before changing anything.",
        variant: null,
        config: "(none — the safety layer is outside the allowlist by design)",
        confidence: "medium",
      });
    }
  }
  return out;
}

// ─── The gardener's reading of the black box ───
// Which fingerprints are harness defects a run on Rune's own repository could
// fix, as opposed to the user's commands failing or a provider misbehaving.

export const GARDENER_CLASSES: ReadonlySet<string> = new Set([
  "crash.uncaught_exception",
  "crash.unhandled_rejection",
  "crash.dirty_exit",
  "crash.rust_tool_panic",
  "crash.store_corruption",
  "provider.malformed_tool_json_fatal",
  "provider.empty_completion",
  "context.budget_overflow",
  "tool.mcp_error",
]);

export interface GardenerFingerprint {
  fingerprint: string;
  class: string;
  component: string;
  messageSample: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  versions: string[];
}

export function gardenerCandidates<T extends GardenerFingerprint>(
  rows: T[],
  opts: { min?: number; limit?: number } = {},
): T[] {
  const min = opts.min ?? 3;
  return rows
    .filter((r) => GARDENER_CLASSES.has(r.class) && r.count >= min)
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1))
    .slice(0, opts.limit ?? 5);
}

export interface GardenerSample {
  ts: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

/** Paths a gardener run must leave to a person. */
export const GARDENER_OFF_LIMITS = [
  "packages/orchestrator/src/prompts.ts",
  "packages/orchestrator/src/security.ts",
  "packages/orchestrator/src/permissions.ts",
  "packages/orchestrator/src/org-policy.ts",
  "packages/orchestrator/src/auto-mode.ts",
  "packages/orchestrator/src/auto-containment.ts",
  "packages/shared/src/secrets.ts",
  "packages/shared/src/credential-store.ts",
];

/**
 * The brief a gardener run is given: one fingerprint, its evidence, and the
 * rules. Reproduce in a test first, fix, run the gates, commit on the run's
 * branch — never push, merge, or touch the doctrine and the safety layer.
 */
export function gardenerBrief(fp: GardenerFingerprint, samples: GardenerSample[]): string {
  const stack = samples.find((s) => s.stack)?.stack;
  const contexts = samples
    .slice(0, 3)
    .map((s) => {
      const ctx = s.context ? JSON.stringify(s.context).slice(0, 240) : "{}";
      return `- ${s.ts.slice(0, 16).replace("T", " ")}: ${s.message.replace(/\s+/g, " ").slice(0, 160)}\n  context: ${ctx}`;
    })
    .join("\n");
  const lines = [
    "You are working on Rune's own source, in this repository. Fix ONE recurring harness defect, evidenced by Rune's black box.",
    "",
    `Fingerprint ${fp.fingerprint} · class ${fp.class} · component ${fp.component}`,
    `Seen ${fp.count}× (first ${fp.firstSeen.slice(0, 10)}, last ${fp.lastSeen.slice(0, 10)}) across versions ${fp.versions.join(", ") || "?"}.`,
    `Sample message: ${fp.messageSample.replace(/\s+/g, " ").slice(0, 300)}`,
  ];
  if (stack) {
    lines.push(
      "",
      "Stack (latest):",
      ...stack
        .split("\n")
        .slice(0, 12)
        .map((l) => `  ${l}`),
    );
  }
  if (contexts) lines.push("", "Recent occurrences:", contexts);
  lines.push(
    "",
    "Rules:",
    "1. Reproduce first: write a failing unit test under tests/unit/ that fails for exactly this reason. Then make it pass with the smallest fix that addresses the cause, not the symptom.",
    "2. Before finishing, run and pass all of: `bun run typecheck`, `bun run lint`, `bun test tests/unit/`, `bunx prettier --check .`.",
    `3. Do not edit these files — they need a person: ${GARDENER_OFF_LIMITS.join(", ")}. Do not change the doctrine token ceiling or any test that guards it.`,
    "4. Commit on this branch with a message starting `fix(gardener):` that cites the fingerprint. Do not push, merge, or open a pull request — a person reviews the branch.",
    "5. If the defect cannot be reproduced in a test, stop: write what you found and why it could not be reproduced into .rune/gardener-report.md, and do not guess at a fix.",
  );
  return lines.join("\n");
}
