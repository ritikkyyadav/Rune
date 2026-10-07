/**
 * T1 — a turn's tool calls go on record before the first one runs.
 *
 * The engine writes what a run appended whenever an event passes through it,
 * and nothing is yielded between the model's call and the tool's return. A
 * process killed inside a tool therefore left no record the call was made.
 * `onBeforeTools` is the moment the engine is given to write it.
 *
 * The process-level half — a real kill, the log read back by the next process —
 * is `tests/integration/signal-shutdown.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

/** One turn that calls two tools, then an answer. */
function makeGateway() {
  let turn = 0;
  return {
    inferStream: async function* () {
      turn++;
      if (turn === 1) {
        yield { type: "tool_use_start", toolCallId: "c1", toolName: "bash" };
        yield { type: "tool_use_stop", toolCallId: "c1", toolInput: { command: "npm publish" } };
        yield { type: "tool_use_start", toolCallId: "c2", toolName: "read_file" };
        yield { type: "tool_use_stop", toolCallId: "c2", toolInput: { path: "a.ts" } };
        yield { type: "message_stop", stopReason: "tool_use" };
      } else {
        yield { type: "content_delta", delta: { type: "text_delta", text: "published" } };
        yield { type: "message_stop", stopReason: "end_turn" };
      }
    },
    infer: async () => ({
      content: [{ type: "text", text: "s" }],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** A run, with everything that happened to it in the order it happened. */
async function run(onBeforeTools: (order: string[], loop: () => AgentLoop) => void) {
  const order: string[] = [];
  const registry = {
    toLlmTools: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => {
      order.push(`run ${input.toolName}`);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  // eslint-disable-next-line prefer-const
  let loop: AgentLoop;
  loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      onBeforeTools: () => onBeforeTools(order, () => loop),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    makeGateway(),
    registry,
  );
  const events: AgentTurnEvent[] = [];
  for await (const event of loop.run("publish it", "s1", "/tmp")) events.push(event);
  const terminal = events.find((e) => e.type === "turn_complete") as
    { stopReason: string } | undefined;
  return { order, stopReason: terminal?.stopReason };
}

describe("before a turn's tools run", () => {
  test("the engine is given the turn's calls, complete, before the first of them runs", async () => {
    const out = await run((order, loop) => {
      // What the engine would write at this moment: the assistant's message,
      // carrying every call of the turn, and no result yet.
      const pending = loop().takePendingPersist();
      const calls = pending
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_use")
        .map((b) => (b.type === "tool_use" ? b.toolName : ""));
      const results = pending.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
      order.push(`record ${calls.join("+")} with ${results.length} results`);
    });
    expect(out.order).toEqual([
      "record bash+read_file with 0 results",
      "run bash",
      "run read_file",
    ]);
    expect(out.stopReason).toBe("end_turn");
  });

  test("it is once per turn of calls, not once per call", async () => {
    const out = await run((order) => order.push("record"));
    expect(out.order.filter((entry) => entry === "record")).toHaveLength(1);
  });

  test("a recorder that throws does not cost the turn its tools", async () => {
    const out = await run((order) => {
      order.push("record");
      throw new Error("the database is locked");
    });
    expect(out.order).toEqual(["record", "run bash", "run read_file"]);
    expect(out.stopReason).toBe("end_turn");
  });
});
