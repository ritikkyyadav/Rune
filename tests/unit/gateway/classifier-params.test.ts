/**
 * Wire shapes for the Auto-mode fast classifier: a tiny, thinking-disabled,
 * non-streaming call. Every provider must translate `thinking: {enabled:false}`
 * into its cheapest reasoning dial and keep a small max-token budget usable —
 * otherwise reasoning models burn the whole budget on hidden thoughts and the
 * classifier sees an empty string.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import {
  GoogleProvider,
  geminiThinkingConfig,
} from "../../../packages/llm-gateway/src/providers/google";
import { OllamaProvider } from "../../../packages/llm-gateway/src/providers/ollama";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";
import { toResponsesBody } from "../../../packages/llm-gateway/src/providers/codex";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fastRequest(over: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Evaluate the LAST call." }] }],
    system: "Output exactly one token: BLOCK or ALLOW.",
    model: "gpt-5",
    provider: "openai",
    maxTokens: 64,
    temperature: 0,
    thinking: { enabled: false },
    stream: false,
    ...over,
  };
}

/** Capture the body the OpenAI SDK would send by stubbing the client seam. */
function captureOpenAI(provider: OpenAIProvider): () => Record<string, unknown> {
  let body: Record<string, unknown> = {};
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          body = params;
          return {
            id: "r",
            model: params.model,
            choices: [{ message: { content: "ALLOW" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          };
        },
      },
    },
  };
  return () => body;
}

describe("OpenAI fast-classifier params", () => {
  test("gpt-5 family with thinking disabled sends reasoning_effort minimal + max_completion_tokens", async () => {
    const provider = new OpenAIProvider("k");
    const body = captureOpenAI(provider);
    const res = await provider.infer(fastRequest({ model: "gpt-5" }));
    expect(body().reasoning_effort).toBe("minimal");
    expect(body().max_completion_tokens).toBe(64);
    expect(body().max_tokens).toBeUndefined();
    expect(res.content[0]).toEqual({ type: "text", text: "ALLOW" });
  });

  test("gpt-5.x point releases use 'none', codex and o-series fall back to 'low'", () => {
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5-mini")).toBe("minimal");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5-nano")).toBe("minimal");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5.1")).toBe("none");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5.5")).toBe("none");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5-codex")).toBe("low");
    expect(OpenAIProvider.minimalReasoningEffort("o3")).toBe("low");
    expect(OpenAIProvider.minimalReasoningEffort("o4-mini")).toBe("low");
  });

  test("thinking enabled keeps the caller's effort (default high)", async () => {
    const provider = new OpenAIProvider("k");
    const body = captureOpenAI(provider);
    await provider.infer(
      fastRequest({ model: "o4-mini", thinking: { enabled: true, effort: "medium" } }),
    );
    expect(body().reasoning_effort).toBe("medium");
    await provider.infer(fastRequest({ model: "o4-mini", thinking: undefined }));
    expect(body().reasoning_effort).toBe("high");
  });

  test("OpenAI-compatible hosts keep classic params and never send reasoning_effort", async () => {
    const provider = new OpenAIProvider("k", "https://openrouter.ai/api/v1", "openrouter");
    const body = captureOpenAI(provider);
    await provider.infer(fastRequest({ model: "gpt-5", provider: "openrouter" }));
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().max_tokens).toBe(64);
  });
});

describe("Gemini fast-classifier params", () => {
  test("thinking disabled → thinkingBudget 0 on 2.5 Flash, 128 floor on 2.5 Pro, low level on 3.x", () => {
    expect(
      geminiThinkingConfig({ model: "gemini-2.5-flash", thinking: { enabled: false } }),
    ).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
    expect(
      geminiThinkingConfig({ model: "gemini-2.5-flash-lite", thinking: { enabled: false } }),
    ).toEqual({ thinkingBudget: 0, includeThoughts: false });
    expect(geminiThinkingConfig({ model: "gemini-2.5-pro", thinking: { enabled: false } })).toEqual(
      {
        thinkingBudget: 128,
        includeThoughts: false,
      },
    );
    expect(
      geminiThinkingConfig({ model: "gemini-3-pro-preview", thinking: { enabled: false } }),
    ).toEqual({ thinkingLevel: "low", includeThoughts: false });
  });

  test("models without a thinking dial get no thinkingConfig at all", () => {
    expect(
      geminiThinkingConfig({ model: "gemini-2.0-flash", thinking: { enabled: false } }),
    ).toBeUndefined();
    expect(geminiThinkingConfig({ model: "gemini-2.5-flash" })).toBeUndefined();
    expect(
      geminiThinkingConfig({ model: "gemini-2.5-flash", thinking: { enabled: true } }),
    ).toBeUndefined();
  });

  test("the generateContent body carries thinkingConfig inside generationConfig", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "reasoning…", thought: true }, { text: "BLOCK" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await new GoogleProvider("k").infer(
      fastRequest({ model: "gemini-2.5-flash", provider: "google" }),
    );
    const generationConfig = sent.generationConfig as Record<string, unknown>;
    expect(generationConfig.maxOutputTokens).toBe(64);
    expect(generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: false });
    // Thought parts never leak into the answer.
    expect(res.content).toEqual([{ type: "text", text: "BLOCK" }]);
  });
});

describe("Ollama fast-classifier params", () => {
  test("thinking disabled → top-level think:false with num_predict budget", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          message: { role: "assistant", content: "ALLOW" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 4,
          eval_count: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await new OllamaProvider().infer(
      fastRequest({ model: "qwen3:8b", provider: "ollama" }),
    );
    expect(sent.think).toBe(false);
    expect((sent.options as Record<string, unknown>).num_predict).toBe(64);
    expect(res.content).toEqual([{ type: "text", text: "ALLOW" }]);
  });

  test("without the flag no think field is sent (model default)", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ message: { role: "assistant", content: "x" }, done: true }),
        {
          status: 200,
        },
      );
    }) as typeof fetch;
    await new OllamaProvider().infer(
      fastRequest({ model: "llama3", provider: "ollama", thinking: undefined }),
    );
    expect("think" in sent).toBe(false);
  });
});

describe("Anthropic / Codex fast-classifier params", () => {
  test("Anthropic sends no thinking block when thinking is disabled", () => {
    const provider = new AnthropicProvider("k");
    const build = (
      provider as unknown as {
        buildThinkingParam(r: InferenceRequest): {
          thinking?: unknown;
          needsInterleavedBeta: boolean;
        };
      }
    ).buildThinkingParam.bind(provider);
    expect(
      build(fastRequest({ model: "claude-sonnet-4-6", provider: "anthropic" })).thinking,
    ).toBeUndefined();
    expect(
      build(
        fastRequest({
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          thinking: { enabled: true },
        }),
      ).thinking,
    ).toBeDefined();
  });

  test("Codex omits the reasoning item when thinking is disabled", () => {
    const body = toResponsesBody(fastRequest({ model: "gpt-5.6-terra", provider: "codex" }), false);
    expect(body.reasoning).toBeUndefined();
    expect(body.include).toBeUndefined();
    const reasoned = toResponsesBody(
      fastRequest({ model: "gpt-5.6-terra", provider: "codex", thinking: { enabled: true } }),
      false,
    );
    expect(reasoned.reasoning).toEqual({ summary: "auto", effort: "high" });
  });
});
