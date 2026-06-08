import { describe, it, expect } from "vitest";
import { buildGateway, providerStatus } from "../../../packages/orchestrator/src/provider-registry";

// Inject an empty env so the host's real keys never leak into assertions.
const noEnv = {} as NodeJS.ProcessEnv;

describe("buildGateway", () => {
  it("registers only providers that have a usable key", () => {
    const gw = buildGateway({ provider: "google", keys: { google: "g", groq: "gsk" }, env: noEnv });
    expect(gw.getRegisteredProviderNames().sort()).toEqual(["google", "groq"]);
  });

  it("skips disabled providers", () => {
    const gw = buildGateway({
      provider: "google",
      keys: { google: "g", groq: "gsk" },
      disabled: new Set(["groq"]),
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toEqual(["google"]);
  });

  it("falls back to env vars when no saved key is present", () => {
    const gw = buildGateway({
      provider: "anthropic",
      keys: {},
      env: { ANTHROPIC_API_KEY: "sk-ant" } as NodeJS.ProcessEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("anthropic");
  });

  it("registers a custom OpenAI-compatible endpoint under 'custom'", () => {
    const gw = buildGateway({
      provider: "custom",
      keys: {},
      customEndpoint: { baseUrl: "https://x/v1", model: "m", key: "k" },
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("custom");
  });

  it("does not register custom without both a key and a base URL", () => {
    const gw = buildGateway({
      provider: "google",
      keys: { google: "g" },
      customEndpoint: { baseUrl: "", model: "m", key: "" },
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toEqual(["google"]);
  });
});

describe("providerStatus", () => {
  it("reports saved/env/none and masks keys without leaking the secret", () => {
    const rows = providerStatus({
      keys: { anthropic: "sk-ant-secret-key-xyz" },
      active: "anthropic",
      env: { GROQ_API_KEY: "gsk_envkey_123456" } as NodeJS.ProcessEnv,
    });

    const a = rows.find((r) => r.id === "anthropic")!;
    expect(a.source).toBe("saved");
    expect(a.active).toBe(true);
    expect(a.masked).not.toContain("secret");

    const g = rows.find((r) => r.id === "groq")!;
    expect(g.source).toBe("env");
    expect(g.hasKey).toBe(true);

    const o = rows.find((r) => r.id === "openai")!;
    expect(o.source).toBe("none");
    expect(o.hasKey).toBe(false);
  });

  it("appends a custom row reflecting the configured endpoint", () => {
    const rows = providerStatus({
      keys: {},
      active: "google",
      customEndpoint: { baseUrl: "https://x/v1", model: "m", key: "k-123456789" },
    });
    const c = rows.find((r) => r.id === "custom")!;
    expect(c.hasKey).toBe(true);
    expect(c.source).toBe("saved");
  });
});
