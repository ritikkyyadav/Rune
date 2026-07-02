/**
 * max_tokens (output truncation) handling in AgentLoop:
 *  1. A truncated response with pending tool calls must NOT execute them —
 *     their args may be salvaged-but-wrong. The calls are answered with error
 *     tool_results and the model is asked to retry.
 *  2. A truncated text-only response gets a "continue where you left off"
 *     nudge instead of being treated as a finished turn.
 *  3. Retries are bounded: a model that maxes out every response ends the
 *     turn with stopReason "max_tokens" instead of looping forever.
 *  4. The request's maxTokens is clamped to the model's per-response cap.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const emptyRegistry = {
  toLlmTools: mock(() => []),
  get: mock(() => undefined),
  execute: mock(async () => {
    throw new Error("execute must not be called for truncated tool calls");
  }),
} as any;

describe("AgentLoop max_tokens handling", () => {
  test("truncated tool calls are not executed; model is asked to retry", async () => {
    let turn = 0;
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        turn++;
        if (turn === 1) {
          yield ev("tool_use_start", { toolCallId: "t1", toolName: "write_file" });
          yield ev("tool_use_stop", { toolCallId: "t1", toolInput: { path: "x" } });
          yield ev("message_stop", { stopReason: "max_tokens" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "recovered" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, emptyRegistry);
    const events = await collect(loop.run("do it", "s1", "/tmp"));

    // The tool was never executed
    expect(emptyRegistry.execute).not.toHaveBeenCalled();
    // The loop retried and finished normally
    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("end_turn");
    // The retry request contains an error tool_result answering the call
    const secondReq = requests[1];
    const toolMsg = secondReq.messages.find((m: any) =>
      m.content.some((b: any) => b.type === "tool_result" && b.toolCallId === "t1"),
    );
    expect(toolMsg).toBeDefined();
    const resultBlock = toolMsg.content.find((b: any) => b.type === "tool_result");
    expect(resultBlock.isError).toBe(true);
    expect(resultBlock.toolResultContent).toContain("output-token limit");
  });

  test("truncated text response gets a continue nudge", async () => {
    let turn = 0;
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        turn++;
        if (turn === 1) {
          yield ev("content_delta", { delta: { type: "text_delta", text: "half an ans" } });
          yield ev("message_stop", { stopReason: "max_tokens" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "…wer" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, emptyRegistry);
    const events = await collect(loop.run("q", "s1", "/tmp"));

    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("end_turn");
    const nudge = requests[1].messages.find((m: any) =>
      m.content.some(
        (b: any) => b.type === "text" && String(b.text).includes("cut off by the output-token"),
      ),
    );
    expect(nudge).toBeDefined();
    expect(nudge.role).toBe("user");
  });

  test("truncation retries are bounded", async () => {
    const gateway = {
      inferStream: mock(async function* () {
        yield ev("content_delta", { delta: { type: "text_delta", text: "x" } });
        yield ev("message_stop", { stopReason: "max_tokens" });
      }),
    } as any;

    const loop = new AgentLoop({ model: "m", provider: "anthropic" }, gateway, emptyRegistry);
    const events = await collect(loop.run("q", "s1", "/tmp"));

    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("max_tokens");
    // 1 initial + 2 retries = 3 calls max
    expect(gateway.inferStream).toHaveBeenCalledTimes(3);
  });

  test("maxTokens is clamped to the model's output cap", async () => {
    const requests: any[] = [];
    const gateway = {
      inferStream: mock(async function* (req: any) {
        requests.push(req);
        yield ev("content_delta", { delta: { type: "text_delta", text: "hi" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }),
    } as any;

    // gpt-4o caps at 16384 — a 32k budget must be clamped down.
    const loop = new AgentLoop(
      { model: "gpt-4o", provider: "openai", maxTokens: 32000 },
      gateway,
      emptyRegistry,
    );
    await collect(loop.run("q", "s1", "/tmp"));
    expect(requests[0].maxTokens).toBe(16384);
  });
});
