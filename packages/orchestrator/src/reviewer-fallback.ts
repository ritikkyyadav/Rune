// ─── Picking a fallback reviewer that is not dying of the same thing ───
//
// The Auto reviewer's retry used to consider only the engine's own model
// tiers. On a subscription session those tiers all resolve to the SESSION'S
// provider, so the moment a quota cap killed the model it killed its reviewer
// too — observed live: `Independent reviewer unavailable: Codex request
// failed (429)` while the codex session it was reviewing sat on the same cap.
// A safety layer whose availability is perfectly correlated with the thing it
// supervises is not an independent layer.
//
// So the retry may now widen to OTHER providers the user has already
// connected — but deliberately not to all of them:
//
//   - An org that pinned a classifier in signed policy stays pinned; the
//     widening never runs.
//   - Only funded and subscription capacity qualifies. A free or local model
//     wrongly ALLOWING a dangerous action is strictly worse than the
//     mechanical containment that already backstops a reviewer outage —
//     containment is available by construction and errs toward safety.
//   - Health is consulted first: a provider currently cooling or pruned is
//     what the retry is escaping, not where it should land.
//
// Pure and injected so the policy is pinned by tests, not folklore.

/** A provider/model pair the retry could run against. */
export interface ReviewerCandidate {
  provider: string;
  model: string;
}

export interface ReviewerFallbackInputs {
  /** The primary reviewer, when it resolved — the thing to be distinct from. */
  primary: ReviewerCandidate | null;
  /** The engine's own tier refs (heavy first), the historical candidates. */
  tierRefs: ReviewerCandidate[];
  /** Providers actually registered in the gateway right now. */
  registered: string[];
  /** Live gateway health: pruned models, cooling providers. */
  health: { pruned: string[]; cooling: Array<{ provider: string; untilMs: number }> };
  /** True when signed policy pinned a classifier provider: never widen. */
  pinnedByPolicy: boolean;
  /** Preset default model for a provider, when one exists. */
  defaultModelFor: (provider: string) => string | undefined;
  /** Capacity class for a provider ("funded" | "subscription" | "free" | "local" | undefined). */
  capacityOf: (provider: string) => string | undefined;
  /** Returns a denial when org policy rejects the pair; falsy = allowed. */
  policyDenies: (provider: string, model: string) => string | null | undefined;
  now?: number;
}

/**
 * The retry identity for a failed reviewer call, or null when none exists.
 *
 * Order: a healthy distinct tier ref (the same data boundary the session
 * already uses), then — unless policy pinned the reviewer — a healthy funded
 * or subscription provider the user has connected, then an unhealthy distinct
 * tier ref as the historical last resort (a cooling provider may still answer
 * one small classifier call). Null falls back to mechanical containment,
 * which is the correct floor.
 */
export function pickFallbackReviewer(inputs: ReviewerFallbackInputs): ReviewerCandidate | null {
  const now = inputs.now ?? Date.now();
  const cooling = new Set(
    inputs.health.cooling.filter((c) => c.untilMs > now).map((c) => c.provider),
  );
  const pruned = new Set(inputs.health.pruned);
  const registered = new Set(inputs.registered);

  const usable = (c: ReviewerCandidate): boolean =>
    registered.has(c.provider) && !inputs.policyDenies(c.provider, c.model);
  const healthy = (provider: string): boolean => !cooling.has(provider) && !pruned.has(provider);
  const distinct = (c: ReviewerCandidate): boolean =>
    !inputs.primary || c.provider !== inputs.primary.provider || c.model !== inputs.primary.model;

  const tierCandidates = inputs.tierRefs.filter((c) => distinct(c) && usable(c));
  const healthyTier = tierCandidates.find((c) => healthy(c.provider));
  if (healthyTier) return healthyTier;

  if (!inputs.pinnedByPolicy) {
    for (const provider of inputs.registered) {
      if (inputs.primary && provider === inputs.primary.provider) continue;
      if (!healthy(provider)) continue;
      const capacity = inputs.capacityOf(provider);
      if (capacity !== "funded" && capacity !== "subscription") continue;
      const model = inputs.defaultModelFor(provider);
      if (!model) continue;
      const candidate = { provider, model };
      if (!usable(candidate)) continue;
      return candidate;
    }
  }

  return tierCandidates[0] ?? null;
}
