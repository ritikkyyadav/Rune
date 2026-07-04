// ─── CostGovernor: the hard ceiling on learning spend ───
// The evolution loop's contract with the user: learning overhead stays under
// `budgetPct` (default 2%) of what the session itself cost. v1's capture and
// retrieval are rule-based and spend NOTHING — this governor exists so the
// future distillation/triage passes (cheapest tier or local models only) are
// structurally incapable of becoming the 30%-of-budget failure mode. Every
// model-spending learning job MUST call allow() first.

export interface CostGovernorConfig {
  /** Learning budget as a percentage of session spend. Default 2. */
  budgetPct?: number;
  /**
   * Absolute floor (USD) always allowed even when the session cost ~nothing —
   * lets a local/free-tier session still run one tiny distillation. Default $0.002.
   */
  floorUsd?: number;
}

export class CostGovernor {
  private budgetPct: number;
  private floorUsd: number;
  private spentUsd = 0;

  constructor(config: CostGovernorConfig = {}) {
    this.budgetPct = config.budgetPct ?? 2;
    this.floorUsd = config.floorUsd ?? 0.002;
  }

  /**
   * May a learning job that will cost ~`estimatedUsd` run, given the session
   * has spent `sessionSpendUsd` so far? Free jobs (0) are always allowed.
   */
  allow(estimatedUsd: number, sessionSpendUsd: number): boolean {
    if (estimatedUsd <= 0) return true;
    const ceiling = Math.max((this.budgetPct / 100) * sessionSpendUsd, this.floorUsd);
    return this.spentUsd + estimatedUsd <= ceiling;
  }

  /** Record what a permitted job actually cost. */
  add(actualUsd: number): void {
    if (actualUsd > 0) this.spentUsd += actualUsd;
  }

  spent(): number {
    return this.spentUsd;
  }

  /** Learning spend as a fraction of session spend (for doctor/status display). */
  ratio(sessionSpendUsd: number): number {
    return sessionSpendUsd <= 0 ? 0 : this.spentUsd / sessionSpendUsd;
  }
}
