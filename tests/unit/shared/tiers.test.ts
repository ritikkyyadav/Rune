/**
 * Model tiers: heavy/standard/light routing across providers.
 *  - provider/model overrides parse only when the prefix is a known provider
 *    (OpenRouter model ids legitimately contain slashes)
 *  - overrides pointing at unkeyed providers are skipped, not honored blindly
 *  - fallback chain: override → provider tier table → session model
 */

import { describe, test, expect } from "bun:test";
import {
  parseTierRef,
  resolveTier,
  PROVIDER_TIER_DEFAULTS,
} from "../../../packages/shared/src/tiers";

const KNOWN = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "xai",
  "openrouter",
  "ollama",
  "ollama-turbo",
  "lmstudio",
  "custom",
]);

describe("parseTierRef", () => {
  test("bare model → active provider", () => {
    expect(parseTierRef("claude-haiku-4-5", "anthropic", KNOWN)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  test("provider/model → cross-provider", () => {
    expect(parseTierRef("deepseek/deepseek-chat", "anthropic", KNOWN)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  test("slash in a MODEL id (openrouter) is not treated as a provider", () => {
    expect(parseTierRef("qwen/qwen3-coder:free", "openrouter", KNOWN)).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-coder:free",
    });
  });

  test("openrouter/vendor/model parses the provider prefix only", () => {
    expect(parseTierRef("openrouter/qwen/qwen3-coder:free", "anthropic", KNOWN)).toEqual({
      provider: "openrouter",
      model: "qwen/qwen3-coder:free",
    });
  });
});

describe("resolveTier", () => {
  const registered = new Set(["anthropic", "deepseek"]);

  test("user override wins when its provider is registered", () => {
    const ref = resolveTier(
      "light",
      { light: "deepseek/deepseek-chat" },
      "anthropic",
      "claude-sonnet-4-6",
      registered,
      KNOWN,
    );
    expect(ref).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });

  test("override on an unkeyed provider is skipped (no mid-task 401s)", () => {
    const ref = resolveTier(
      "light",
      { light: "openai/gpt-5-mini" }, // openai NOT registered
      "anthropic",
      "claude-sonnet-4-6",
      registered,
      KNOWN,
    );
    // Falls back to anthropic's built-in light tier
    expect(ref).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("no override → provider tier table", () => {
    expect(
      resolveTier("heavy", undefined, "anthropic", "claude-sonnet-4-6", registered, KNOWN),
    ).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(resolveTier("light", {}, "deepseek", "deepseek-chat", registered, KNOWN)).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  test("unknown provider (local runtime) falls back to the session model", () => {
    const ref = resolveTier(
      "light",
      undefined,
      "lmstudio",
      "local-model",
      new Set(["lmstudio"]),
      KNOWN,
    );
    expect(ref).toEqual({ provider: "lmstudio", model: "local-model" });
  });

  test("every tier table entry has all three tiers", () => {
    for (const [provider, tiers] of Object.entries(PROVIDER_TIER_DEFAULTS)) {
      expect(tiers.heavy, provider).toBeTruthy();
      expect(tiers.standard, provider).toBeTruthy();
      expect(tiers.light, provider).toBeTruthy();
    }
  });
});
