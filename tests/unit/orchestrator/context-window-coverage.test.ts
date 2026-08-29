/**
 * Context-window coverage against the provider catalog.
 *
 * The bug this pins: 12 of the 46 selectable models matched no family rule and
 * fell to UNKNOWN_MODEL_CONTEXT_LIMIT (100k). For gpt-oss (131k real) that is a
 * quarter of the window discarded; the agent compacts far below the real limit
 * and pays for summarizer round-trips against a context with room to spare.
 *
 * The floors are deliberately conservative — guessing too HIGH earns a provider
 * 400, guessing too low only costs an early compaction — and live discovery
 * raises them wherever a catalog reports the truth. What must never happen
 * again is a model reaching users with no rule at all.
 */
import { describe, expect, test } from "bun:test";
import {
  getContextLimit,
  TokenCounter,
  UNKNOWN_MODEL_CONTEXT_LIMIT,
} from "../../../packages/orchestrator/src/tokenizer";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

/**
 * Models whose window genuinely cannot be known from the id, where the 100k
 * default is the correct answer rather than a gap:
 *   - a local runtime's id is a placeholder for whatever the user loaded
 *   - a cloaked/stealth id deliberately reveals nothing about the model
 * Both are corrected at runtime by live discovery when the host reports one.
 */
const UNKNOWABLE = new Set(["local-model", "stealth/ox-alpha"]);

function catalogModels(): string[] {
  const out: string[] = [];
  for (const p of PROVIDER_PRESETS) {
    for (const m of p.models ?? []) out.push(m.id);
    if (p.defaultModel) out.push(p.defaultModel);
  }
  return [...new Set(out)];
}

describe("context-window coverage", () => {
  test("every selectable model resolves to a real window", () => {
    const missing = catalogModels().filter(
      (m) => !UNKNOWABLE.has(m) && getContextLimit(m) === UNKNOWN_MODEL_CONTEXT_LIMIT,
    );
    expect(
      missing,
      `Models with no context-window rule:\n  ${missing.join("\n  ")}\n` +
        `Add a family rule to TokenCounter.getContextLimit, or list the id in ` +
        `UNKNOWABLE if its window truly cannot be known from the id alone.`,
    ).toEqual([]);
  });

  test("the deliberately-unknowable ids still resolve to the safe default", () => {
    for (const m of UNKNOWABLE) {
      expect(getContextLimit(m)).toBe(UNKNOWN_MODEL_CONTEXT_LIMIT);
    }
  });

  test("known families keep their real windows", () => {
    // Regression guard: the generic "claude" rule must never shadow the 1M
    // entries that precede it.
    expect(getContextLimit("claude-opus-5")).toBe(1_000_000);
    expect(getContextLimit("claude-sonnet-5")).toBe(1_000_000);
    expect(getContextLimit("claude-sonnet-4-5")).toBe(200_000);
    expect(getContextLimit("gpt-5.6-sol")).toBe(400_000);
    expect(getContextLimit("gemini-2.5-flash")).toBe(1_048_576);
    expect(getContextLimit("qwen3-coder:480b")).toBe(262_144);
  });

  test("newly-covered open-weight families beat the old 100k default", () => {
    for (const m of ["gpt-oss:120b", "gpt-oss:20b", "nemotron-3-super", "gemma4:31b"]) {
      expect(getContextLimit(m)).toBeGreaterThan(UNKNOWN_MODEL_CONTEXT_LIMIT);
    }
  });

  test("a live catalog reading overrides the static floor", () => {
    try {
      expect(getContextLimit("gpt-oss:120b")).toBe(131_072);
      TokenCounter.registerContextLimit("gpt-oss:120b", 262_144);
      expect(getContextLimit("gpt-oss:120b")).toBe(262_144);
    } finally {
      TokenCounter.clearContextLimits();
    }
  });

  test("a malformed catalog entry cannot shrink a window", () => {
    try {
      TokenCounter.registerContextLimit("claude-opus-5", 0);
      TokenCounter.registerContextLimit("claude-opus-5", -5);
      expect(getContextLimit("claude-opus-5")).toBe(1_000_000);
    } finally {
      TokenCounter.clearContextLimits();
    }
  });
});
