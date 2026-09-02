/**
 * P2.6 — the sub-agent channel is typed, and the string is a projection of it.
 *
 * A sub-agent runs the same loop the lead does and produces the same 22-member
 * union. All of it was flattened to a string at the tool boundary
 * (`onProgress: (note: string)`), so the fleet panel rendered parsed prose: a
 * worker's `tool_call_end` arrived as `"w2 edit_file src/x.ts"`, and anything
 * the projection did not think to include — a retry, a verification result, a
 * handoff — did not exist upstream at all.
 *
 * The contract under test: `tool_progress` carries the child event under
 * `child`, `note` is derived from it, and the derivation is exhaustive against
 * the union so a new member cannot be silently dropped from the fleet rung.
 */

import { describe, expect, test } from "bun:test";

import { AGENT_TURN_EVENT_TYPES, type AgentTurnEvent } from "../../../packages/protocol/src/index";
import { projectChildEvent } from "../../../packages/orchestrator/src/subagent-events";

/** One synthetic event per union member, for the sweep below. */
function sample(type: string): AgentTurnEvent {
  switch (type) {
    case "text_delta":
    case "thinking_delta":
      return { type, text: "x" } as AgentTurnEvent;
    case "tool_call_start":
      return { type, callId: "c1", toolName: "read_file" };
    case "tool_call_args_delta":
      return { type, callId: "c1", partialJson: "{" };
    case "tool_call_end":
      return {
        type,
        callId: "c1",
        args: { path: "src/x.ts" },
        output: {
          callId: "c1",
          toolName: "edit_file",
          success: true,
          result: "ok",
          durationMs: 3,
        },
      };
    case "turn_complete":
      return { type, stopReason: "end_turn", totalTurns: 2 };
    case "error":
      return { type, error: "boom", recoverable: false };
    case "context_warning":
    case "notice":
      return { type, message: "heads up" } as AgentTurnEvent;
    case "verification_started":
      return { type, attempt: 1 };
    case "verification_completed":
      return { type, attempt: 1, ran: true, passed: true, report: "green" };
    case "stream_reset":
      return { type };
    case "todo_updated":
      return { type, items: [] };
    case "step_check":
      return { type, step: "wire the reducer", ran: true, passed: false, report: "red" };
    case "fallback":
      return {
        type,
        from: { provider: "a", model: "m1" },
        to: { provider: "b", model: "m2" },
      };
    case "retry":
      return { type, provider: "a", model: "m1", attempt: 2, of: 3, waitMs: 500 };
    case "usage":
      return { type, inputTokens: 1, outputTokens: 2 };
    case "compaction":
      return { type, beforeTokens: 100, afterTokens: 40, limitTokens: 200 };
    case "checkpoint_saved":
      return { type, runId: "r1", version: 1, turnCount: 3 };
    case "handoff":
      return { type, reason: "max_turns", state: "half done" };
    case "replanning":
      return { type, reason: "verification kept failing", trigger: "verification" };
    case "tool_progress":
      return { type, callId: "c1", note: "n" };
    default:
      throw new Error(`no sample for ${type} — add one when you add the member`);
  }
}

describe("the child-event projection", () => {
  test("has a decision for every member of the union", () => {
    // Not "returns a string for every member" — silence is a legitimate
    // decision for a token delta. The point is that none of them throws or
    // falls off the end, which is what the exhaustive switch guarantees.
    for (const type of AGENT_TURN_EVENT_TYPES) {
      expect(() => projectChildEvent("w1", sample(type))).not.toThrow();
    }
  });

  test("names the agent, so a fleet is not one shared heartbeat", () => {
    const note = projectChildEvent("w2", sample("tool_call_end"));
    expect(note).toContain("w2");
    expect(note).toContain("edit_file");
    expect(note).toContain("src/x.ts");
  });

  test("surfaces what the string channel never could", () => {
    // Each of these was invisible upstream before P2.6: the worker's own
    // projection only ever emitted tool names and a fallback marker.
    expect(projectChildEvent("w1", sample("retry"))).toContain("2 of 3");
    expect(projectChildEvent("w1", sample("verification_completed"))).toContain("checks passed");
    expect(projectChildEvent("w1", sample("step_check"))).toContain("check failed");
    expect(projectChildEvent("w1", sample("handoff"))).toContain("max turns");
    expect(projectChildEvent("w1", sample("replanning"))).toContain("re-planning");
  });

  test("stays silent on events that would strobe a one-line rung", () => {
    expect(projectChildEvent("w1", sample("text_delta"))).toBeNull();
    expect(projectChildEvent("w1", sample("thinking_delta"))).toBeNull();
    expect(projectChildEvent("w1", sample("tool_call_args_delta"))).toBeNull();
    expect(projectChildEvent("w1", sample("usage"))).toBeNull();
    // A nested tool_progress is ALREADY a projection. Re-projecting it would
    // put a sub-agent's sub-agent's heartbeat on the lead's rung.
    expect(projectChildEvent("w1", sample("tool_progress"))).toBeNull();
  });

  test("bounds every line it produces", () => {
    const long = "x".repeat(4000);
    const note = projectChildEvent("w1", { type: "error", error: long, recoverable: false });
    expect(note!.length).toBeLessThanOrEqual(160);
  });

  test("collapses whitespace — a rung is one line", () => {
    const note = projectChildEvent("w1", {
      type: "notice",
      message: "line one\nline two\n\tindented",
    });
    expect(note).not.toContain("\n");
    expect(note).not.toContain("\t");
  });
});
