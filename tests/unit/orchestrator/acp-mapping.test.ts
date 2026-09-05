/**
 * The Rune → ACP event mapping, one case per member of the turn union.
 *
 * `docs/editors.md` publishes a table saying what an editor receives for each
 * of the 22 events and why the rest are dropped. A table in prose beside a
 * `switch` in code drifts the first time somebody adds a member — that is the
 * exact failure `docs/auto-mode.md` is the standing example of.
 *
 * So this file IS the table: every member of `AgentTurnEvent` is named here
 * with the update it becomes or `null`, and the union type is imported so a new
 * member fails to compile until it has a row. `tests/integration/acp-conformance.test.ts`
 * then proves the shapes are the protocol's, against the ACP project's own
 * client.
 */

import { describe, expect, test } from "bun:test";

import type { AgentTurnEvent } from "@rune/protocol";

import { toUpdate, toolKind } from "../../../packages/orchestrator/src/bin/acp-cli";

/** Every member of the union, with the `sessionUpdate` it must produce. */
const CASES: Array<{ event: AgentTurnEvent; sends: string | null }> = [
  { event: { type: "text_delta", text: "hi" }, sends: "agent_message_chunk" },
  { event: { type: "thinking_delta", text: "hmm" }, sends: "agent_thought_chunk" },
  { event: { type: "tool_call_start", callId: "c1", toolName: "bash" }, sends: "tool_call" },
  {
    event: { type: "tool_call_args_delta", callId: "c1", partialJson: '{"a' },
    sends: null,
  },
  {
    event: {
      type: "tool_call_end",
      callId: "c1",
      args: {},
      output: { success: true, result: "ok" },
    },
    sends: "tool_call_update",
  },
  { event: { type: "turn_complete", stopReason: "end_turn", totalTurns: 1 }, sends: null },
  { event: { type: "error", error: "boom", recoverable: false }, sends: "agent_message_chunk" },
  { event: { type: "context_warning", message: "80% full" }, sends: "agent_thought_chunk" },
  { event: { type: "notice", message: "switching model" }, sends: "agent_thought_chunk" },
  { event: { type: "verification_started", attempt: 1 }, sends: "agent_thought_chunk" },
  {
    event: {
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: false,
      report: "2 failing",
    },
    sends: "agent_thought_chunk",
  },
  { event: { type: "stream_reset" }, sends: null },
  {
    event: { type: "todo_updated", items: [{ content: "step", status: "pending" }] },
    sends: "plan",
  },
  {
    event: { type: "step_check", step: "wire it", ran: true, passed: true, report: "" },
    sends: "agent_thought_chunk",
  },
  {
    event: {
      type: "fallback",
      from: { provider: "a", model: "m" },
      to: { provider: "b", model: "n" },
    },
    sends: null,
  },
  {
    event: { type: "retry", provider: "a", model: "m", attempt: 1, of: 3, waitMs: 500 },
    sends: null,
  },
  { event: { type: "usage", inputTokens: 10, outputTokens: 2 }, sends: null },
  {
    event: { type: "compaction", beforeTokens: 100, afterTokens: 10, limitTokens: 200 },
    sends: null,
  },
  {
    event: { type: "checkpoint_saved", runId: "r1", version: 1, turnCount: 2 },
    sends: null,
  },
  {
    event: { type: "handoff", reason: "turn_limit", state: "half done" },
    sends: "agent_thought_chunk",
  },
  {
    event: { type: "replanning", reason: "tests keep failing", trigger: "verification" },
    sends: "agent_thought_chunk",
  },
  { event: { type: "tool_progress", callId: "c1", note: "still going" }, sends: null },
  // ─── The narrative (P11.1) ───
  // The hypotheses and the decision are reasoning, and an editor has a
  // reasoning stream. The rest is task state with nowhere to land.
  { event: { type: "task_kind", kind: "investigate", source: "harness" }, sends: null },
  {
    event: {
      type: "hypothesis",
      hypothesis: {
        id: "h1",
        text: "cache eviction on deploy",
        status: "testing",
        evidence: [],
        at: "2026-09-03T00:00:00.000Z",
      },
    },
    sends: "agent_thought_chunk",
  },
  {
    event: {
      type: "hypothesis_updated",
      id: "h1",
      status: "refuted",
      reason: "TTL unchanged",
      source: "harness",
    },
    sends: "agent_thought_chunk",
  },
  {
    event: {
      type: "decision",
      decision: {
        id: "d1",
        text: "restore the composite index",
        basedOn: [{ kind: "check", ref: "bun test" }],
        at: "2026-09-03T00:00:00.000Z",
      },
    },
    sends: "agent_thought_chunk",
  },
  {
    event: {
      type: "artifact",
      artifact: {
        id: "a1",
        kind: "file",
        ref: "migrations/0042.sql",
        at: "2026-09-03T00:00:00.000Z",
      },
    },
    sends: null,
  },
  {
    event: {
      type: "pending_decision",
      decision: {
        id: "p1",
        kind: "held_step",
        summary: "backfill on the replica",
        createdAt: "2026-09-03T00:00:00.000Z",
      },
    },
    sends: null,
  },
  { event: { type: "decision_resolved", id: "p1", outcome: "approved" }, sends: null },
  {
    event: {
      type: "decision_record",
      record: {
        taskId: "s1",
        objective: "why did latency rise",
        decision: null,
        decisions: [],
        hypotheses: [],
        artifacts: [],
        checks: [],
        remains: { openSteps: [], pending: [] },
        generatedAt: "2026-09-03T00:00:00.000Z",
      },
    },
    sends: null,
  },
];

describe("toUpdate — the published mapping table", () => {
  test("covers every member of the turn union exactly once", () => {
    const named = CASES.map((c) => c.event.type);
    expect(new Set(named).size).toBe(named.length);
    // 30 members, as `docs/protocol.md` and `docs/editors.md` both say. A new
    // member without a row here is a member nobody decided about.
    expect(named.length).toBe(30);
  });

  for (const { event, sends } of CASES) {
    test(`${event.type} → ${sends ?? "nothing (documented drop)"}`, () => {
      const update = toUpdate(event as unknown as { type: string } & Record<string, unknown>);
      expect(update?.sessionUpdate ?? null).toBe(sends);
    });
  }

  test("a verification result says whether it passed, not just that it happened", () => {
    // The whole point of the line. An editor told "verification completed" with
    // no verdict reads as reassurance for a run that failed.
    const failed = toUpdate({
      type: "verification_completed",
      attempt: 2,
      ran: true,
      passed: false,
      report: "2 tests failing\nmore detail nobody needs here",
    })!;
    const text = (failed.content as { text: string }).text;
    expect(text).toContain("FAILED");
    expect(text).toContain("2 tests failing");
    // One line, not a build log.
    expect(text).not.toContain("more detail");

    const passed = toUpdate({
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: true,
      report: "",
    })!;
    expect((passed.content as { text: string }).text).toContain("passed");
  });

  test("a handoff carries the state of work, which is its entire content", () => {
    const update = toUpdate({
      type: "handoff",
      reason: "context_exhausted",
      state: "done: parser. remaining: the printer.",
    })!;
    const text = (update.content as { text: string }).text;
    expect(text).toContain("context_exhausted");
    expect(text).toContain("remaining: the printer");
  });
});

describe("toolKind — what icon an editor draws", () => {
  test.each([
    ["bash", "execute"],
    ["run_shell", "execute"],
    ["grep_search", "search"],
    ["read_file", "read"],
    ["write_file", "edit"],
    ["multi_edit", "edit"],
    ["apply_patch", "edit"],
    ["web_fetch", "fetch"],
    ["think", "think"],
    // The ordering that P10.6's conformance run caught: `todo_write` contains
    // "write" and is a plan update, not a file modification.
    ["todo_write", "think"],
    ["something_else", "other"],
  ])("%s → %s", (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });
});
