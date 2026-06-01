import { describe, test, expect, afterEach } from "bun:test";
import { GoogleProvider } from "../../../packages/llm-gateway/src/providers/google";
import { providerSupportsNativeSearch } from "../../../packages/llm-gateway/src/types";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockGemini(captured: { body?: any }, candidate: unknown): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    captured.body = JSON.parse(String(init?.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        candidates: [candidate],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    } as Response;
  }) as typeof fetch;
}

const baseReq = (enableWebSearch: boolean): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "latest news?" }] }],
  model: "gemini-2.5-flash",
  provider: "google",
  maxTokens: 100,
  stream: false,
  enableWebSearch,
});

describe("providerSupportsNativeSearch", () => {
  test("only google and anthropic ground natively", () => {
    expect(providerSupportsNativeSearch("google")).toBe(true);
    expect(providerSupportsNativeSearch("anthropic")).toBe(true);
    expect(providerSupportsNativeSearch("openrouter")).toBe(false);
    expect(providerSupportsNativeSearch("openai")).toBe(false);
    expect(providerSupportsNativeSearch("ollama")).toBe(false);
  });
});

describe("GoogleProvider native grounding", () => {
  test("enableWebSearch adds the googleSearch tool to the request", async () => {
    const captured: { body?: any } = {};
    mockGemini(captured, { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" });
    await new GoogleProvider("key").infer(baseReq(true));
    expect(captured.body.tools).toContainEqual({ googleSearch: {} });
  });

  test("no tools added when grounding is disabled and no function tools", async () => {
    const captured: { body?: any } = {};
    mockGemini(captured, { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" });
    await new GoogleProvider("key").infer(baseReq(false));
    expect(captured.body.tools).toBeUndefined();
  });

  test("groundingMetadata is surfaced as a Sources citation list", async () => {
    const captured: { body?: any } = {};
    mockGemini(captured, {
      content: { parts: [{ text: "The answer." }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "Example A" } },
          { web: { uri: "https://example.com/a", title: "Example A" } }, // duplicate → deduped
          { web: { uri: "https://example.com/b", title: "Example B" } },
        ],
      },
    });
    const res = await new GoogleProvider("key").infer(baseReq(true));
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("The answer.");
    expect(text).toContain("Sources:");
    expect(text).toContain("[Example A](https://example.com/a)");
    expect(text).toContain("[Example B](https://example.com/b)");
    // Deduped — only one Example A entry.
    expect(text.match(/Example A/g)?.length).toBe(1);
  });
});
