/**
 * compact_context — the /compress behaviour as a model-invocable tool.
 *  - the tool flags the context engine and reports usage; it never throws
 *  - ContextEngine.requestCompaction forces the next shouldCompact/
 *    compactWorkingSet pair even below the turn threshold
 *  - the request flag is consumed by the attempt (fruitless compactions
 *    can't retrigger forever)
 */

import { describe, test, expect } from "bun:test";
import {
  createCompactTool,
  COMPACT_TOOL_SCHEMA,
} from "../../../packages/orchestrator/src/compact-tool";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}
/**
 * Turns with a body: compaction now declines to apply a "compaction" that
 * would leave the working set no smaller than it found it (P10.8), and a
 * six-token transcript is smaller than any summary of it. The contract under
 * test here is the request flag, not that arithmetic.
 */
const conversation = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) =>
    msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}: ${"context ".repeat(60)}`),
  );

function summarizerGateway() {
  return {
    getRegisteredProviderNames: () => [],
    infer: async () => ({
      id: "r1",
      content: [{ type: "text", text: "SUMMARY: goals, files, next step." }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "m",
    }),
  } as any;
}

const input = {
  toolName: "compact_context",
  callId: "c1",
  args: {},
  sessionId: "s",
  workspaceRoot: "/ws",
};

describe("compact_context tool", () => {
  test("schema: auto-permission, instant, no args", () => {
    expect(COMPACT_TOOL_SCHEMA.name).toBe("compact_context");
    expect(COMPACT_TOOL_SCHEMA.permissionLevel).toBe("auto");
    expect(COMPACT_TOOL_SCHEMA.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  test("execute flags the engine and reports usage", async () => {
    let called = 0;
    const tool = createCompactTool({
      requestCompaction: () => {
        called++;
        return { used: 70_000, limit: 100_000, percent: 70 };
      },
    });
    const out = await tool.execute(input);
    expect(called).toBe(1);
    expect(out.success).toBe(true);
    expect(out.result).toContain("Compaction scheduled");
    expect(out.result).toContain("70%");
  });

  test("a throwing dependency surfaces as a failed result, never a throw", async () => {
    const tool = createCompactTool({
      requestCompaction: () => {
        throw new Error("engine gone");
      },
    });
    const out = await tool.execute(input);
    expect(out.success).toBe(false);
    expect(out.error).toContain("engine gone");
  });
});

describe("ContextEngine.requestCompaction", () => {
  test("forces shouldCompact and a below-threshold compaction, then is consumed", async () => {
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, summarizerGateway());
    expect(engine.shouldCompact()).toBe(false);

    engine.requestCompaction();
    expect(engine.shouldCompact()).toBe(true);

    // 6 messages is below the threshold of 10 — only the request forces it.
    const r = await engine.compactWorkingSet(conversation(6), 2);
    expect(r.compacted).toBe(true);

    // Consumed: back to normal behaviour.
    expect(engine.shouldCompact()).toBe(false);
    const again = await engine.compactWorkingSet(conversation(6), 2);
    expect(again.compacted).toBe(false);
  });

  test("the flag is consumed even when there is nothing to compact", async () => {
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, summarizerGateway());
    engine.requestCompaction();
    const r = await engine.compactWorkingSet(conversation(2), 6);
    expect(r.compacted).toBe(false);
    expect(engine.shouldCompact()).toBe(false);
  });
});
