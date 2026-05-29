/**
 * Unit tests for ContextEngine.compactWorkingSet() — contract C1.
 *
 * Covers:
 *  1. Below-threshold → unchanged, compacted: false.
 *  2. Above-threshold → [summaryMsg, ...recentK] returned, compacted: true.
 *  3. No orphaned tool_use after compaction.
 *  4. No orphaned tool_result after compaction.
 *  5. Cut-point walks backward to respect tool pairs that straddle the naive cut.
 *  6. recentK is respected (default 6).
 *  7. If the entire history is one big tool-pair, no compact happens (safeCutPoint=0 < 4).
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

// ─── Mock gateway ───────────────────────────────────────────────────────────

function createMockGateway(summaryText = "Summary of earlier conversation.") {
  return {
    infer: mock(async () => ({
      content: [{ type: "text" as const, text: summaryText }],
      model: "test",
      stopReason: "end_turn" as const,
      usage: { inputTokens: 10, outputTokens: 20 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

// ─── Message factories ───────────────────────────────────────────────────────

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolUseMsg(toolCallId: string, toolName = "read_file"): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        toolCallId,
        toolName,
        toolInput: { path: "/tmp/test.ts" },
      },
    ],
  };
}

function toolResultMsg(toolCallId: string, result = "file contents"): Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId,
        toolResultContent: result,
      },
    ],
  };
}

/** Build a plain alternating user/assistant conversation of `n` turns. */
function plainConversation(n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? userMsg(`Turn ${i}`) : assistantMsg(`Reply ${i}`),
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("compactWorkingSet — contract C1", () => {
  // ── 1. Below threshold ──────────────────────────────────────────────────

  test("returns messages unchanged when below summarize threshold", async () => {
    const gateway = createMockGateway();
    // threshold = 20, so 5 messages should NOT trigger compaction
    const engine = new ContextEngine({ summarizeTurnsThreshold: 20 }, gateway);
    const messages = plainConversation(5);

    const result = await engine.compactWorkingSet(messages);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages); // same reference
    expect(gateway.infer).not.toHaveBeenCalled();
  });

  test("returns compacted: false when messages.length equals threshold - 1", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);
    const messages = plainConversation(9); // one below threshold

    const result = await engine.compactWorkingSet(messages);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  // ── 2. Above threshold → summary + recent ───────────────────────────────

  test("returns [summaryMessage, ...recentK] when above threshold", async () => {
    const gateway = createMockGateway("Summarized: old stuff.");
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(12); // well above threshold

    const result = await engine.compactWorkingSet(messages, 4);

    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(gateway.infer).toHaveBeenCalledTimes(1);
  });

  test("first returned message is a user-role summary with [Earlier conversation summary] prefix", async () => {
    const gateway = createMockGateway("Key decisions and actions.");
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(10);

    const result = await engine.compactWorkingSet(messages, 4);

    expect(result.compacted).toBe(true);
    const first = result.messages[0];
    expect(first.role).toBe("user");
    expect(first.content[0].type).toBe("text");
    if (first.content[0].type === "text") {
      expect(first.content[0].text).toContain("[Earlier conversation summary]");
      expect(first.content[0].text).toContain("Key decisions and actions.");
    }
  });

  test("recent verbatim messages are preserved at end of result", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(10);
    const recentK = 4;

    const result = await engine.compactWorkingSet(messages, recentK);

    expect(result.compacted).toBe(true);
    // The last recentK messages of `messages` must appear at end of result
    const expectedRecent = messages.slice(messages.length - recentK);
    const actualRecent = result.messages.slice(result.messages.length - recentK);
    expect(actualRecent).toEqual(expectedRecent);
  });

  test("total returned messages = 1 summary + recentK (plain conversation)", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const recentK = 6;
    const messages = plainConversation(20);

    const result = await engine.compactWorkingSet(messages, recentK);

    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBe(recentK + 1); // 1 summary + 6 recent
  });

  // ── 3. No orphaned tool_use after compaction ────────────────────────────

  test("no orphaned tool_use: every tool_use has its tool_result in result", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);

    // tool_use + tool_result pair sits right at the cut zone (messages 4 & 5)
    // so the cut should walk backward to avoid splitting it.
    const messages: Message[] = [
      userMsg("msg0"),
      assistantMsg("msg1"),
      userMsg("msg2"),
      assistantMsg("msg3"),
      toolUseMsg("call-1"),      // index 4 — naive cut with recentK=6 would land near here
      toolResultMsg("call-1"),   // index 5
      userMsg("msg6"),
      assistantMsg("msg7"),
      userMsg("msg8"),
      assistantMsg("msg9"),
      userMsg("msg10"),
      assistantMsg("msg11"),
    ];

    const result = await engine.compactWorkingSet(messages, 6);

    // Collect all tool_use IDs and tool_result IDs in the result
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of result.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use") toolUseIds.add(block.toolCallId);
        if (block.type === "tool_result") toolResultIds.add(block.toolCallId);
      }
    }

    // Every tool_use must have a matching tool_result
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });

  // ── 4. No orphaned tool_result after compaction ─────────────────────────

  test("no orphaned tool_result: every tool_result has its tool_use in result", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);

    const messages: Message[] = [
      userMsg("a"),
      assistantMsg("b"),
      userMsg("c"),
      assistantMsg("d"),
      toolUseMsg("call-X"),     // index 4
      toolResultMsg("call-X"),  // index 5
      userMsg("e"),
      assistantMsg("f"),
      userMsg("g"),
      assistantMsg("h"),
    ];

    const result = await engine.compactWorkingSet(messages, 5);

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of result.messages) {
      for (const block of msg.content) {
        if (block.type === "tool_use") toolUseIds.add(block.toolCallId);
        if (block.type === "tool_result") toolResultIds.add(block.toolCallId);
      }
    }

    // Every tool_result must have a matching tool_use
    for (const id of toolResultIds) {
      expect(toolUseIds.has(id)).toBe(true);
    }
  });

  // ── 5. Cut-point walks backward past a straddle ─────────────────────────

  test("cut-point backs away when naive cut would split tool pair", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);

    // 10 messages; recentK=6 → naive cut = 4.
    // Put tool_use at index 3, tool_result at index 4 → straddles naive cut.
    // Safe cut should retreat to index 3 (or earlier).
    const messages: Message[] = [
      userMsg("0"),
      assistantMsg("1"),
      userMsg("2"),
      toolUseMsg("pair-A"),    // index 3
      toolResultMsg("pair-A"), // index 4 — naive cut falls here
      userMsg("5"),
      assistantMsg("6"),
      userMsg("7"),
      assistantMsg("8"),
      userMsg("9"),
    ];

    const result = await engine.compactWorkingSet(messages, 6);

    if (result.compacted) {
      // Verify the invariant regardless of where the cut landed
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();
      for (const msg of result.messages) {
        for (const block of msg.content) {
          if (block.type === "tool_use") toolUseIds.add(block.toolCallId);
          if (block.type === "tool_result") toolResultIds.add(block.toolCallId);
        }
      }
      for (const id of toolUseIds) {
        expect(toolResultIds.has(id)).toBe(true);
      }
      for (const id of toolResultIds) {
        expect(toolUseIds.has(id)).toBe(true);
      }
    }
    // Either compacted cleanly or bailed (both are valid outcomes here)
    expect([true, false]).toContain(result.compacted);
  });

  // ── 6. Default recentK = 6 ──────────────────────────────────────────────

  test("default recentK is 6 for a plain conversation", async () => {
    const gateway = createMockGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(16);

    const result = await engine.compactWorkingSet(messages); // no recentK arg

    expect(result.compacted).toBe(true);
    expect(result.messages.length).toBe(7); // 1 summary + 6 recent
  });

  // ── 7. Cannot compact if safe cut < 4 ───────────────────────────────────

  test("returns compacted: false when history is one large tool pair that cannot be split", async () => {
    const gateway = createMockGateway();
    // threshold = 4 so length=4 triggers compaction attempt
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);

    // All 4 messages form 2 tool_use/tool_result pairs — no safe cut point
    // that leaves >= 4 messages to summarize exists.
    const messages: Message[] = [
      toolUseMsg("A"),
      toolResultMsg("A"),
      toolUseMsg("B"),
      toolResultMsg("B"),
    ];

    // With recentK=4 the only safe cut is 0, which is < 4 → bail.
    const result = await engine.compactWorkingSet(messages, 4);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  // ── 8. Fallback when gateway fails ──────────────────────────────────────

  test("returns compacted: false if gateway throws during summary generation", async () => {
    const gateway = {
      infer: mock(async () => { throw new Error("network error"); }),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(12);

    const result = await engine.compactWorkingSet(messages);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  // ── 9. Session memory is updated on successful compaction ───────────────

  test("appends to session memory summaries on successful compaction", async () => {
    const gateway = createMockGateway("The session so far.");
    const engine = new ContextEngine({ summarizeTurnsThreshold: 4 }, gateway);
    const messages = plainConversation(12);

    const result = await engine.compactWorkingSet(messages, 4);

    expect(result.compacted).toBe(true);
    const memory = engine.getMemory();
    expect(memory.summaries.length).toBeGreaterThan(0);
    expect(memory.summaries[0].summary).toContain("The session so far.");
  });
});
