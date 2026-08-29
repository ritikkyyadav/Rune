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
    heavy: "claude-opus-5",
    standard: "claude-sonnet-5",
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
  // The ChatGPT/Codex backend. Absent from this table until 2026-08-28, which
  // meant resolveTier fell all the way through to step 3 and returned the
  // SESSION model for every tier: every "cheap scout" (task defaults to light)
  // was a 32-turn gpt-5.6-sol run against the plan quota. A recorded audit
  // session hit "429 The usage limit has been reached" nine minutes in, then
  // silently finished its deepest sub-agent on a free fallback model. The
  // gpt-5.6 line encodes reasoning effort in the model NAME (sol > terra >
  // luna) rather than a reasoning.effort param, so the tier split is just the
  // right variant per weight.
  codex: {
    heavy: "gpt-5.6-sol",
    standard: "gpt-5.6-terra",
    light: "gpt-5.6-luna",
  },
  // OpenRouter's :free tier churns constantly: qwen/qwen3-coder:free retired
  // 2026-07-15, then deepseek-v4-flash:free and deepseek-r1:free were
  // withdrawn from the free tier ("paid version available now" 404s,
  // observed 2026-08-26). Current ids verified live with a completion on
  // 2026-08-26. NOTE: the compaction summarizer no longer trusts this table
  // first — it runs on the active session model (engine.syncSummarizerTier)
  // and only falls back through here.
  openrouter: {
    heavy: "nvidia/nemotron-3-ultra-550b-a55b:free",
    standard: "minimax/minimax-m3:free",
    light: "minimax/minimax-m3:free",
  },
  // Ollama Cloud rotates its free lineup wholesale: qwen3-coder:480b AND its
  // announced successor qwen3-coder-next both 410'd on 2026-07-15, which left
  // this table pointing at a corpse for the second time and killed compaction
  // for ollama-turbo sessions. Current ids verified live (200 + tool calls)
  // against https://ollama.com/v1/models on 2026-08-26. When these rot again,
  // the summarizer's live-list recovery (context-engine.ts) keeps compaction
  // alive; refresh this table to stop the main loop from booting on a corpse.
  "ollama-turbo": {
    heavy: "gpt-oss:120b",
    standard: "gpt-oss:120b",
    light: "gpt-oss:20b",
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
