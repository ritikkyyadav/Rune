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
import { declaredCachePolicies } from "../../../packages/llm-gateway/src/providers/cache-policy";

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
  // `lmstudio` (P8.6) and `copilot` (P8.5) were removed under program decision
  // D5. Copilot's evidence: zero sessions had ever run on it in ~/.gear/gear.db
  // across 601 recorded sessions, against an undocumented internal endpoint,
  // VS Code header impersonation, a stale catalog, and streams that reported no
  // usage at all.
  test.each(["lmstudio", "copilot"])("%s has no preset", (id) => {
    expect(getPreset(id)).toBeUndefined();
  });

  test.each(["lmstudio", "copilot"])("%s has no capacity rank", (id) => {
    expect(PROVIDER_CAPACITY[id]).toBeUndefined();
  });

  test.each(["lmstudio", "copilot"])("%s has no tier defaults", (id) => {
    expect(PROVIDER_TIER_DEFAULTS[id]).toBeUndefined();
  });

  test.each(["lmstudio", "copilot"])("%s has no fallback model", (id) => {
    expect(defaultModelForProvider(id)).toBeUndefined();
  });
});

describe("P10.5 — the tables are ONE generated source", () => {
  // P8.6 folded `ollama-turbo` and left nine providers with a second copy of
  // their ids in `PROVIDER_TIER_DEFAULTS` and the gateway's fallback table.
  // P10.5 finished the fold: both tables are now projections of the presets, so
  // these assertions are structural — a hand-maintained entry cannot come back
  // without failing here.
  test("every tier entry is projected from a preset that declares `tiers`", () => {
    const declared = PROVIDER_PRESETS.filter((p) => p.tiers).map((p) => p.id);
    expect(Object.keys(PROVIDER_TIER_DEFAULTS).sort()).toEqual(declared.sort());
    for (const id of declared) {
      expect(PROVIDER_TIER_DEFAULTS[id]).toEqual(getPreset(id)!.tiers!);
    }
  });

  test("every fallback model is projected from a preset that declares one", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(defaultModelForProvider(preset.id)).toBe(preset.fallbackModel);
    }
  });

  test("a provider with no tier entry has no preset tiers either", () => {
    // The two ways of saying "fall through to the session model" must agree.
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.tiers) expect(PROVIDER_TIER_DEFAULTS[preset.id]).toBeUndefined();
    }
  });
});

describe("P10.5 — the enterprise routes", () => {
  /** Presets whose kind is a cloud route rather than a vendor's own API. */
  const ENTERPRISE_KINDS = new Set(["bedrock", "vertex", "azure-openai"]);
  const routes = PROVIDER_PRESETS.filter((p) => ENTERPRISE_KINDS.has(p.kind));

  test("the enterprise routes are registered", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  test.each(routes.map((p) => p.id))("%s declares its own tiers and fallback", (id) => {
    // A cloud route's model ids are the cloud's, not the vendor's, so it cannot
    // inherit anything — it must own every id it names.
    const preset = getPreset(id)!;
    expect(preset.tiers, `${id} has no tiers`).toBeDefined();
    expect(preset.fallbackModel, `${id} has no fallback model`).toBeDefined();
  });

  test.each(routes.map((p) => p.id))("%s is funded capacity and metered billing", (id) => {
    // The two questions must not contradict each other about the same account:
    // a cloud account with committed spend has headroom AND a real bill.
    expect(PROVIDER_CAPACITY[id]).toBe("funded");
    expect(billingModeFor(id, getPreset(id)!.defaultModel)).toBe("metered");
  });

  test.each(routes.map((p) => p.id))("%s has a declared cache policy", (id) => {
    // Absence falls to "none" silently, which would claim no cache for a route
    // whose upstream definitely has one. The declaration has to be explicit.
    expect(Object.keys(declaredCachePolicies())).toContain(id);
  });

  test.each(routes.map((p) => p.id))("%s authenticates without a stored secret", (id) => {
    // The point of these routes: the machine's cloud login is the credential.
    // A route that offered only `api_key` would be asking someone to paste a
    // long-lived cloud credential into a coding tool.
    expect(getPreset(id)!.auth).toContain("chain");
  });
});
