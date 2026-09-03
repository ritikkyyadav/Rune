// ─── Model Tiers ───
//
// Three capability tiers, mixable across providers, so heavy lifting runs on
// frontier models while cheap internal work (sub-agent exploration, compaction
// summaries, memory dreams) runs on lightweight ones:
//
//   heavy    — hardest tasks: deep refactors, planning, research synthesis
//   standard — the main agent loop's default
//   light    — internal utility work where speed/cost beat depth
//
// Resolution order (per tier):
//   1. User override from config.toml `[tiers]` — accepts "model" (active
//      provider) or "provider/model" (cross-provider, e.g. heavy = "anthropic/
//      claude-opus-4-8" while light = "deepseek/deepseek-chat"). Only honored
//      when that provider is actually registered (has credentials).
//   2. The active provider's built-in tier defaults below.
//   3. The active session model (always registered, never wrong).

import { PROVIDER_PRESETS } from "./providers";

export type ModelTier = "heavy" | "standard" | "light";

/**
 * How sub-agents are orchestrated (`[subagents] mode`):
 *
 *   "auto"       — (default) the agent delegates when it helps and routes each
 *                  call's model weight per tier: light scouts, standard
 *                  workers, heavy on request.
 *   "off"        — no sub-agents at all. The task/worker tools are never
 *                  registered, the doctrine never mentions them, and one agent
 *                  with the session's full capability does everything itself.
 *   "configured" — every sub-agent runs the model the user named in
 *                  `[subagents] model`, regardless of tier.
 *   "mirror"     — every sub-agent runs the SESSION's exact model, provider,
 *                  and reasoning effort. No compromise between the work you
 *                  watch and the work that gets delegated.
 */
export type SubagentMode = "off" | "auto" | "configured" | "mirror";

/** The reasoning dials a `[subagents] effort` may name (mirrors ReasoningEffort). */
const SUBAGENT_EFFORT_VALUES = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Read `[subagents] effort`; anything unrecognized means "not set". */
export function normalizeSubagentEffort(
  value: unknown,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  return SUBAGENT_EFFORT_VALUES.has(v)
    ? (v as "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
    : undefined;
}

/** Read `[subagents] mode`; anything unrecognized keeps today's behavior. */
export function normalizeSubagentMode(value: unknown): SubagentMode {
  switch (
    String(value ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "off":
    case "none":
    case "solo":
    case "single":
      return "off";
    case "configured":
    case "manual":
    case "fixed":
      return "configured";
    case "mirror":
    case "static":
    case "same":
    case "session":
      return "mirror";
    default:
      return "auto";
  }
}

export interface TierRef {
  provider: string;
  model: string;
}

export interface TiersConfig {
  heavy?: string;
  standard?: string;
  light?: string;
}

/**
 * Built-in tier defaults per provider — DERIVED, not hand-maintained.
 *
 * P8.6 started this fold and left it half done: `ollama-turbo` owned its ids in
 * its preset while nine other providers kept a second copy here, so "one
 * catalogue per provider" was true of one provider. P10.5 finished it. Every id
 * now lives in exactly one place, `ProviderPreset.tiers`, and this table is a
 * projection of it. A provider absent from the presets' `tiers` (local
 * runtimes, the custom endpoint) has no entry and falls through to the session
 * model, exactly as before.
 *
 * The fold is not cosmetic. `ollama-turbo`'s lineup rotted twice — qwen3-coder:
 * 480b and its announced successor qwen3-coder-next both 410'd on 2026-07-15 —
 * and each rot had to be chased through three hand-maintained tables. When it
 * was missed here, this table pointed at a corpse while the presets had already
 * been refreshed, which killed compaction for those sessions. There is now one
 * place to fix, and `tests/unit/shared/provider-tables.test.ts` fails if any
 * table names a model its provider does not offer.
 *
 * When ids rot again, the summarizer's live-list recovery (context-engine.ts)
 * keeps compaction alive; refresh the preset to stop the main loop from booting
 * on a corpse.
 */
export const PROVIDER_TIER_DEFAULTS: Record<
  string,
  { heavy: string; standard: string; light: string }
> = Object.fromEntries(PROVIDER_PRESETS.filter((p) => p.tiers).map((p) => [p.id, p.tiers!]));

/**
 * Parse a tier override value: "model" → active provider; "provider/model" →
 * that provider — but only when the prefix is a KNOWN provider id, because
 * model ids legitimately contain slashes (OpenRouter's "qwen/qwen3-coder:free").
 */
export function parseTierRef(
  value: string,
  activeProvider: string,
  knownProviders: ReadonlySet<string>,
): TierRef {
  const slash = value.indexOf("/");
  if (slash > 0) {
    const prefix = value.slice(0, slash);
    if (knownProviders.has(prefix)) {
      return { provider: prefix, model: value.slice(slash + 1) };
    }
  }
  return { provider: activeProvider, model: value };
}

/**
 * Resolve a tier to a concrete provider+model.
 *
 * @param tier            Which tier to resolve.
 * @param overrides       User `[tiers]` config (may be undefined/partial).
 * @param activeProvider  The session's current provider.
 * @param activeModel     The session's current model (final fallback).
 * @param registered      Providers with working credentials — an override or
 *                        default naming an unregistered provider is skipped.
 * @param knownProviders  All valid provider ids (for provider/model parsing).
 */
export function resolveTier(
  tier: ModelTier,
  overrides: TiersConfig | undefined,
  activeProvider: string,
  activeModel: string,
  registered: ReadonlySet<string>,
  knownProviders: ReadonlySet<string>,
): TierRef {
  // 1. Explicit user override
  const override = overrides?.[tier];
  if (override && override.trim()) {
    const ref = parseTierRef(override.trim(), activeProvider, knownProviders);
    if (registered.has(ref.provider)) return ref;
    // Provider not usable (no key) — fall through rather than 401 mid-task.
  }

  // 2. Active provider's built-in tier table
  const defaults = PROVIDER_TIER_DEFAULTS[activeProvider];
  if (defaults && registered.has(activeProvider)) {
    return { provider: activeProvider, model: defaults[tier] };
  }

  // 3. The session model — always registered, never wrong.
  return { provider: activeProvider, model: activeModel };
}
