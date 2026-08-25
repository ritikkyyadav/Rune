/**
 * Phase-5 (Crown Flow): long tool calls stream progress WHILE they execute.
 * Pre-fix, sub-agents/workers emitted zero events — a multi-minute build
 * rendered as one frozen line.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

describe("tool_progress pump", () => {
  test("progress notes yield as events, in order, before the tool's end event", async () => {
    const gateway = {
      inferStream: mock(async function* () {
        yield ev("tool_use_start", { toolCallId: "w1", toolName: "worker" });
        yield ev("tool_use_stop", { toolCallId: "w1", toolInput: { files: ["a.ts"] } });
        yield ev("message_stop", { stopReason: "tool_use" });
      }),
      infer: mock(async () => ({
        content: [{ type: "text", text: "s" }],
        model: "t",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    // Second turn ends the run.
    let call = 0;
    const inner = gateway.inferStream;
    gateway.inferStream = mock(async function* (...args: unknown[]) {
      call++;
      if (call === 1) {
        yield* inner(...args);
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    });

    const registry = {
      toLlmTools: mock(() => []),
      get: mock((name: string) => ({
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: "execute",
          permissionLevel: "auto",
        },
      })),
      execute: mock(async (input: any) => {
        // A long tool reporting progress mid-flight.
        input.onProgress?.("read_file src/a.ts");
        await new Promise((r) => setTimeout(r, 5));
        input.onProgress?.("edit_file src/a.ts");
        await new Promise((r) => setTimeout(r, 5));
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: "ok",
          durationMs: 10,
        };
      }),
    } as any;

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 4, systemPrompt: "s" } as any,
      gateway,
      registry,
    );
    const events: AgentTurnEvent[] = [];
    for await (const e of loop.run("go", "s1", "/tmp")) events.push(e);

    const progress = events.filter((e) => e.type === "tool_progress") as any[];
    expect(progress.map((p) => p.note)).toEqual(["read_file src/a.ts", "edit_file src/a.ts"]);
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_progress")).toBeLessThan(types.indexOf("tool_call_end"));
  });
});
