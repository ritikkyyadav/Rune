// ─── The helper route: where Rune's own calls go (P12.1) ───
//
// Rune makes completions the user never asked for: the compaction summarizer,
// the intent read that gives a task its kind, the repair pass that fixes a
// sub-agent's report shape. Every one of them ran on the SESSION model —
// whatever frontier model the user picked — because nothing had ever said
// otherwise.
//
// On a metered account that is a rounding error. On a free tier it is the
// whole problem: a free route is priced in requests per minute, not dollars,
// so a governance call and a work call cost exactly the same thing, and 45% of
// this agent's recorded incidents are the resulting rate limits. Sending the
// governance traffic somewhere else is the cheapest fix available.
//
// `[routing] helper` names that somewhere. It is a MODEL SELECTION, not a
// capability: nothing about what the helper is asked changes, only which
// endpoint answers.
//
// ── What this does NOT touch ──
//
// The Auto-mode safety reviewer. reviewer-fallback.ts states the reason in
// full and it has not changed: "a free or local model wrongly ALLOWING a
// dangerous action is strictly worse than the mechanical containment that
// already backstops a reviewer outage". Routing the safety layer onto the
// cheapest free model by DEFAULT would be exactly that trade, made silently,
// for everyone. So the default helper never reaches the classifier — a user
// who explicitly names a model in `[routing] helper` has made that choice
// themselves and it is honored (`appliesToSafety`), and the existing
// `[permissions.autoMode] classifierModel` still wins over both.
//
// The classifier's saving comes from somewhere better instead: not making the
// call at all when the reviewer has already answered the same question
// (auto-mode.ts, the confident-allow recall).

import { PROVIDER_CAPACITY, PROVIDER_TIER_DEFAULTS, PROVIDER_PRESETS } from "@rune/shared";
import type { ProviderCapacity } from "@rune/shared";

export interface HelperRoute {
  provider: string;
  model: string;
  /** Why this pair, in one clause — for `/config helper` and the docs. */
  reason: string;
  /**
   * True when the user named this route themselves. Only an explicitly named
   * helper is allowed to answer safety questions; see the header.
   */
  explicit: boolean;
}

export interface HelperRouteInputs {
  /**
   * The raw `[routing] helper` value. Unset, "off" or "session" = the session
   * model, as before; "auto" = pick the cheapest healthy free route; anything
   * else names one. Unset is OFF, not auto: an automatic pick crosses providers,
   * and a governance call that leaves the session's provider without being
   * asked is a network call nobody configured — the integration suite found
   * its mock summarizer answered by a live free model the first time auto was
   * the default. The saving is real and unmeasured live; it is opted into.
   */
  setting?: string;
  /** The session's own provider/model — the fallback that is proven alive every turn. */
  session: { provider: string; model: string };
  /** Providers with working credentials right now. */
  registered: readonly string[];
  /** Cross-session health: a pair known retired, a provider known capped. */
  isRetired?: (provider: string, model: string) => boolean;
  cappedUntil?: (provider: string) => number;
  /** Returns a denial string when signed org policy rejects the pair. */
  policyDenies?: (provider: string, model: string) => string | null | undefined;
  now?: number;
}

/** Every provider id the presets know, for "provider/model" parsing. */
function knownProviders(): Set<string> {
  const s = new Set(PROVIDER_PRESETS.map((p) => p.id));
  s.add("custom");
  return s;
}

/**
 * Cheapness order for a helper. NOT the fallback order — that one prefers
 * funded capacity precisely because it is trying to keep the WORK running.
 * A helper wants the opposite: the cheapest thing that answers, because a
 * summarizer running on an Opus seat is money set on fire and a summarizer
 * running on a free model is a summary.
 *
 * `local` first: a localhost runtime never 429s and never bills, and the
 * 8k-window objection that ranks it last for the main loop does not apply —
 * governance prompts are small by construction (a classifier verdict, a five
 * bullet summary, a two-word intent read).
 */
const HELPER_CAPACITY_ORDER: readonly ProviderCapacity[] = [
  "local",
  "free",
  "subscription",
  "funded",
];

function helperRank(provider: string): number {
  const capacity = PROVIDER_CAPACITY[provider] ?? "free";
  const idx = HELPER_CAPACITY_ORDER.indexOf(capacity);
  return idx < 0 ? HELPER_CAPACITY_ORDER.length : idx;
}

/**
 * The model a provider should serve helper traffic with: its LIGHT tier
 * default. One source of truth with the summarizer and the memory dream — when
 * a free model is retired upstream, fixing `[tiers]` in shared/tiers.ts fixes
 * all three. A private list here would rot independently, which is exactly how
 * compaction ended up pinned to models retired in July.
 */
function lightModelFor(provider: string): string | undefined {
  const light = PROVIDER_TIER_DEFAULTS[provider]?.light;
  if (light) return light;
  // Not every preset declares tiers — `ollama`, the local runtime, is the one
  // that matters here, and it is the ideal helper (never 429s, never bills).
  // Its preset default is the honest second answer; falling through to
  // "no candidate" would have made the whole local-first ordering unreachable.
  return PROVIDER_PRESETS.find((p) => p.id === provider)?.defaultModel;
}

/**
 * Resolve `[routing] helper` to a concrete provider/model, or null when the
 * governance call should simply run wherever it runs today.
 *
 * Null is a real answer and the caller must handle it: it means "nothing
 * cheaper than the session is available", and in that case the session model
 * is both correct and already what the code does.
 */
export function resolveHelperRoute(inputs: HelperRouteInputs): HelperRoute | null {
  const now = inputs.now ?? Date.now();
  const registered = new Set(inputs.registered);
  const denies = inputs.policyDenies ?? (() => null);
  const retired = inputs.isRetired ?? (() => false);
  const capped = inputs.cappedUntil ?? (() => 0);

  const usable = (provider: string, model: string): boolean =>
    registered.has(provider) &&
    !!model &&
    !retired(provider, model) &&
    capped(provider) <= now &&
    !denies(provider, model);

  const raw = (inputs.setting ?? "").trim();
  const lowered = raw.toLowerCase();

  // Unset, "off", "session": the historical behaviour. Unset is off (see
  // `HelperRouteInputs.setting`); "auto" has to be asked for.
  if (!raw || lowered === "off" || lowered === "session" || lowered === "none") return null;

  // An explicitly named route. "provider/model" when the prefix is a known
  // provider id; a bare model id otherwise — model ids legitimately contain
  // slashes ("qwen/qwen3-coder:free"), which is why the prefix must be checked
  // against the preset list rather than split blindly.
  if (raw && lowered !== "auto") {
    const slash = raw.indexOf("/");
    const known = knownProviders();
    const prefix = slash > 0 ? raw.slice(0, slash) : "";
    const pair =
      prefix && known.has(prefix)
        ? { provider: prefix, model: raw.slice(slash + 1) }
        : { provider: inputs.session.provider, model: raw };
    if (!registered.has(pair.provider)) {
      // Named but not connected. Falling through to auto would silently ignore
      // a user's explicit choice; returning null runs governance on the session
      // model, which is the honest "your helper is not available" behaviour.
      return null;
    }
    return {
      ...pair,
      explicit: true,
      reason: `named in [routing] helper`,
    };
  }

  // ── auto: the cheapest healthy route ──
  const candidates: Array<{ provider: string; model: string; rank: number }> = [];
  for (const provider of registered) {
    const model = lightModelFor(provider);
    if (!model || !usable(provider, model)) continue;
    candidates.push({ provider, model, rank: helperRank(provider) });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.provider.localeCompare(b.provider));

  const pick = candidates[0];
  if (!pick) return null;

  // A helper that resolves to the session's own pair is not a helper — it is
  // the status quo with extra words. Say null so the readout can be truthful.
  if (pick.provider === inputs.session.provider && pick.model === inputs.session.model) return null;

  // Nor is one that is no cheaper than the session. Routing a Sonnet session's
  // summaries onto another funded frontier model saves nothing and costs the
  // cache: the session pair is warm every turn, a second provider is cold.
  // STRICTLY cheaper, hence >= — equal capacity is not a saving, it is a
  // second cold prefix.
  if (helperRank(pick.provider) >= helperRank(inputs.session.provider)) return null;

  const capacity = PROVIDER_CAPACITY[pick.provider] ?? "free";
  return {
    provider: pick.provider,
    model: pick.model,
    explicit: false,
    reason: `cheapest healthy route (${capacity} capacity, light tier)`,
  };
}

/**
 * Whether a resolved helper may answer SAFETY questions (the Auto classifier
 * and its supervisor). Only an explicit one may — see the header.
 */
export function helperAppliesToSafety(route: HelperRoute | null): boolean {
  return route?.explicit === true;
}
