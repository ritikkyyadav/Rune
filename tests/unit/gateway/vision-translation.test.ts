/**
 * Vision pipeline, wire side: every provider must either SEND image blocks in
 * its native format or replace them with an explicit omission note the model
 * can act on honestly. Silent drops are how "I inspected the image" lies are
 * born.
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import { OpenRouterProvider } from "../../../packages/llm-gateway/src/providers/openrouter";
import { GoogleProvider } from "../../../packages/llm-gateway/src/providers/google";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";
import { OllamaProvider } from "../../../packages/llm-gateway/src/providers/ollama";
import type { Message } from "../../../packages/llm-gateway/src/types";

const IMG = { type: "image" as const, mediaType: "image/webp", data: "QUJD" };
const messages: Message[] = [
  { role: "user", content: [IMG, { type: "text", text: "match this mockup" }] },
];

describe("vision wire translation", () => {
  test("a vision-capable OpenAI model sends image_url data-URL parts before the text", () => {
    const p = new OpenAIProvider("k") as any;
    const out = p.toOpenAIMessages(messages, undefined, undefined, "gpt-4o");
    const user = out.find((m: any) => m.role === "user");
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/webp;base64,QUJD" },
    });
    expect(user.content[1]).toEqual({ type: "text", text: "match this mockup" });
  });

  // P8.6: the gate reads the MODEL now. It used to read the provider NAME,
  // which meant a Claude model behind OpenRouter — which sees images perfectly
  // well — had its screenshots stripped with a note blaming the transport.
  test("a vision-capable model behind OpenRouter now gets the pixels", () => {
    const p = new OpenRouterProvider("k") as any;
    const out = p.inner.toOpenAIMessages(
      messages,
      undefined,
      undefined,
      "anthropic/claude-sonnet-4-6",
    );
    const user = out.find((m: any) => m.role === "user");
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/webp;base64,QUJD" },
    });
  });

  test("an unrecognized model omits pixels with an explicit note", () => {
    const p = new OpenAIProvider("k", "https://openrouter.ai/api/v1", "openrouter") as any;
    const out = p.toOpenAIMessages(messages, undefined, undefined, "stealth/ox-alpha");
    const user = out.find((m: any) => m.role === "user");
    expect(typeof user.content).toBe("string");
    expect(user.content).toContain("match this mockup");
    expect(user.content).toContain("image(s) omitted");
    expect(user.content).toContain("could not view");
    // The note names the model, because the model is the reason.
    expect(user.content).toContain("stealth/ox-alpha");
  });

  // Regression: the test above hand-builds the inner adapter WITH the name, so
  // it passed while the real OpenRouterProvider forgot to forward one and the
  // adapter silently identified as first-party "openai" — arming the
  // gpt-5/o-series reasoning-param branch for bare ids. Always assert through
  // the constructor users actually reach.
  test("OpenRouterProvider forwards its name, so the real path omits pixels too", () => {
    const p = new OpenRouterProvider("k") as any;
    expect(p.inner.name).toBe("openrouter");

    const out = p.inner.toOpenAIMessages(messages, undefined, undefined, "stealth/ox-alpha");
    const user = out.find((m: any) => m.role === "user");
    expect(typeof user.content).toBe("string");
    expect(user.content).toContain("match this mockup");
    expect(user.content).toContain("image(s) omitted");
    expect(user.content).toContain("openrouter transport");
  });

  test("no model at all is treated as unknown, never as capable", () => {
    const p = new OpenAIProvider("k") as any;
    const out = p.toOpenAIMessages(messages);
    const user = out.find((m: any) => m.role === "user");
    expect(typeof user.content).toBe("string");
    expect(user.content).toContain("image(s) omitted");
  });

  test("Ollama says it could not view the image instead of dropping it silently", () => {
    const p = new OllamaProvider("http://localhost:11434") as any;
    const out = p.toOllamaMessages(messages);
    const user = out.find((m: any) => m.role === "user");
    expect(user.content).toContain("match this mockup");
    expect(user.content).toContain("image(s) omitted");
    expect(user.content).toContain("could not view");
  });

  // The name also gates first-party reasoning params. A bare "gpt-5" typed
  // against OpenRouter must keep the classic params OpenRouter normalizes,
  // not switch to max_completion_tokens/reasoning_effort.
  test("OpenRouter keeps classic tuning params even for a bare reasoning id", () => {
    const p = new OpenRouterProvider("k") as any;
    const params = p.inner.buildTuningParams({ model: "gpt-5", maxTokens: 100, temperature: 0.5 });
    expect(params.max_tokens).toBe(100);
    expect(params.max_completion_tokens).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("Gemini rides images as inlineData parts", () => {
    const p = new GoogleProvider("k") as any;
    const contents = p.toGeminiContents(messages);
    expect(contents[0].parts[0]).toEqual({
      inlineData: { mimeType: "image/webp", data: "QUJD" },
    });
    expect(contents[0].parts[1]).toEqual({ text: "match this mockup" });
  });

  test("Anthropic rides images as base64 image blocks (pre-existing path still alive)", () => {
    const p = new AnthropicProvider("k") as any;
    const out = p.toAnthropicMessages(messages);
    const user = out.find((m: any) => m.role === "user");
    const img = user.content.find((b: any) => b.type === "image");
    expect(img).toBeDefined();
    expect(img.source).toMatchObject({ type: "base64", media_type: "image/webp", data: "QUJD" });
  });
});
