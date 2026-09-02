import type {
  BillingMode,
  CostEntry,
  CostLedger,
  ModelPricing,
  ProviderName,
  TokenUsage,
} from "./types";
import {
  billingModeFor,
  DEFAULT_CACHE_READ_RATIO,
  DEFAULT_CACHE_WRITE_RATIO,
  MODEL_PRICING,
} from "./types";

export type BudgetScope = "session" | "daily" | "monthly";

export interface BudgetCap {
  scope: BudgetScope;
  limitUsd: number;
}

/**
 * What the cache did on ONE provider. Separated per provider because that is
 * the axis the answer varies on: a session that fell back from a caching
 * provider to one with no cache at all reports a blended rate that describes
 * neither, and the blended number is the one that looks fine.
 */
export interface ProviderCacheStats {
  /** Share of this provider's input served warm, 0-1, or null for no data. */
  hitRate: number | null;
  /** Dollars the cache saved on this provider against the no-cache counterfactual. */
  savingUsd: number;
  cacheReadTokens: number;
  /** Every input token on this provider: fresh + read + written. */
  totalInputTokens: number;
}

export interface CostBreakdown {
  /** Dollars actually spent — zero for subscription and free routes. */
  totalCostUsd: number;
  /** What the same work costs metered at list rates. The comparable number. */
  totalListCostUsd: number;
  byProvider: Partial<Record<ProviderName, number>>;
  byModel: Record<string, number>;
  /** Metered-equivalent split, so a free route still shows where value went. */
  listByModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Share of total input served from cache, 0–1, or null when nothing has
   * been recorded. Null is not zero: "no data" and "no cache hits" are
   * different facts and the UI must not render them the same.
   */
  cacheHitRate: number | null;
  /** What the run WOULD have cost with no cache discount at all. */
  listCostWithoutCacheUsd: number;
  /** Dollars the cache saved against that counterfactual. */
  cacheSavingUsd: number;
  /**
   * The same two facts, per provider. `hitRate: null` means this provider
   * reported no input at all - "no data", which is not "0%".
   */
  cacheByProvider: Partial<Record<ProviderName, ProviderCacheStats>>;
  /** Models with no entry in MODEL_PRICING — their tokens are unpriced. */
  unpricedModels: string[];
  /** True when any priced model used an inferred rate. */
  hasEstimatedRates: boolean;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: BudgetScope,
    readonly limitUsd: number,
    readonly projectedUsd: number,
  ) {
    super(
      `Budget exceeded for ${scope}: projected $${projectedUsd.toFixed(4)} over limit $${limitUsd.toFixed(4)}`,
    );
    this.name = "BudgetExceededError";
  }
}

/** Zero-filled usage, so callers may pass a partial report. */
function normalizeUsage(usage: TokenUsage): Required<TokenUsage> {
  return {
    inputTokens: Math.max(0, usage.inputTokens || 0),
    outputTokens: Math.max(0, usage.outputTokens || 0),
    cacheReadTokens: Math.max(0, usage.cacheReadTokens || 0),
    cacheCreationTokens: Math.max(0, usage.cacheCreationTokens || 0),
  };
}

export class CostTracker {
  private ledger: CostLedger = {
    entries: [],
    totalCostUsd: 0,
    totalListCostUsd: 0,
    unpricedModels: [],
  };
  private budgets: BudgetCap[];
  private pricing: Record<string, ModelPricing>;
  private unpriced = new Set<string>();

  constructor(options: { budgets?: BudgetCap[]; pricing?: Record<string, ModelPricing> } = {}) {
    this.budgets = options.budgets ?? [];
    this.pricing = { ...MODEL_PRICING, ...(options.pricing ?? {}) };
  }

  /**
   * Look up a model's rates.
   *
   * Falls back to a bare-id match so an OpenRouter-prefixed or date-suffixed
   * id resolves to the same rates as its canonical entry — "openai/gpt-4o"
   * and "gpt-4o" are one model billed one way, and requiring both spellings
   * in the table is how the old one drifted into 21 blind spots.
   */
  pricingFor(model: string): ModelPricing | undefined {
    const direct = this.pricing[model];
    if (direct) return direct;
    const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : undefined;
    if (bare && this.pricing[bare]) return this.pricing[bare];
    return undefined;
  }

  /** Whether this model's tokens can be priced at all. */
  hasPricing(model: string): boolean {
    return this.pricingFor(model) !== undefined;
  }

  /**
   * List-rate value of one usage report, in dollars. Prices each class of
   * input at its own rate — pricing cache reads as fresh input is how a
   * caching agent reports a bill several times its real one.
   *
   * Returns 0 for an unknown model. Callers that need to tell "free" from
   * "unknown" apart must consult hasPricing() — record() does.
   */
  estimate(model: string, usage: TokenUsage): number {
    const price = this.pricingFor(model);
    if (!price) return 0;
    const u = normalizeUsage(usage);
    const cacheRead = price.cacheReadPerMillion ?? price.inputPerMillion * DEFAULT_CACHE_READ_RATIO;
    const cacheWrite =
      price.cacheWritePerMillion ?? price.inputPerMillion * DEFAULT_CACHE_WRITE_RATIO;
    return (
      (u.inputTokens * price.inputPerMillion +
        u.cacheReadTokens * cacheRead +
        u.cacheCreationTokens * cacheWrite +
        u.outputTokens * price.outputPerMillion) /
      1_000_000
    );
  }

  /**
   * What the same usage would have cost with every cached token billed fresh.
   * The counterfactual the cache saving is measured against.
   */
  estimateWithoutCache(model: string, usage: TokenUsage): number {
    const price = this.pricingFor(model);
    if (!price) return 0;
    const u = normalizeUsage(usage);
    const allInput = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
    return (allInput * price.inputPerMillion + u.outputTokens * price.outputPerMillion) / 1_000_000;
  }

  record(
    model: string,
    provider: ProviderName,
    usage: TokenUsage,
    timestamp = new Date(),
  ): CostEntry {
    const u = normalizeUsage(usage);
    const price = this.pricingFor(model);
    const priced = price !== undefined;
    if (!priced) this.unpriced.add(model);

    const billing: BillingMode = billingModeFor(provider, model);
    const listCostUsd = this.estimate(model, u);
    // A subscription seat or a free pool bills nothing at the margin. The list
    // figure is still recorded — it is the only number comparable to a
    // competitor's invoice.
    const costUsd = billing === "metered" ? listCostUsd : 0;

    const entry: CostEntry = {
      model,
      provider,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
      costUsd,
      listCostUsd,
      billing,
      priced,
      estimated: price?.estimated === true,
      timestamp,
    };
    // Record BEFORE the cap is tested. The provider has already served and
    // billed this response; refusing to count it would make the ledger
    // understate exactly the run that overspent. The cap governs whether the
    // NEXT request goes out, not whether this one happened.
    this.ledger.entries.push(entry);
    this.ledger.totalCostUsd += costUsd;
    this.ledger.totalListCostUsd += listCostUsd;
    this.ledger.unpricedModels = [...this.unpriced];

    // Tested against the METERED-EQUIVALENT total, not actual spend. A cap on
    // spend can never fire on a subscription or free route — where this agent
    // spends most of its life — so it would guard only the runs that need
    // guarding least.
    const sessionBudget = this.budgets.find((b) => b.scope === "session");
    if (sessionBudget && this.ledger.totalListCostUsd > sessionBudget.limitUsd) {
      throw new BudgetExceededError(
        "session",
        sessionBudget.limitUsd,
        this.ledger.totalListCostUsd,
      );
    }
    return entry;
  }

  getLedger(): CostLedger {
    return {
      entries: [...this.ledger.entries],
      totalCostUsd: this.ledger.totalCostUsd,
      totalListCostUsd: this.ledger.totalListCostUsd,
      unpricedModels: [...this.unpriced],
    };
  }

  getBreakdown(): CostBreakdown {
    const byProvider: Partial<Record<ProviderName, number>> = {};
    const byModel: Record<string, number> = {};
    const listByModel: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let listCostWithoutCacheUsd = 0;
    let hasEstimatedRates = false;
    // Per-provider accumulators: read tokens, all input tokens, and the
    // no-cache counterfactual minus what was actually listed.
    const perProvider = new Map<
      ProviderName,
      { read: number; total: number; listed: number; withoutCache: number }
    >();

    for (const e of this.ledger.entries) {
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.costUsd;
      const acc = perProvider.get(e.provider) ?? {
        read: 0,
        total: 0,
        listed: 0,
        withoutCache: 0,
      };
      acc.read += e.cacheReadTokens;
      acc.total += e.inputTokens + e.cacheReadTokens + e.cacheCreationTokens;
      acc.listed += e.listCostUsd;
      acc.withoutCache += this.estimateWithoutCache(e.model, e);
      perProvider.set(e.provider, acc);
      byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
      listByModel[e.model] = (listByModel[e.model] ?? 0) + e.listCostUsd;
      inputTokens += e.inputTokens;
      outputTokens += e.outputTokens;
      cacheReadTokens += e.cacheReadTokens;
      cacheCreationTokens += e.cacheCreationTokens;
      listCostWithoutCacheUsd += this.estimateWithoutCache(e.model, e);
      if (e.estimated) hasEstimatedRates = true;
    }

    const cacheByProvider: Partial<Record<ProviderName, ProviderCacheStats>> = {};
    for (const [provider, acc] of perProvider) {
      cacheByProvider[provider] = {
        // Null, not zero, when the provider reported no input at all.
        hitRate: acc.total > 0 ? acc.read / acc.total : null,
        savingUsd: Math.max(0, acc.withoutCache - acc.listed),
        cacheReadTokens: acc.read,
        totalInputTokens: acc.total,
      };
    }

    const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
    return {
      totalCostUsd: this.ledger.totalCostUsd,
      totalListCostUsd: this.ledger.totalListCostUsd,
      byProvider,
      byModel,
      listByModel,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheHitRate: totalInput > 0 ? cacheReadTokens / totalInput : null,
      listCostWithoutCacheUsd,
      cacheSavingUsd: Math.max(0, listCostWithoutCacheUsd - this.ledger.totalListCostUsd),
      cacheByProvider,
      unpricedModels: [...this.unpriced],
      hasEstimatedRates,
    };
  }

  estimateToolCost(toolName: string): number {
    const costs: Record<string, number> = {
      bash: 0.005,
      web_fetch: 0.003,
      web_search: 0.004,
      read_file: 0.001,
      write_file: 0.002,
      edit_file: 0.002,
      list_dir: 0.001,
      grep: 0.001,
      // Retired in P4.7. The row stays so sessions recorded before then
      // still price their calls instead of silently costing zero.
      ast_query: 0.002,
      symbol_search: 0.001,
    };
    return costs[toolName] ?? 0.002;
  }

  preExecutionCheck(estimatedCost: number): boolean {
    const sessionBudget = this.budgets.find((b) => b.scope === "session");
    if (!sessionBudget) return true;
    return this.ledger.totalCostUsd + estimatedCost <= sessionBudget.limitUsd;
  }

  reset(): void {
    this.ledger = {
      entries: [],
      totalCostUsd: 0,
      totalListCostUsd: 0,
      unpricedModels: [],
    };
    this.unpriced.clear();
  }
}
