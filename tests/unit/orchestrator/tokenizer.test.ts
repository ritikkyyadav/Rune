import { describe, test, expect } from "bun:test";
import {
  TokenCounter,
  countTokens,
  getContextLimit,
} from "../../../packages/orchestrator/src/tokenizer";

describe("TokenCounter", () => {
  test("counts tokens for simple text", () => {
    const counter = new TokenCounter();
    const count = counter.countTokens("Hello world, this is a test.");
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(50);
  });

  test("empty string returns 0", () => {
    const counter = new TokenCounter();
    expect(counter.countTokens("")).toBe(0);
  });

  test("caches results for same input", () => {
    const counter = new TokenCounter();
    const text = "This is a caching test with some words.";
    const first = counter.countTokens(text);
    const second = counter.countTokens(text);
    expect(first).toBe(second);
  });

  test("punctuation-heavy text counts higher", () => {
    const counter = new TokenCounter();
    const plain = "Hello world foo bar baz";
    const punchy = "Hello! world? {foo} [bar] (baz)";
    expect(counter.countTokens(punchy)).toBeGreaterThan(counter.countTokens(plain));
  });

  test("is more accurate than naive length/4 for code", () => {
    const counter = new TokenCounter();
    const code = `function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}`;
    const tokenCount = counter.countTokens(code);
    const naiveCount = Math.ceil(code.length / 4);
    // Word-based should differ from naive
    expect(tokenCount).not.toBe(naiveCount);
  });

  test("clearCache empties the cache", () => {
    const counter = new TokenCounter();
    counter.countTokens("test text");
    counter.clearCache();
    // After clearing, should still work
    const count = counter.countTokens("test text");
    expect(count).toBeGreaterThan(0);
  });
});

describe("getContextLimit", () => {
  test("returns correct limit for known models", () => {
    expect(getContextLimit("claude-sonnet-4-20250514")).toBe(200000);
    expect(getContextLimit("gpt-4o")).toBe(128000);
    expect(getContextLimit("gemini-2.5-flash")).toBe(1048576);
  });

  test("returns 100k default for unknown models", () => {
    expect(getContextLimit("unknown-model-v99")).toBe(100000);
  });

  // The blanket `["claude", 200000]` rule outlived the lineup it described and
  // compacted every 1M-window Claude model at ~140k. These assertions are the
  // tripwire: they fail the moment the table drifts behind the lineup again.
  test("current Claude lineup gets its real 1M window", () => {
    for (const model of [
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ]) {
      expect([model, getContextLimit(model)]).toEqual([model, 1000000]);
    }
  });

  test("the 1M rules survive provider prefixes and date suffixes", () => {
    expect(getContextLimit("anthropic/claude-opus-5")).toBe(1000000);
    expect(getContextLimit("claude-sonnet-5-20260101")).toBe(1000000);
  });

  test("older Claude models keep 200k — the generic rule still applies", () => {
    for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-3-5-sonnet"]) {
      expect([model, getContextLimit(model)]).toEqual([model, 200000]);
    }
  });
});

describe("countTokens (convenience)", () => {
  test("returns same result as TokenCounter instance", () => {
    const counter = new TokenCounter();
    const text = "Quick test string";
    expect(countTokens(text)).toBe(counter.countTokens(text));
  });
});
