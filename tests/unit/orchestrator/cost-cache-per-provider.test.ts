/**
 * P8.8 — the cache number in the product, per provider, with one rule:
 *
 *   `null` renders as "no data". NEVER as "0%".
 *
 * They are different facts. A provider that reports no cache counters at all
 * (Ollama Cloud, measured 2026-09-02) and a provider whose cache genuinely
 * missed every time both produce a screen that says something — and if they
 * produce the SAME screen, the reader is being told a number nobody measured.
 * That is the failure this whole phase is about.
 *
 * The second rule is per-provider separation: a session that fell back from a
 * caching provider to one with none reports a blended rate describing neither,
 * and the blend is always the flattering number.
 */

import { describe, test, expect } from "bun:test";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import {
  formatCacheRate,
  formatCostReport,
  formatCostSummary,
} from "../../../packages/orchestrator/src/cost-report";

describe("the one rule", () => {
  test("null is 'no data', and 0 is '0%'", () => {
    expect(formatCacheRate(null)).toBe("no data");
    expect(formatCacheRate(0)).toBe("0%");
    expect(formatCacheRate(0.5)).toBe("50%");
    expect(formatCacheRate(1)).toBe("100%");
  });

  test("no data never renders as a percentage anywhere in the readout", () => {
    const t = new CostTracker();
    const lines = formatCostReport(t.getBreakdown());
    const cache = lines.find((l) => l.label.startsWith("Cache"));
    expect(cache?.value).not.toContain("%");
    expect(cache?.value).toContain("no data");
  });

  test("the status line omits the cache entirely rather than claiming 0%", () => {
    const t = new CostTracker();
    expect(formatCostSummary(t.getBreakdown())).not.toContain("cache");
  });
});

describe("per-provider cache facts", () => {
  test("each provider reports its own rate, not a blend", () => {
    const t = new CostTracker();
    // A well-cached Anthropic leg...
    t.record("claude-sonnet-4-6", "anthropic", {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 9_000,
    });
    // ...then a fallback onto a provider whose cache reports nothing.
    t.record("gpt-oss:20b", "ollama-turbo", { inputTokens: 10_000, outputTokens: 100 });

    const b = t.getBreakdown();
    expect(b.cacheByProvider.anthropic?.hitRate).toBeCloseTo(0.9, 5);
    expect(b.cacheByProvider["ollama-turbo"]?.hitRate).toBe(0);

    // The blended figure is real too, and it describes neither leg — which is
    // exactly why the per-provider split exists.
    // 9,000 warm of 20,000 total input across both legs.
    expect(b.cacheHitRate).toBeCloseTo(0.45, 5);
  });

  test("a provider that reported no input at all is null, not zero", () => {
    const t = new CostTracker();
    // Output only: nothing was read, written, or sent fresh.
    t.record("claude-sonnet-4-6", "anthropic", { inputTokens: 0, outputTokens: 50 });
    expect(t.getBreakdown().cacheByProvider.anthropic?.hitRate).toBeNull();
  });

  test("savings are attributed to the provider that earned them", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-6", "anthropic", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 100_000,
    });
    t.record("gpt-oss:20b", "ollama-turbo", { inputTokens: 10_000, outputTokens: 10 });

    const b = t.getBreakdown();
    expect(b.cacheByProvider.anthropic!.savingUsd).toBeGreaterThan(0);
    // No cache reads, so nothing was saved — and nothing is claimed.
    expect(b.cacheByProvider["ollama-turbo"]!.savingUsd).toBe(0);
  });

  test("the readout breaks out providers once there is more than one", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-6", "anthropic", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 9_000,
    });
    t.record("gpt-oss:20b", "ollama-turbo", { inputTokens: 10_000, outputTokens: 10 });

    const labels = formatCostReport(t.getBreakdown()).map((l) => l.label.trim());
    expect(labels).toContain("anthropic");
    expect(labels).toContain("ollama-turbo");
  });

  test("a single-provider session is not padded with a redundant breakdown", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-4-6", "anthropic", {
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 9_000,
    });
    const labels = formatCostReport(t.getBreakdown()).map((l) => l.label.trim());
    expect(labels).not.toContain("anthropic");
  });
});
