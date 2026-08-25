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

export type ModelTier = "heavy" | "standard" | "light";

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
 * Built-in tier defaults per provider. Conservative, broadly-available IDs —
 * a wrong ID here silently degrades a tier to a 404, so prefer boring over
 * bleeding-edge. Providers absent from this table (local runtimes, custom
 * endpoints) fall through to the session model.
 */
export const PROVIDER_TIER_DEFAULTS: Record<
  string,
  { heavy: string; standard: string; light: string }
> = {
  anthropic: {
    heavy: "claude-opus-4-8",
    standard: "claude-sonnet-4-6",
    light: "claude-haiku-4-5",
  },
  openai: {
    heavy: "gpt-5",
    standard: "gpt-5",
    light: "gpt-5-mini",
  },
  google: {
    heavy: "gemini-2.5-pro",
    standard: "gemini-2.5-pro",
    light: "gemini-2.5-flash",
  },
  deepseek: {
    heavy: "deepseek-reasoner",
    standard: "deepseek-chat",
    light: "deepseek-chat",
  },
  groq: {
    heavy: "llama-3.3-70b-versatile",
    standard: "llama-3.3-70b-versatile",
    light: "llama-3.1-8b-instant",
  },
  xai: {
    heavy: "grok-4",
    standard: "grok-4",
    light: "grok-4-fast",
  },
  // qwen/qwen3-coder:free and qwen3-coder:480b were retired upstream on
  // 2026-07-15 (see gateway.ts's model-gone handling) — these entries mirror
  // the gateway's refreshed defaults so a tier can never resolve to a corpse.
  openrouter: {
    heavy: "deepseek/deepseek-r1:free",
    standard: "deepseek/deepseek-v4-flash:free",
    light: "deepseek/deepseek-v4-flash:free",
  },
  "ollama-turbo": {
    heavy: "qwen3-coder-next",
    standard: "qwen3-coder-next",
    light: "qwen3-coder-next",
  },
};

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
