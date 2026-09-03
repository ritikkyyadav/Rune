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

import type { AgentTurnEvent, ChildAgentEvent, WorkflowNodeContext } from "@gear/protocol";

export type FleetState = "queued" | "running" | "done" | "failed" | "skipped";

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
  /**
   * Where this row sits in a workflow graph, when it is a workflow node rather
   * than an ad-hoc `task`/`worker` (P10.9).
   *
   * Absent for a fan-out, and deliberately so: a fan-out IS flat — every member
   * was dispatched at once and none waits on another — and drawing levels over
   * it would invent a structure it does not have.
   */
  node?: WorkflowNodeContext;
}

export interface Fleet {
  rows: FleetRow[];
  nextOrder: number;
}

export const INITIAL_FLEET: Fleet = { rows: [], nextOrder: 0 };

/**
 * One wave of a workflow: the level, its members, and the edges into it.
 *
 * `after` is what the level waited for, deduped across its members. It is the
 * half that makes a level mean something — "wave 2 of 3" says there is an
 * order, "after scope" says what the order was.
 */
export interface FleetWave {
  workflow: string;
  wave: number;
  waves: number;
  after: string[];
  rows: FleetRow[];
}

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

/**
 * The state a workflow node is in, which its own agent events cannot always
 * say. A cache hit runs no agent at all and a skip never starts one, so
 * without this the two outcomes a workflow is most worth watching for are the
 * two the panel cannot draw.
 */
function nodeState(node: WorkflowNodeContext | undefined): FleetState | null {
  if (!node) return null;
  if (node.cached) return "done";
  switch (node.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "running":
      return "running";
    default:
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
  // The node's own status outranks the event's shape. A node that failed
  // reports an `error` the row would read as failed anyway; a node that was
  // SKIPPED reports a notice, and reading that as "still running" would leave
  // a row spinning for a member that will never run.
  const declared = nodeState(child.node);
  const state_ = declared ?? (finished ? "done" : failed ? "failed" : "running");
  const settled = state_ === "done" || state_ === "failed" || state_ === "skipped";

  if (at === -1) {
    const row: FleetRow = {
      agentId: child.agentId,
      label: child.label ?? child.agentId,
      state: state_,
      order: state.nextOrder,
      // A brand-new row with a silent event still needs a line, and the host's
      // own projection is the only other thing that describes it.
      note: projected ?? event.note ?? "",
      startedAt: now,
      endedAt: settled ? now : undefined,
      tools: child.event.type === "tool_call_start" ? 1 : 0,
      ...(child.node ? { node: child.node } : {}),
    };
    return { rows: [...state.rows, row], nextOrder: state.nextOrder + 1 };
  }

  const prev = state.rows[at]!;
  const next: FleetRow = {
    ...prev,
    label: child.label ?? prev.label,
    state: state_,
    // A silent event (a token delta) keeps the row's last REAL line. Falling
    // back to `note` here looks equivalent and is not: `note` is a projection
    // of the same event, so when the projection is silent the note is either
    // stale or a shrug, and either one overwrites something true.
    note: projected ?? prev.note,
    endedAt: settled ? (prev.endedAt ?? now) : prev.endedAt,
    tools: prev.tools + (child.event.type === "tool_call_start" ? 1 : 0),
    ...(child.node ? { node: child.node } : {}),
  };
  const rows = [...state.rows];
  rows[at] = next;
  return { ...state, rows };
}

/** Dispatch order, always — arrival order is whichever child happened to speak. */
export function fleetRows(state: Fleet): FleetRow[] {
  return [...state.rows].sort((a, b) => a.order - b.order);
}

/** The rows that are an ad-hoc fan-out: flat, because that is what they are. */
export function adHocRows(state: Fleet): FleetRow[] {
  return fleetRows(state).filter((r) => !r.node);
}

/**
 * The workflow rows, grouped into the levels the executor ran them in.
 *
 * Grouped and not merely sorted: the level is the answer to "why has that one
 * not started", and a sorted flat list makes the reader recover it from the
 * workflow file. Levels come back in wave order and members within a level in
 * dispatch order — the same rule the flat list keeps, so a row does not move
 * under the eye when its state changes.
 */
export function fleetWaves(state: Fleet): FleetWave[] {
  const nodes = fleetRows(state).filter((r): r is FleetRow & { node: WorkflowNodeContext } =>
    Boolean(r.node),
  );
  const waves = [...new Set(nodes.map((r) => r.node.wave))].sort((a, b) => a - b);
  return waves.map((wave) => {
    const rows = nodes.filter((r) => r.node.wave === wave);
    const first = rows[0]!.node;
    return {
      workflow: first.workflow,
      wave,
      waves: first.waves,
      after: [...new Set(rows.flatMap((r) => r.node.dependsOn))],
      rows,
    };
  });
}
