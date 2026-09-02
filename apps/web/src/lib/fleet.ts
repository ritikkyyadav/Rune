// ─── The fleet, from typed child events ───
//
// Before P2.6 a sub-agent's whole life reached the lead as a string: the tool
// boundary took `onProgress: (note: string)` and everything the projection did
// not think to include — a retry, a verification result, a handoff inside a
// worker — did not exist upstream at all. A panel built on that was rendering
// parsed prose.
//
// `tool_progress` now carries the child event itself under `child`, so this
// reducer reads the same union the lead's own transcript reads. `note` is still
// there and still a projection of it; a surface that wants a one-line heartbeat
// uses that, and this one wants the truth.

import type { AgentTurnEvent, ChildAgentEvent } from "@gear/protocol";

export type FleetState = "queued" | "running" | "done" | "failed";

export interface FleetRow {
  agentId: string;
  label: string;
  state: FleetState;
  /** Dispatch order — the panel sorts by this, never by arrival. */
  order: number;
  /** The last thing this agent actually did, projected to one line. */
  note: string;
  startedAt: number;
  endedAt?: number;
  /** Tool calls this agent has made, for the receipt. */
  tools: number;
}

export interface Fleet {
  rows: FleetRow[];
  nextOrder: number;
}

export const INITIAL_FLEET: Fleet = { rows: [], nextOrder: 0 };

/** One line describing a child event. Deliberately silent on the strobing members. */
export function projectChild(event: ChildAgentEvent["event"]): string | null {
  switch (event.type) {
    case "tool_call_start":
      return `${event.toolName}`;
    case "tool_call_end":
      return `${event.output?.toolName ?? "tool"} ${event.output?.success === false ? "failed" : "ok"}`;
    case "verification_completed":
      return event.passed ? "checks passed" : "checks failed";
    case "retry":
      return `retrying ${event.provider}/${event.model}`;
    case "handoff":
      return `paused — ${String(event.reason).replace(/_/g, " ")}`;
    case "error":
      return `error: ${event.error}`;
    case "turn_complete":
      return "finished";
    default:
      // Token deltas, usage, and a nested tool_progress would strobe a
      // one-line rung. Silence here is a decision, not an omission.
      return null;
  }
}

export function fleetReducer(state: Fleet, event: AgentTurnEvent, now = Date.now()): Fleet {
  if (event.type !== "tool_progress") return state;
  const child = (event as { child?: ChildAgentEvent }).child;
  if (!child?.agentId) return state;

  const at = state.rows.findIndex((r) => r.agentId === child.agentId);
  const projected = projectChild(child.event);
  const finished = child.event.type === "turn_complete";
  const failed = child.event.type === "error";

  if (at === -1) {
    const row: FleetRow = {
      agentId: child.agentId,
      label: child.label ?? child.agentId,
      state: finished ? "done" : failed ? "failed" : "running",
      order: state.nextOrder,
      // A brand-new row with a silent event still needs a line, and the host's
      // own projection is the only other thing that describes it.
      note: projected ?? event.note ?? "",
      startedAt: now,
      endedAt: finished || failed ? now : undefined,
      tools: child.event.type === "tool_call_start" ? 1 : 0,
    };
    return { rows: [...state.rows, row], nextOrder: state.nextOrder + 1 };
  }

  const prev = state.rows[at]!;
  const next: FleetRow = {
    ...prev,
    label: child.label ?? prev.label,
    state: finished ? "done" : failed ? "failed" : "running",
    // A silent event (a token delta) keeps the row's last REAL line. Falling
    // back to `note` here looks equivalent and is not: `note` is a projection
    // of the same event, so when the projection is silent the note is either
    // stale or a shrug, and either one overwrites something true.
    note: projected ?? prev.note,
    endedAt: finished || failed ? now : prev.endedAt,
    tools: prev.tools + (child.event.type === "tool_call_start" ? 1 : 0),
  };
  const rows = [...state.rows];
  rows[at] = next;
  return { ...state, rows };
}

/** Dispatch order, always — arrival order is whichever child happened to speak. */
export function fleetRows(state: Fleet): FleetRow[] {
  return [...state.rows].sort((a, b) => a.order - b.order);
}
