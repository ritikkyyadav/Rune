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

import type { CostBreakdown } from "@rune/llm-gateway";

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
