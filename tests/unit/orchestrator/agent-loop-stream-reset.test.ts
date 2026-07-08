/**
 * AgentLoop handling of gateway stream_reset (mid-stream retry):
 *  - Partial text/tool calls accumulated before the reset must be DISCARDED —
 *    the persisted assistant message contains only the re-streamed response,
 *    and half-formed tool calls never execute.
 *  - Context-overflow errors force a compaction and retry instead of dying.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop, isContextOverflowError } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  const executed: string[] = [];
  return {
    executed,
    toLlmTools: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => {
      executed.push(input.callId);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    },
  } as any;
}

const textDelta = (text: string) => ({
  type: "content_delta",
  contentIndex: 0,
  delta: { type: "text_delta", text },
});

const stopEvent = (stopReason = "end_turn") => ({
  type: "message_stop",
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 },
});

function loopWith(gateway: any, extra: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 8,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      thinking: false,
      ...extra,
    },
    gateway,
    makeRegistry(),
  );
}

describe("AgentLoop — stream_reset discards the partial message", () => {
  test("text before the reset never reaches the transcript; tool calls before the reset never run", async () => {
    const gateway = {
      inferStream: async function* () {
        // Partial junk that the retry supersedes:
        yield textDelta("HALF-ANSWER-");
        yield { type: "tool_use_start", toolCallId: "t-stale", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "t-stale", partialJson: '{"pa' };
        // Gateway decided to retry:
        yield { type: "stream_reset" };
        // Clean re-stream:
        yield textDelta("Final clean answer.");
        yield stopEvent();
      },
    } as any;

    const loop = loopWith(gateway);
    const events = await collect(loop.run("go", "s1", "/ws"));

    // The reset is surfaced to UIs plus an explanatory notice.
    expect(events.some((e) => e.type === "stream_reset")).toBe(true);
    expect(
      events.some((e) => e.type === "notice" && /interrupted mid-stream/i.test(e.message)),
    ).toBe(true);

    // The persisted assistant message holds ONLY the re-streamed text.
    const assistant = loop.getMessages().find((m: Message) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const text = assistant!.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(text).toBe("Final clean answer.");
    expect(text).not.toContain("HALF-ANSWER");

    // The stale half-formed tool call was dropped, not executed.
    expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });
});

describe("AgentLoop — context-overflow recovery", () => {
  test("isContextOverflowError matches real provider wordings", () => {
    expect(isContextOverflowError("prompt is too long: 250134 tokens > 200000 maximum")).toBe(true);
    expect(
      isContextOverflowError(
        "This model's maximum context length is 128000 tokens. However, you requested 131000 tokens",
      ),
    ).toBe(true);
    expect(isContextOverflowError("400 context_length_exceeded")).toBe(true);
    expect(isContextOverflowError("The input token count exceeds the maximum allowed")).toBe(true);
    expect(isContextOverflowError("rate limited, retry in 5s")).toBe(false);
    expect(isContextOverflowError("invalid api key")).toBe(false);
  });

  test("an over-limit rejection force-compacts and retries instead of dying", async () => {
    let call = 0;
    const gateway = {
      inferStream: async function* () {
        call++;
        if (call === 1) {
          yield { type: "error", error: "prompt is too long: 210000 tokens > 200000 maximum" };
          return;
        }
        yield textDelta("Recovered after compaction.");
        yield stopEvent();
      },
    } as any;

    let forceSeen: boolean | undefined;
    const contextEngine = {
      buildPrompt: (system: string, _tools: unknown[], messages: Message[]) => ({
        messages,
        system,
        tools: [],
        totalTokens: 1,
        evictedCount: 0,
      }),
      noteRealUsage: () => {},
      shouldCompact: () => false,
      compactWorkingSet: async (messages: Message[], _k: number, opts?: { force?: boolean }) => {
        forceSeen = opts?.force;
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "[summary]" }] } as Message,
            ...messages.slice(-1),
          ],
          compacted: true,
        };
      },
    } as unknown as ContextEngine;

    const loop = loopWith(gateway, { contextEngine });
    const events = await collect(loop.run("go", "s1", "/ws"));

    expect(forceSeen).toBe(true);
    expect(
      events.some((e) => e.type === "notice" && /context window exceeded/i.test(e.message)),
    ).toBe(true);
    // No unrecoverable error; the run completed after the retry.
    expect(events.some((e) => e.type === "error" && e.recoverable === false)).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_complete");
    expect(call).toBe(2);
  });
});
