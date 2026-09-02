// ─── AgentTurnEvent — the one event union ───
//
// Canonical here. `packages/orchestrator/src/agent-loop.ts` re-exports it, and
// every surface (TUI, desktop, web, headless, SDK) imports it from this
// package. Before Phase 2 the desktop kept a hand-written copy that had
// drifted both ways — stale `plan_*` members that no longer existed, missing
// `retry` / `tool_progress` / `step_check` / `handoff` — and adding a member
// here compiled clean in all three reducers and rendered nothing anywhere.
//
// The rule that replaces that: every reducer ends in `default: assertNever`,
// and every member it chooses to ignore is named in a case of its own.

import type { ToolCallOutput } from "./tool";
import type { HandoffReason, TodoItem } from "./task";

export type AgentTurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; callId: string; toolName: string }
  | { type: "tool_call_args_delta"; callId: string; partialJson: string }
  | {
      type: "tool_call_end";
      callId: string;
      args: Record<string, unknown>;
      output: ToolCallOutput;
    }
  | { type: "turn_complete"; stopReason: string; totalTurns: number }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "context_warning"; message: string }
  | { type: "notice"; message: string }
  | { type: "verification_started"; attempt: number }
  | {
      type: "verification_completed";
      attempt: number;
      ran: boolean;
      passed: boolean;
      report: string;
    }
  // The provider stream was abandoned mid-response and is being re-streamed:
  // UIs must drop any partially-rendered text/thinking for the current turn.
  | { type: "stream_reset" }
  // The plan as the spine holds it: each item carries the evidence the harness
  // measured while it was open, and an `unproven` mark when the model closed
  // it with nothing behind it. Emitted only when the list was ACCEPTED — a
  // refused completion surfaces as a failed todo_write instead.
  | { type: "todo_updated"; items: TodoItem[] }
  // The harness ran the project's compile-class check at a step boundary
  // (a step that wrote files was being closed with no check of its own).
  | { type: "step_check"; step: string; ran: boolean; passed: boolean; report: string }
  // ─── v2 surface events (structured, replacing prose-only signals) ───
  // The gateway abandoned one provider/model and is streaming from another.
  // The turn continues; nothing already accepted is lost.
  | {
      type: "fallback";
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      status?: number;
      reason?: string;
      chain?: string[];
    }
  // The same provider is about to be re-tried after a transient failure. The
  // turn continues; the surface shows `↻ 1 of 3` for the length of the backoff
  // instead of looking wedged with nothing to explain it.
  | {
      type: "retry";
      provider: string;
      model: string;
      attempt: number;
      of: number;
      status?: number;
      waitMs: number;
      reason?: string;
    }
  // Authoritative provider token usage for the request just completed, plus a
  // context-budget snapshot so UIs can keep a live meter without polling.
  | {
      type: "usage";
      /** Fresh input only — cached input is reported separately below. */
      inputTokens: number;
      outputTokens: number;
      /**
       * Input served from a warm prompt cache, and input written into it.
       * Carried so the ledger can price them at their discounted rates and
       * report what caching is actually worth; without these the cheapest
       * part of every turn is billed as if it were the most expensive.
       */
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      /**
       * The model this usage was actually billed against. Carried because a
       * run can switch models mid-flight (provider fallback, /model), and
       * pricing the tokens against the session's nominal model would quietly
       * misreport spend. Consumers that don't care may ignore it.
       */
      model?: string;
      /** Context window occupancy after this report, when an engine tracks it. */
      context?: { used: number; limit: number; percent: number };
    }
  // The working set was summarized in place. Estimates come from the same
  // heuristic counter the budget uses — render them as approximate.
  | {
      type: "compaction";
      beforeTokens: number;
      afterTokens: number;
      /** Context limit the percentages should be computed against. */
      limitTokens: number;
      summarizedCount?: number;
      /** True when a provider over-limit rejection forced this compaction. */
      forced?: boolean;
    }
  // A durable run-state checkpoint was written (see @gear/shared state.ts).
  | { type: "checkpoint_saved"; runId: string; version: number; turnCount: number }
  // ─── Task-spine events ───
  // The run ended BEFORE finishing (turn ceiling, exhausted context, abort,
  // error) with open todos: `state` is the zero-token "state of work" handoff
  // (done / remaining / files / next step). Resume picks it up automatically.
  | { type: "handoff"; reason: HandoffReason; state: string }
  // The loop told the model to stop patching and genuinely change approach —
  // after verification kept failing, or a struggle signal (edit churn) fired.
  | { type: "replanning"; reason: string; trigger: "verification" | "struggle" }
  // Live progress from a LONG tool call (sub-agent / worker): one short note
  // per meaningful step, rendered on the status rung — never in the transcript.
  //
  // `state` is the call's own lifecycle, which the tool cannot report because
  // it does not know when the loop chose to start it: `started` fires the
  // instant execution begins (a fan-out wider than maxParallelTools leaves the
  // rest QUEUED, and a queued scout must not be drawn as a running one), and
  // `settled` fires the instant it resolves. Both matter because every
  // `tool_call_end` in a batch is emitted together, after the LAST call
  // finishes: without `settled`, a scout that came back in twenty seconds was
  // still reported as running four minutes later.
  //
  // `child` is the sub-agent's own typed event (P2.6). `note` remains the
  // one-line projection the TUI's status rung renders, so a surface that only
  // wants a heartbeat never has to reduce the child union.
  | {
      type: "tool_progress";
      callId: string;
      note: string;
      state?: "started" | "settled";
      ok?: boolean;
      /** The sub-agent event this note was projected from, when there was one. */
      child?: ChildAgentEvent;
    };

/**
 * A sub-agent's own event, carried inside `tool_progress.child`.
 *
 * `agentId` is the worker's stable id within the fan-out, so a fleet panel can
 * keep a row per sub-agent instead of folding every worker into one shared
 * heartbeat. Recursion stops at one level: a sub-agent's sub-agent reports
 * through its parent's projection, which is what keeps the frame bounded.
 */
export interface ChildAgentEvent {
  agentId: string;
  /** What the sub-agent was dispatched to do, for the row's left half. */
  label?: string;
  event: AgentTurnEvent;
}

/** Every member's discriminant, as a type. */
export type AgentTurnEventType = AgentTurnEvent["type"];

/**
 * The manifest every reducer test iterates.
 *
 * The two guards below make this list impossible to leave stale: `satisfies`
 * proves nothing invented is in it, and `_AllMembersListed` fails to compile
 * when a union member is missing from it. Adding a member to `AgentTurnEvent`
 * is therefore a type error until it is listed here — and the reducer test
 * then fails until every surface handles it.
 */
export const AGENT_TURN_EVENT_TYPES = [
  "text_delta",
  "thinking_delta",
  "tool_call_start",
  "tool_call_args_delta",
  "tool_call_end",
  "turn_complete",
  "error",
  "context_warning",
  "notice",
  "verification_started",
  "verification_completed",
  "stream_reset",
  "todo_updated",
  "step_check",
  "fallback",
  "retry",
  "usage",
  "compaction",
  "checkpoint_saved",
  "handoff",
  "replanning",
  "tool_progress",
] as const satisfies readonly AgentTurnEventType[];

/** Compile-time completeness: `never` unless every member is listed above. */
type _AllMembersListed =
  Exclude<AgentTurnEventType, (typeof AGENT_TURN_EVENT_TYPES)[number]> extends never
    ? true
    : {
        ERROR: "AGENT_TURN_EVENT_TYPES is missing a member of AgentTurnEvent";
        missing: Exclude<AgentTurnEventType, (typeof AGENT_TURN_EVENT_TYPES)[number]>;
      };
const _allMembersListed: _AllMembersListed = true;
void _allMembersListed;

const AGENT_TURN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_TURN_EVENT_TYPES);

/** Narrow an untrusted frame payload to a known event discriminant. */
export function isAgentTurnEventType(value: unknown): value is AgentTurnEventType {
  return typeof value === "string" && AGENT_TURN_EVENT_TYPE_SET.has(value);
}

/**
 * Shallow structural check on an inbound event frame.
 *
 * Deliberately shallow: the host is the only writer of these frames, and a
 * client that rejects a frame because a NEWER host added an optional field
 * would break the additive-minor contract in `version.ts`. What this catches
 * is a frame that is not an event at all.
 */
export function isAgentTurnEvent(value: unknown): value is AgentTurnEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    isAgentTurnEventType((value as { type?: unknown }).type)
  );
}
