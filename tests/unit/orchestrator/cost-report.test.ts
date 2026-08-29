/**
 * The readout's rules.
 *
 * The bug these pin: `/cost` printed a single `$0.0000`. That figure was
 * accurate — the traffic rode a ChatGPT subscription — and answered no
 * question. These tests hold the distinctions that make the number useful:
 * free is not unmeasured, "no cache data" is not "0% hit rate", and an
 * inferred rate is never presented as a published one.
 */
import { describe, test, expect } from "bun:test";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import {
  formatCostReport,
  formatCostSummary,
  formatTokens,
  formatUsd,
} from "../../../packages/orchestrator/src/cost-report";

function rowsFor(t: CostTracker) {
  const lines = formatCostReport(t.getBreakdown());
  return new Map(lines.map((l) => [l.label, l]));
}

describe("number formatting", () => {
  test("sub-cent amounts keep four decimals, dollars keep two", () => {
    expect(formatUsd(0.0034)).toBe("$0.0034");
    expect(formatUsd(3.256)).toBe("$3.26");
    expect(formatUsd(0)).toBe("$0.00");
  });

  test("token counts compact instead of printing eight digits", () => {
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(93_721)).toBe("93.7k");
    expect(formatTokens(43_861_351)).toBe("43.86M");
  });
});

describe("the readout distinguishes free from unmeasured", () => {
  test("a subscription route shows $0 spent AND what it was worth", () => {
    const t = new CostTracker();
    t.record("gpt-5.6-sol", "codex", { inputTokens: 1_000_000, outputTokens: 10_000 });
    const rows = rowsFor(t);

    expect(rows.get("Spent")?.value).toBe("$0.00");
    expect(rows.get("Spent")?.note).toContain("subscription");
    // The comparable figure is present and non-zero — this is the whole point.
    expect(rows.get("Metered equivalent")?.value).toBe("~$1.35");
  });

  test("an unpriced model is called out, not folded into the total", () => {
    const t = new CostTracker();
    t.record("some-unreleased-model", "openai", { inputTokens: 500_000, outputTokens: 1_000 });
    const rows = rowsFor(t);

    expect(rows.get("Unpriced")?.value).toBe("some-unreleased-model");
    expect(rows.get("Unpriced")?.tone).toBe("warn");
    expect(rows.get("Unpriced")?.note).toContain("NOT counted");
  });

  test("inferred rates are marked with a tilde and explained", () => {
    const t = new CostTracker();
    t.record("gpt-5.6-sol", "codex", { inputTokens: 1_000, outputTokens: 10 });
    const rows = rowsFor(t);
    expect(rows.get("Metered equivalent")?.value.startsWith("~")).toBe(true);
    expect(rows.get("Note")?.value).toContain("inferred");
  });

  test("published rates carry no tilde", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-5", "anthropic", { inputTokens: 1_000_000, outputTokens: 0 });
    const rows = rowsFor(t);
    expect(rows.get("Metered equivalent")?.value).toBe("$2.00");
    expect(rows.has("Note")).toBe(false);
  });
});

describe("cache reporting", () => {
  test("no usage reads as 'no data yet', never 0%", () => {
    const rows = rowsFor(new CostTracker());
    expect(rows.get("Cache")?.value).toBe("no data yet");
    expect(rows.has("Cache hit rate")).toBe(false);
  });

  test("a warm session reports its hit rate and the dollars saved", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-5", "anthropic", {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 900_000,
    });
    const rows = rowsFor(t);

    expect(rows.get("Cache hit rate")?.value).toBe("90%");
    expect(rows.get("Cache hit rate")?.tone).toBe("good");
    // 2.10 uncached vs 0.48 cached
    expect(rows.get("Cache saved")?.value).toBe("$1.62");
    expect(rows.get("Cache saved")?.note).toContain("$2.10");
  });

  test("a cold session reports 0% without claiming a saving", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-5", "anthropic", { inputTokens: 100_000, outputTokens: 1_000 });
    const rows = rowsFor(t);
    expect(rows.get("Cache hit rate")?.value).toBe("0%");
    expect(rows.get("Cache saved")?.value).toBe("$0.00");
  });
});

describe("status-bar summary", () => {
  test("a metered route leads with actual spend", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-5", "anthropic", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(formatCostSummary(t.getBreakdown())).toBe("$2.20 · cache 50%");
  });

  test("a subscription route leads with value, since spend is always zero", () => {
    const t = new CostTracker();
    t.record("gpt-5.6-sol", "codex", { inputTokens: 1_000_000, outputTokens: 10_000 });
    expect(formatCostSummary(t.getBreakdown())).toBe("~$1.35 value · cache 0%");
  });
});
