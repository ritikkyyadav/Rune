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
import type { CompletionVerdict, Criterion } from "./roundtrips";
import type {
  CheckRecord,
  DecisionRecord,
  EvidenceRef,
  HandoffReason,
  Hypothesis,
  HypothesisStatus,
  PendingDecision,
  TaskArtifact,
  TaskDecision,
  TaskKind,
  TodoItem,
} from "./task";

// ─── The task lifecycle (Phase 2) ───
//
// One read model the TUI, the persisted session and a headless caller can all
// produce and compare. Before it there were eight lifecycle concepts, each
// defined in a different module and reaching each of the three consumers by a
// different route: headless was the only one that read the terminal verdict,
// the persisted session the only one that kept the objective, and the TUI the
// only one that ever saw the user's constraints. They agreed on nothing —
// including which files the run had changed.
//
// It is a PROJECTION, not a store and not a coordinator: every field already
// exists somewhere, and this names one place to read it from.

/**
 * How a task ended; `running` until it does.
 *
 * One vocabulary in place of the two that overlapped on five values:
 * `turn_complete.stopReason` (7) and `HandoffReason` (8).
 */
export type TaskLifecycleStatus =
  | "running"
  | "end_turn"
  | "aborted"
  | "halted"
  | "max_turns"
  | "max_tokens"
  | "provider_lost"
  | "open_steps"
  | "stalled"
  // ── What the HARNESS stopped (Phase 5B) ──
  // Four terminal exits emitted no `turn_complete` at all, so the engine
  // invented one afterwards: a loop-detector kill, a barren-turn kill, a
  // budget-admission refusal and a genuine provider outage all recorded
  // identically as `provider_lost`. The vocabulary had nine members and no
  // spelling for "the harness stopped this run"; these two are it.
  | "loop_detected"
  | "barren"
  // The gateway refused the request before it was sent — a spend cap or a
  // model with no price. `max_turns` and `max_tokens` are already budget
  // stops; this is the third, and without it `statusFromStopReason` would
  // fall back to `end_turn` and record a refusal as a clean finish.
  | "budget";

/** Lead work, or a delegated child of either kind. */
export type TaskLifecycleKind = "lead" | "task" | "worker";

/** A child this task dispatched, as its parent can report it. */
export interface TaskLifecycleChild {
  /** `task_<uuid>` — the child's own durable id. */
  id: string;
  kind: "task" | "worker";
  status: TaskLifecycleStatus;
  /**
   * One lowercase word naming this child's ROLE in the fan-out — `planner`,
   * `builder`, `verifier` (P4 §2.6).
   *
   * The id is durable and unreadable; `label` is a 2-5 word brief and too long
   * for a column. Neither is a name, which is why a fan-out could only ever be
   * reported as a count: there was nothing to call the second of five workers.
   * Written by the master through the delegation call's own `name` argument,
   * else derived by the harness from the task shape. Absent from an older
   * build's row, which reads as unnamed rather than as a name of "".
   */
  name?: string;
  /** How a worker's writes reached the lead's tree, when it had any. */
  integration?: "merged" | "retained" | "shared";
  /** Paths the merge refused, so a conflict is a field and not prose. */
  conflicts?: string[];

  // ─── When the child was actually running (P3B I4) ───
  //
  // The lead's own clock measures dispatch-to-result, which includes the
  // child's whole run: startup, its work, and the integration of its writes
  // back into the lead's tree. Those are three different costs and only the
  // middle one is the work. The child is the only party that knows the first
  // and the last, so it reports them here — on the row it already sends home.
  // Both ISO-8601, both optional: a child from an older build reports neither,
  // and an absent stamp reads as "not measured" rather than as zero.

  /** When the child's own loop began, as the child observed it. */
  startedAt?: string;
  /** When its result was complete and its writes (if any) were integrated. */
  integratedAt?: string;
}

/** What the TUI, the persisted session and a headless caller must agree on. */
export interface TaskLifecycle {
  /** `sessions.id` for lead work; `task_<uuid>` for a delegated child. */
  id: string;
  /** The parent's `id`; absent for lead work. */
  parentId?: string;
  kind: TaskLifecycleKind;

  /** The objective as the spine holds it. Bounded on the wire by the emitter. */
  objective: string;
  /** The read-back criteria and their rungs, as they stand. */
  constraints: Criterion[];

  /** Where the work is, and what revision it was against. */
  workspace: { root: string; head: string | null; dirty: boolean };

  status: TaskLifecycleStatus;

  budget: {
    turnsUsed: number;
    turnsMax: number;
    secondWindsUsed: number;
    tokensIn: number;
    tokensOut: number;
    spentUsd: number;
    capUsd: number | null;
    reservedUsd: number;
  };

  /** Where a restart would pick up: the last persisted seq, and when. */
  checkpoint: { seq: number; at: string; compactions: number } | null;

  /** The plan and what moved it. Checks are the most recent ones, not all. */
  evidence: { todos: TodoItem[]; checks: CheckRecord[]; verifiedCriteria: number };

  /** Children this task dispatched, by id, with their own terminal status. */
  children: TaskLifecycleChild[];
}

/**
 * Why a `lifecycle` event was emitted.
 *
 * Carried because the projection is a latest-wins snapshot: without the moment
 * a consumer can see that something changed and not what kind of thing it was,
 * which is the difference between a timeline and a gauge.
 */
export type TaskLifecycleMoment =
  | "start"
  | "steering"
  | "dispatch"
  | "child_return"
  | "compaction"
  | "checkpoint"
  | "budget"
  | "terminal";

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
  // `verdict` is OPTIONAL on purpose: it is an added field on the member every
  // consumer already handles, so nothing that reads `turn_complete` today has
  // to learn a new event type to keep working. Absent only where no contract
  // was in scope — a sub-agent loop, or a caller driving AgentLoop directly.
  | {
      type: "turn_complete";
      stopReason: string;
      totalTurns: number;
      verdict?: CompletionVerdict;
    }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "context_warning"; message: string }
  | { type: "notice"; message: string }
  | { type: "verification_started"; attempt: number }
  // `status` is what happened; `reason` says why nothing was concluded. Both
  // are OPTIONAL because rows written before they existed are still replayed —
  // read the event through `verificationOutcome`, which answers for either
  // shape. `ran` and `passed` are kept for a client that predates `status`,
  // and on a new event they are derived from it: `passed` is true only for
  // `passed`, `ran` is false exactly for `inconclusive`.
  | {
      type: "verification_completed";
      attempt: number;
      status?: VerificationStatus;
      reason?: VerificationInconclusiveReason;
      /**
       * On a `failed` result: every failing test was already failing on the
       * tree the run started from, and the run added none. The checks are
       * still red — this says whose red it is, not that it is green.
       */
      preexisting?: boolean;
      ran: boolean;
      passed: boolean;
      report: string;
      /**
       * Git-ignored paths these checks generated in the workspace and the
       * harness removed again when they had run. Absent when there were none.
       */
      removed?: string[];
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
  // `removed`: as on `verification_completed`.
  | {
      type: "step_check";
      step: string;
      ran: boolean;
      passed: boolean;
      report: string;
      removed?: string[];
    }
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
      /**
       * What was actually dropped. `tool_results` means old tool-result bodies
       * were stripped and no summarizer ran; `summarized` means the head was
       * folded into the merged state.
       */
      tier?: "tool_results" | "summarized";
      /**
       * What asked for it. `auto` keeps a 30% verbatim tail; `requested`
       * (`compact_context`) and `overflow` (a provider rejection) cut to the
       * recent exchange, so their tails are legitimately much smaller.
       * `manual` is the user's own `/compact` — it was persisted as a value
       * outside this union and normalised away on replay, so a compaction the
       * user asked for came back indistinguishable from one nobody asked for.
       */
      trigger?: "auto" | "requested" | "overflow" | "manual";
      /**
       * The compaction did NOT happen: the summarizer failed and the working
       * set is unchanged. Emitted so the failure is visible on every surface
       * rather than only as a `notice` the transcript may have scrolled past —
       * a run that dies of an over-limit prompt after two silent failures
       * looked, to all three consumers, like a run that simply errored.
       */
      failed?: boolean;
      /**
       * Why the summarizer did not produce a summary — present on a failed
       * compaction AND on one the deterministic tier rescued. The rescue is
       * the case `failed` cannot express: the working set really did shrink,
       * so the compaction happened, but no summarizer ran and the run is one
       * unexplained `tier: "tool_results"` row away from dying of an
       * over-limit prompt with no visible cause.
       */
      failureReason?: string;
    }
  // A durable run-state checkpoint was written (see @rune/shared state.ts).
  | { type: "checkpoint_saved"; runId: string; version: number; turnCount: number }
  // The task lifecycle, projected. One event carries the id, the objective,
  // the user's constraints, the workspace revision, the budget, the plan and
  // the children — so the TUI, the persisted log and a headless caller read
  // the same numbers instead of each deriving their own. See `TaskLifecycle`.
  | { type: "lifecycle"; moment: TaskLifecycleMoment; lifecycle: TaskLifecycle }
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
    }
  // ─── The narrative (P11.1) ───
  //
  // What the run SUSPECTED, what it settled, and what it committed to. The
  // plan ledger already carries what was done and on what evidence; without
  // these a surface can show a green tick and still be unable to say why one
  // approach was taken and two were abandoned.
  //
  // The task's shape, from the Intent Interpreter at task start (`source:
  // "harness"` for the deterministic reading, `"model"` for the one revision
  // the model is allowed). A surface composes for this.
  | { type: "task_kind"; kind: TaskKind; source: "harness" | "model" }
  // A hypothesis was raised: named BEFORE it is tested, which is what makes
  // the refutation legible later instead of invisible.
  | { type: "hypothesis"; hypothesis: Hypothesis }
  // …and settled. `refuted` and `confirmed` come from a check's verdict, not
  // from the model's confidence; `reason` is the check's own summary.
  | {
      type: "hypothesis_updated";
      id: string;
      status: HypothesisStatus;
      reason?: string;
      evidence?: EvidenceRef[];
      /** Who moved it: the model reporting, or the harness reading a check. */
      source: "harness" | "model";
    }
  // The run committed to something, with what justified it.
  | { type: "decision"; decision: TaskDecision }
  // The run produced something that outlives it.
  | { type: "artifact"; artifact: TaskArtifact }
  // A decision is waiting on a person — a held step, a question, a permission
  // prompt, a read-back. One shape for all four, because the inbox is one list.
  | { type: "pending_decision"; decision: PendingDecision }
  | { type: "decision_resolved"; id: string; outcome: string }
  // The task ended: the whole record, generated from state, nothing invented.
  | { type: "decision_record"; record: DecisionRecord };

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
  /**
   * One lowercase word naming this child's role — the panel's card title
   * (P4 §2.6). See `TaskLifecycleChild.name`.
   *
   * Carried separately from `label` because they answer different questions: a
   * name says WHO this is across every row it will ever own, a label says what
   * it was asked this once. A panel that had only the label had to re-print the
   * whole brief on every line it wanted to attribute.
   */
  name?: string;
  event: AgentTurnEvent;
  /**
   * Set when this sub-agent is a NODE of a running workflow (P10.9).
   *
   * A fan-out from `task`/`worker` is a flat list and reads correctly as one:
   * every member was dispatched at once and none of them waits on another. A
   * workflow is not that shape — it is levels, and the level a node sits on is
   * the only thing that explains why it has not started yet. Carrying that
   * here, rather than letting a panel recover it by parsing the note, is the
   * difference between a fleet view and a guess about one.
   */
  node?: WorkflowNodeContext;
}

/**
 * Where a workflow node sits in its graph, for the surfaces that draw it.
 *
 * Everything here is known to the executor before the node runs, so a queued
 * node in wave 3 can be drawn as queued in wave 3 rather than as an absence.
 */
export interface WorkflowNodeContext {
  /** The workflow's name — the group heading. */
  workflow: string;
  /** The node's id: its cache key, its group member, and its edge endpoint. */
  node: string;
  /** `task` (read-only investigation) or `worker` (write-capable). */
  kind: "task" | "worker";
  /** Topological level, 0-based, and how many levels there are in total. */
  wave: number;
  waves: number;
  /** The ids this node waited for — the wave's edges, named rather than drawn. */
  dependsOn: string[];
  /** Attempt in progress (1-based) and the ceiling this node's `retry` allows. */
  attempt: number;
  attempts: number;
  /** True when the node was answered from cache and never ran at all. */
  cached: boolean;
  /** The node's own outcome, once the executor has one for it. */
  status?: "running" | "completed" | "failed" | "skipped";
}

/**
 * What the project's checks established at the end of a turn.
 *
 * `inconclusive` is not a softer `failed`: it means no verdict was reached — a
 * check was killed at its deadline, the run was cancelled, or nothing could
 * run here — and a surface must say that, not "checks fail" and not "checks
 * pass".
 */
export type VerificationStatus = "passed" | "failed" | "inconclusive";

export type VerificationInconclusiveReason =
  | "timeout"
  | "cancelled"
  | "missing_runner"
  | "no_checks"
  /** Decided, not discovered: what changed is documentation no check reads. */
  | "not_required";

/**
 * The outcome of a `verification_completed` event, whichever host wrote it.
 *
 * An event from before `status` existed carried two booleans, and is read the
 * way every reducer already read it: nothing ran → no verdict; otherwise the
 * verdict is `passed`.
 */
export function verificationOutcome(event: {
  status?: VerificationStatus;
  reason?: VerificationInconclusiveReason;
  preexisting?: boolean;
  ran?: boolean;
  passed?: boolean;
}): {
  status: VerificationStatus;
  reason?: VerificationInconclusiveReason;
  preexisting?: boolean;
} {
  if (event.status === "failed" && event.preexisting === true) {
    return { status: "failed", preexisting: true };
  }
  if (event.status === "passed" || event.status === "failed") return { status: event.status };
  if (event.status === "inconclusive") {
    return { status: "inconclusive", reason: event.reason ?? "no_checks" };
  }
  if (event.ran === false) return { status: "inconclusive", reason: "no_checks" };
  return { status: event.passed === true ? "passed" : "failed" };
}

/**
 * The outcome in a few words — the same words on every surface.
 *
 * Here rather than in each reducer because the point of naming the outcome is
 * lost the moment the terminal says "timed out" and the headless stream says
 * "failed" about one event. A surface adds its own grammar around this; it
 * does not choose a different verdict.
 */
export function describeVerification(outcome: {
  status: VerificationStatus;
  reason?: VerificationInconclusiveReason;
  preexisting?: boolean;
}): string {
  if (outcome.status === "passed") return "passed";
  if (outcome.status === "failed") {
    return outcome.preexisting ? "failed before this run (nothing new)" : "failed";
  }
  switch (outcome.reason) {
    case "timeout":
      return "did not finish (timed out)";
    case "cancelled":
      return "did not finish (cancelled)";
    case "missing_runner":
      return "could not run (toolchain missing)";
    case "not_required":
      return "not required (documentation only)";
    default:
      return "nothing to run";
  }
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
  "lifecycle",
  "handoff",
  "replanning",
  "tool_progress",
  "task_kind",
  "hypothesis",
  "hypothesis_updated",
  "decision",
  "artifact",
  "pending_decision",
  "decision_resolved",
  "decision_record",
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
