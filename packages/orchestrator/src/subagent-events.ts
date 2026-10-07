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
import { describeVerification, verificationOutcome } from "@rune/protocol";

/** How a sub-agent event is announced upward. */
export type ChildEventSink = (child: ChildAgentEvent) => void;

const MAX_NOTE_CHARS = 160;

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_NOTE_CHARS ? one.slice(0, MAX_NOTE_CHARS - 1) + "…" : one;
}

/** How much of a brief a fleet row can carry before it is a paragraph. */
const MAX_LABEL_CHARS = 80;

/**
 * What this child is announced as: the master's own `label`, else the head of
 * its prompt (P4 §2.6).
 *
 * Both handlers declared `label` on their schema and neither destructured it,
 * so `ChildAgentEvent.label` was always the prompt head. The TUI hid the defect
 * by re-parsing the streamed argument JSON itself; every other consumer of the
 * stream saw a contract cut off at eighty characters and had no way to know a
 * label existed. One definition, called from both.
 */
export function childLabel(label: unknown, prompt: unknown): string {
  const written = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : "";
  if (written) return written.slice(0, MAX_LABEL_CHARS);
  return String(prompt ?? "").slice(0, MAX_LABEL_CHARS);
}

/** Words that name no subject — a fallback built from them names nothing. */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "in",
  "on",
  "and",
  "or",
  "this",
  "that",
  "its",
  "every",
  "all",
  "find",
  "build",
  "make",
  "write",
  "read",
  "map",
  "check",
  "run",
  "add",
  "fix",
  "look",
  "where",
  "what",
  "which",
  "how",
]);

/**
 * A name derived from the SHAPE of the task, when the master wrote none.
 *
 * `scout-auth`, `build-ui` — the tool's own verb plus the first word of the
 * brief that names a subject. Derived by the harness and never by a second
 * model call: a fan-out dispatched by a small free-route model will routinely
 * supply no name at all, and an unnamed row is the thing this phase exists to
 * remove. Returns "" when the brief says nothing usable; the panel's ordinal
 * (`agent-2`) is the floor under that.
 */
export function deriveChildName(kind: "task" | "worker", brief: string): string {
  const verb = kind === "worker" ? "build" : "scout";
  const word = brief
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w.length > 2 && w.length <= 12 && !STOP_WORDS.has(w));
  if (!word) return "";
  // The panel's name column is eleven cells (agents-panel NAME_COLS) and a name
  // clipped mid-word reads as damage, not as a name: `scout-setti` is worse
  // than either half of it. So the verb is dropped before the subject is — the
  // row already says `scout` or `work` in its own column, and the SUBJECT is
  // the part that tells two members apart.
  const prefixed = `${verb}-${word}`;
  if (prefixed.length <= NAME_BUDGET) return prefixed;
  return word.length <= NAME_BUDGET ? word : word.slice(0, NAME_BUDGET);
}

/** Mirrors `NAME_COLS` in bin/ui/agents-panel.ts — the panel's name column. */
const NAME_BUDGET = 11;

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
    case "verification_completed": {
      // Read `passed` alone and a child whose checks never ran — or were
      // killed at their deadline — announced "checks passed" to its parent.
      const outcome = verificationOutcome(event);
      return clip(
        outcome.status === "inconclusive"
          ? `${tag}checks: ${describeVerification(outcome)}`
          : `${tag}checks ${describeVerification(outcome)}`,
      );
    }
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
    // The child's lifecycle projection is its parent's material, not a rung
    // line: the lead folds a child into its OWN `lifecycle.children[]`.
    case "lifecycle":
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
 * Whether a child event is worth carrying to the parent at all (P4 §1.4).
 *
 * The gate in agent-loop used to be `if (!note) return` — the projection's
 * silence decided what crossed the boundary, so the whole watchable half of a
 * sub-agent's run (its prose, its thinking, its token counts) never left the
 * child. Opening that gate to EVERYTHING would put a child's per-token argument
 * JSON on the parent's queue, which no surface reads and which is the one
 * channel that genuinely scales with the size of a tool call.
 *
 * So the gate moves here and names what it drops:
 *
 *   `tool_progress` — a nested projection. Re-projecting one is how a
 *   grandchild's heartbeat would arrive twice, wearing two names.
 *
 * `tool_call_args_delta` used to be dropped here too, on the reasoning that a
 * pane shows a call's NAME when it opens and its result when it lands. That
 * left the one question a person opens a child's transcript to ask — what is
 * it running RIGHT NOW — unanswerable for exactly the calls that take long
 * enough to ask it about: a two-minute test run sat in the pane as the single
 * word `run`, with the command arriving only once it was over. The arguments
 * cross now, and what keeps them from being the channel that scales with the
 * size of a call is a ceiling rather than a refusal: see
 * `CHILD_ARGS_FORWARD_BYTES`.
 */
export function childEventCarriesSurface(event: AgentTurnEvent): boolean {
  return event.type !== "tool_progress";
}

/**
 * How much of ONE child call's argument JSON crosses to the parent.
 *
 * A pane needs the head of the arguments — the path, the command, the pattern —
 * to name what a running call is about. It never needs the body: a
 * `write_file` carries the whole file as an argument, and forwarding that a
 * token at a time is megabytes of traffic to render one path. Four kibibytes
 * holds every target a tool row can show and is spent in the first few dozen
 * tokens of an ordinary call.
 */
export const CHILD_ARGS_FORWARD_BYTES = 4 * 1024;

/**
 * Meter one child's argument stream against that ceiling.
 *
 * Returns the function the loop asks before forwarding a child event: true to
 * carry it, false once that call's allowance is spent. Anything that is not an
 * argument delta is always carried. The ledger is per parent tool batch, which
 * is the lifetime of the calls it counts.
 */
export function childArgsMeter(): (child: ChildAgentEvent) => boolean {
  const spent = new Map<string, number>();
  return (child) => {
    if (child.event.type !== "tool_call_args_delta") return true;
    const key = `${child.agentId}\u0000${child.event.callId}`;
    const used = spent.get(key) ?? 0;
    if (used >= CHILD_ARGS_FORWARD_BYTES) return false;
    spent.set(key, used + child.event.partialJson.length);
    return true;
  };
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
