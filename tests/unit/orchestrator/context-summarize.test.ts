/**
 * Unit tests for ContextEngine.summarizeConversation() — backs `/compress`.
 *
 * Covers:
 *  1. Returns summary text plus source/summary token counts on success.
 *  2. Empty conversation → null, no gateway call.
 *  3. Gateway failure → null.
 *  4. Comprehensive system prompt + user focus instructions are forwarded.
 */

import { describe, test, expect, mock } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

function createMockGateway(summaryText = "A thorough summary.") {
  return {
    infer: mock(async () => ({
      content: [{ type: "text" as const, text: summaryText }],
      model: "test",
      stopReason: "end_turn" as const,
      usage: { inputTokens: 100, outputTokens: 50 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("ContextEngine.summarizeConversation — manual /compress", () => {
  test("returns summary text plus source & summary token counts", async () => {
    const gateway = createMockGateway("Goals: X. Did: Y. Next: Z.");
    const ce = new ContextEngine({}, gateway);
    const messages = [userMsg("please do X"), assistantMsg("doing X"), userMsg("status?")];

    const r = await ce.summarizeConversation(messages);

    expect(r).not.toBeNull();
    expect(r!.summary).toContain("Goals: X.");
    expect(r!.sourceTokens).toBeGreaterThan(0);
    expect(r!.summaryTokens).toBeGreaterThan(0);
    expect(gateway.infer).toHaveBeenCalledTimes(1);
  });

  test("returns null for an empty conversation without calling the gateway", async () => {
    const gateway = createMockGateway();
    const ce = new ContextEngine({}, gateway);

    const r = await ce.summarizeConversation([]);

    expect(r).toBeNull();
    expect(gateway.infer).not.toHaveBeenCalled();
  });

  test("returns null when summary generation throws", async () => {
    const gateway = {
      infer: mock(async () => {
        throw new Error("no api key");
      }),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const ce = new ContextEngine({}, gateway);

    const r = await ce.summarizeConversation([userMsg("hi"), assistantMsg("hello")]);

    expect(r).toBeNull();
  });

  test("summarizes with the active provider/model (not the anthropic default)", async () => {
    const gateway = createMockGateway("done");
    const ce = new ContextEngine({}, gateway);
    // The Engine calls this whenever the model/provider changes.
    ce.setSummarizer("gemini-2.5-flash", "google");

    await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")]);

    const req = gateway.infer.mock.calls[0]![0];
    expect(req.provider).toBe("google");
    expect(req.model).toBe("gemini-2.5-flash");
  });

  test("falls back to another registered provider when the active one fails", async () => {
    let calls = 0;
    const gateway = {
      infer: mock(async (req: any) => {
        calls++;
        if (req.provider === "anthropic") throw Object.assign(new Error("not registered"));
        return {
          content: [{ type: "text" as const, text: "fallback summary" }],
          model: req.model,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      getRegisteredProviderNames: mock(() => ["anthropic", "google"]),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const ce = new ContextEngine({}, gateway);
    ce.setSummarizer("claude-haiku-4-5-20251001", "anthropic");

    const r = await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")]);

    expect(r).not.toBeNull();
    expect(r!.summary).toBe("fallback summary");
    expect(calls).toBe(2); // anthropic threw, google succeeded
  });

  test("uses a comprehensive system prompt and forwards user focus instructions", async () => {
    const gateway = createMockGateway();
    const ce = new ContextEngine({}, gateway);

    await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")], "keep the API contract");

    const req = gateway.infer.mock.calls[0]![0];
    expect(req.system).toContain("compacting a conversation");
    const prompt = req.messages[0].content[0].text as string;
    expect(prompt).toContain("keep the API contract");
    // Comprehensive mode gets a larger output budget than rolling summaries (500).
    expect(req.maxTokens).toBeGreaterThanOrEqual(1000);
  });
});
