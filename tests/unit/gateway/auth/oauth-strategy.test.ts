import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "crypto";
import {
  OAuthStrategy,
  base64url,
  generatePkce,
  randomState,
  startLoopback,
  type OAuthFlow,
} from "../../../../packages/llm-gateway/src/auth/oauth-strategy";
import { openRouterOAuthFlow } from "../../../../packages/llm-gateway/src/oauth/openrouter";
import { anthropicOAuthFlow } from "../../../../packages/llm-gateway/src/oauth/anthropic";
import { AuthError } from "../../../../packages/llm-gateway/src/auth/types";
import type { AuthContext } from "../../../../packages/llm-gateway/src/auth/types";
import {
  getPreset,
  oauthAccount,
  type CredentialStore,
} from "../../../../packages/shared/src/index";

function memStore(seed: Record<string, string> = {}): CredentialStore {
  const m = new Map(Object.entries(seed));
  return {
    backend: "file",
    secure: false,
    async get(a) {
      return m.get(a) ?? null;
    },
    async set(a, s) {
      m.set(a, s);
    },
    async delete(a) {
      m.delete(a);
    },
    async list() {
      return [...m.keys()];
    },
  };
}

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    providerId: "openrouter",
    preset: getPreset("openrouter")!,
    store: memStore(),
    env: {} as NodeJS.ProcessEnv,
    log: () => {},
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("PKCE + state", () => {
  it("challenge is the base64url S256 of the verifier", () => {
    const { verifier, challenge } = generatePkce();
    const expected = base64url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("base64url is url-safe and unpadded", () => {
    const { verifier, challenge } = generatePkce();
    for (const s of [verifier, challenge]) {
      expect(s).not.toMatch(/[+/=]/);
      expect(s.length).toBeGreaterThanOrEqual(43);
    }
  });

  it("state is random each call", () => {
    expect(randomState()).not.toBe(randomState());
  });
});

describe("loopback capture", () => {
  it("captures code + state from the redirect and serves a success page", async () => {
    const loop = await startLoopback();
    try {
      expect(loop.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      const res = await fetch(`${loop.redirectUri}?code=abc&state=xyz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/Authorized/);
      expect(await loop.waitForCode).toEqual({ code: "abc", state: "xyz" });
    } finally {
      loop.close();
    }
  });

  it("rejects when the provider returns an error", async () => {
    const loop = await startLoopback();
    try {
      await fetch(`${loop.redirectUri}?error=access_denied`);
      await expect(loop.waitForCode).rejects.toThrow(/access_denied/);
    } finally {
      loop.close();
    }
  });
});

describe("OAuthStrategy.authenticate (fake IdP, real loopback)", () => {
  // A fake provider whose authorize URL round-trips the redirect back to us.
  function fakeFlow(over: Partial<OAuthFlow> = {}): OAuthFlow {
    return {
      providerId: "openrouter",
      credentialKind: "apiKey",
      usesState: false,
      authorizeUrl: ({ redirectUri, codeChallenge, state }) =>
        `https://idp.test/auth?callback_url=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${codeChallenge}&state=${state}`,
      exchange: async ({ code, codeVerifier }) => {
        expect(code).toBe("the-code");
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        return { secret: "sk-or-minted-123" };
      },
      ...over,
    };
  }

  // Simulate the user's browser hitting the loopback with the auth code.
  const browserThatApproves = (stateOverride?: string) => async (url: string) => {
    const u = new URL(url);
    const cb = u.searchParams.get("callback_url")!;
    const state = stateOverride ?? u.searchParams.get("state") ?? "";
    await fetch(`${cb}?code=the-code&state=${encodeURIComponent(state)}`);
  };

  it("runs the full flow, mints a key, and persists it under the oauth account", async () => {
    const store = memStore();
    const strat = new OAuthStrategy(fakeFlow());
    const cred = await strat.authenticate(ctx({ store, openBrowser: browserThatApproves() }));
    expect(cred).toMatchObject({ kind: "apiKey", secret: "sk-or-minted-123" });
    const raw = await store.get(oauthAccount("openrouter"));
    expect(JSON.parse(raw!).secret).toBe("sk-or-minted-123");
  });

  it("rejects on state mismatch when the provider uses state", async () => {
    const strat = new OAuthStrategy(fakeFlow({ usesState: true }));
    await expect(
      strat.authenticate(ctx({ openBrowser: browserThatApproves("tampered-state") })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("wraps an exchange failure as a terminal AuthError with recovery text", async () => {
    const strat = new OAuthStrategy(
      fakeFlow({
        exchange: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(
      strat.authenticate(ctx({ openBrowser: browserThatApproves() })),
    ).rejects.toMatchObject({ name: "AuthError", recovery: "run: gear login openrouter" });
  });
});

describe("OAuthStrategy token lifecycle (bearer + refresh)", () => {
  const bearerFlow: OAuthFlow = {
    providerId: "openrouter",
    credentialKind: "bearer",
    authorizeUrl: () => "https://idp.test/auth",
    exchange: async () => ({ secret: "access-1", refreshToken: "refresh-1", expiresInSec: 3600 }),
    refresh: async (rt) => {
      expect(rt).toBe("refresh-1");
      return { secret: "access-2", refreshToken: "refresh-2", expiresInSec: 3600 };
    },
  };

  it("loads a stored, still-valid bearer without refreshing", async () => {
    const blob = JSON.stringify({
      secret: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      method: "oauth",
    });
    const store = memStore({ [oauthAccount("openrouter")]: blob });
    const cred = await new OAuthStrategy(bearerFlow).loadCredentials(ctx({ store }));
    expect(cred?.secret).toBe("access-1");
  });

  it("refreshes proactively when the token is near expiry", async () => {
    const blob = JSON.stringify({
      secret: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 10_000, // within the 60s skew
      method: "oauth",
    });
    const store = memStore({ [oauthAccount("openrouter")]: blob });
    const cred = await new OAuthStrategy(bearerFlow).loadCredentials(ctx({ store }));
    expect(cred?.secret).toBe("access-2");
    // the rotated refresh token is persisted
    expect(JSON.parse((await store.get(oauthAccount("openrouter")))!).refreshToken).toBe(
      "refresh-2",
    );
  });

  it("returns null when a near-expiry token can't be refreshed", async () => {
    const failing: OAuthFlow = {
      ...bearerFlow,
      refresh: async () => {
        throw new Error("refresh revoked");
      },
    };
    const blob = JSON.stringify({
      secret: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 5_000,
      method: "oauth",
    });
    const store = memStore({ [oauthAccount("openrouter")]: blob });
    expect(await new OAuthStrategy(failing).loadCredentials(ctx({ store }))).toBeNull();
  });

  it("logout removes the stored session", async () => {
    const store = memStore({ [oauthAccount("openrouter")]: "{}" });
    await new OAuthStrategy(bearerFlow).logout(ctx({ store }));
    expect(await store.get(oauthAccount("openrouter"))).toBeNull();
  });
});

describe("OpenRouter reference flow", () => {
  it("builds an authorize URL with callback_url + S256 challenge", () => {
    const url = openRouterOAuthFlow.authorizeUrl({
      redirectUri: "http://localhost:9999/callback",
      codeChallenge: "CHAL",
      state: "ignored",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://openrouter.ai/auth");
    expect(u.searchParams.get("callback_url")).toBe("http://localhost:9999/callback");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("parses the minted key from the token endpoint", async () => {
    let sentBody: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ key: "sk-or-v1-abc" }), { status: 200 });
    }) as typeof fetch;
    const result = await openRouterOAuthFlow.exchange({
      code: "c",
      codeVerifier: "v",
      redirectUri: "http://localhost/callback",
    });
    expect(result.secret).toBe("sk-or-v1-abc");
    expect(sentBody).toMatchObject({
      code: "c",
      code_verifier: "v",
      code_challenge_method: "S256",
    });
  });

  it("throws when the token endpoint fails", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    await expect(
      openRouterOAuthFlow.exchange({ code: "c", codeVerifier: "v", redirectUri: "http://x/cb" }),
    ).rejects.toThrow(/OpenRouter token exchange failed \(400\)/);
  });
});

// ─── Manual code-paste redirect (no loopback) ───
describe("OAuthStrategy manual code-paste redirect (Anthropic-style)", () => {
  function manualFlow(over: Partial<OAuthFlow> = {}): OAuthFlow {
    return {
      providerId: "anthropic",
      credentialKind: "bearer",
      usesState: true,
      redirect: "manual",
      manualRedirectUri: "https://provider.test/callback",
      authorizeUrl: ({ redirectUri, codeChallenge, state }) =>
        `https://provider.test/auth?redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${codeChallenge}&state=${state}`,
      exchange: async ({ code, codeVerifier, redirectUri }) => {
        expect(code).toBe("the-code");
        expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
        expect(redirectUri).toBe("https://provider.test/callback");
        return { secret: "access-tok", refreshToken: "refresh-tok", expiresInSec: 3600 };
      },
      ...over,
    };
  }

  function anthropicCtx(over: Partial<AuthContext> = {}): AuthContext {
    return ctx({ providerId: "anthropic", preset: getPreset("anthropic")!, ...over });
  }

  it("opens the browser, prompts for a pasted code#state, and persists the bearer", async () => {
    const store = memStore();
    let opened = "";
    let promptedFor = "";
    let sentState = "";
    const cred = await new OAuthStrategy(manualFlow()).authenticate(
      anthropicCtx({
        store,
        openBrowser: async (url: string) => {
          opened = url;
          sentState = new URL(url).searchParams.get("state") ?? "";
        },
        prompt: async (q: string) => {
          promptedFor = q;
          return `the-code#${sentState}`; // provider echoes the state back
        },
      }),
    );
    expect(opened).toContain("https://provider.test/auth");
    expect(promptedFor).toMatch(/paste/i);
    expect(cred).toMatchObject({ kind: "bearer", secret: "access-tok" });
    expect(JSON.parse((await store.get(oauthAccount("anthropic")))!)).toMatchObject({
      secret: "access-tok",
      refreshToken: "refresh-tok",
    });
  });

  it("accepts a bare code with no #state — PKCE still protects", async () => {
    const cred = await new OAuthStrategy(manualFlow()).authenticate(
      anthropicCtx({ openBrowser: async () => {}, prompt: async () => "the-code" }),
    );
    expect(cred.secret).toBe("access-tok");
  });

  it("rejects a pasted state that doesn't match the one we sent (CSRF)", async () => {
    await expect(
      new OAuthStrategy(manualFlow()).authenticate(
        anthropicCtx({ openBrowser: async () => {}, prompt: async () => "the-code#tampered" }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("errors clearly when there is no interactive prompt to paste into", async () => {
    await expect(
      new OAuthStrategy(manualFlow()).authenticate(
        anthropicCtx({ openBrowser: async () => {}, prompt: undefined }),
      ),
    ).rejects.toMatchObject({ name: "AuthError" });
  });

  it("treats an empty paste as a terminal AuthError", async () => {
    await expect(
      new OAuthStrategy(manualFlow()).authenticate(
        anthropicCtx({ openBrowser: async () => {}, prompt: async () => "   " }),
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

// ─── Anthropic Claude Pro/Max flow shape ───
describe("Anthropic subscription flow (Claude Pro/Max)", () => {
  it("is a manual-redirect, stateful, bearer flow", () => {
    expect(anthropicOAuthFlow.credentialKind).toBe("bearer");
    expect(anthropicOAuthFlow.redirect).toBe("manual");
    expect(anthropicOAuthFlow.usesState).toBe(true);
    expect(anthropicOAuthFlow.manualRedirectUri).toContain("platform.claude.com");
  });

  it("authorize URL carries PKCE (S256), the user:inference scope, and code=true", () => {
    const u = new URL(
      anthropicOAuthFlow.authorizeUrl({
        redirectUri: "https://platform.claude.com/oauth/code/callback",
        codeChallenge: "CHAL",
        state: "STATE",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("code_challenge")).toBe("CHAL");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toContain("user:inference");
    expect(u.searchParams.get("state")).toBe("STATE");
    expect(u.searchParams.get("client_id")).toBeTruthy();
  });

  it("encodes the scope's spaces as %20 — claude.ai rejects the form-style + as 'Invalid request format'", () => {
    // Raw-string assertion on purpose: URLSearchParams.get() decodes + and %20
    // identically, which is exactly how the live regression slipped past the
    // parsed-param checks above.
    const raw = anthropicOAuthFlow.authorizeUrl({
      redirectUri: "https://platform.claude.com/oauth/code/callback",
      codeChallenge: "CHAL",
      state: "STATE",
    });
    expect(raw).toContain("scope=org%3Acreate_api_key%20user%3Aprofile%20user%3Ainference");
    expect(raw.split("?")[1]).not.toContain("+");
    expect(raw).toContain(
      "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
    );
  });

  it("exchanges an authorization code for a refreshable bearer", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await anthropicOAuthFlow.exchange({
      code: "c",
      codeVerifier: "v",
      redirectUri: "https://platform.claude.com/oauth/code/callback",
      state: "s",
    });
    expect(result).toMatchObject({ secret: "at", refreshToken: "rt", expiresInSec: 3600 });
    expect(sent).toMatchObject({
      grant_type: "authorization_code",
      code: "c",
      code_verifier: "v",
      state: "s",
    });
  });

  it("refreshes the bearer via the refresh token", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 }), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await anthropicOAuthFlow.refresh!("rt");
    expect(result.secret).toBe("at2");
    expect(sent).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
  });

  it("throws with the HTTP status on a failed exchange", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
    await expect(
      anthropicOAuthFlow.exchange({ code: "c", codeVerifier: "v", redirectUri: "x" }),
    ).rejects.toThrow(/Anthropic token endpoint failed \(401\)/);
  });
});
