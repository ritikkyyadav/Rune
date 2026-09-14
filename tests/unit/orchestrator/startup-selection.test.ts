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
import { getPreset } from "../../../packages/shared/src/providers";
import {
  modelForProvider,
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

  test("the custom endpoint's key may live in the credential store, not the sidecar", () => {
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
    expect(selection.provider).toBe("custom");
    expect(selection.model).toBe("mock-small");
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
      model: "mistral-large-latest",
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
      model: "claude-sonnet-4-6",
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
      model: "mistral-large-latest",
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
    expect(modelForProvider("mistral", ctx)).toBe("mistral-large-latest");
    expect(modelForProvider("google", ctx)).toBe("gemini-2.5-flash");
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
