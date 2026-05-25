import type { CostEntry, CostLedger, ModelPricing, ProviderName, TokenUsage } from "./types";
import { MODEL_PRICING } from "./types";

export type BudgetScope = "session" | "daily" | "monthly";

export interface BudgetCap {
  scope: BudgetScope;
  limitUsd: number;
}

export interface CostBreakdown {
  totalCostUsd: number;
  byProvider: Partial<Record<ProviderName, number>>;
  byModel: Record<string, number>;
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

export class CostTracker {
  private ledger: CostLedger = { entries: [], totalCostUsd: 0 };
  private budgets: BudgetCap[];
  private pricing: Record<string, ModelPricing>;

  constructor(options: { budgets?: BudgetCap[]; pricing?: Record<string, ModelPricing> } = {}) {
    this.budgets = options.budgets ?? [];
    this.pricing = { ...MODEL_PRICING, ...(options.pricing ?? {}) };
  }

  estimate(model: string, usage: TokenUsage): number {
    const price = this.pricing[model];
    if (!price) return 0;
    return (
      (usage.inputTokens * price.inputPerMillion) / 1_000_000 +
      (usage.outputTokens * price.outputPerMillion) / 1_000_000
    );
  }

  record(
    model: string,
    provider: ProviderName,
    usage: TokenUsage,
    timestamp = new Date(),
  ): CostEntry {
    const costUsd = this.estimate(model, usage);
    const projected = this.ledger.totalCostUsd + costUsd;
    const sessionBudget = this.budgets.find((b) => b.scope === "session");
    if (sessionBudget && projected > sessionBudget.limitUsd) {
      throw new BudgetExceededError("session", sessionBudget.limitUsd, projected);
    }

    const entry: CostEntry = {
      model,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      timestamp,
    };
    this.ledger.entries.push(entry);
    this.ledger.totalCostUsd += costUsd;
    return entry;
  }

  getLedger(): CostLedger {
    return {
      entries: [...this.ledger.entries],
      totalCostUsd: this.ledger.totalCostUsd,
    };
  }

  getBreakdown(): CostBreakdown {
    const byProvider: Partial<Record<ProviderName, number>> = {};
    const byModel: Record<string, number> = {};

    for (const entry of this.ledger.entries) {
      byProvider[entry.provider] = (byProvider[entry.provider] ?? 0) + entry.costUsd;
      byModel[entry.model] = (byModel[entry.model] ?? 0) + entry.costUsd;
    }

    return {
      totalCostUsd: this.ledger.totalCostUsd,
      byProvider,
      byModel,
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
    this.ledger = { entries: [], totalCostUsd: 0 };
  }
}
