/**
 * R5.3 of docs/program/rune-reliability-plan-20261014.md: when the context is
 * back over the threshold within two turns of a compaction, three times
 * running, auto-compaction stops and the run ends with a named error and the
 * fix — instead of paying a summariser call every other turn for a run that
 * cannot finish.
 */

import { describe, expect, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

/** A model that reads a different file every turn, then answers at `answerAt`. */
function readingGateway(answerAt: number) {
  const gw = {
    calls: 0,
    inferStream: async function* () {
      gw.calls++;
      if (gw.calls < answerAt) {
        const id = `c${gw.calls}`;
        yield { type: "tool_use_start", toolCallId: id, toolName: "read_file" };
        yield { type: "tool_use_stop", toolCallId: id, toolInput: { path: `src/f${gw.calls}.ts` } };
        yield {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        return;
      }
      yield { type: "content_start", contentIndex: 0 };
      yield {
        type: "content_delta",
        contentIndex: 0,
        delta: { type: "text_delta", text: "Done." },
      };
      yield { type: "content_stop", contentIndex: 0 };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as any;
  return gw;
}

/** A context engine that is over its threshold whenever `full(check)` says so. */
function engine(full: (check: number) => boolean) {
  const e = {
    checks: 0,
    compactions: 0,
    buildPrompt: (system: string, _tools: unknown[], messages: Message[]) => ({
      messages,
      system,
      tools: [],
      totalTokens: 1,
      evictedCount: 0,
    }),
    noteRealUsage: () => {},
    shouldCompact: () => full(++e.checks),
    compactWorkingSet: async (messages: Message[]) => {
      e.compactions++;
      return { messages, compacted: true };
    },
  };
  return e;
}

const registry = {
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
  execute: async (i: { toolName: string; callId: string }) => ({
    callId: i.callId,
    toolName: i.toolName,
    success: true,
    result: "contents",
    durationMs: 1,
  }),
} as any;

async function run(gw: unknown, contextEngine: unknown): Promise<AgentTurnEvent[]> {
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 40,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      suspendClock: false,
      contextEngine: contextEngine as ContextEngine,
    } as any,
    gw as any,
    registry,
  );
  const events: AgentTurnEvent[] = [];
  for await (const e of loop.run("read the files", "s1", "/tmp")) events.push(e);
  return events;
}

describe("compaction thrash", () => {
  test("a context full again every turn is compacted three times, then the run ends named", async () => {
    const ctx = engine(() => true);
    const gw = readingGateway(30);
    const events = await run(gw, ctx);

    expect(ctx.compactions).toBe(3);
    const fatal = events.find((e) => e.type === "error" && !(e as any).recoverable) as any;
    expect(fatal?.error).toContain("fills up again within 2 turns of being compacted");
    expect(fatal?.error).toContain("read large files in pages");
    const last = events.at(-1) as any;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("max_tokens");
    // It stopped at the fourth fill, not at the answer.
    expect(gw.calls).toBe(4);
  });

  test("a refill two turns after each compaction is still thrash", async () => {
    // Every second check is over the threshold: back within two turns, every time.
    const ctx = engine((check) => check % 2 === 0);
    const events = await run(readingGateway(30), ctx);
    expect(ctx.compactions).toBe(3);
    expect((events.at(-1) as any).stopReason).toBe("max_tokens");
  });

  test("a context that takes three turns to refill is compacted as often as it needs", async () => {
    // Every third check is over the threshold: slow enough to be real work.
    const ctx = engine((check) => check % 3 === 0);
    const gw = readingGateway(16);
    const events = await run(gw, ctx);

    expect(ctx.compactions).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.type === "error" && !(e as any).recoverable)).toBe(false);
    expect((events.at(-1) as any).stopReason).toBe("end_turn");
  });
});
