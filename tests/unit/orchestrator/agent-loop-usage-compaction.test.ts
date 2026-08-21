/**
 * v2 structured events from the flat AgentLoop:
 *  - message_stop usage → one `usage` event with the provider's real counts
 *    (plus the context snapshot when an engine is attached);
 *  - a near-budget working set → one `compaction` event with before/after
 *    estimates from compactWorkingSet;
 *  - the gateway's typed `fallback` stream event passes through untouched.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { ContextEngine } from "../../../packages/orchestrator/src/context-engine";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: () => undefined,
    execute: async () => {
      throw new Error("no tools in this test");
    },
  } as any;
}

const textStop = (text: string) => [
  { type: "content_start", contentIndex: 0 },
  { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text } },
  { type: "content_stop", contentIndex: 0 },
  {
    type: "message_stop",
    stopReason: "end_turn",
    usage: { inputTokens: 1200, outputTokens: 340 },
  },
];

function gatewayYielding(...turns: any[][]) {
  let call = 0;
  return {
    inferStream: async function* () {
      const events = turns[Math.min(call, turns.length - 1)]!;
      call++;
      for (const e of events) yield e;
    },
  } as any;
}

function loopWith(gateway: any, contextEngine?: ContextEngine) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 4,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      verifyExecution: false,
      contextEngine,
    } as any,
    gateway,
    makeRegistry(),
  );
}

const byType = <T extends AgentTurnEvent["type"]>(events: AgentTurnEvent[], type: T) =>
  events.filter((e): e is Extract<AgentTurnEvent, { type: T }> => e.type === type);

describe("AgentLoop — v2 structured events", () => {
  test("provider usage surfaces as one usage event with real counts", async () => {
    const loop = loopWith(gatewayYielding(textStop("done")));
    const events = await collect(loop.run("go", "s1", "/ws"));
    const usage = byType(events, "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.inputTokens).toBe(1200);
    expect(usage[0]!.outputTokens).toBe(340);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  test("usage carries the context snapshot when an engine is attached", async () => {
    const contextEngine = {
      buildPrompt: async (messages: any, system: any) => ({
        messages,
        system,
        tools: [],
        totalTokens: 1,
        evictedCount: 0,
      }),
      noteRealUsage: () => {},
      getContextUsage: () => ({ used: 41_000, limit: 100_000, percent: 41 }),
      shouldCompact: () => false,
      compactWorkingSet: async (messages: any) => ({ messages, compacted: false }),
    } as unknown as ContextEngine;
    const loop = loopWith(gatewayYielding(textStop("done")), contextEngine);
    const events = await collect(loop.run("go", "s1", "/ws"));
    const usage = byType(events, "usage");
    expect(usage[0]!.context).toEqual({ used: 41_000, limit: 100_000, percent: 41 });
  });

  test("near-budget working set → one compaction event with honest estimates", async () => {
    let compactions = 0;
    const contextEngine = {
      buildPrompt: async (messages: any, system: any) => ({
        messages,
        system,
        tools: [],
        totalTokens: 1,
        evictedCount: 0,
      }),
      noteRealUsage: () => {},
      getContextUsage: () => ({ used: 82_000, limit: 100_000, percent: 82 }),
      shouldCompact: () => compactions === 0,
      compactWorkingSet: async (messages: any) => {
        compactions++;
        return {
          messages,
          compacted: true,
          beforeTokens: 82_000,
          afterTokens: 51_000,
          summarizedCount: 14,
        };
      },
    } as unknown as ContextEngine;
    const loop = loopWith(gatewayYielding(textStop("done")), contextEngine);
    const events = await collect(loop.run("go", "s1", "/ws"));
    const compaction = byType(events, "compaction");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toMatchObject({
      beforeTokens: 82_000,
      afterTokens: 51_000,
      limitTokens: 100_000,
      summarizedCount: 14,
    });
  });

  test("the gateway's typed fallback event passes through to the UI", async () => {
    const loop = loopWith(
      gatewayYielding([
        {
          type: "fallback",
          from: { provider: "google", model: "gemini-2.5-flash" },
          to: { provider: "openrouter", model: "qwen3" },
          status: 429,
          reason: "rate limited",
        },
        ...textStop("recovered"),
      ]),
    );
    const events = await collect(loop.run("go", "s1", "/ws"));
    const fallback = byType(events, "fallback");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.from.provider).toBe("google");
    expect(fallback[0]!.to.provider).toBe("openrouter");
    expect(fallback[0]!.status).toBe(429);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });
});
