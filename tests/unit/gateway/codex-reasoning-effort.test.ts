/**
 * Reasoning effort on the Codex (ChatGPT-subscription) path.
 *
 * The defect: `toResponsesBody` sent `reasoning: { summary }` and deliberately
 * omitted `effort`, on the stated belief that "the sol/terra/luna variants
 * encode effort in the model name" and that `reasoning.effort` was "an
 * API-key-only param rejected here". Both halves were wrong, and neither was
 * ever tested — Gear's incident history contains zero rejections of the field,
 * because it never sent it once.
 *
 * The cost was the whole product on that route: every ChatGPT-subscription
 * session ran at the server's default depth with `max` unreachable, which is
 * why a frontier model felt weaker in Gear than a small model on OpenRouter.
 * Compounding it, `thinkingEffort` existed on AgentLoopConfig and NOTHING in
 * the repo ever set it — no flag, no config key, no command.
 *
 * Measured against the live backend, 2026-08-30, gpt-5.6-sol:
 *   effort=low|medium|high|xhigh|max → HTTP 200
 *   effort=minimal                   → HTTP 400 "not supported with the
 *                                      'gpt-5.6-sol' model"
 *   effort=banana                    → HTTP 400 naming param reasoning.effort
 * and the real Codex CLI carries it too (`model_reasoning_effort = "max"`).
 */

import { describe, test, expect } from "bun:test";
import { toResponsesBody, codexEffortFor } from "../../../packages/llm-gateway/src/providers/codex";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/types";

function req(over: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    model: "gpt-5.6-sol",
    provider: "codex",
    maxTokens: 100,
    stream: true,
    ...over,
  } as InferenceRequest;
}

const reasoningOf = (r: InferenceRequest) =>
  (toResponsesBody(r, true).reasoning ?? {}) as Record<string, unknown>;

describe("codex reasoning.effort", () => {
  test("the field is sent at all — it never used to be", () => {
    const reasoning = reasoningOf(req());
    expect(reasoning.effort).toBeDefined();
    // The summary that was already there must survive.
    expect(reasoning.summary).toBe("auto");
  });

  test("an unspecified effort defaults to high, not to the server's choice", () => {
    expect(reasoningOf(req()).effort).toBe("high");
  });

  test("the caller's choice is honoured, including the values Gear could not reach", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(reasoningOf(req({ thinking: { enabled: true, effort } })).effort).toBe(effort);
    }
  });

  test("thinking explicitly off asks for none, not for the default", () => {
    // Utility calls and the fast classifier run on tiny budgets; hidden
    // reasoning would eat the whole completion and return empty content.
    expect(reasoningOf(req({ thinking: { enabled: false } })).effort).toBeUndefined();
    expect(codexEffortFor("gpt-5.6-sol", { enabled: false })).toBe("none");
  });

  test("a value the MODEL rejects is clamped, never sent as-is", () => {
    // The backend 400s the whole request on an unsupported value. A user's
    // configured preference must not be able to hard-fail every call.
    expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: "minimal" })).toBe("low");
    expect(codexEffortFor("gpt-5.6-terra", { enabled: true, effort: "minimal" })).toBe("low");
    // Everything the family does accept passes through untouched.
    for (const e of ["none", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(codexEffortFor("gpt-5.6-sol", { enabled: true, effort: e })).toBe(e);
    }
  });

  test("the rest of the body is unchanged — this was a one-field fix", () => {
    const body = toResponsesBody(req(), true);
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });
});
