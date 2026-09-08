/**
 * The run-economics readout: `/cost`'s second half, and all of `rune cost`.
 *
 * The rule this file exists to hold is the one the money readout already
 * keeps: `null` is "no data" and NEVER "0%". A meter that renders "no cache
 * counters were reported" and "the cache missed every time" identically is how
 * an invented number reaches a screen.
 */

import { describe, expect, test } from "bun:test";
import { summarizeRunEconomics } from "../../../packages/llm-gateway/src/index";
import type { ProviderName } from "../../../packages/llm-gateway/src/index";
import {
  formatBytes,
  formatCostReport,
  formatRunEconomics,
} from "../../../packages/orchestrator/src/cost-report";
import { costEntriesFrom } from "../../../packages/orchestrator/src/bin/cost-cli";

type Entry = Parameters<typeof summarizeRunEconomics>[0][number];

function entry(over: Partial<Entry> = {}): Entry {
  return {
    model: "claude-sonnet-4-6",
    provider: "anthropic" as ProviderName,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    listCostUsd: 0.01,
    ...over,
  };
}

const render = (entries: Entry[]) => formatRunEconomics(summarizeRunEconomics(entries));
const find = (lines: ReturnType<typeof formatRunEconomics>, label: string) =>
  lines.find((l) => l.label.trim() === label);

describe("formatRunEconomics", () => {
  test("prints nothing at all for a session with no completions", () => {
    // A fresh session must show the money readout unchanged, not a wall of
    // zeroes that look like measurements.
    expect(render([])).toEqual([]);
  });

  test("splits completions work vs governance and names the share", () => {
    const lines = render([
      entry({ role: "primary" }),
      entry({ role: "classifier" }),
      entry({ role: "summarizer" }),
      entry({ role: "summarizer" }),
    ]);
    const completions = find(lines, "Completions")!;
    expect(completions.value).toBe("4");
    expect(completions.note).toContain("1 work");
    expect(completions.note).toContain("3 governance");
    expect(completions.note).toContain("75%");
    // Three quarters of the requests being Rune's own is a warning, not a fact
    // reported in the same weight as the rest.
    expect(completions.tone).toBe("warn");
  });

  test("each role that ran gets its own row, ordered by call count", () => {
    const lines = render([
      entry({ role: "classifier" }),
      entry({ role: "classifier" }),
      entry({ role: "summarizer" }),
    ]);
    const rows = lines.filter((l) => l.label.startsWith("  ")).map((l) => l.label.trim());
    expect(rows.slice(0, 2)).toEqual(["classifier", "summarizer"]);
    expect(find(lines, "classifier")!.value).toBe("2");
  });

  test("fresh tokens per call reports the governance figure beside the overall one", () => {
    const lines = render([
      entry({ role: "primary", inputTokens: 2_000 }),
      entry({ role: "classifier", inputTokens: 34_000 }),
    ]);
    const fresh = find(lines, "Fresh in / call")!;
    expect(fresh.value).toBe("18.0k");
    expect(fresh.note).toContain("34.0k");
  });

  test('a cache with no counters reads "no data", not 0%', () => {
    const lines = render([entry({ inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })]);
    expect(find(lines, "Cache read ratio")!.value).toBe("no data");
  });

  test("a cache that genuinely missed reads 0%", () => {
    const lines = render([entry({ inputTokens: 1_000, cacheReadTokens: 0 })]);
    expect(find(lines, "Cache read ratio")!.value).toBe("0%");
  });

  test("the list estimate names governance's share of it", () => {
    const lines = render([
      entry({ role: "primary", listCostUsd: 1 }),
      entry({ role: "summarizer", listCostUsd: 0.5 }),
    ]);
    const list = find(lines, "List estimate")!;
    expect(list.value).toContain("1.50");
    expect(list.note).toContain("0.50");
  });

  test("prompt composition is shown per call and says how many calls measured it", () => {
    const composition = {
      doctrine: 2_000,
      planLedger: 1_000,
      taskState: 500,
      toolSchemas: 4_000,
      conversation: 2_500,
      total: 10_000,
    };
    const lines = render([
      entry({ role: "primary", composition }),
      entry({ role: "primary", composition }),
      entry({ role: "classifier" }),
    ]);
    const bytes = find(lines, "Prompt bytes / call")!;
    expect(bytes.value).toBe(formatBytes(10_000));
    // The denominator is the calls that MEASURED one, not every call — a
    // governance call attributing nothing must not make prompts look smaller.
    expect(bytes.note).toBe("measured on 2 of 3 completions");
    expect(find(lines, "doctrine")!.note).toBe("20%");
    expect(find(lines, "tool schemas")!.note).toBe("40%");
  });

  test("no composition row at all when nothing measured one", () => {
    const lines = render([entry({ role: "primary" })]);
    expect(find(lines, "Prompt bytes / call")).toBeUndefined();
  });

  test("an unpriced model is named so the estimate is not read as complete", () => {
    const lines = render([entry({ model: "an-unpriced-model" })]);
    const unpriced = find(lines, "Unpriced")!;
    expect(unpriced.value).toBe("an-unpriced-model");
    expect(unpriced.tone).toBe("warn");
  });

  test("the existing money readout still works and is unchanged", () => {
    const lines = formatCostReport({
      totalCostUsd: 0,
      totalListCostUsd: 1,
      byProvider: {},
      byModel: {},
      listByModel: {},
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: null,
      listCostWithoutCacheUsd: 1,
      cacheSavingUsd: 0,
      cacheByProvider: {},
      unpricedModels: [],
      hasEstimatedRates: false,
    });
    expect(lines[0]!.label).toBe("Spent");
    expect(lines[0]!.note).toContain("subscription / free tier");
  });
});

describe("formatBytes", () => {
  test("reads at the magnitude a person can hold", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2_048)).toBe("2.0KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00MB");
  });
});

describe("costEntriesFrom (rune cost reads the session log back)", () => {
  const row = (type: string, payload: Record<string, unknown>) => ({
    seq: 1,
    event: { type, payload },
  });

  test("reads role and composition off the persisted rows", () => {
    const entries = costEntriesFrom([
      row("cost", {
        model: "m",
        provider: "openrouter",
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 2,
        cacheCreationTokens: 3,
        costUsd: 0,
        listCostUsd: 0.5,
        role: "summarizer",
        composition: {
          doctrine: 1,
          planLedger: 0,
          taskState: 0,
          toolSchemas: 0,
          conversation: 0,
          total: 1,
        },
      }),
      row("assistant_msg", { content: "not a cost row" }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.role).toBe("summarizer");
    expect(entries[0]!.composition!.doctrine).toBe(1);
  });

  test("a pre-P12.1 row with no role or composition still counts, as the work", () => {
    const entries = costEntriesFrom([
      row("cost", { model: "m", provider: "anthropic", inputTokens: 5, outputTokens: 1 }),
    ]);
    expect(entries[0]!.role).toBeUndefined();
    expect(entries[0]!.composition).toBeUndefined();
    expect(summarizeRunEconomics(entries).governanceCompletions).toBe(0);
    // Missing counters read as zero tokens, not as NaN on the readout.
    expect(entries[0]!.cacheReadTokens).toBe(0);
  });
});
