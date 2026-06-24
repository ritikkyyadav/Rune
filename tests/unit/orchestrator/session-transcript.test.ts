/**
 * Unit tests for eventsToTranscript — the pure event-log → display-line mapper
 * that backs session resume/replay.
 */

import { describe, test, expect } from "bun:test";
import { eventsToTranscript } from "../../../packages/orchestrator/src/engine";

function ev(seq: number, type: string, payload: Record<string, unknown>) {
  return { seq, event: { type, payload } };
}

describe("eventsToTranscript", () => {
  test("maps user and assistant messages to roled lines, skipping empties", () => {
    const lines = eventsToTranscript([
      ev(1, "user_msg", { content: "write hello.ts" }),
      ev(2, "assistant_msg", { content: "Done." }),
      ev(3, "user_msg", { content: "   " }), // blank → skipped
      ev(4, "assistant_msg", { content: "" }), // empty → skipped
    ]);
    expect(lines).toEqual([
      { role: "user", text: "write hello.ts" },
      { role: "assistant", text: "Done." },
    ]);
  });

  test("correlates tool_result back to the tool name, args, and result from the turn", () => {
    const lines = eventsToTranscript([
      ev(1, "user_msg", { content: "edit it" }),
      ev(2, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "c1", toolName: "edit_file", toolInput: { path: "a.ts" } }],
      }),
      ev(3, "tool_result", { callId: "c1", content: '{"path":"a.ts","diff":"+x"}', isError: false }),
      ev(4, "assistant_msg", {
        content: "",
        toolUses: [{ callId: "c2", toolName: "bash", toolInput: { command: "ls" } }],
      }),
      ev(5, "tool_result", { callId: "c2", content: "boom", isError: true }),
    ]);
    // The args + result are carried through so replay can render a faithful
    // `Edited a.ts +1 -0` / `Ran ls` line instead of a bare tool name.
    expect(lines).toEqual([
      { role: "user", text: "edit it" },
      {
        role: "tool",
        text: "edit_file",
        toolName: "edit_file",
        args: { path: "a.ts" },
        result: '{"path":"a.ts","diff":"+x"}',
        isError: false,
      },
      {
        role: "tool",
        text: "bash",
        toolName: "bash",
        args: { command: "ls" },
        result: "boom",
        isError: true,
      },
    ]);
  });

  test("unknown call ids fall back to 'tool' with empty args/result", () => {
    const lines = eventsToTranscript([ev(1, "tool_result", { callId: "missing" })]);
    expect(lines).toEqual([
      { role: "tool", text: "tool", toolName: "tool", args: {}, result: "", isError: false },
    ]);
  });

  test("compaction becomes a note; checkpoint and unknown types are dropped", () => {
    const lines = eventsToTranscript([
      ev(1, "checkpoint", { summary: "session_started" }),
      ev(2, "compaction", { summary: "…" }),
      ev(3, "research_plan", { plan: {} }),
    ]);
    expect(lines).toEqual([{ role: "note", text: "context compacted earlier in this session" }]);
  });
});
