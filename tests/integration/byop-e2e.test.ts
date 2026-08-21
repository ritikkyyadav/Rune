import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OAuthStrategy, type OAuthFlow } from "../../packages/llm-gateway/src/auth/oauth-strategy";
import type { AuthContext } from "../../packages/llm-gateway/src/auth/types";
import { openCredentialStore, oauthAccount } from "../../packages/shared/src/credential-store";
import { getPreset } from "../../packages/shared/src/providers";
import {
  buildGateway,
  resolveProviderCredentials,
} from "../../packages/orchestrator/src/provider-registry";

// End-to-end BYOP lifecycle through the real strategy + resolver + gateway,
// with a mock IdP (fake OAuthFlow) and a real loopback — no network, no keychain.
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-byop-e2e-"));
  env = {
    HOME: dir,
    BERNE_CREDENTIALS_PATH: join(dir, "credentials.json"),
    BERNE_CREDENTIAL_INDEX_PATH: join(dir, "credentials.index.json"),
  } as NodeJS.ProcessEnv;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A mock OpenRouter-style IdP: its authorize URL round-trips the redirect back to
// the loopback, and its exchange mints a key (kind: apiKey), like OpenRouter.
const mockFlow: OAuthFlow = {
  providerId: "openrouter",
  credentialKind: "apiKey",
  usesState: false,
  authorizeUrl: ({ redirectUri, codeChallenge, state }) =>
    `https://idp.test/auth?callback_url=${encodeURIComponent(redirectUri)}&cc=${codeChallenge}&state=${state}`,
  exchange: async ({ code }) => {
    expect(code).toBe("code-42");
    return { secret: "sk-or-oauth-minted-key" };
  },
};

const approveInBrowser = async (url: string) => {
  const u = new URL(url);
  const cb = u.searchParams.get("callback_url")!;
  await fetch(`${cb}?code=code-42&state=${u.searchParams.get("state") ?? ""}`);
};

describe("BYOP end-to-end lifecycle", () => {
  it("logs in via OAuth, resolves + registers the provider, then logs out", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env });
    const ctx: AuthContext = {
      providerId: "openrouter",
      preset: getPreset("openrouter")!,
      store,
      env,
      openBrowser: approveInBrowser,
      log: () => {},
    };

    // 1. Login (mock IdP) persists a credential under the oauth account.
    const cred = await new OAuthStrategy(mockFlow).authenticate(ctx);
    expect(cred).toMatchObject({ kind: "apiKey", secret: "sk-or-oauth-minted-key" });
    expect(await store.get(oauthAccount("openrouter"))).toBeTruthy();

    // 2. The boot resolver (using the REAL openrouter oauth strategy) picks it up.
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "openrouter",
      env: {} as NodeJS.ProcessEnv, // no env key — the credential must come from the store
    });
    expect(credentials.openrouter?.secret).toBe("sk-or-oauth-minted-key");
    expect(credentials.openrouter?.meta?.method).toBe("oauth");

    // 3. buildGateway registers openrouter purely from the resolved credential.
    const gw = buildGateway({
      provider: "openrouter",
      keys: {},
      credentials,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(gw.getRegisteredProviderNames()).toContain("openrouter");

    // 4. Logout removes the credential; re-resolution no longer registers it.
    await new OAuthStrategy(mockFlow).logout(ctx);
    expect(await store.get(oauthAccount("openrouter"))).toBeNull();
    const after = await resolveProviderCredentials({
      store,
      keys: {},
      active: "openrouter",
      env: {} as NodeJS.ProcessEnv,
    });
    expect(after.openrouter).toBeUndefined();
    const gw2 = buildGateway({
      provider: "openrouter",
      keys: {},
      credentials: after,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(gw2.getRegisteredProviderNames()).not.toContain("openrouter");
  });

  it("an env-key-only run registers the identical provider set with or without the credential map", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env });
    const runEnv = { GROQ_API_KEY: "gsk_env", GOOGLE_API_KEY: "g" } as NodeJS.ProcessEnv;
    const credentials = await resolveProviderCredentials({
      store,
      keys: {},
      active: "google",
      env: runEnv,
    });
    const withCreds = buildGateway({ provider: "google", keys: {}, credentials, env: runEnv });
    const legacy = buildGateway({ provider: "google", keys: {}, env: runEnv });
    expect(withCreds.getRegisteredProviderNames().sort()).toEqual(
      legacy.getRegisteredProviderNames().sort(),
    );
    // sanity: the preset metadata the resolver relied on is intact
    expect(getPreset("openrouter")?.auth).toEqual(["oauth", "api_key"]);
  });
});
