// ─── Cost readout ───
//
// Turns a CostBreakdown into display rows. Pure and UI-free so the numbers can
// be unit-tested without a terminal, and so `/cost`, the session-end summary,
// and the signed export all say the same thing.
//
// The rules here exist because the previous readout printed a single
// `$0.0000` — technically true (the traffic rode a subscription) and useless.
// A meter that cannot distinguish "free" from "unmeasured", or show what the
// same work costs metered, answers no question anyone actually asks.

import type { CostBreakdown, RunEconomics } from "@rune/llm-gateway";
import { compositionShares } from "@rune/llm-gateway";

export type CostTone = "normal" | "muted" | "warn" | "good";

export interface CostReportLine {
  label: string;
  value: string;
  note?: string;
  tone?: CostTone;
}

/**
 * Money, at a precision that suits the magnitude. Sub-cent amounts need four
 * decimals to say anything at all; dollar amounts read as noise with them.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Token counts, compacted — 43,861,351 is unreadable in a status line. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

/**
 * A cache hit rate for display. THE rule of this module, in one function:
 * `null` is "no data", never "0%". They are different facts — a provider that
 * reports no cache counters and a provider whose cache missed every time — and
 * rendering them the same is how an invented number reaches a screen.
 *
 * Every surface that shows a hit rate calls this: the `/cost` readout, the
 * status line, and `rune audit`.
 */
export function formatCacheRate(rate: number | null): string {
  return rate === null ? "no data" : formatPercent(rate);
}

/**
 * The full readout.
 *
 * Ordered by the question each line answers: what did this cost me, what would
 * it have cost metered, what did caching save, and how much should you trust
 * the figures.
 */
export function formatCostReport(b: CostBreakdown): CostReportLine[] {
  const lines: CostReportLine[] = [];
  const tilde = b.hasEstimatedRates ? "~" : "";

  // 1. What actually left the building.
  const subscriptionOnly = b.totalCostUsd === 0 && b.totalListCostUsd > 0;
  lines.push({
    label: "Spent",
    value: formatUsd(b.totalCostUsd),
    note: subscriptionOnly ? "subscription / free tier — no metered charge" : undefined,
    tone: "normal",
  });

  // 2. The number that compares to a competitor's invoice.
  lines.push({
    label: "Metered equivalent",
    value: `${tilde}${formatUsd(b.totalListCostUsd)}`,
    note: "what this would cost at list rates",
    tone: "muted",
  });

  // 3. What caching bought. Null hit rate is "no data", never 0%.
  if (b.cacheHitRate === null) {
    lines.push({
      label: "Cache",
      value: "no data yet",
      note: "no usage reported this session",
      tone: "muted",
    });
  } else {
    lines.push({
      label: "Cache hit rate",
      value: formatPercent(b.cacheHitRate),
      note: `${formatTokens(b.cacheReadTokens)} of ${formatTokens(
        b.inputTokens + b.cacheReadTokens + b.cacheCreationTokens,
      )} input served warm`,
      tone: b.cacheHitRate >= 0.5 ? "good" : "normal",
    });
    lines.push({
      label: "Cache saved",
      value: `${tilde}${formatUsd(b.cacheSavingUsd)}`,
      note: `vs ${tilde}${formatUsd(b.listCostWithoutCacheUsd)} with no cache`,
      tone: b.cacheSavingUsd > 0 ? "good" : "muted",
    });
  }

  // 3b. Per provider, when more than one was used. A blended rate across a
  // caching provider and a non-caching one describes neither.
  const providers = Object.entries(b.cacheByProvider);
  if (providers.length > 1) {
    for (const [provider, stats] of providers) {
      if (!stats) continue;
      lines.push({
        label: `  ${provider}`,
        value: formatCacheRate(stats.hitRate),
        note:
          stats.hitRate === null
            ? "no usage reported"
            : `${formatTokens(stats.cacheReadTokens)} of ${formatTokens(
                stats.totalInputTokens,
              )} warm · saved ${tilde}${formatUsd(stats.savingUsd)}`,
        tone: stats.hitRate === null ? "muted" : stats.hitRate >= 0.5 ? "good" : "normal",
      });
    }
  }

  // 4. Volume, so the dollar figures have a denominator.
  lines.push({
    label: "Tokens",
    value: `${formatTokens(
      b.inputTokens + b.cacheReadTokens + b.cacheCreationTokens,
    )} in · ${formatTokens(b.outputTokens)} out`,
    tone: "muted",
  });

  // 5. Confidence. A meter that hides its own uncertainty is the original bug.
  if (b.unpricedModels.length > 0) {
    lines.push({
      label: "Unpriced",
      value: b.unpricedModels.join(", "),
      note: "tokens NOT counted above — add rates to MODEL_PRICING",
      tone: "warn",
    });
  }
  if (b.hasEstimatedRates) {
    lines.push({
      label: "Note",
      value: "~ marks inferred rates",
      note: "no published price list for some models used",
      tone: "muted",
    });
  }

  return lines;
}

/** Bytes, compacted the way formatTokens compacts counts. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n < 1_024) return `${Math.round(n)}B`;
  if (n < 1_024 * 1_024) return `${(n / 1_024).toFixed(1)}KB`;
  return `${(n / (1_024 * 1_024)).toFixed(2)}MB`;
}

/**
 * The run-economics readout: what a task cost in COMPLETIONS rather than in
 * dollars.
 *
 * This is the half of the meter that free tiers actually need. A free route
 * bills nothing and rate-limits everything, so `formatCostReport` above — which
 * answers "what did this cost" — correctly reports $0.00 and says nothing about
 * whether the run will survive. These lines answer the question that decides it:
 * how many requests did Rune make, how many of those were its OWN, how much
 * fresh input did each one carry, and how much of that was served warm.
 *
 * Appended to `/cost` and printed by `rune cost`. Returns [] when nothing has
 * been recorded, so a fresh session prints the money readout unchanged.
 */
export function formatRunEconomics(e: RunEconomics): CostReportLine[] {
  if (e.completions === 0) return [];
  const lines: CostReportLine[] = [];
  const tilde = e.unpricedModels.length > 0 ? "~" : "";

  // 1. The completion count, split. The number a rate limit meters.
  lines.push({
    label: "Completions",
    value: String(e.completions),
    note:
      `${e.primaryCompletions} work · ${e.governanceCompletions} governance` +
      (e.governanceShare === null ? "" : ` (${formatPercent(e.governanceShare)})`),
    tone: e.governanceShare !== null && e.governanceShare >= 0.5 ? "warn" : "normal",
  });

  // 2. Which of Rune's own calls, by name. Only roles that actually ran.
  for (const role of e.byRole) {
    if (role.completions === 0) continue;
    lines.push({
      label: `  ${role.role}`,
      value: String(role.completions),
      note: `${formatTokens(role.freshInputTokens)} fresh in · ${formatTokens(role.outputTokens)} out`,
      tone: "muted",
    });
  }

  // 3. Fresh tokens per completion — the other half of the pressure. The
  //    founder's measurement was ~34k; this is where it becomes visible.
  if (e.freshTokensPerCompletion !== null) {
    lines.push({
      label: "Fresh in / call",
      value: formatTokens(Math.round(e.freshTokensPerCompletion)),
      note:
        e.governanceFreshTokensPerCompletion === null
          ? "uncached input the provider had to read"
          : `${formatTokens(Math.round(e.governanceFreshTokensPerCompletion))} on a governance call`,
      tone: "normal",
    });
  }

  // 4. Cache. Same rule as everywhere: null is "no data", never 0%.
  lines.push({
    label: "Cache read ratio",
    value: formatCacheRate(e.cacheReadRatio),
    note:
      e.cacheReadRatio === null
        ? "no provider reported cache counters"
        : `${formatTokens(e.cacheReadTokens)} of ${formatTokens(
            e.freshInputTokens + e.cacheReadTokens + e.cacheCreationTokens,
          )} input served warm`,
    tone: e.cacheReadRatio !== null && e.cacheReadRatio >= 0.5 ? "good" : "normal",
  });

  // 5. What the same completions cost at list rates, and what governance's
  //    share of that is — the price of Rune's own overhead, stated.
  lines.push({
    label: "List estimate",
    value: `${tilde}${formatUsd(e.listCostUsd)}`,
    note:
      e.governanceListCostUsd > 0
        ? `${tilde}${formatUsd(e.governanceListCostUsd)} of it governance`
        : "at published rates, regardless of who paid",
    tone: "muted",
  });

  // 6. What a request is MADE of. Only when something measured it — the
  //    governance callers do not, and a composition row averaged over calls
  //    that never reported one would be a fiction.
  const shares = e.composition ? compositionShares(e.composition) : null;
  if (e.composition && shares) {
    const perCall = e.composition.total / e.composition.measured;
    lines.push({
      label: "Prompt bytes / call",
      value: formatBytes(perCall),
      note: `measured on ${e.composition.measured} of ${e.completions} completions`,
      tone: "muted",
    });
    const parts: Array<[string, number, number]> = [
      ["doctrine", e.composition.doctrine, shares.doctrine],
      ["tool schemas", e.composition.toolSchemas, shares.toolSchemas],
      ["plan ledger", e.composition.planLedger, shares.planLedger],
      ["task state", e.composition.taskState, shares.taskState],
      ["conversation", e.composition.conversation, shares.conversation],
    ];
    for (const [label, bytes, share] of parts) {
      lines.push({
        label: `  ${label}`,
        value: formatBytes(bytes / e.composition.measured),
        note: formatPercent(share),
        tone: "muted",
      });
    }
    // Which way the fixed overhead moved across the run (P13.1). The averages
    // above hide it: the opening completion carries the opening doctrine, and
    // the tool surface grows as catalogued tools are loaded. Only shown when
    // the two actually differ — on a one-completion run they cannot.
    const { fixedFirst, fixedLast } = e.composition;
    if (e.composition.measured > 1 && fixedFirst !== fixedLast) {
      const delta = fixedLast - fixedFirst;
      lines.push({
        label: "  fixed overhead",
        value: `${formatBytes(fixedFirst)} → ${formatBytes(fixedLast)}`,
        note:
          delta < 0
            ? `${formatBytes(-delta)} less doctrine + schema on the last call than the first`
            : `${formatBytes(delta)} more — tools were loaded into the prompt mid-run`,
        tone: "muted",
      });
    }
  }

  if (e.unpricedModels.length > 0) {
    lines.push({
      label: "Unpriced",
      value: e.unpricedModels.join(", "),
      note: "the list estimate above understates by these models' tokens",
      tone: "warn",
    });
  }
  return lines;
}

/**
 * One-line form for a status bar. Leads with the metered equivalent, because
 * on a subscription route the actual spend is always $0.00 and says nothing.
 */
export function formatCostSummary(b: CostBreakdown): string {
  const tilde = b.hasEstimatedRates ? "~" : "";
  const spend =
    b.totalCostUsd > 0
      ? formatUsd(b.totalCostUsd)
      : `${tilde}${formatUsd(b.totalListCostUsd)} value`;
  if (b.cacheHitRate === null) return spend;
  return `${spend} · cache ${formatCacheRate(b.cacheHitRate)}`;
}
