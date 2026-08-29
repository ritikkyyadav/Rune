/**
 * The transcript invariant every tool-calling provider depends on: each
 * `tool_use` block in an assistant message has a matching `tool_result`.
 *
 * The Codex/Responses translation is a straight 1:1 map (tool_use →
 * function_call, tool_result → function_call_output), so one unpaired call
 * makes the NEXT request 400 with "No tool output found for function call" —
 * and because the transcript is persisted, it poisons that session for good
 * rather than failing one turn.
 *
 * This was always true, but it used to be nearly unreachable: the codex
 * provider sent `parallel_tool_calls: false`, so a turn carried one call.
 * With parallel calls enabled a turn carries up to `maxParallelTools`, and a
 * batch where SOME calls are refused by the permission gate is the ordinary
 * case rather than a corner. Pinned here so the pairing can never regress
 * quietly into an unrecoverable session.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { Message, ContentBlock } from "../../../packages/llm-gateway/src/types";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** One turn emitting N tool calls, then a turn that ends with text. */
function gatewayEmitting(calls: Array<{ id: string; name: string }>) {
  let turn = 0;
  return {
    inferStream: mock(async function* () {
      turn++;
      if (turn === 1) {
        for (const c of calls) {
          yield ev("tool_use_start", { toolCallId: c.id, toolName: c.name });
          yield ev("tool_use_stop", { toolCallId: c.id, toolInput: { path: `${c.id}.ts` } });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
  } as any;
}

function registry(opts: { throwOn?: string } = {}) {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => {
      // A tool that throws must still not break pairing: the registry contract
      // is that execute() converts a throw into a failed ToolCallOutput.
      if (opts.throwOn && input.callId === opts.throwOn) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: "exploded",
          durationMs: 1,
        };
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    }),
  } as any;
}

function idsOf(messages: Message[], kind: "tool_use" | "tool_result"): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content as ContentBlock[]) {
      if (b.type === kind) out.push(b.toolCallId);
    }
  }
  return out;
}

function loopWith(gateway: any, reg: any, permission?: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "codex",
      maxTokens: 100,
      maxTurns: 6,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
    },
    gateway,
    reg,
    permission,
  );
}

const BATCH = [
  { id: "c1", name: "read_file" },
  { id: "c2", name: "read_file" },
  { id: "c3", name: "read_file" },
  { id: "c4", name: "read_file" },
];

describe("every tool_use gets a tool_result", () => {
  test("a full parallel batch pairs one-to-one", async () => {
    const loop = loopWith(gatewayEmitting(BATCH), registry());
    await drain(loop.run("go", "s", "/ws"));
    const messages = loop.getMessages();
    expect(idsOf(messages, "tool_use")).toEqual(["c1", "c2", "c3", "c4"]);
    expect(idsOf(messages, "tool_result")).toEqual(["c1", "c2", "c3", "c4"]);
  });

  test("a DENIED call inside the batch is still answered", async () => {
    // The realistic unpaired-call risk: the permission gate refuses one member
    // of a batch. A refusal is a result, not an absence.
    const deny = async ({ toolName: _t, args }: any) =>
      args?.path === "c2.ts" ? { allowed: false, reason: "nope" } : { allowed: true };
    const loop = loopWith(gatewayEmitting(BATCH), registry(), deny);
    await drain(loop.run("go", "s", "/ws"));
    const messages = loop.getMessages();
    expect(idsOf(messages, "tool_result")).toEqual(idsOf(messages, "tool_use"));
    expect(idsOf(messages, "tool_result")).toContain("c2");
  });

  test("a failing tool is still answered", async () => {
    const loop = loopWith(gatewayEmitting(BATCH), registry({ throwOn: "c3" }));
    await drain(loop.run("go", "s", "/ws"));
    const messages = loop.getMessages();
    expect(idsOf(messages, "tool_result")).toEqual(idsOf(messages, "tool_use"));
  });

  test("results keep the order the model issued the calls in", async () => {
    // Concurrency must not reorder the transcript: providers match on id, but
    // a reordered transcript is still a different conversation than happened.
    const loop = loopWith(gatewayEmitting(BATCH), registry());
    await drain(loop.run("go", "s", "/ws"));
    expect(idsOf(loop.getMessages(), "tool_result")).toEqual(["c1", "c2", "c3", "c4"]);
  });
});
