/**
 * P2.5 — what a reconnecting client is handed, and what it is told.
 *
 * `eventsToTranscript` reads the session log for a human and handles five of
 * fourteen persisted types. A reconnecting CLIENT needs something different:
 * the typed events it would have received live. `replayEvents` is that mapper,
 * beside it and pure, so this can test it with no engine and no database.
 *
 * The property that matters most is the honest one. `text_delta` is never
 * persisted — a keystroke log is not state — so an assistant turn comes back
 * as ONE settled block, and the protocol says `settled: true` rather than
 * pretending a client received the stream that produced it.
 */

import { describe, expect, test } from "bun:test";

import { replayEvents } from "../../../packages/orchestrator/src/engine";

type Row = { seq: number; event: { type: string; payload: Record<string, unknown> } };

const row = (seq: number, type: string, payload: Record<string, unknown> = {}): Row => ({
  seq,
  event: { type, payload },
});

describe("replayEvents", () => {
  test("an assistant turn comes back as one settled block, not a keystroke stream", () => {
    const { frames } = replayEvents([
      row(1, "user_msg", { content: "fix the reducer" }),
      row(2, "assistant_msg", { content: "Done. The reducer now handles retry." }),
    ]);
    const deltas = frames.filter((f) => f.event.type === "text_delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0]!.event as { text: string }).text).toBe(
      "Done. The reducer now handles retry.",
    );
  });

  test("user turns come back separately, with their sequences", () => {
    // `AgentTurnEvent` has no member for "the person said this", so they are
    // returned alongside rather than shoehorned into the union — and they
    // carry their seq so a client can interleave them back into order.
    const { frames, userTurns } = replayEvents([
      row(1, "user_msg", { content: "first" }),
      row(2, "assistant_msg", { content: "ok" }),
      row(3, "user_msg", { content: "second" }),
    ]);
    expect(userTurns).toEqual([
      { seq: 1, text: "first" },
      { seq: 3, text: "second" },
    ]);
    expect(frames.map((f) => f.event.type)).toEqual(["text_delta"]);
  });

  test("a tool call is rebuilt with the args it was called with", () => {
    // The result row carries only a callId; the tool name and arguments live
    // on the assistant message that announced it. Correlating them is what
    // lets a replayed transcript say "Edited src/x.ts" and not "tool".
    const { frames } = replayEvents([
      row(1, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "c1", toolName: "edit_file", toolInput: { path: "src/x.ts" } }],
      }),
      row(2, "tool_result", { callId: "c1", content: "+3 -1" }),
    ]);
    expect(frames.map((f) => f.event.type)).toEqual(["tool_call_start", "tool_call_end"]);
    const end = frames[1]!.event as {
      type: "tool_call_end";
      args: Record<string, unknown>;
      output: { toolName: string; success: boolean; result: string };
    };
    expect(end.args).toEqual({ path: "src/x.ts" });
    expect(end.output.toolName).toBe("edit_file");
    expect(end.output.success).toBe(true);
    expect(end.output.result).toBe("+3 -1");
  });

  test("a failed tool call replays as failed", () => {
    const { frames } = replayEvents([
      row(1, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "c1", toolName: "bash", toolInput: { command: "false" } }],
      }),
      row(2, "tool_result", { callId: "c1", content: "exit 1", isError: true }),
    ]);
    const end = frames[1]!.event as { output: { success: boolean; error?: string } };
    expect(end.output.success).toBe(false);
    expect(end.output.error).toBe("exit 1");
  });

  test("run_trace unpacks back into the exact event it was written from", () => {
    // The twelve run-level events had no row at all, so a reconnecting client
    // saw the text and the tools and nothing about what the run cost, which
    // provider it fell back to, or that it handed off short of finishing.
    const usage = { type: "usage", inputTokens: 120, outputTokens: 40, cacheReadTokens: 900 };
    const handoff = { type: "handoff", reason: "max_turns", state: "3 of 5 steps done" };
    const { frames } = replayEvents([row(1, "run_trace", usage), row(2, "run_trace", handoff)]);
    expect(frames.map((f) => f.event)).toEqual([usage, handoff] as never);
  });

  test("a run_trace row that is not an event is dropped, not thrown on", () => {
    const { frames } = replayEvents([
      row(1, "run_trace", { type: "not_a_real_event", junk: true }),
      row(2, "assistant_msg", { content: "still here" }),
    ]);
    expect(frames.map((f) => f.event.type)).toEqual(["text_delta"]);
  });

  test("compaction, notices and checkpoints all map", () => {
    const { frames } = replayEvents([
      row(1, "compaction", { beforeTokens: 100, afterTokens: 40, limitTokens: 200 }),
      row(2, "system_note", { content: "agent loop terminated: rate limited" }),
      row(3, "checkpoint_saved", { runId: "r1", version: 2, turnCount: 7 }),
      row(4, "error", { error: "provider lost", recoverable: false }),
    ]);
    expect(frames.map((f) => f.event.type)).toEqual([
      "compaction",
      "notice",
      "checkpoint_saved",
      "error",
    ]);
  });

  test("rows that are not turn events are skipped without complaint", () => {
    // research_*, cost, safety_decision, security_probe, retro and task_state
    // belong to `rune audit` and to the research stream, not to a turn replay.
    const { frames, userTurns } = replayEvents([
      row(1, "research_plan", { plan: {} }),
      row(2, "cost", { usd: 0.02 }),
      row(3, "safety_decision", {}),
      row(4, "retro", {}),
      row(5, "task_state", {}),
    ]);
    expect(frames).toEqual([]);
    expect(userTurns).toEqual([]);
  });

  test("lastSeq is the resume point", () => {
    const { lastSeq } = replayEvents([
      row(4, "user_msg", { content: "hi" }),
      row(9, "assistant_msg", { content: "hello" }),
    ]);
    expect(lastSeq).toBe(9);
  });

  test("an empty log replays as nothing, not as an error", () => {
    expect(replayEvents([])).toEqual({ frames: [], userTurns: [], lastSeq: 0 });
  });
});
