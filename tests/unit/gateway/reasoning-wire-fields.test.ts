/**
 * P8.7 — the effort dial reaches the wire, per provider, under its real name.
 *
 * THIS TEST IS THE POINT OF THE ITEM. Gear has shipped a depth dial that went
 * nowhere twice:
 *
 *   - Codex ran at the server default because `reasoning.effort` was never
 *     sent, while "max" sat in the picker looking selectable.
 *   - Gemini dropped `thinking.effort` in the adapter: the value travelled the
 *     whole way down the request and was then ignored, so `/effort high` on a
 *     Gemini session changed nothing.
 *
 * Both were invisible from inside the process — the request looked fine, the
 * model answered, and only the depth was quietly wrong. The only defence is a
 * test that reads the ACTUAL body each adapter builds and names the exact
 * field, per provider. Every provider gets a row here, including the ones
 * whose correct answer is "no field at all".
 */

import { describe, test, expect } from "bun:test";
import { OpenAIProvider } from "../../../packages/llm-gateway/src/providers/openai";
import { OpenRouterProvider } from "../../../packages/llm-gateway/src/providers/openrouter";
import { toResponsesBody, codexEffortFor } from "../../../packages/llm-gateway/src/providers/codex";
import { geminiThinkingConfig } from "../../../packages/llm-gateway/src/providers/google";
import { AnthropicProvider } from "../../../packages/llm-gateway/src/providers/anthropic";
import { reasoningEffortsFor } from "../../../packages/llm-gateway/src/types";
import type {
  InferenceRequest,
  ReasoningEffort,
} from "../../../packages/llm-gateway/src/types";

const req = (
  over: Partial<InferenceRequest> & Pick<InferenceRequest, "model" | "provider">,
): InferenceRequest => ({
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  maxTokens: 4_000,
  stream: false,
  ...over,
});

const tuning = (p: OpenAIProvider, r: InferenceRequest): Record<string, unknown> =>
  (
    p as unknown as { buildTuningParams: (r: InferenceRequest) => Record<string, unknown> }
  ).buildTuningParams(r);

const anthropicThinking = (r: InferenceRequest): Record<string, unknown> | undefined =>
  (
    new AnthropicProvider("k") as unknown as {
      buildThinkingParam: (r: InferenceRequest) => { thinking?: Record<string, unknown> };
    }
  ).buildThinkingParam(r).thinking;

// ─────────────────────────────────────────────────────────────────────────

describe("openai — the field is `reasoning_effort`", () => {
  const p = new OpenAIProvider("k");

  test.each(["low", "medium", "high"] as ReasoningEffort[])("%s reaches the body", (effort) => {
    const body = tuning(
      p,
      req({ model: "gpt-5", provider: "openai", thinking: { enabled: true, effort } }),
    );
    expect(body.reasoning_effort).toBe(effort);
    // The reasoning family also swaps the token cap field.
    expect(body.max_completion_tokens).toBe(4_000);
    expect(body.max_tokens).toBeUndefined();
  });

  test("thinking off maps to the model's floor, not to an omitted field", () => {
    // Omitting the field is NOT "off": gpt-5/o-series default to medium and
    // spend the whole small completion budget on hidden reasoning, returning
    // empty content.
    const body = tuning(
      p,
      req({ model: "gpt-5", provider: "openai", thinking: { enabled: false } }),
    );
    expect(body.reasoning_effort).toBe("minimal");
  });

  test("a non-reasoning model gets classic params and no effort field", () => {
    const body = tuning(
      p,
      req({ model: "gpt-4o", provider: "openai", thinking: { enabled: true, effort: "high" } }),
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBe(4_000);
  });

  test("the dial the picker offers matches the models that accept it", () => {
    expect(reasoningEffortsFor("openai", "gpt-5")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortsFor("openai", "gpt-4o")).toEqual([]);
  });
});

describe("codex — the field is `reasoning.effort`", () => {
  test.each(["low", "medium", "high", "xhigh", "max"] as ReasoningEffort[])(
    "%s reaches the Responses body",
    (effort) => {
      const body = toResponsesBody(
        req({ model: "gpt-5.6-sol", provider: "codex", thinking: { enabled: true, effort } }),
        false,
      );
      expect((body.reasoning as Record<string, unknown>).effort).toBe(effort);
    },
  );

  test("`max` is reachable — it was not, when the field was never sent", () => {
    expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: "max" })).toBe("max");
    expect(reasoningEffortsFor("codex", "gpt-5.6-sol")).toContain("max");
  });

  test("the gpt-5.6 line rejects `minimal`, so it is floored to low", () => {
    expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: "minimal" })).toBe("low");
  });

  test("thinking off asks for none, not for the server default", () => {
    expect(codexEffortFor("gpt-5.6-sol", { enabled: false })).toBe("none");
  });
});

describe("google — the field is `thinkingConfig.thinkingBudget` / `thinkingLevel`", () => {
  // Gemini has no effort field: depth is a token budget. This mapping is what
  // was missing — the effort arrived and was dropped.
  test.each([
    ["low", 4_096],
    ["medium", 8_192],
    ["high", 16_384],
    ["xhigh", 24_576],
    ["max", 24_576],
  ] as [ReasoningEffort, number][])("2.5 Flash: %s → budget %i", (effort, budget) => {
    const cfg = geminiThinkingConfig({
      model: "gemini-2.5-flash",
      thinking: { enabled: true, effort },
    });
    expect(cfg?.thinkingBudget).toBe(budget);
  });

  test("2.5 Pro cannot go below its documented floor of 128", () => {
    const cfg = geminiThinkingConfig({
      model: "gemini-2.5-pro",
      thinking: { enabled: true, effort: "minimal" },
    });
    expect(cfg?.thinkingBudget).toBe(128);
  });

  test("an explicit budget still wins over the effort", () => {
    const cfg = geminiThinkingConfig({
      model: "gemini-2.5-flash",
      thinking: { enabled: true, effort: "low", budgetTokens: 20_000 },
    });
    expect(cfg?.thinkingBudget).toBe(20_000);
  });

  test("3.x takes a level, and only the two documented values", () => {
    const low = geminiThinkingConfig({
      model: "gemini-3-pro",
      thinking: { enabled: true, effort: "low" },
    });
    const high = geminiThinkingConfig({
      model: "gemini-3-pro",
      thinking: { enabled: true, effort: "max" },
    });
    expect(low?.thinkingLevel).toBe("low");
    expect(high?.thinkingLevel).toBe("high");
    expect(low?.thinkingBudget).toBeUndefined();
  });

  test("a model with no thinking field is sent none — an unknown key is a 400", () => {
    expect(
      geminiThinkingConfig({ model: "gemini-2.0-flash", thinking: { enabled: true, effort: "high" } }),
    ).toBeUndefined();
  });

  test("the picker now offers the dial, because the wire now carries it", () => {
    expect(reasoningEffortsFor("google", "gemini-2.5-flash")).toEqual(["low", "medium", "high"]);
    expect(reasoningEffortsFor("google", "gemini-3-pro")).toEqual(["low", "high"]);
    expect(reasoningEffortsFor("google", "gemini-2.0-flash")).toEqual([]);
  });
});

describe("anthropic — the field is `thinking`, and it takes a budget, never an effort", () => {
  test("budget-mode models get type/budget_tokens", () => {
    const thinking = anthropicThinking(
      req({
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        thinking: { enabled: true, budgetTokens: 8_000 },
      }),
    );
    expect(thinking).toEqual({ type: "enabled", budget_tokens: 2_000 });
  });

  test("no reasoning_effort is invented for a provider that has no such field", () => {
    const thinking = anthropicThinking(
      req({
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        thinking: { enabled: true, effort: "max", budgetTokens: 8_000 },
      }),
    );
    expect(thinking).not.toHaveProperty("effort");
    expect(thinking).not.toHaveProperty("reasoning_effort");
  });

  test("the picker offers no dial, because there is none to offer", () => {
    expect(reasoningEffortsFor("anthropic", "claude-opus-5")).toEqual([]);
  });
});

describe("openai-compatible hosts — no effort field, and no impersonation", () => {
  test("OpenRouter keeps classic params even for a bare reasoning id", () => {
    const inner = (new OpenRouterProvider("k") as unknown as { inner: OpenAIProvider }).inner;
    const body = tuning(
      inner,
      req({ model: "gpt-5", provider: "openrouter", thinking: { enabled: true, effort: "high" } }),
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBe(4_000);
  });

  test.each(["openrouter", "groq", "deepseek", "xai", "ollama-turbo", "custom"])(
    "%s offers no dial",
    (id) => {
      expect(reasoningEffortsFor(id, "whatever-model")).toEqual([]);
    },
  );
});
