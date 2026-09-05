// ─── Sub-agent events, and the one line they project to ───
//
// A sub-agent runs the same loop the lead does and produces the same 22-member
// union. All of that was flattened to a string at the boundary
// (`onProgress: (note: string)`), so the fleet panel was rendering parsed
// prose: a worker's `tool_call_end` arrived as `"w2 edit_file src/x.ts"` and
// anything the projection did not think to include — a retry, a verification
// result, a handoff — was simply gone.
//
// P2.6 keeps the string and adds the event. `tool_progress` carries the child
// event under `child`; `note` stays as its projection, so a surface that only
// wants a one-line heartbeat (the TUI's status rung) never has to reduce a
// second union, and a surface that wants the truth (the fleet panel, the
// desktop fleet view) has it.

import type { AgentTurnEvent, ChildAgentEvent, WorkflowNodeContext } from "@rune/protocol";

/** How a sub-agent event is announced upward. */
export type ChildEventSink = (child: ChildAgentEvent) => void;

const MAX_NOTE_CHARS = 160;

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_NOTE_CHARS ? one.slice(0, MAX_NOTE_CHARS - 1) + "…" : one;
}

/**
 * The one-line projection of a child event, or null when the event says
 * nothing a heartbeat should show.
 *
 * Deliberately narrow. The status rung is one line that a person reads at a
 * glance while waiting; a projection that tried to say everything would say
 * nothing. The full event is carried beside it for surfaces that want more.
 */
export function projectChildEvent(agentId: string, event: AgentTurnEvent): string | null {
  const tag = agentId ? `${agentId} ` : "";
  switch (event.type) {
    case "tool_call_end": {
      const path = typeof event.args?.path === "string" ? ` ${event.args.path}` : "";
      const cmd = typeof event.args?.command === "string" ? ` ${event.args.command}` : "";
      return clip(`${tag}${event.output.toolName}${path || cmd}`);
    }
    case "fallback":
      return clip(`${tag}↯ ${event.to.provider}/${event.to.model}`);
    case "retry":
      return clip(`${tag}↻ ${event.attempt} of ${event.of}`);
    case "verification_started":
      return clip(`${tag}verifying`);
    case "verification_completed":
      return clip(`${tag}${event.passed ? "checks passed" : "checks failed"}`);
    case "step_check":
      return clip(`${tag}${event.passed ? "check passed" : "check failed"} — ${event.step}`);
    case "replanning":
      return clip(`${tag}re-planning`);
    case "handoff":
      return clip(`${tag}paused — ${event.reason.replace(/_/g, " ")}`);
    case "compaction":
      return clip(`${tag}compacted`);
    case "error":
      return clip(`${tag}${event.error}`);
    case "notice":
    case "context_warning":
      return clip(`${tag}${event.message}`);

    // A scout's hypothesis is the most informative thing a one-line heartbeat
    // can carry: it says what the worker is chasing, not merely that it is
    // busy. The verdict is shorter still and is the half a reader waits for.
    case "hypothesis":
      return clip(`${tag}testing: ${event.hypothesis.text}`);
    case "hypothesis_updated":
      return clip(`${tag}${event.id} ${event.status}${event.reason ? ` — ${event.reason}` : ""}`);
    case "decision":
      return clip(`${tag}decided: ${event.decision.text}`);

    // ── Named and deliberately silent on the rung ──
    // Token-level deltas would strobe a one-line heartbeat; a nested
    // tool_progress is already a projection and must not be re-projected;
    // turn_complete is reported by the call's own `settled` marker.
    case "text_delta":
    case "thinking_delta":
    case "tool_call_args_delta":
    case "tool_call_start":
    case "stream_reset":
    case "todo_updated":
    case "usage":
    case "checkpoint_saved":
    case "turn_complete":
    case "tool_progress":
    // Task state a fleet row has no column for: the lead composes the surface,
    // holds the pending-decision inbox, and generates the record.
    case "task_kind":
    case "artifact":
    case "pending_decision":
    case "decision_resolved":
    case "decision_record":
      return null;

    default:
      // Exhaustive: a member added to AgentTurnEvent is a type error here
      // until the fleet rung has decided whether it is worth a line.
      return exhaustive(event);
  }
}

function exhaustive(event: never): null {
  void event;
  return null;
}

/**
 * The line a WORKFLOW NODE deserves when its own event says nothing (P10.9).
 *
 * Two node outcomes carry no sub-agent event at all: a cache hit runs nothing,
 * and a skip never starts. A node that finished successfully ends on a
 * `turn_complete`, which the projection above is deliberately silent about
 * because an ordinary sub-agent's completion is reported by the call's own
 * `settled` marker — and a workflow node has no such marker, because the whole
 * workflow is one call.
 *
 * So: terminal node states speak, and a running node stays as quiet here as it
 * is above. Anything else would put a second heartbeat on the same row.
 */
export function projectWorkflowNode(node: WorkflowNodeContext | undefined): string | null {
  if (!node) return null;
  if (node.cached) return clip(`${node.node} cached`);
  switch (node.status) {
    case "completed":
      return clip(`${node.node} done`);
    case "failed":
      return clip(`${node.node} failed`);
    case "skipped":
      return clip(`${node.node} skipped`);
    default:
      return null;
  }
}
