/**
 * The startup provider/model ladder: CLI flags → sticky → config → auto-detect.
 *
 * This is the rule the six-step setup wizard's "restart required" promise rests
 * on, and it was false: the config rung was gated on a hand-written list of six
 * provider ids, so `[llm] defaultProvider = "custom"` — everything the wizard
 * writes — fell through to auto-detect and a new process opened on whatever key
 * happened to be on the machine. The regression cases at the bottom are the two
 * halves of that defect, reproduced from the Phase 4 walkthrough's frames.
 */

import { describe, test, expect } from "bun:test";
import { getPreset, PROVIDER_PRESETS } from "../../../packages/shared/src/providers";
import {
  modelForProvider,
  nearestProviderIds,
  resolveStartupSelection,
  type StartupSelectionInput,
} from "../../../packages/orchestrator/src/startup-selection";

/** The machine with nothing on it: no keys anywhere, no endpoint, no preset lies. */
function base(over: Partial<StartupSelectionInput> = {}): StartupSelectionInput {
  return {
    config: { llm: {} },
    secrets: { keys: {} },
    lastUsed: null,
    env: {},
    hasStoredCredential: () => false,
    getPreset,
    ...over,
  };
}

/** The profile the setup wizard leaves behind: custom endpoint + custom model. */
const WIZARD: Partial<StartupSelectionInput> = {
  config: { llm: { defaultProvider: "custom", custom: { model: "mock-small" } } },
  secrets: {
    keys: {},
    custom: { baseUrl: "http://127.0.0.1:64614/v1", model: "mock-small", key: "local" },
  },
};

describe("resolveStartupSelection", () => {
  test("a saved custom provider with a usable endpoint is honoured", () => {
    expect(resolveStartupSelection(base(WIZARD))).toEqual({
      provider: "custom",
      model: "mock-small",
      source: "config",
    });
  });

  test("a keyless custom endpoint is NOT usable, whatever the credential store says", () => {
    // This case used to claim the opposite, and it was vacuous in three ways
    // (V6 finding 15): `loadSecrets` drops a keyless `custom` outright, so this
    // state cannot come out of a real profile; nothing writes a
    // `provider:custom` credential; and where the state was forced by hand the
    // boot got WORSE, because `buildGateway` needs `key && baseUrl` from the
    // sidecar and refused to register the provider the selection had named —
    // so the CLI substituted `registeredProviders[0]` and landed on gemini.
    // What the selection promises must be what the gateway can serve.
    const selection = resolveStartupSelection(
      base({
        ...WIZARD,
        secrets: {
          keys: {},
          custom: { baseUrl: "http://127.0.0.1:64614/v1", model: "mock-small" },
        },
        hasStoredCredential: (id) => id === "custom",
      }),
    );
    expect(selection.provider).not.toBe("custom");
    expect(selection.source).toBe("auto");
  });

  test("a sidecar key IS what makes the custom endpoint usable", () => {
    // The other half of the same branch: with the key present it is honoured,
    // so the case above pins a credential rule and not merely a refusal.
    expect(resolveStartupSelection(base(WIZARD)).provider).toBe("custom");
  });

  test("a saved preset with a stored credential is honoured, not just the six built-ins", () => {
    const selection = resolveStartupSelection(
      base({
        config: { llm: { defaultProvider: "mistral" } },
        hasStoredCredential: (id) => id === "mistral",
      }),
    );
    expect(selection).toEqual({
      provider: "mistral",
      model: "mistral-medium-latest",
      source: "config",
    });
  });

  test("a saved preset whose key is only an env var is honoured", () => {
    const selection = resolveStartupSelection(
      base({
        config: { llm: { defaultProvider: "mistral" } },
        env: { MISTRAL_API_KEY: "sk-test" },
      }),
    );
    expect(selection.provider).toBe("mistral");
  });

  test("a saved provider with no credential anywhere falls through to auto-detect", () => {
    const selection = resolveStartupSelection(
      base({
        config: { llm: { defaultProvider: "mistral" } },
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      }),
    );
    expect(selection).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      source: "auto",
    });
  });

  test("a saved custom provider with no endpoint at all falls through to auto-detect", () => {
    const selection = resolveStartupSelection(
      base({ config: { llm: { defaultProvider: "custom", custom: { model: "mock-small" } } } }),
    );
    expect(selection.source).toBe("auto");
    expect(selection.provider).toBe("openrouter"); // the last resort
  });

  test("the sticky pick beats config", () => {
    const selection = resolveStartupSelection(
      base({
        ...WIZARD,
        lastUsed: { provider: "mistral", model: "codestral-latest" },
        hasStoredCredential: (id) => id === "mistral",
      }),
    );
    expect(selection).toEqual({
      provider: "mistral",
      model: "codestral-latest",
      source: "sticky",
    });
  });

  test("an unusable sticky pick loses to a usable config provider", () => {
    const selection = resolveStartupSelection(
      base({ ...WIZARD, lastUsed: { provider: "mistral", model: "codestral-latest" } }),
    );
    expect(selection).toEqual({ provider: "custom", model: "mock-small", source: "config" });
  });

  test("--provider beats the sticky pick", () => {
    const selection = resolveStartupSelection(
      base({
        ...WIZARD,
        cliProvider: "mistral",
        lastUsed: { provider: "google", model: "gemini-2.5-flash" },
        hasStoredCredential: () => true,
      }),
    );
    expect(selection).toEqual({
      provider: "mistral",
      model: "mistral-medium-latest",
      source: "flag",
    });
  });

  test("--model alone keeps the ladder but pins the model", () => {
    const selection = resolveStartupSelection(base({ ...WIZARD, cliModel: "mock-large" }));
    expect(selection).toEqual({ provider: "custom", model: "mock-large", source: "config" });
  });

  test("a local runtime needs no key at all", () => {
    const selection = resolveStartupSelection(
      base({ config: { llm: { defaultProvider: "ollama", ollama: { model: "gpt-oss:20b" } } } }),
    );
    expect(selection).toEqual({ provider: "ollama", model: "gpt-oss:20b", source: "config" });
  });

  test("auto-detect still prefers funded capacity over the last resort", () => {
    expect(resolveStartupSelection(base({ env: { OLLAMA_API_KEY: "k" } })).provider).toBe(
      "ollama-turbo",
    );
    expect(resolveStartupSelection(base()).provider).toBe("openrouter");
  });

  // ─── A preset removed because its vendor retired the product ───

  test("a saved provider this build no longer knows degrades to auto-detect, with a notice", () => {
    // `github-models` was removed on 2026-09-16: GitHub retired GitHub Models
    // on 2026-07-30 — playground, catalog and inference API at once. A config
    // that still names it must not crash and must not boot onto a dead host;
    // it must fall to auto-detect and SAY SO. Silent degradation is how a user
    // ends up on an unexpected provider with no explanation.
    const selection = resolveStartupSelection(
      base({
        config: { llm: { defaultProvider: "github-models" } },
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        // Even with a credential filed under the retired id, it cannot be used.
        hasStoredCredential: (id) => id === "github-models",
      }),
    );
    expect(selection).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      source: "auto",
      unknownSaved: "github-models",
    });
  });

  test("a sticky pick naming a removed preset degrades the same way", () => {
    const selection = resolveStartupSelection(
      base({
        lastUsed: { provider: "github-models", model: "openai/gpt-4.1" },
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        hasStoredCredential: () => true,
      }),
    );
    expect(selection.source).toBe("auto");
    expect(selection.provider).toBe("anthropic");
    expect(selection.unknownSaved).toBe("github-models");
  });

  test("a normal auto-detect carries no notice", () => {
    // The field must be ABSENT, not empty: a notice printed on every boot is
    // noise, and noise is how a real one gets missed.
    const selection = resolveStartupSelection(base({ env: { ANTHROPIC_API_KEY: "sk" } }));
    expect(selection.unknownSaved).toBeUndefined();
    expect(selection).toEqual({ provider: "anthropic", model: "claude-opus-5", source: "auto" });
  });

  test("the custom endpoint is never reported as an unknown preset", () => {
    // `custom` has no preset BY DESIGN — it is the escape hatch. Reporting it
    // as retired would be a lie printed at every keyless boot.
    const selection = resolveStartupSelection(
      base({ config: { llm: { defaultProvider: "custom", custom: { model: "mock-small" } } } }),
    );
    expect(selection.source).toBe("auto");
    expect(selection.unknownSaved).toBeUndefined();
  });

  // ─── Regressions: the walkthrough's "google from nowhere" ───

  test("regression: a saved custom provider is not replaced by a stray GOOGLE_API_KEY", () => {
    // The frame this reproduces: `.codex/audit-20260910/handoff/m0/walkthrough-frames/
    // 120x40-restart-keyed-setup.txt`, whose SAVED vs ACTIVE rows read
    // `provider custom / google`, `model mock-small / gemini-2.5…`.
    const selection = resolveStartupSelection(
      base({
        ...WIZARD,
        env: { GOOGLE_API_KEY: "AIza-test" },
        hasStoredCredential: (id) => id === "google" || id === "openrouter",
      }),
    );
    expect(selection.provider).toBe("custom");
    expect(selection.model).toBe("mock-small");
  });

  test("regression: a provider outside the six built-ins never defaults to gemini", () => {
    // `DEFAULT_MODELS[fallback] ?? DEFAULT_MODELS.google` was the second half of
    // the same defect: any provider the CLI did not know by hand was moved to
    // gemini-2.5-flash, a model it does not serve.
    const ctx = { config: WIZARD.config!, secrets: WIZARD.secrets!, getPreset };
    expect(modelForProvider("custom", ctx)).toBe("mock-small");
    expect(modelForProvider("mistral", ctx)).toBe("mistral-medium-latest");
    expect(modelForProvider("google", ctx)).toBe("gemini-3.8-flash");
  });

  test("regression: the custom endpoint's own model is the last-resort default", () => {
    expect(
      modelForProvider("custom", {
        config: { llm: { defaultProvider: "custom" } },
        secrets: { custom: { baseUrl: "http://127.0.0.1:1/v1", model: "mock-small" } },
        getPreset,
      }),
    ).toBe("mock-small");
  });
});

/**
 * The branches no case reached.
 *
 * V6's attack 9 broke one branch of the module at a time and re-ran the fifteen
 * cases above: seven mutations left 15/15 green. The behaviour was right; it
 * was simply not pinned, which means the next edit is free to break it. One
 * case per surviving mutation, named after the mutation it kills.
 */
describe("the rungs the mutation matrix found untested", () => {
  test("sticky: a built-in provider keyed only by an ENV VAR is still sticky", () => {
    // Kills: stickyUsable -> (LOCAL_PROVIDERS.has(p) || hasStoredCredential(p))
    expect(
      resolveStartupSelection(
        base({
          lastUsed: { provider: "anthropic", model: "claude-sonnet-4-6" },
          env: { ANTHROPIC_API_KEY: "sk-env" },
        }),
      ),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", source: "sticky" });
  });

  test("sticky: a local runtime needs no credential of any kind", () => {
    // Kills: stickyUsable -> (hasStoredCredential(p) || (isCliProvider(p) && hasCreds(p)))
    expect(
      resolveStartupSelection(base({ lastUsed: { provider: "ollama", model: "llama3.1" } })),
    ).toEqual({ provider: "ollama", model: "llama3.1", source: "sticky" });
    // `ollama` is also one of the six the CLI knows by hand, so the case above
    // alone does not prove the LOCAL half is doing anything — hasCreds answers
    // it too. A local preset OUTSIDE the six is the branch's only real reader,
    // and "local" is a registry fact, not a roster of one id.
    expect(
      resolveStartupSelection(
        base({
          lastUsed: { provider: "a-local-runtime", model: "qwen3" },
          getPreset: (id) =>
            id === "a-local-runtime" ? { local: true, defaultModel: "qwen3" } : getPreset(id),
        }),
      ),
    ).toEqual({ provider: "a-local-runtime", model: "qwen3", source: "sticky" });
  });

  test("flag: surrounding whitespace is trimmed before the registry lookup", () => {
    // Kills: input.cliProvider?.trim() -> input.cliProvider (with the trim
    // inside resolveProviderId removed too — there is one trim per place a
    // value can arrive, and this pins the behaviour rather than either line).
    expect(resolveStartupSelection(base({ cliProvider: "  anthropic  " }))).toMatchObject({
      provider: "anthropic",
      source: "flag",
    });
  });

  test("flag: an id in the wrong case is the id, not a miss", () => {
    expect(resolveStartupSelection(base({ cliProvider: "Anthropic" }))).toMatchObject({
      provider: "anthropic",
      source: "flag",
    });
  });

  test("flag: an id the registry does not know does not answer the flag rung", () => {
    // The CLI turns this into a refusal; the module's job is to report that the
    // flag did NOT decide, so a typo can never be silently dropped downstream.
    const selection = resolveStartupSelection(
      base({ cliProvider: "nope-xyz", config: { llm: { defaultProvider: "google" } } }),
    );
    expect(selection.source).not.toBe("flag");
    expect(selection.provider).not.toBe("nope-xyz");
  });

  test("sticky: an explicit --model alone still kills the sticky pick", () => {
    // Kills: lastUsed = cliProvider ? null : (input.lastUsed ?? null)
    const selection = resolveStartupSelection(
      base({
        cliModel: "gpt-4o",
        lastUsed: { provider: "anthropic", model: "claude-sonnet-4-6" },
        hasStoredCredential: (id) => id === "anthropic",
      }),
    );
    expect(selection.source).not.toBe("sticky");
    expect(selection.model).toBe("gpt-4o");
  });

  test("auto: a /keys secret for ollama-turbo is a credential, not only the env var", () => {
    // Kills: if (env.OLLAMA_API_KEY) return "ollama-turbo"
    expect(
      resolveStartupSelection(base({ secrets: { keys: { "ollama-turbo": "sk-keys" } } })),
    ).toEqual({ provider: "ollama-turbo", model: "gpt-oss:120b", source: "auto" });
  });

  test("config: `[llm.<id>] apiKey` is one of the four credential sources", () => {
    // Kills: hasCreds -> drop `sectionFor(config, p)?.apiKey`. Auto-detect
    // reads the same key, so `source` is what tells the two rungs apart.
    expect(
      resolveStartupSelection(
        base({
          config: { llm: { defaultProvider: "anthropic", anthropic: { apiKey: "sk-config" } } },
        }),
      ),
    ).toEqual({ provider: "anthropic", model: "claude-opus-5", source: "config" });
  });

  test("config: a /keys secret is one of the four credential sources", () => {
    // Kills: hasCreds -> drop `secrets.keys?.[p]`
    expect(
      resolveStartupSelection(
        base({
          config: { llm: { defaultProvider: "mistral" } },
          secrets: { keys: { mistral: "sk-keys" } },
        }),
      ),
    ).toMatchObject({ provider: "mistral", source: "config" });
  });
});

/**
 * A provider switched OFF in `/keys` holds its key and is still unusable.
 *
 * Holding a credential and being usable are different questions, and this
 * module asked only the first: a disabled provider was selected, `buildGateway`
 * then refused to register it, and the boot printed "<id> has no API key" — a
 * false statement about the user's own key — before substituting
 * `registeredProviders[0]` (V6 finding 14).
 */
describe("secrets.disabled", () => {
  test("a disabled saved provider loses the config rung", () => {
    const selection = resolveStartupSelection(
      base({
        config: { llm: { defaultProvider: "mistral" } },
        secrets: { keys: { mistral: "sk-mistral", google: "AIza" }, disabled: ["mistral"] },
      }),
    );
    expect(selection.provider).not.toBe("mistral");
    expect(selection.source).toBe("auto");
  });

  test("a disabled sticky provider loses the sticky rung", () => {
    const selection = resolveStartupSelection(
      base({
        lastUsed: { provider: "anthropic", model: "claude-sonnet-4-6" },
        env: { ANTHROPIC_API_KEY: "sk-env" },
        secrets: { keys: {}, disabled: ["anthropic"] },
      }),
    );
    expect(selection.source).not.toBe("sticky");
  });

  test("a disabled custom endpoint loses too, key and base URL notwithstanding", () => {
    const selection = resolveStartupSelection(
      base({
        ...WIZARD,
        secrets: {
          keys: {},
          custom: { baseUrl: "http://127.0.0.1:64614/v1", model: "mock-small", key: "local" },
          disabled: ["custom"],
        },
      }),
    );
    expect(selection.provider).not.toBe("custom");
  });

  test("an empty or absent disabled list changes nothing", () => {
    expect(
      resolveStartupSelection(
        base({
          config: { llm: { defaultProvider: "mistral" } },
          secrets: { keys: { mistral: "sk-mistral" }, disabled: [] },
        }),
      ),
    ).toMatchObject({ provider: "mistral", source: "config" });
  });
});

describe("nearestProviderIds — a refusal that is usable", () => {
  const ids = PROVIDER_PRESETS.map((preset) => preset.id);

  test("a typo comes back with the id it was a typo of", () => {
    expect(nearestProviderIds("anthrpic", ids)).toContain("anthropic");
    expect(nearestProviderIds("opnai", ids)).toContain("openai");
    expect(nearestProviderIds("open", ids)[0]).toMatch(/^open/);
  });

  test("nonsense comes back empty rather than with an arbitrary neighbour", () => {
    expect(nearestProviderIds("qqqqqqqqqqqqqqqq", ids)).toEqual([]);
  });

  test("the list is bounded, so the refusal stays readable", () => {
    expect(nearestProviderIds("o", ids).length).toBeLessThanOrEqual(5);
  });
});
