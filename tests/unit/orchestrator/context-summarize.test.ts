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
    // anthropic threw twice (configured summarizer, then its stock light
    // default), then google succeeded.
    expect(calls).toBe(3);
  });

  test("falls back to the live session model when the light-tier pick is retired", async () => {
    const models: string[] = [];
    const gateway = {
      infer: mock(async (req: any) => {
        models.push(req.model);
        if (req.model !== "gpt-oss:120b") {
          throw Object.assign(new Error("410 model was retired"), { status: 410 });
        }
        return {
          content: [{ type: "text" as const, text: "session-model summary" }],
          model: req.model,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      getRegisteredProviderNames: mock(() => ["ollama-turbo"]),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const ce = new ContextEngine({}, gateway);
    // The tier table rotted to a retired id, but the session model is alive.
    ce.setSummarizer("dead-light-model", "ollama-turbo", {
      model: "gpt-oss:120b",
      provider: "ollama-turbo",
    });

    const r = await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")]);

    expect(r).not.toBeNull();
    expect(r!.summary).toBe("session-model summary");
    expect(models).toContain("gpt-oss:120b");
  });

  test("memoizes retired summarizer models so later compactions skip them", async () => {
    const models: string[] = [];
    const gateway = {
      infer: mock(async (req: any) => {
        models.push(req.model);
        if (req.model === "dead-light-model") {
          throw Object.assign(new Error("410 model was retired"), { status: 410 });
        }
        return {
          content: [{ type: "text" as const, text: "ok" }],
          model: req.model,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      getRegisteredProviderNames: mock(() => ["ollama-turbo"]),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const ce = new ContextEngine({}, gateway);
    ce.setSummarizer("dead-light-model", "ollama-turbo", {
      model: "live-model",
      provider: "ollama-turbo",
    });

    await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")]);
    const callsAfterFirst = models.length;
    await ce.summarizeConversation([userMsg("more"), assistantMsg("work")]);

    // First walk burned a call on the corpse; the second must not.
    expect(models.filter((m) => m === "dead-light-model")).toHaveLength(1);
    expect(models.length).toBe(callsAfterFirst + 1);
  });

  test("recovers via live model listing when every static candidate is gone", async () => {
    const models: string[] = [];
    const gateway = {
      infer: mock(async (req: any) => {
        models.push(req.model);
        if (req.model !== "freshly-launched") {
          throw Object.assign(new Error("410 model was retired"), { status: 410 });
        }
        return {
          content: [{ type: "text" as const, text: "recovered summary" }],
          model: req.model,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }),
      getRegisteredProviderNames: mock(() => ["ollama-turbo"]),
      registerProvider: mock(() => {}),
      getProvider: mock(() => ({
        listModels: async () => [{ id: "also-dead" }, { id: "freshly-launched" }],
      })),
      getTotalCost: mock(() => 0),
    } as any;
    const ce = new ContextEngine({}, gateway);
    ce.setSummarizer("dead-light-model", "ollama-turbo");

    const r = await ce.summarizeConversation([userMsg("hi"), assistantMsg("yo")]);

    expect(r).not.toBeNull();
    expect(r!.summary).toBe("recovered summary");

    // Self-heal: the next compaction goes straight to the discovered model.
    const before = models.length;
    await ce.summarizeConversation([userMsg("more"), assistantMsg("work")]);
    expect(models.length).toBe(before + 1);
    expect(models[models.length - 1]).toBe("freshly-launched");
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
