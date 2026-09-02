/**
 * P8.6 — the three model tables have to agree.
 *
 * A provider's model ids lived in three hand-maintained tables with no
 * cross-check: `PROVIDER_PRESETS` (what the picker offers),
 * `PROVIDER_TIER_DEFAULTS` (what heavy/standard/light resolve to), and the
 * gateway's `PROVIDER_DEFAULT_MODELS` (what a fallback lands on). Nothing tied
 * them together, so they drifted:
 *
 *   - `ollama` fell back to "llama3" while its preset said "llama3.1";
 *   - Groq's light tier resolved to an id the picker never listed;
 *   - `ollama-turbo`'s tier table pointed at a lineup that had 410'd, twice,
 *     while the preset had already been refreshed — which killed compaction
 *     for those sessions.
 *
 * The rule: every model id any table names for a provider must be a model that
 * provider's preset actually offers. A preset with an empty catalogue is a
 * provider the picker cannot serve, and is itself a failure.
 */

import { describe, test, expect } from "bun:test";
import {
  PROVIDER_PRESETS,
  PROVIDER_CAPACITY,
  getPreset,
} from "../../../packages/shared/src/providers";
import { PROVIDER_TIER_DEFAULTS } from "../../../packages/shared/src/tiers";
import { defaultModelForProvider } from "../../../packages/llm-gateway/src/gateway";
import { billingModeFor } from "../../../packages/llm-gateway/src/types";

/** The ids a preset offers in the picker. */
function catalogue(id: string): string[] {
  return (getPreset(id)?.models ?? []).map((m) => m.id);
}

describe("every preset has a usable catalogue", () => {
  test.each(PROVIDER_PRESETS.map((p) => p.id))("%s offers at least one model", (id) => {
    // `lmstudio` shipped `models: []` with a placeholder `local-model` default:
    // a provider in the picker with nothing to pick. It was removed in P8.6.
    expect(catalogue(id).length, `${id} has an empty catalogue`).toBeGreaterThan(0);
  });

  test.each(PROVIDER_PRESETS.map((p) => p.id))("%s's default model is in its catalogue", (id) => {
    expect(catalogue(id)).toContain(getPreset(id)!.defaultModel);
  });
});

describe("the tier table agrees with the presets", () => {
  test.each(Object.keys(PROVIDER_TIER_DEFAULTS))("%s's tier ids are all offered", (id) => {
    const preset = getPreset(id);
    expect(preset, `${id} has tier defaults but no preset`).toBeDefined();
    const offered = catalogue(id);
    const tiers = PROVIDER_TIER_DEFAULTS[id]!;
    for (const tier of ["heavy", "standard", "light"] as const) {
      expect(offered, `${id}.${tier} = ${tiers[tier]} is not in the picker`).toContain(tiers[tier]);
    }
  });
});

describe("the gateway fallback table agrees with the presets", () => {
  test.each(PROVIDER_PRESETS.map((p) => p.id))("%s's fallback model is offered", (id) => {
    const fallback = defaultModelForProvider(id);
    // Not every provider needs a fallback entry; the ones that have one must
    // name a model the provider actually serves.
    if (fallback === undefined) return;
    expect(catalogue(id), `${id} falls back to ${fallback}, which it does not offer`).toContain(
      fallback,
    );
  });
});

describe("a folded preset owns its ids", () => {
  test("ollama-turbo's tier and fallback ids come from its preset", () => {
    const preset = getPreset("ollama-turbo")!;
    expect(preset.tiers).toBeDefined();
    expect(preset.fallbackModel).toBeDefined();
    expect(PROVIDER_TIER_DEFAULTS["ollama-turbo"]).toEqual(preset.tiers!);
    expect(defaultModelForProvider("ollama-turbo")).toBe(preset.fallbackModel);
  });
});

describe("capacity and billing tell the same story", () => {
  // These are different questions (fallback headroom vs who pays), but they
  // cannot contradict each other about the same account. `ollama-turbo` was
  // "free" capacity and "subscription" billing at the same time.
  test("ollama-turbo is free on both axes", () => {
    expect(PROVIDER_CAPACITY["ollama-turbo"]).toBe("free");
    expect(billingModeFor("ollama-turbo", "gpt-oss:120b")).toBe("free");
  });

  test("a local runtime is local capacity and free billing", () => {
    expect(PROVIDER_CAPACITY.ollama).toBe("local");
    expect(billingModeFor("ollama", "llama3.1")).toBe("free");
  });

  test("codex stays the subscription transport", () => {
    expect(PROVIDER_CAPACITY.codex).toBe("subscription");
    expect(billingModeFor("codex", "gpt-5.6-sol")).toBe("subscription");
  });

  test("every preset has a capacity entry", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(PROVIDER_CAPACITY[preset.id], `${preset.id} has no capacity`).toBeDefined();
    }
  });

  test("no capacity entry names a provider that no longer exists", () => {
    const known = new Set([...PROVIDER_PRESETS.map((p) => p.id), "custom"]);
    for (const id of Object.keys(PROVIDER_CAPACITY)) {
      expect(known, `${id} is ranked but not a provider`).toContain(id);
    }
  });
});

describe("the dropped providers are gone from every table", () => {
  test.each(["lmstudio"])("%s has no preset", (id) => {
    expect(getPreset(id)).toBeUndefined();
  });

  test.each(["lmstudio"])("%s has no capacity rank", (id) => {
    expect(PROVIDER_CAPACITY[id]).toBeUndefined();
  });

  test.each(["lmstudio"])("%s has no tier defaults", (id) => {
    expect(PROVIDER_TIER_DEFAULTS[id]).toBeUndefined();
  });

  test.each(["lmstudio"])("%s has no fallback model", (id) => {
    expect(defaultModelForProvider(id)).toBeUndefined();
  });
});
