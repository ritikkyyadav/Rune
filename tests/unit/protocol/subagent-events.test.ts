/**
 * P2.6 — the sub-agent channel is typed, and the string is a projection of it.
 *
 * A sub-agent runs the same loop the lead does and produces the same 30-member
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
import {
  childEventCarriesSurface,
  childLabel,
  deriveChildName,
  projectChildEvent,
} from "../../../packages/orchestrator/src/subagent-events";

const NOW = "2026-09-03T00:00:00.000Z";

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
    // ─── The narrative (P11.1) ───
    case "task_kind":
      return { type, kind: "investigate", source: "harness" };
    case "hypothesis":
      return {
        type,
        hypothesis: {
          id: "h1",
          text: "the pool is exhausted",
          status: "testing",
          evidence: [],
          at: NOW,
        },
      };
    case "hypothesis_updated":
      return { type, id: "h1", status: "refuted", reason: "pool at 20%", source: "harness" };
    case "decision":
      return { type, decision: { id: "d1", text: "restore the index", basedOn: [], at: NOW } };
    case "artifact":
      return { type, artifact: { id: "a1", kind: "file", ref: "src/x.ts", at: NOW } };
    case "pending_decision":
      return {
        type,
        decision: { id: "p1", kind: "held_step", summary: "deploy", createdAt: NOW },
      };
    case "decision_resolved":
      return { type, id: "p1", outcome: "approved" };
    case "decision_record":
      return {
        type,
        record: {
          taskId: "s1",
          objective: "why is it slow",
          decision: null,
          decisions: [],
          hypotheses: [],
          artifacts: [],
          checks: [],
          remains: { openSteps: [], pending: [] },
          generatedAt: NOW,
        },
      };
    case "lifecycle":
      return {
        type,
        moment: "start",
        lifecycle: {
          id: "s1",
          kind: "lead",
          objective: "why is it slow",
          constraints: [],
          workspace: { root: "/w", head: null, dirty: false },
          status: "running",
          budget: {
            turnsUsed: 0,
            turnsMax: 80,
            secondWindsUsed: 0,
            tokensIn: 0,
            tokensOut: 0,
            spentUsd: 0,
            capUsd: null,
            reservedUsd: 0,
          },
          checkpoint: null,
          evidence: { todos: [], checks: [], verifiedCriteria: 0 },
          children: [],
        },
      };
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

// ─── P4 §1.4 — the gate that made a sub-agent unwatchable ───
//
// The projection's silence used to be the GATE: `agent-loop.ts` read
// `if (!note) return`, and `text_delta`, `thinking_delta`, `tool_call_start`
// and `usage` all project to null on purpose — a one-line heartbeat that
// strobed on every token would be a flicker with a name on it. The
// consequence, which nobody intended, was that no child prose, no child
// thinking and no child token count reached the parent AT ALL. A pane cannot
// subscribe to something the parent never received.
//
// `childEventCarriesSurface` is that gate, moved off the projection and given
// its own answer: `note` says what a RUNG shows, this says what CROSSES.

describe("what crosses the child boundary", () => {
  test("a child's thinking reaches the parent even though no rung line does", () => {
    // The two halves of the same event, and they must disagree: silent on the
    // rung, carried on the wire. This is the one-line change the whole
    // watch-a-sub-agent-think pane rests on.
    expect(projectChildEvent("w1", sample("thinking_delta"))).toBeNull();
    expect(childEventCarriesSurface(sample("thinking_delta"))).toBe(true);
  });

  test("carries the rest of the watchable stream too", () => {
    for (const type of ["text_delta", "tool_call_start", "usage", "tool_call_end"]) {
      expect(childEventCarriesSurface(sample(type))).toBe(true);
    }
  });

  test("still drops the two nobody reads", () => {
    // Argument JSON arriving one fragment at a time is the one channel that
    // genuinely scales with the size of a tool call, and a pane shows the
    // call's NAME when it opens and its RESULT when it lands.
    expect(childEventCarriesSurface(sample("tool_call_args_delta"))).toBe(false);
    // A nested tool_progress is already a projection; carrying it is how a
    // grandchild's heartbeat arrives twice, wearing two names.
    expect(childEventCarriesSurface(sample("tool_progress"))).toBe(false);
  });

  test("has an answer for every member of the union", () => {
    for (const type of AGENT_TURN_EVENT_TYPES) {
      expect(typeof childEventCarriesSurface(sample(type))).toBe("boolean");
    }
  });
});

describe("the label the master wrote", () => {
  test("prefers it to the head of the prompt", () => {
    // Both handlers declared `label` on their schema and neither read it, so
    // `ChildAgentEvent.label` was always the prompt head. The TUI hid the
    // defect by re-parsing the argument JSON itself; every other consumer of
    // the stream saw a contract cut off at eighty characters.
    expect(childLabel("map the deploy surface", "Find every lambda…")).toBe(
      "map the deploy surface",
    );
    expect(childLabel(undefined, "Find every lambda behind the gateway")).toBe(
      "Find every lambda behind the gateway",
    );
    expect(childLabel("  two   words\n", "x")).toBe("two words");
  });

  test("derives a name from the task shape, never from a second model call", () => {
    expect(deriveChildName("task", "map the auth store")).toBe("scout-auth");
    expect(deriveChildName("worker", "build the panel")).toBe("build-panel");
    // Nothing usable is "" — the panel's ordinal is the floor under that, and
    // inventing `scout-the` would be a name that names nothing.
    expect(deriveChildName("task", "do it")).toBe("");
  });
});
