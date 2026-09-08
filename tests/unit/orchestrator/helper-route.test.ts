/**
 * `[routing] helper` — where Rune's own calls go.
 *
 * The decisions pinned here are the ones a future edit would otherwise
 * quietly reverse:
 *   · the automatic pick is never allowed to answer SAFETY questions;
 *   · a route that is no cheaper than the session is not a helper;
 *   · health (retired model, capped provider) is consulted before choosing;
 *   · an explicitly named route that is not connected does NOT silently fall
 *     back to an automatic pick.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveHelperRoute,
  helperAppliesToSafety,
} from "../../../packages/orchestrator/src/helper-route";
import { PROVIDER_TIER_DEFAULTS } from "../../../packages/shared/src/tiers";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

const SESSION = { provider: "anthropic", model: "claude-sonnet-4-6" };
/** `ollama` declares no `[tiers]`, so the resolver falls to its preset default. */
const OLLAMA_LIGHT =
  PROVIDER_TIER_DEFAULTS.ollama?.light ??
  PROVIDER_PRESETS.find((p) => p.id === "ollama")!.defaultModel!;

describe("resolveHelperRoute — auto", () => {
  test("prefers a local runtime over a free pool over a funded key", () => {
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter", "ollama"],
    });
    expect(route).not.toBeNull();
    expect(route!.provider).toBe("ollama");
    // The model comes from the shared tables — the light tier where a preset
    // declares one, its preset default otherwise. One source of truth with
    // the summarizer and the memory dream, so a retirement upstream is fixed
    // in one place. (`ollama` declares no tiers; it takes the default.)
    expect(route!.model).toBe(OLLAMA_LIGHT);
    expect(route!.explicit).toBe(false);
  });

  test("falls to the free pool when no local runtime is connected", () => {
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter"],
    });
    expect(route!.provider).toBe("openrouter");
  });

  test("null when nothing cheaper than the session is connected", () => {
    // Only the session's own provider is connected. A "helper" that resolves
    // to the session's own capacity is the status quo with extra words, and
    // the readout has to be able to say so rather than print a route that
    // changes nothing.
    expect(resolveHelperRoute({ session: SESSION, registered: ["anthropic"] })).toBeNull();
    expect(
      resolveHelperRoute({
        session: { provider: "ollama", model: OLLAMA_LIGHT },
        registered: ["ollama"],
      }),
    ).toBeNull();
  });

  test("a funded session is not routed onto another funded provider", () => {
    // Cross-provider routing between two equally-funded routes saves nothing
    // and costs the prompt cache: the session pair is warm every turn.
    const route = resolveHelperRoute({
      session: { provider: "openai", model: "gpt-5.6" },
      registered: ["openai", "anthropic"],
    });
    expect(route).toBeNull();
  });

  test("skips a provider whose plan/quota cap has not lifted", () => {
    const now = 1_000_000;
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter", "ollama"],
      cappedUntil: (p) => (p === "ollama" ? now + 60_000 : 0),
      now,
    });
    expect(route!.provider).toBe("openrouter");
  });

  test("skips a model a previous session watched die", () => {
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter", "ollama"],
      isRetired: (p) => p === "ollama",
    });
    expect(route!.provider).toBe("openrouter");
  });

  test("skips a pair signed org policy rejects", () => {
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter", "ollama"],
      policyDenies: (p) => (p === "ollama" ? "policy: local runtimes are not allowed" : null),
    });
    expect(route!.provider).toBe("openrouter");
  });

  test("null when every candidate is unhealthy", () => {
    const route = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "openrouter", "ollama"],
      isRetired: () => true,
    });
    expect(route).toBeNull();
  });
});

describe("resolveHelperRoute — explicit and off", () => {
  test('"off" / "session" / "none" restore the historical behaviour', () => {
    for (const setting of ["off", "session", "none", "OFF"]) {
      expect(
        resolveHelperRoute({ setting, session: SESSION, registered: ["anthropic", "ollama"] }),
      ).toBeNull();
    }
  });

  test('"provider/model" is honoured when that provider is connected', () => {
    const route = resolveHelperRoute({
      setting: "openrouter/qwen/qwen3-coder:free",
      session: SESSION,
      registered: ["anthropic", "openrouter"],
    });
    expect(route).toEqual({
      provider: "openrouter",
      // Only the FIRST slash is the provider separator: model ids contain
      // slashes, and splitting blindly is how a valid id becomes unreachable.
      model: "qwen/qwen3-coder:free",
      explicit: true,
      reason: "named in [routing] helper",
    });
  });

  test("a bare model id runs on the session's own provider", () => {
    const route = resolveHelperRoute({
      setting: "claude-haiku-4-5",
      session: SESSION,
      registered: ["anthropic"],
    });
    expect(route).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      explicit: true,
      reason: "named in [routing] helper",
    });
  });

  test("an unknown prefix is treated as part of the model id, not a provider", () => {
    const route = resolveHelperRoute({
      setting: "qwen/qwen3-coder:free",
      session: SESSION,
      registered: ["anthropic"],
    });
    expect(route!.provider).toBe("anthropic");
    expect(route!.model).toBe("qwen/qwen3-coder:free");
  });

  test("a named route that is not connected returns null, not an automatic pick", () => {
    // Silently substituting a different model for the one the user named is
    // worse than doing nothing: the governance call then runs on the session
    // model, which is the honest "your helper is not available".
    const route = resolveHelperRoute({
      setting: "openrouter/whatever:free",
      session: SESSION,
      registered: ["anthropic", "ollama"],
    });
    expect(route).toBeNull();
  });
});

describe("helperAppliesToSafety", () => {
  test("only an explicitly named helper may answer safety questions", () => {
    const auto = resolveHelperRoute({
      session: SESSION,
      registered: ["anthropic", "ollama"],
    });
    expect(auto).not.toBeNull();
    // The automatic pick is the cheapest connected route. Handing the Auto
    // reviewer to it by default is exactly the trade reviewer-fallback.ts
    // refuses: a free model wrongly ALLOWING is worse than containment.
    expect(helperAppliesToSafety(auto)).toBe(false);

    const named = resolveHelperRoute({
      setting: "anthropic/claude-haiku-4-5",
      session: SESSION,
      registered: ["anthropic"],
    });
    expect(helperAppliesToSafety(named)).toBe(true);
    expect(helperAppliesToSafety(null)).toBe(false);
  });
});
