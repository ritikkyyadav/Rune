import { describe, expect, mock, test } from "bun:test";

import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";

function event(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

describe("AgentLoop tool-result security boundary", () => {
  test("processor output reaches both UI events and the next model request", async () => {
    const requests: any[] = [];
    let turn = 0;
    const gateway = {
      inferStream: mock(async function* (request: any) {
        requests.push(request);
        turn++;
        if (turn === 1) {
          yield event("tool_use_start", { toolCallId: "r1", toolName: "read_file" });
          yield event("tool_use_stop", { toolCallId: "r1", toolInput: { path: "README.md" } });
          yield event("message_stop", { stopReason: "tool_use" });
        } else {
          yield event("content_delta", { delta: { type: "text_delta", text: "done" } });
          yield event("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;
    const registry = {
      toLlmTools: mock(() => []),
      get: mock(() => ({
        schema: {
          name: "read_file",
          version: "1",
          description: "",
          inputSchema: { type: "object" },
          category: "read",
          permissionLevel: "auto",
        },
      })),
      execute: mock(async (input: any) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "hostile payload",
        durationMs: 1,
      })),
    } as any;
    const processor = mock(async ({ output }: any) => ({
      ...output,
      result: "[SCREENED]\n" + output.result,
    }));

    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTurns: 3,
        systemPrompt: "s",
        toolResultProcessor: processor,
      },
      gateway,
      registry,
    );
    const emitted: any[] = [];
    for await (const item of loop.run("read it", "session", "/tmp")) emitted.push(item);

    expect(processor).toHaveBeenCalledTimes(1);
    const toolEvent = emitted.find((item) => item.type === "tool_call_end");
    expect(toolEvent.output.result).toStartWith("[SCREENED]");

    const toolMessage = requests[1].messages.find((message: any) => message.role === "tool");
    const toolResult = toolMessage.content.find((block: any) => block.type === "tool_result");
    expect(toolResult.toolResultContent).toStartWith("[SCREENED]");
  });

  test("probe failure adds a warning instead of silently trusting the result", async () => {
    let turn = 0;
    const gateway = {
      inferStream: mock(async function* () {
        turn++;
        if (turn === 1) {
          yield event("tool_use_start", { toolCallId: "r2", toolName: "read_file" });
          yield event("tool_use_stop", { toolCallId: "r2", toolInput: { path: "x" } });
          yield event("message_stop", { stopReason: "tool_use" });
        } else {
          yield event("content_delta", { delta: { type: "text_delta", text: "done" } });
          yield event("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;
    const registry = {
      toLlmTools: mock(() => []),
      get: mock(() => ({
        schema: {
          category: "read",
          permissionLevel: "auto",
        },
      })),
      execute: mock(async (input: any) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "raw result",
        durationMs: 1,
      })),
    } as any;
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTurns: 3,
        systemPrompt: "s",
        toolResultProcessor: async () => {
          throw new Error("probe offline");
        },
      },
      gateway,
      registry,
    );
    const emitted: any[] = [];
    for await (const item of loop.run("read it", "session", "/tmp")) emitted.push(item);

    const toolEvent = emitted.find((item) => item.type === "tool_call_end");
    expect(toolEvent.output.result).toContain("probe failed");
    expect(toolEvent.output.result).toContain("raw result");
  });
});
