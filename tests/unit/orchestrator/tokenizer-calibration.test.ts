import { describe, test, expect, beforeEach } from "bun:test";
import { TokenCounter, tokenCounter } from "../../../packages/orchestrator/src/tokenizer";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";

// The old estimator (words × 1.3 + punctuation × 0.5) collapsed on dense text:
// a minified line or JSON blob is a handful of "words" but thousands of real
// tokens, so prompts were undercounted, over-budget requests got sent, and the
// provider's rejection was the first signal. These tests pin the two fixes:
// a chars/4 floor on the estimate, and per-model calibration learned from the
// REAL usage counts providers report.

describe("TokenCounter estimation", () => {
  test("dense minified text is floored at chars/4, not word-counted", () => {
    const counter = new TokenCounter();
    // ~4000 chars, almost no whitespace — the word formula alone would see
    // one giant "word" (≈1.3 tokens + punctuation).
    const minified = ("a(1)" + "x".repeat(36)).repeat(100);
    expect(minified.length).toBeGreaterThanOrEqual(4000);
    expect(counter.countTokens(minified)).toBeGreaterThanOrEqual(minified.length / 4);
  });

  test("JSON blobs don't undercount", () => {
    const counter = new TokenCounter();
    const blob = JSON.stringify({
      success: true,
      result: {
        stdout: "line\n".repeat(200),
        files: Array.from({ length: 50 }, (_, i) => `src/module_${i}.ts`),
      },
    });
    expect(counter.countTokens(blob)).toBeGreaterThanOrEqual(blob.length / 4);
  });

  test("prose estimates stay in a sane band", () => {
    const counter = new TokenCounter();
    const prose = "The quick brown fox jumps over the lazy dog near the river bank. ".repeat(20);
    const estimate = counter.countTokens(prose);
    // ~13 words/sentence × 20 ≈ 260 words ≈ 260-400 real tokens.
    expect(estimate).toBeGreaterThan(200);
    expect(estimate).toBeLessThan(600);
  });

  test("calibration scales estimates for the named model", () => {
    const counter = new TokenCounter();
    const text = "word ".repeat(1000);
    const before = counter.countTokens(text, "test-model");
    counter.noteCalibration("test-model", 1000, 2000); // provider says 2×
    const after = counter.countTokens(text, "test-model");
    expect(after).toBe(Math.ceil(before * 2));
    // Other models are untouched.
    expect(counter.countTokens(text, "other-model")).toBe(before);
  });

  test("calibration converges by EMA instead of jumping", () => {
    const counter = new TokenCounter();
    counter.noteCalibration("m", 1000, 2000); // first sample adopts ratio: 2.0
    expect(counter.getCalibration("m")).toBeCloseTo(2.0, 5);
    counter.noteCalibration("m", 1000, 1000); // pull toward 1.0 by α=0.3
    expect(counter.getCalibration("m")).toBeCloseTo(2.0 + 0.3 * (1.0 - 2.0), 5);
  });

  test("absurd ratios are clamped and tiny prompts ignored", () => {
    const counter = new TokenCounter();
    counter.noteCalibration("m", 1000, 1_000_000);
    expect(counter.getCalibration("m")).toBeLessThanOrEqual(4);
    counter.noteCalibration("n", 100, 100_000); // estimated < 500 → noise, ignored
    expect(counter.getCalibration("n")).toBe(1);
  });

  test("active model's calibration applies when countTokens gets no model", () => {
    const counter = new TokenCounter();
    const text = "word ".repeat(1000);
    const before = counter.countTokens(text);
    counter.noteCalibration("session-model", 1000, 3000);
    // noteCalibration marks the model active; unqualified counts now scale.
    expect(counter.countTokens(text)).toBe(Math.ceil(before * 3));
  });
});

describe("ContextEngine token feedback", () => {
  beforeEach(() => {
    tokenCounter.clearCache();
    tokenCounter.resetCalibrations();
  });

  const gateway = { getRegisteredProviderNames: () => [] } as any;

  test("noteRealUsage calibrates the shared counter from the built prompt", () => {
    const engine = new ContextEngine({}, gateway);
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "word ".repeat(2000) }] },
    ];
    const built = engine.buildPrompt("system", [], messages, undefined, "cal-model");
    engine.noteRealUsage({ inputTokens: built.totalTokens * 2 }, "cal-model");
    expect(tokenCounter.getCalibration("cal-model")).toBeGreaterThan(1.5);
    // The next build estimates ~2× higher for the same content.
    const rebuilt = engine.buildPrompt("system", [], messages, undefined, "cal-model");
    expect(rebuilt.totalTokens).toBeGreaterThan(built.totalTokens * 1.5);
  });

  test("default budget is capped to a small model's real window", () => {
    const engine = new ContextEngine({}, gateway); // default 100k budget
    // llama3 → 8192-token window. Aux items beyond ~85% of it must be evicted
    // rather than shipped in a prompt the provider is guaranteed to reject.
    const bigChunks = Array.from({ length: 30 }, (_, i) => ({
      content: `// file${i}\n` + "const x = 1;\n".repeat(400),
      relevance: 0.9,
    }));
    const built = engine.buildPrompt("system", [], [], bigChunks, "llama3");
    expect(built.totalTokens).toBeLessThanOrEqual(Math.floor(8192 * 0.85));
    expect(built.evictedCount).toBeGreaterThan(0);
  });

  test("explicitly configured budget is respected verbatim", () => {
    const engine = new ContextEngine({ budget: { maxTokens: 50_000 } }, gateway);
    const bigChunks = Array.from({ length: 30 }, (_, i) => ({
      content: `// file${i}\n` + "const x = 1;\n".repeat(400),
      relevance: 0.9,
    }));
    const built = engine.buildPrompt("system", [], [], bigChunks, "llama3");
    // User said 50k — the engine must not silently re-cap it to the model map
    // (they may be running a context-extended variant the map doesn't know).
    expect(built.totalTokens).toBeGreaterThan(Math.floor(8192 * 0.85));
    expect(built.totalTokens).toBeLessThanOrEqual(50_000);
  });

  test("conversation messages are never evicted even over a tiny window", () => {
    const engine = new ContextEngine({}, gateway);
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `turn ${i}: ` + "content ".repeat(500) }],
    }));
    const built = engine.buildPrompt("system", [], messages, undefined, "llama3");
    expect(
      built.messages.filter((m) => !String(m.content[0]).includes("Session context")).length,
    ).toBeGreaterThanOrEqual(messages.length);
  });
});
