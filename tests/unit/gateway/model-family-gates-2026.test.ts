/**
 * The gates that decide what a model is, by its NAME.
 *
 * Every one of these was written as a list of the ids shipping that week, and
 * every one of them was silently wrong the moment a vendor shipped the next
 * generation. Nothing failed: a model simply stopped getting a reasoning
 * block, or took the classic parameter path, or lost its vision flag, and the
 * only symptom was that the product felt weaker than it should. The 2026-09-16
 * roster refresh made all of that live — gpt-6-astra is the bundled Codex
 * default now, and the whole dotted gpt-5.x line is on the OpenAI preset.
 *
 * So these tests assert the FAMILY, not the id: the current generation, the
 * one before it, and the one that does not exist yet. A gate that only knows
 * today's names is the defect, not a passing test.
 */

import { describe, test, expect } from "bun:test";
import { toResponsesBody, codexEffortFor } from "../../../packages/llm-gateway/src/providers/codex";
import {
  REASONING_FAMILY,
  HIDDEN_REASONING_FAMILY,
  OpenAIProvider,
} from "../../../packages/llm-gateway/src/providers/openai";
import { modelSeesImages } from "../../../packages/llm-gateway/src/providers/model-capabilities";
import { reasoningEffortsFor } from "../../../packages/llm-gateway/src/types";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

function req(model: string, over: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "s",
    model,
    provider: "codex",
    maxTokens: 256,
    ...over,
  } as InferenceRequest;
}

describe("codex: which models get a reasoning block", () => {
  test.each([
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.5",
    "codex-mini",
    "o3",
    "o4-mini",
  ])("%s is sent WITH reasoning", (model) => {
    const body = toResponsesBody(req(model), false);
    expect(body.reasoning, `${model} lost its reasoning block`).toBeDefined();
  });

  test("gpt-6-astra was the regression: the old rule stopped at gpt-5", () => {
    // /^(gpt-5|o[134]|codex)/ — the exact rule that shipped. The model OpenAI
    // made the Codex default would have gone out with no reasoning at all.
    expect(/^(gpt-5|o[134]|codex)/.test("gpt-6-astra")).toBe(false);
    expect(toResponsesBody(req("gpt-6-astra"), false).reasoning).toBeDefined();
  });

  test("a generation that does not exist yet is already handled", () => {
    expect(toResponsesBody(req("gpt-7-whatever"), false).reasoning).toBeDefined();
    expect(toResponsesBody(req("gpt-12-whatever"), false).reasoning).toBeDefined();
  });

  test("a non-OpenAI id gets no reasoning block", () => {
    expect(toResponsesBody(req("llama3.1"), false).reasoning).toBeUndefined();
  });
});

describe("codex: the effort clamp", () => {
  test("the gpt-5.6 clamp is unchanged — minimal is a measured 400 there", () => {
    expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: "minimal" })).toBe("low");
    expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: "max" })).toBe("max");
  });

  test("gpt-6 passes the requested effort through — its matrix is UNMEASURED", () => {
    // No live call has probed which values gpt-6-astra accepts. A clamp built
    // on a guess silently weakens every request; passing through fails loudly
    // once instead. This test exists to be changed by a measurement.
    for (const effort of ["low", "medium", "high", "xhigh", "max", "minimal"] as const) {
      expect(codexEffortFor("gpt-6-astra", { enabled: true, effort })).toBe(effort);
    }
  });

  test("thinking explicitly off still means the floor, on any generation", () => {
    expect(codexEffortFor("gpt-6-astra", { enabled: false })).toBe("none");
  });
});

describe("openai: the reasoning-family parameter path", () => {
  // Reaching the private predicate through the exported regex it now delegates
  // to: the same expression decides max_completion_tokens vs max_tokens,
  // whether sampling params are sent, and whether reasoning_effort rides along.
  test.each([
    ["gpt-6-astra", true],
    ["gpt-6-astra-pro", true],
    ["gpt-5.6-sol", true],
    ["gpt-5.5", true],
    ["gpt-5.4-mini", true],
    ["gpt-5", true],
    ["gpt-5-mini", true],
    ["o3", true],
    ["o4-mini", true],
    // Not reasoning families: these take the classic params and always did.
    ["gpt-4o", false],
    ["gpt-4.1", false],
    ["llama-3.3-70b-versatile", false],
  ] as const)("%s → reasoning family: %s", (model, expected) => {
    expect(REASONING_FAMILY.test(model)).toBe(expected);
  });

  test("the DOTTED ids were the silent half of this bug", () => {
    // /^(gpt-5|o[134])(-|:|$)/ — the rule that shipped. "gpt-5" matched, but
    // the next character was "." and the tail allowed only "-", ":" or end, so
    // every gpt-5.4/5.5/5.6 id fell to the classic path: `max_tokens` on a
    // model that requires `max_completion_tokens`, and no reasoning_effort.
    const old = /^(gpt-5|o[134])(-|:|$)/;
    for (const model of ["gpt-5.6-sol", "gpt-5.5", "gpt-5.4-mini", "gpt-6-astra"]) {
      expect(old.test(model)).toBe(false);
      expect(REASONING_FAMILY.test(model)).toBe(true);
    }
  });

  test("the thinking-off floor never sends a value a model may reject", () => {
    // Measured families keep their measured floor.
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5")).toBe("minimal");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5-mini")).toBe("minimal");
    expect(OpenAIProvider.minimalReasoningEffort("gpt-5.6-sol")).toBe("none");
    // gpt-6 is UNMEASURED: "none" is the family-consistent guess, and a wrong
    // guess here 400s the Auto-mode classifier on every turn. "low" is accepted
    // by every reasoning model there has ever been.
    expect(OpenAIProvider.minimalReasoningEffort("gpt-6-astra")).toBe("low");
    expect(OpenAIProvider.minimalReasoningEffort("o3")).toBe("low");
  });

  test("the idle watchdog knows the new families think in silence", () => {
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "openai/gpt-6-astra", "o3"]) {
      expect(HIDDEN_REASONING_FAMILY.test(model)).toBe(true);
    }
    expect(HIDDEN_REASONING_FAMILY.test("gpt-4o")).toBe(false);
  });
});

describe("the depth dial follows the model, not the calendar", () => {
  test("codex offers max on the current flagship", () => {
    expect(reasoningEffortsFor("codex", "gpt-6-astra")).toContain("max");
    expect(reasoningEffortsFor("codex", "gpt-5.6-sol")).toContain("max");
  });

  test("the OpenAI API dial reaches the whole current line", () => {
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.4-mini", "gpt-5"]) {
      expect(reasoningEffortsFor("azure-openai", model)).toEqual(["low", "medium", "high"]);
    }
    for (const model of ["gpt-5.4-mini", "gpt-5"]) {
      expect(reasoningEffortsFor("openai", model)).toEqual(["low", "medium", "high"]);
    }
  });

  test("the API dial goes as deep as the model pages document, and no deeper", () => {
    // gpt-6 astra/sol/luna and the gpt-5.6 line document low…max on the API
    // (2026-09-28). Azure stays narrow: nothing has read a Foundry deployment's
    // accepted values, and it can trail the first-party model.
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]) {
      expect(reasoningEffortsFor("openai", model)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    expect(reasoningEffortsFor("azure-openai", "gpt-6-sol")).toEqual(["low", "medium", "high"]);
  });

  test("Anthropic and the 3.x Gemini line are unchanged by this refresh", () => {
    expect(reasoningEffortsFor("anthropic", "claude-opus-5")).toEqual([]);
    expect(reasoningEffortsFor("google", "gemini-3.8-flash")).toEqual(["low", "high"]);
  });
});

describe("vision families", () => {
  test.each(["gpt-6-astra", "gpt-5.6-sol", "gpt-4o", "claude-opus-5", "gemini-3.8-flash"])(
    "%s sees images",
    (model) => {
      expect(modelSeesImages(model)).toBe(true);
    },
  );

  test("grok is NOT claimed as vision-capable — nobody checked", () => {
    // A false positive here sends an image block to a model that may reject
    // the whole request. Absence of evidence is the answer, not optimism.
    expect(modelSeesImages("grok-4.6")).toBe(false);
  });
});
