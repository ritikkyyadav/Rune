// ─── Run economics: what a task actually cost in COMPLETIONS (P12.1) ───
//
// Measured 2026-09-07 on 666 sessions of the founder's run DB: 45% of all
// recorded incidents are provider rate limits, and the run rides free tiers.
// A free tier is not priced in dollars, it is priced in REQUESTS PER MINUTE —
// so the number that decides whether Rune works there is not spend, it is how
// many completions one task takes and how many fresh input tokens each one
// carries. The meter answered neither: every completion looked alike, so the
// harness's own calls (the safety classifier, the compaction summarizer, the
// intent read) were invisible beside the work, and the ~34k fresh tokens on
// each one had no attribution at all.
//
// This module is the answer, and it is deliberately pure over cost entries:
// the live ledger and the rows `rune cost` reads back out of the session
// database are the same shape, so the two surfaces can never drift into
// reporting different numbers for the same session.

import type { CallRole, CostEntry, ProviderName } from "./types";
import { isGovernanceRole, MODEL_PRICING } from "./types";

/** One role's slice of a run. */
export interface RoleEconomics {
  role: CallRole;
  completions: number;
  /** Fresh (uncached) input tokens — the number a rate limit actually meters. */
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  listCostUsd: number;
  costUsd: number;
}

/** Bytes per prompt part, summed over the completions that measured them. */
export interface CompositionEconomics {
  /** How many completions carried a composition record. */
  measured: number;
  doctrine: number;
  planLedger: number;
  taskState: number;
  toolSchemas: number;
  conversation: number;
  total: number;
  /**
   * The FIXED overhead (doctrine + tool schemas) on the first measured
   * completion and on the last (P13.1).
   *
   * The averages above hide the shape a run actually has. Rune now sends a
   * bigger prefix on the opening completion than on the ones after it — the
   * opening rituals leave the doctrine at turn 2 — and it sends MORE tool
   * schema as catalogued tools are loaded. An average over both is a number
   * that describes no request that was ever sent. These two say which way the
   * overhead moved, which is the whole question the meter exists to answer.
   */
  fixedFirst: number;
  fixedLast: number;
}

export interface RunEconomics {
  completions: number;
  /** Completions doing the user's work (`primary`, `subagent`, `research`). */
  primaryCompletions: number;
  /** Completions that are Rune's own overhead. */
  governanceCompletions: number;
  /** governance / total, or null when nothing was recorded. */
  governanceShare: number | null;
  /** Mean fresh input tokens per completion — the free-tier pressure figure. */
  freshTokensPerCompletion: number | null;
  /** Mean fresh input tokens on a governance completion specifically. */
  governanceFreshTokensPerCompletion: number | null;
  /** Warm share of all input, 0-1, or null for no data. NEVER report 0 for no data. */
  cacheReadRatio: number | null;
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** What every recorded token is worth at list rates, free routes included. */
  listCostUsd: number;
  /** What was actually paid. Zero on a free or subscription route. */
  costUsd: number;
  /** List dollars attributable to governance completions alone. */
  governanceListCostUsd: number;
  /** Per role, highest completion count first; roles with no traffic are absent. */
  byRole: RoleEconomics[];
  /** Prompt composition, over the completions that measured it. Null when none did. */
  composition: CompositionEconomics | null;
  /** Models seen with no MODEL_PRICING row — their list figures are understated. */
  unpricedModels: string[];
}

/** A row absent a role predates the field or did not say; it is the work. */
function roleOf(entry: { role?: CallRole }): CallRole {
  return entry.role ?? "primary";
}

const EMPTY_ROLE = (role: CallRole): RoleEconomics => ({
  role,
  completions: 0,
  freshInputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  listCostUsd: 0,
  costUsd: 0,
});

/**
 * The economics of a set of completions.
 *
 * Accepts anything cost-entry-SHAPED rather than `CostEntry` itself, because
 * the rows read back out of the session log are plain JSON with a string
 * timestamp — and forcing them through a Date parse to be counted would be
 * ceremony over a number nothing here reads.
 */
export function summarizeRunEconomics(
  entries: ReadonlyArray<
    Pick<
      CostEntry,
      | "model"
      | "provider"
      | "inputTokens"
      | "outputTokens"
      | "cacheReadTokens"
      | "cacheCreationTokens"
      | "costUsd"
      | "listCostUsd"
    > &
      Partial<Pick<CostEntry, "role" | "composition" | "priced">>
  >,
): RunEconomics {
  const byRole = new Map<CallRole, RoleEconomics>();
  const unpriced = new Set<string>();
  let freshInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let listCostUsd = 0;
  let costUsd = 0;
  let governanceCompletions = 0;
  let governanceFresh = 0;
  let governanceListCostUsd = 0;
  const comp: CompositionEconomics = {
    measured: 0,
    doctrine: 0,
    planLedger: 0,
    taskState: 0,
    toolSchemas: 0,
    conversation: 0,
    total: 0,
    fixedFirst: 0,
    fixedLast: 0,
  };

  for (const e of entries) {
    const role = roleOf(e);
    const acc = byRole.get(role) ?? EMPTY_ROLE(role);
    const fresh = Math.max(0, e.inputTokens || 0);
    const read = Math.max(0, e.cacheReadTokens || 0);
    const written = Math.max(0, e.cacheCreationTokens || 0);
    const out = Math.max(0, e.outputTokens || 0);
    acc.completions++;
    acc.freshInputTokens += fresh;
    acc.cacheReadTokens += read;
    acc.cacheCreationTokens += written;
    acc.outputTokens += out;
    acc.listCostUsd += e.listCostUsd || 0;
    acc.costUsd += e.costUsd || 0;
    byRole.set(role, acc);

    freshInputTokens += fresh;
    cacheReadTokens += read;
    cacheCreationTokens += written;
    outputTokens += out;
    listCostUsd += e.listCostUsd || 0;
    costUsd += e.costUsd || 0;
    if (isGovernanceRole(role)) {
      governanceCompletions++;
      governanceFresh += fresh;
      governanceListCostUsd += e.listCostUsd || 0;
    }
    if (e.priced === false || (e.model && MODEL_PRICING[e.model] === undefined)) {
      unpriced.add(e.model);
    }
    if (e.composition) {
      comp.measured++;
      comp.doctrine += e.composition.doctrine || 0;
      comp.planLedger += e.composition.planLedger || 0;
      comp.taskState += e.composition.taskState || 0;
      comp.toolSchemas += e.composition.toolSchemas || 0;
      comp.conversation += e.composition.conversation || 0;
      comp.total += e.composition.total || 0;
      const fixed = (e.composition.doctrine || 0) + (e.composition.toolSchemas || 0);
      if (comp.measured === 1) comp.fixedFirst = fixed;
      comp.fixedLast = fixed;
    }
  }

  const completions = entries.length;
  const totalInput = freshInputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    completions,
    primaryCompletions: completions - governanceCompletions,
    governanceCompletions,
    governanceShare: completions > 0 ? governanceCompletions / completions : null,
    freshTokensPerCompletion: completions > 0 ? freshInputTokens / completions : null,
    governanceFreshTokensPerCompletion:
      governanceCompletions > 0 ? governanceFresh / governanceCompletions : null,
    // Null is "no data", never "0%" — the rule the whole cost surface keeps.
    cacheReadRatio: totalInput > 0 ? cacheReadTokens / totalInput : null,
    freshInputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    listCostUsd,
    costUsd,
    governanceListCostUsd,
    byRole: [...byRole.values()].sort(
      (a, b) => b.completions - a.completions || a.role.localeCompare(b.role),
    ),
    composition: comp.measured > 0 ? comp : null,
    unpricedModels: [...unpriced].filter(Boolean),
  };
}

/** Provider totals, for a readout that wants to name where the calls went. */
export function completionsByProvider(
  entries: ReadonlyArray<{ provider: ProviderName; role?: CallRole }>,
): Array<{ provider: ProviderName; completions: number; governance: number }> {
  const map = new Map<ProviderName, { completions: number; governance: number }>();
  for (const e of entries) {
    const acc = map.get(e.provider) ?? { completions: 0, governance: 0 };
    acc.completions++;
    if (isGovernanceRole(roleOf(e))) acc.governance++;
    map.set(e.provider, acc);
  }
  return [...map.entries()]
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.completions - a.completions);
}
