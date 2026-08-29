/**
 * The meter's coverage guard.
 *
 * The bug this pins: MODEL_PRICING drifted behind the provider catalog until
 * 21 of 41 selectable models had no entry. CostTracker.estimate returns 0 for
 * an unknown model — indistinguishable from a genuinely free one — so the
 * ledger reported $0.0675 for 43.9M tokens of real work. The three models
 * carrying 92% of that traffic (the gpt-5.6 line) were all missing.
 *
 * A model a user can select but the meter cannot price is a reporting hole,
 * and holes open silently. These tests fail the build when one does.
 */
import { describe, test, expect } from "bun:test";
import { CostTracker } from "../../../packages/llm-gateway/src/cost-tracker";
import { billingModeFor, MODEL_PRICING } from "../../../packages/llm-gateway/src/types";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

/**
 * Every model id the catalog offers, with the provider that offers it.
 *
 * Local runtimes are excluded: their catalogued id is a placeholder for
 * "whatever you loaded in LM Studio", so there is no model to price and no
 * dollar to meter. billingModeFor() reports them free, which is the honest
 * answer — not a coverage hole.
 */
function catalogModels(): Array<{ provider: string; model: string }> {
  const out: Array<{ provider: string; model: string }> = [];
  for (const preset of PROVIDER_PRESETS) {
    if (preset.local) continue;
    for (const m of preset.models ?? []) out.push({ provider: preset.id, model: m.id });
    if (preset.defaultModel) out.push({ provider: preset.id, model: preset.defaultModel });
  }
  return out;
}

describe("pricing coverage against the provider catalog", () => {
  const tracker = new CostTracker();

  test("every selectable model has a price", () => {
    const missing = catalogModels()
      .filter(({ model }) => !tracker.hasPricing(model))
      .map(({ provider, model }) => `${provider}:${model}`);

    expect(
      missing,
      `Models users can select but the meter cannot price:\n  ${missing.join("\n  ")}\n` +
        `Add them to MODEL_PRICING in packages/llm-gateway/src/types.ts. ` +
        `An unpriced model reports $0, which is indistinguishable from free.`,
    ).toEqual([]);
  });

  test("every provider's default model has a price", () => {
    const missing = PROVIDER_PRESETS.filter(
      (p) => !p.local && p.defaultModel && !tracker.hasPricing(p.defaultModel),
    ).map((p) => `${p.id}:${p.defaultModel}`);
    expect(missing).toEqual([]);
  });

  test("a local runtime is free, not unpriced", () => {
    expect(billingModeFor("lmstudio", "local-model")).toBe("free");
    expect(billingModeFor("ollama", "whatever-you-loaded")).toBe("free");
  });

  test("no price entry is negative or output-cheaper-than-input", () => {
    for (const [model, price] of Object.entries(MODEL_PRICING)) {
      expect(price.inputPerMillion, `${model} input rate`).toBeGreaterThanOrEqual(0);
      expect(price.outputPerMillion, `${model} output rate`).toBeGreaterThanOrEqual(0);
      // Output is never cheaper than input on any real provider; a row where it
      // is means the two columns were transposed.
      expect(price.outputPerMillion, `${model} output cheaper than input`).toBeGreaterThanOrEqual(
        price.inputPerMillion,
      );
    }
  });

  test("an unknown model is flagged, not silently priced at zero", () => {
    const t = new CostTracker();
    const entry = t.record("no-such-model-v9", "openai", {
      inputTokens: 1_000_000,
      outputTokens: 1_000,
    });
    expect(entry.priced).toBe(false);
    expect(t.getBreakdown().unpricedModels).toContain("no-such-model-v9");
  });

  test("a genuinely free model is priced, and not flagged unpriced", () => {
    const t = new CostTracker();
    const entry = t.record("stealth/ox-alpha", "openrouter", {
      inputTokens: 1_000_000,
      outputTokens: 1_000,
    });
    expect(entry.priced).toBe(true);
    expect(entry.listCostUsd).toBe(0);
    expect(t.getBreakdown().unpricedModels).toEqual([]);
  });
});

describe("cache-aware pricing", () => {
  test("cache reads are billed at their discount, not as fresh input", () => {
    const t = new CostTracker();
    // claude-sonnet-5: $2/M in, $10/M out, cache read defaults to 10% = $0.20/M
    const cost = t.estimate("claude-sonnet-5", {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 900_000,
    });
    // 0.1M * $2 + 0.9M * $0.20 + 0.01M * $10 = 0.20 + 0.18 + 0.10
    expect(cost).toBeCloseTo(0.48, 6);
  });

  test("a model with an explicit cache rate does not take the 10% default", () => {
    const t = new CostTracker();
    // gemini-2.5-flash discounts to 25%, not 10%.
    const cost = t.estimate("gemini-2.5-flash", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.0375, 6);
  });

  test("the no-cache counterfactual prices every token fresh", () => {
    const t = new CostTracker();
    const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 900_000 };
    const withCache = t.estimate("claude-sonnet-5", usage);
    const without = t.estimateWithoutCache("claude-sonnet-5", usage);
    // 1M * $2 + 0.01M * $10 = 2.10
    expect(without).toBeCloseTo(2.1, 6);
    expect(without).toBeGreaterThan(withCache);
  });

  test("breakdown reports hit rate and the dollars the cache saved", () => {
    const t = new CostTracker();
    t.record("claude-sonnet-5", "anthropic", {
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 900_000,
    });
    const b = t.getBreakdown();
    expect(b.cacheHitRate).toBeCloseTo(0.9, 6);
    expect(b.cacheSavingUsd).toBeCloseTo(2.1 - 0.48, 6);
  });

  test("hit rate is null with no data, never a misleading zero", () => {
    expect(new CostTracker().getBreakdown().cacheHitRate).toBeNull();
  });
});

describe("billing mode separates spend from worth", () => {
  test("a subscription seat costs nothing but still reports list value", () => {
    const t = new CostTracker();
    const entry = t.record("gpt-5.6-sol", "codex", {
      inputTokens: 1_000_000,
      outputTokens: 10_000,
    });
    expect(entry.billing).toBe("subscription");
    expect(entry.costUsd).toBe(0);
    // 1M * $1.25 + 0.01M * $10 = 1.35
    expect(entry.listCostUsd).toBeCloseTo(1.35, 6);
    expect(t.getLedger().totalCostUsd).toBe(0);
    expect(t.getLedger().totalListCostUsd).toBeCloseTo(1.35, 6);
  });

  test("a metered route charges what it is worth", () => {
    const t = new CostTracker();
    const entry = t.record("claude-sonnet-5", "anthropic", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(entry.billing).toBe("metered");
    expect(entry.costUsd).toBeCloseTo(2, 6);
  });

  test("the same model is metered or free depending on the account", () => {
    expect(billingModeFor("google", "gemini-2.5-flash")).toBe("metered");
    expect(billingModeFor("openrouter", "deepseek/deepseek-v4-flash:free")).toBe("free");
    expect(billingModeFor("ollama-turbo", "qwen3-coder:480b")).toBe("subscription");
    expect(billingModeFor("ollama", "qwen3-coder:480b")).toBe("free");
  });

  test("estimated rates are carried through so readouts can mark them", () => {
    const t = new CostTracker();
    expect(t.record("gpt-5.6-sol", "codex", { inputTokens: 1, outputTokens: 1 }).estimated).toBe(
      true,
    );
    expect(
      t.record("claude-sonnet-5", "anthropic", { inputTokens: 1, outputTokens: 1 }).estimated,
    ).toBe(false);
    expect(t.getBreakdown().hasEstimatedRates).toBe(true);
  });
});

describe("prefixed model ids resolve to their canonical rates", () => {
  test("an OpenRouter-prefixed id prices like the bare model", () => {
    const t = new CostTracker();
    const prefixed = t.estimate("openrouter/claude-sonnet-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const bare = t.estimate("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 });
    expect(prefixed).toBe(bare);
  });
});
