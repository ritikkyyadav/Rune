// ─── Gear · the engine adapter ───
// Translates the events Berne's agent loop already emits into the mission vocabulary.
// It is the seam where an existing coding agent becomes legible as a mission, and it
// is deliberately conservative about what it will let the product claim.
//
// **The ceiling.** Every rung this adapter produces is capped at `observed`, and it
// never emits CRITERION_MET. That is not caution for its own sake: the top two rungs
// mean *reproduced* (made to happen on demand, more than once) and *verified* (a test
// asserts it, and that test failed before the change) — and nothing in the current
// engine event stream carries a baseline commit or a repeat count. An adapter that
// promoted a green test run to `✓` would be inventing the one fact the whole claim
// column exists to protect.
//
// To lift the ceiling, the engine has to grow three things, in this order:
//   1. a baseline commit recorded when the mission opens
//   2. a test runner that reports `passed / total` against that baseline as well as
//      against the working tree
//   3. criteria as objects, agreed at minute zero, that those results can flip
// Until then the product tells the truth at `·` and says nothing it cannot support.

import { type DraftEvent, type Rung } from "../events";

/** The subset of Berne's plan-runner event stream this adapter understands. */
export type EngineEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; callId: string; toolName: string }
  | { type: "tool_call_args_delta"; callId: string; partialJson: string }
  | {
      type: "tool_call_end";
      callId: string;
      args: Record<string, unknown>;
      output: {
        toolName: string;
        success: boolean;
        result: string;
        error?: string;
        durationMs: number;
      };
    }
  | {
      type: "plan_created";
      plan: { steps: Array<{ index: number; description: string; dependsOn: number[] }> };
    }
  | {
      type: "plan_updated";
      reason: string;
      plan: { steps: Array<{ index: number; description: string; dependsOn: number[] }> };
    }
  | { type: "step_started"; stepIndex: number; description: string }
  | { type: "step_completed"; stepIndex: number; result: { success: boolean; summary: string } }
  | { type: "plan_completed"; plan: { status: string; steps: Array<{ status: string }> } }
  | { type: "todo_updated"; items: Array<{ content: string; status: string }> }
  | { type: "notice"; message: string }
  | { type: "context_warning"; message: string }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "turn_complete"; stopReason: string; totalTurns: number }
  | { type: "stream_reset" };

/** The highest claim an adapted event may carry. See the note at the top of the file. */
const CEILING: Rung = "observed";

/** Tools whose *arguments* say what file they touched. Never parsed out of prose. */
const WRITERS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "notebook_edit"]);

const VERBS: Record<string, string> = {
  read_file: "read",
  list_dir: "ls",
  grep: "grep",
  search_code: "search",
  symbol_search: "symbol",
  write_file: "write",
  edit_file: "edit",
  multi_edit: "edit",
  apply_patch: "patch",
  bash: "run",
  web_fetch: "fetch",
  web_search: "search",
  task: "agent",
  todo_write: "plan",
};

const idx = (n: number) => String(n + 1).padStart(2, "0");

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * What the row says the tool was pointed at. Taken from the structured arguments, so
 * a tool that changes its human-readable output cannot change what the stream claims.
 */
function subject(toolName: string, args: Record<string, unknown>): string {
  const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  if (path) return path;
  const cmd = str(args.command);
  if (cmd) return cmd;
  const q = str(args.pattern) ?? str(args.query);
  if (q) return q;
  return toolName;
}

/**
 * `+N −M` out of our own edit tools' output, and nothing else. If the shape is not
 * there the adapter emits no CHANGE_APPLIED at all rather than a change with invented
 * numbers — an under-claimed stream is recoverable, an over-claimed one is not.
 */
function changeCounts(result: string): { added: number; removed: number } | undefined {
  const m = /([+＋]?)(\d+)\s*(?:added|insertions?)\D+(\d+)\s*(?:removed|deletions?)/i.exec(result);
  if (m) return { added: Number(m[2]), removed: Number(m[3]) };
  const plusMinus = /\+(\d+)\s*[−-]\s*(\d+)/.exec(result);
  if (plusMinus) return { added: Number(plusMinus[1]), removed: Number(plusMinus[2]) };
  return undefined;
}

export interface AdapterOptions {
  /** how many phases the plan has, when it is known before the first PLAN_SET */
  actor?: string;
}

/**
 * Stateless per-event translation, except for the plan revision counter and the set of
 * open tool calls — both of which are facts about the stream, not about the model.
 */
export class EngineAdapter {
  private revision = 0;
  private readonly actor: string;
  private readonly openTools = new Map<string, string>();

  constructor(opts: AdapterOptions = {}) {
    this.actor = opts.actor ?? "gear";
  }

  /** Zero or more mission events for one engine event. Order is preserved. */
  translate(ev: EngineEvent): DraftEvent[] {
    switch (ev.type) {
      case "plan_created":
      case "plan_updated":
        return [
          {
            type: "PLAN_SET",
            revision: ++this.revision,
            cause: ev.type === "plan_updated" ? ev.reason : undefined,
            steps: ev.plan.steps.map((s) => ({
              index: idx(s.index),
              title: s.description,
              dependsOn: s.dependsOn.map(idx),
            })),
          },
        ];

      // A todo list is a plan that arrived without being called one.
      case "todo_updated":
        return [
          {
            type: "PLAN_SET",
            revision: ++this.revision,
            steps: ev.items.map((t, i) => ({ index: idx(i), title: t.content, dependsOn: [] })),
          },
        ];

      case "step_started":
        return [{ type: "PHASE_OPENED", index: idx(ev.stepIndex), title: ev.description }];

      case "step_completed":
        return [
          {
            type: "PHASE_CLOSED",
            index: idx(ev.stepIndex),
            outcome: ev.result.success ? "met" : "missed",
            summary: ev.result.summary,
            rung: CEILING,
            elapsedMs: 0,
          },
        ];

      case "plan_completed":
        return [
          {
            type: "MISSION_CONCLUDED",
            // Concluded, not complete. Whether it succeeded is a count of criteria,
            // and this adapter is not allowed to flip one.
            outcome: "concluded",
            elapsedMs: 0,
          },
        ];

      case "tool_call_start": {
        this.openTools.set(ev.callId, ev.toolName);
        return [
          {
            type: "TOOL_STARTED",
            id: ev.callId,
            verb: VERBS[ev.toolName] ?? ev.toolName,
            args: "",
            actor: this.actor,
          },
        ];
      }

      // The pulse is driven by this and by nothing else: bytes actually arriving.
      case "tool_call_args_delta":
        return this.openTools.has(ev.callId)
          ? [{ type: "TOOL_PROGRESS", id: ev.callId, bytes: ev.partialJson.length }]
          : [];

      case "tool_call_end": {
        this.openTools.delete(ev.callId);
        const out: DraftEvent[] = [
          {
            type: "TOOL_ENDED",
            id: ev.callId,
            exit: ev.output.success ? 0 : 1,
            detail: ev.output.error ?? subject(ev.output.toolName, ev.args),
            bytes: ev.output.result.length,
            elapsedMs: ev.output.durationMs,
            rung: CEILING,
          },
        ];

        const path = str(ev.args.file_path) ?? str(ev.args.path);
        const counts = changeCounts(ev.output.result);
        if (ev.output.success && WRITERS.has(ev.output.toolName) && path && counts) {
          out.push({
            type: "CHANGE_APPLIED",
            path,
            hunks: 1,
            added: counts.added,
            removed: counts.removed,
            // No cause: this engine does not yet emit findings, and a change that
            // claims a cause it cannot name is worse than one that admits it has none.
            tests: [],
            newFile: ev.output.toolName === "write_file",
          });
        }
        return out;
      }

      // Prose, notices, warnings, stream resets and turn bookkeeping change no mission
      // state. They belong on the screen, but not in the log.
      default:
        return [];
    }
  }
}

/** True when an adapted stream is claiming more than the engine can support. */
export const withinCeiling = (events: DraftEvent[]): boolean =>
  events.every(
    (e) =>
      e.type !== "CRITERION_MET" &&
      !("rung" in e && (e.rung === "reproduced" || e.rung === "verified")),
  );
