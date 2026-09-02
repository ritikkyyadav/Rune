import { describe, it, expect } from "bun:test";
import {
  PROVIDER_PRESETS,
  getPreset,
  CUSTOM_PROVIDER_ID,
  getProviderDescriptor,
  effectiveAuthMethods,
  authMethodLabel,
  accountLoginLabel,
  AUTO_PROVIDER_PRIORITY,
} from "../../../packages/shared/src/providers";

describe("provider presets", () => {
  it("prefers direct paid-capacity providers during automatic startup", () => {
    expect(AUTO_PROVIDER_PRIORITY).toEqual(["anthropic", "openai", "google", "openrouter"]);
  });

  it("offers the named providers the keys panel promises", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    for (const id of ["anthropic", "openai", "openrouter", "google", "groq", "xai", "deepseek"]) {
      expect(ids).toContain(id);
    }
  });

  it("has unique ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has the required fields", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.label).toBeTruthy();
      expect(p.defaultModel).toBeTruthy();
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(["anthropic", "openai-compat", "google", "ollama", "codex"]).toContain(p.kind);
    }
  });

  it("remote openai-compat hosts carry an https base URL; local ones use localhost", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.kind === "openai-compat" && p.id !== "openai" && !p.local) {
        expect(p.baseUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it("local runtimes are keyless and carry a base URL", () => {
    const locals = PROVIDER_PRESETS.filter((p) => p.local);
    // `lmstudio` was the second local runtime until P8.6 dropped it: empty
    // catalogue, placeholder default, duplicating the slot Ollama fills.
    expect(locals.map((p) => p.id).sort()).toEqual(["ollama"]);
    for (const p of locals) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.envVar).toBeUndefined(); // no API key
    }
  });

  it("resolves presets by id; custom/unknown are not presets", () => {
    expect(getPreset("groq")?.label).toBe("Groq");
    expect(getPreset("nope")).toBeUndefined();
    expect(getPreset(CUSTOM_PROVIDER_ID)).toBeUndefined();
  });
});

describe("auth methods + descriptor", () => {
  const noEnv = {} as NodeJS.ProcessEnv;

  it("defaults api_key for cloud providers and local for runtimes", () => {
    expect(effectiveAuthMethods(getPreset("groq")!, noEnv)).toEqual(["api_key"]);
    expect(effectiveAuthMethods(getPreset("ollama")!, noEnv)).toEqual(["local"]);
  });

  it("declares OpenRouter's documented OAuth flow, api_key as fallback", () => {
    expect(effectiveAuthMethods(getPreset("openrouter")!, noEnv)).toEqual(["oauth", "api_key"]);
  });

  it("offers Anthropic subscription OAuth (Claude Pro/Max) with api_key as fallback", () => {
    // Ships enabled now (no GEAR_ANTHROPIC_OAUTH flag): oauth preferred, api_key
    // fallback. Env-independent — existing key/env users still resolve to api_key
    // because no OAuth session is stored (see resolveProviderCredentials).
    expect(effectiveAuthMethods(getPreset("anthropic")!, noEnv)).toEqual(["oauth", "api_key"]);
    const anyEnv = { GEAR_ANTHROPIC_OAUTH: "1" } as NodeJS.ProcessEnv;
    expect(effectiveAuthMethods(getPreset("anthropic")!, anyEnv)).toEqual(["oauth", "api_key"]);
  });

  it("getProviderDescriptor surfaces identity, auth, capabilities, and models", () => {
    const d = getProviderDescriptor("openrouter", noEnv)!;
    expect(d.label).toBe("OpenRouter");
    expect(d.auth).toEqual(["oauth", "api_key"]);
    expect(d.capabilities.streaming).toBe(true);
    expect(d.capabilities.toolCalling).toBe(true);
    expect(d.models.length).toBeGreaterThan(0);
    expect(d.local).toBe(false);
    expect(getProviderDescriptor("nope", noEnv)).toBeUndefined();
  });

  it("marks local runtimes as local in the descriptor", () => {
    expect(getProviderDescriptor("ollama", noEnv)!.local).toBe(true);
  });

  it("adds the subscription providers with account-style logins", () => {
    // `copilot` was the third until P8.5 dropped it (zero sessions ever ran on
    // it). Codex → OAuth (ChatGPT); Anthropic → OAuth (Claude Pro/Max).
    expect(getPreset("codex")).toBeDefined();
    expect(effectiveAuthMethods(getPreset("codex")!, noEnv)).toEqual(["oauth"]);
    expect(effectiveAuthMethods(getPreset("anthropic")!, noEnv)).toEqual(["oauth", "api_key"]);
  });
});

describe("subscription login labels (pi-style picker)", () => {
  it("frames the account login per subscription provider", () => {
    expect(accountLoginLabel("anthropic")).toMatch(/Claude Pro\/Max/);
    expect(accountLoginLabel("codex")).toMatch(/ChatGPT Plus\/Pro/);
    expect(accountLoginLabel("copilot")).toBeUndefined(); // dropped in P8.5
    expect(accountLoginLabel("groq")).toBeUndefined(); // API-key-only provider
  });

  it("labels methods the way pi does: account vs API key", () => {
    expect(authMethodLabel("api_key")).toBe("Sign in with an API key");
    expect(authMethodLabel("oauth", "anthropic")).toBe(
      "Sign in with your Claude Pro/Max subscription",
    );
    expect(authMethodLabel("oauth", "groq")).toBe("Sign in with an account");
  });
});
