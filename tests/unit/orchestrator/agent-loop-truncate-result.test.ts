/**
 * Tool-result transcript cap: a single oversized tool output (the Rust bash
 * tool can return 512KB) must be truncated head+tail before entering the
 * message history, with an explicit marker so the model knows to narrow its
 * query.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop, truncateForTranscript } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

describe("truncateForTranscript", () => {
  test("passes small output through untouched", () => {
    expect(truncateForTranscript("hello")).toBe("hello");
    const at = "x".repeat(30_000);
    expect(truncateForTranscript(at)).toBe(at);
  });

  test("truncates oversized output keeping head and tail", () => {
    const text = "H".repeat(50_000) + "MIDDLE" + "T".repeat(50_000);
    const out = truncateForTranscript(text);
    expect(out.length).toBeLessThan(30_000);
    expect(out.startsWith("H")).toBe(true);
    expect(out.endsWith("T")).toBe(true);
    expect(out).toContain("characters omitted");
    expect(out).not.toContain("MIDDLE");
  });
});

describe("AgentLoop applies the cap to transcript tool_results", () => {
  test("oversized tool output is truncated in the next request's messages", async () => {
    let turn = 0;
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "t1", toolName: "bash" });
          yield ev("tool_use_stop", { toolCallId: "t1", toolInput: { command: "yes" } });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "ok" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const huge = "line\n".repeat(100_000); // 500KB
    const registry = {
      toLlmTools: mock(() => []),
      get: mock(() => ({ schema: { category: "execute", permissionLevel: "auto" } })),
      execute: mock(async (input: any) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: huge,
        durationMs: 1,
      })),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, registry);
    for await (const _ of loop.run("run it", "s1", "/tmp")) {
      // drain
    }

    const secondReq = requests[1];
    const toolMsg = secondReq.messages.find((m: any) =>
      m.content.some((b: any) => b.type === "tool_result"),
    );
    const block = toolMsg.content.find((b: any) => b.type === "tool_result");
    expect(block.toolResultContent.length).toBeLessThan(31_000);
    expect(block.toolResultContent).toContain("characters omitted");
  });
});
