import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildGateway,
  providerStatus,
  resolveProviderCredentials,
} from "../../../packages/orchestrator/src/provider-registry";
import {
  openCredentialStore,
  apiKeyAccount,
  oauthAccount,
} from "../../../packages/shared/src/credential-store";

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

  it("builds the Anthropic transport in OAuth mode for a bearer (subscription) credential", () => {
    const gw = buildGateway({
      provider: "anthropic",
      keys: {},
      credentials: {
        anthropic: { kind: "bearer", secret: "oauth-access-token", meta: { method: "oauth" } },
      },
      env: noEnv,
    });
    const provider = gw.getProvider("anthropic") as unknown as { oauth: boolean } | undefined;
    expect(provider).toBeDefined();
    expect(provider!.oauth).toBe(true); // Bearer + Claude-Code identity path
  });

  it("keeps the Anthropic transport in api-key mode for an apiKey credential", () => {
    const gw = buildGateway({
      provider: "anthropic",
      keys: {},
      credentials: {
        anthropic: { kind: "apiKey", secret: "sk-ant-xyz", meta: { method: "api_key" } },
      },
      env: noEnv,
    });
    const provider = gw.getProvider("anthropic") as unknown as { oauth: boolean } | undefined;
    expect(provider!.oauth).toBe(false);
  });

  it("registers the Copilot transport from a device credential (durable GitHub token)", () => {
    const gw = buildGateway({
      provider: "copilot",
      keys: {},
      credentials: { copilot: { kind: "apiKey", secret: "gho_x", meta: { method: "device" } } },
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("copilot");
    expect(gw.getProvider("copilot")?.name).toBe("copilot");
  });

  it("does not register Copilot without a credential (no env/key fallback exists)", () => {
    const gw = buildGateway({ provider: "copilot", keys: {}, env: noEnv });
    expect(gw.getRegisteredProviderNames()).not.toContain("copilot");
  });

  it("registers the Codex transport from an oauth bearer, threading the account id", () => {
    const gw = buildGateway({
      provider: "codex",
      keys: {},
      credentials: {
        codex: { kind: "bearer", secret: "at", meta: { method: "oauth", accountId: "acct_1" } },
      },
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("codex");
    const p = gw.getProvider("codex") as unknown as { accountId?: string } | undefined;
    expect(p?.accountId).toBe("acct_1"); // → chatgpt-account-id header
  });

  it("does NOT phantom-register local runtimes for a cloud session", () => {
    // ollama/lmstudio must not appear just because they have default localhost
    // URLs — a cloud session should never silently fall back to localhost.
    const gw = buildGateway({ provider: "google", keys: { google: "g" }, env: noEnv });
    const names = gw.getRegisteredProviderNames();
    expect(names).not.toContain("ollama");
    expect(names).not.toContain("lmstudio");
  });

  it("registers local ollama when it is the active provider", () => {
    const gw = buildGateway({ provider: "ollama", keys: {}, env: noEnv });
    expect(gw.getRegisteredProviderNames()).toContain("ollama");
  });

  it("registers a local runtime once its base URL is configured", () => {
    const gw = buildGateway({
      provider: "google",
      keys: { google: "g" },
      localBaseUrls: { lmstudio: "http://localhost:1234/v1" },
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("lmstudio");
  });

  it("honors OLLAMA_HOST as a configured local endpoint", () => {
    const gw = buildGateway({
      provider: "google",
      keys: { google: "g" },
      env: { OLLAMA_HOST: "http://box:11434" } as NodeJS.ProcessEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("ollama");
  });

  it("skips a disabled local runtime even when active", () => {
    const gw = buildGateway({
      provider: "ollama",
      keys: {},
      disabled: new Set(["ollama"]),
      env: noEnv,
    });
    expect(gw.getRegisteredProviderNames()).not.toContain("ollama");
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

  it("marks local runtimes with their endpoint and no key", () => {
    const rows = providerStatus({
      keys: {},
      active: "google",
      localBaseUrls: { ollama: "http://box:11434" },
      env: {} as NodeJS.ProcessEnv,
    });
    const o = rows.find((r) => r.id === "ollama")!;
    expect(o.local).toBe(true);
    expect(o.endpoint).toBe("http://box:11434");
    expect(o.hasKey).toBe(true); // configured → usable
    expect(o.masked).toBe(""); // never a key

    const lm = rows.find((r) => r.id === "lmstudio")!;
    expect(lm.local).toBe(true);
    expect(lm.endpoint).toBe("http://localhost:1234/v1"); // preset default
    expect(lm.hasKey).toBe(false); // not configured, not active
  });

  it("reports the key count and a masked, dated pool for a multi-account provider", () => {
    const rows = providerStatus({
      keys: { "ollama-turbo": "key2-SECRETMIDDLE-bbbb" },
      keyEntries: {
        "ollama-turbo": [
          {
            id: "k1",
            key: "key1-SECRETMIDDLE-aaaa",
            label: "personal",
            addedAt: "2026-07-01T00:00:00Z",
          },
          {
            id: "k2",
            key: "key2-SECRETMIDDLE-bbbb",
            label: "work",
            addedAt: "2026-07-10T00:00:00Z",
          },
        ],
      },
      activeKeyId: { "ollama-turbo": "k2" },
      active: "google",
      env: {} as NodeJS.ProcessEnv,
    });
    const ot = rows.find((r) => r.id === "ollama-turbo")!;
    expect(ot.keyCount).toBe(2);
    expect(ot.savedKeys).toHaveLength(2);
    expect(ot.savedKeys.map((k) => k.label)).toEqual(["personal", "work"]);
    // Masked, never raw; active flag points at the mirror key.
    expect(ot.savedKeys[0].masked).not.toContain("SECRETMIDDLE");
    expect(ot.savedKeys.find((k) => k.active)?.id).toBe("k2");
    expect(ot.savedKeys[1].addedAt).toBe("2026-07-10T00:00:00Z");
  });

  it("counts a single saved key as one and env/none as one/zero", () => {
    const rows = providerStatus({
      keys: { anthropic: "sk-ant-single-000" },
      active: "anthropic",
      env: { GROQ_API_KEY: "gsk_env_000000" } as NodeJS.ProcessEnv,
    });
    expect(rows.find((r) => r.id === "anthropic")!.keyCount).toBe(1);
    expect(rows.find((r) => r.id === "groq")!.keyCount).toBe(1);
    expect(rows.find((r) => r.id === "openai")!.keyCount).toBe(0);
  });
});

// ─── BYOP: the credential-resolution firewall ───
describe("resolveProviderCredentials + credential-map firewall", () => {
  let dir: string;
  let storeEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alan-reg-cred-"));
    storeEnv = {
      HOME: dir,
      BERNE_CREDENTIALS_PATH: join(dir, "credentials.json"),
      BERNE_CREDENTIAL_INDEX_PATH: join(dir, "credentials.index.json"),
    } as NodeJS.ProcessEnv;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("builds the SAME provider set with an empty store as the legacy path", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    const keys = { google: "g", groq: "gsk" };
    const credentials = await resolveProviderCredentials({
      store,
      keys,
      active: "google",
      env: noEnv,
    });
    const withCreds = buildGateway({ provider: "google", keys, credentials, env: noEnv });
    const legacy = buildGateway({ provider: "google", keys, env: noEnv });
    expect(withCreds.getRegisteredProviderNames().sort()).toEqual(
      legacy.getRegisteredProviderNames().sort(),
    );
  });

  it("resolves an env-only key to the same secret the legacy path would use", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    const env = { GROQ_API_KEY: "gsk_env" } as NodeJS.ProcessEnv;
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "google",
      env,
    });
    expect(credentials.groq?.secret).toBe("gsk_env");
    expect(credentials.groq?.meta?.source).toBe("env");
  });

  it("registers a provider whose key lives ONLY in the secure store", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    await store.set(apiKeyAccount("groq"), "gsk_from_keychain");
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "google",
      env: noEnv,
    });
    expect(credentials.groq?.secret).toBe("gsk_from_keychain");
    expect(credentials.groq?.meta?.source).toBe("keychain");
    const gw = buildGateway({ provider: "google", keys: { google: "g" }, credentials, env: noEnv });
    expect(gw.getRegisteredProviderNames().sort()).toEqual(["google", "groq"]);
  });

  it("lets a stored key win over a saved/env key (new precedence)", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    await store.set(apiKeyAccount("groq"), "gsk_store_wins");
    const credentials = await resolveProviderCredentials({
      store,
      keys: { groq: "gsk_saved" },
      active: "google",
      env: noEnv,
    });
    expect(credentials.groq?.secret).toBe("gsk_store_wins");
  });

  it("resolves a Copilot device credential stored under the oauth account", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    await store.set(
      oauthAccount("copilot"),
      JSON.stringify({ secret: "gho_stored", method: "device" }),
    );
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "copilot",
      env: noEnv,
    });
    expect(credentials.copilot?.secret).toBe("gho_stored");
    expect(credentials.copilot?.meta?.method).toBe("device");
  });

  it("does not emit credentials for local runtimes (they register keylessly)", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "ollama",
      env: noEnv,
    });
    expect(credentials.ollama).toBeUndefined();
    expect(credentials.lmstudio).toBeUndefined();
  });

  it("skips disabled providers during resolution", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: storeEnv });
    const credentials = await resolveProviderCredentials({
      store,
      keys: { groq: "gsk", google: "g" },
      active: "google",
      disabled: new Set(["groq"]),
      env: noEnv,
    });
    expect(credentials.groq).toBeUndefined();
    expect(credentials.google?.secret).toBe("g");
  });
});

describe("providerStatus is BYOP-aware (never lies about the credential in use)", () => {
  it("shows oauth source + method when an OAuth credential is resolved, over an env key", () => {
    const rows = providerStatus({
      keys: {},
      active: "openrouter",
      env: { OPENROUTER_API_KEY: "sk-env" } as NodeJS.ProcessEnv,
      credentials: {
        openrouter: { kind: "apiKey", secret: "sk-or-oauth", meta: { method: "oauth" } },
      },
    });
    const r = rows.find((x) => x.id === "openrouter")!;
    expect(r.source).toBe("oauth");
    expect(r.authMethod).toBe("oauth");
    expect(r.hasKey).toBe(true);
    expect(r.masked).not.toContain("oauth"); // masked, never raw
  });

  it("shows keychain source for a securely-stored api key", () => {
    const rows = providerStatus({
      keys: {},
      active: "groq",
      env: {} as NodeJS.ProcessEnv,
      credentials: {
        groq: { kind: "apiKey", secret: "gsk_x", meta: { method: "api_key", source: "keychain" } },
      },
    });
    expect(rows.find((x) => x.id === "groq")!.source).toBe("keychain");
  });

  it("falls back to the legacy env/saved view when no credential is resolved", () => {
    const rows = providerStatus({
      keys: {},
      active: "google",
      env: { GROQ_API_KEY: "gsk" } as NodeJS.ProcessEnv,
    });
    expect(rows.find((x) => x.id === "groq")!.source).toBe("env");
  });
});
