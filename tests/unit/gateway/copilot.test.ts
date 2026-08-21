/**
 * GitHub Copilot subscription login + transport.
 *   • githubCopilotDeviceFlow — device-authorization start + poll-status mapping.
 *   • DeviceCodeStrategy over that flow — persists the durable GitHub token.
 *   • CopilotProvider — mints a short-lived Copilot token from the GitHub token,
 *     caches it, refreshes near expiry, and injects the bearer + editor headers.
 * All network is mocked; no real GitHub calls.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { CopilotProvider } from "../../../packages/llm-gateway/src/providers/copilot";
import { githubCopilotDeviceFlow } from "../../../packages/llm-gateway/src/oauth/github-copilot";
import { DeviceCodeStrategy } from "../../../packages/llm-gateway/src/auth/device-code-strategy";
import type { AuthContext } from "../../../packages/llm-gateway/src/auth/types";
import { getPreset, oauthAccount, type CredentialStore } from "../../../packages/shared/src/index";

const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function memStore(): CredentialStore {
  const m = new Map<string, string>();
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

function copilotCtx(store: CredentialStore): AuthContext {
  return {
    providerId: "copilot",
    preset: getPreset("copilot")!,
    store,
    env: {} as NodeJS.ProcessEnv,
    log: () => {},
  };
}

type Call = { url: string; init?: RequestInit };

describe("githubCopilotDeviceFlow", () => {
  it("starts device authorization and returns the user code + verification URI", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe(DEVICE_CODE_URL);
      return new Response(
        JSON.stringify({
          device_code: "dev-123",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 5,
          expires_in: 900,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth = await githubCopilotDeviceFlow.startDeviceAuth();
    expect(auth).toMatchObject({
      deviceCode: "dev-123",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      intervalSec: 5,
      expiresInSec: 900,
    });
  });

  it("maps poll responses: pending / slow_down / denied / expired / done", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ error: "authorization_pending" }, "pending"],
      [{ error: "slow_down" }, "slow_down"],
      [{ error: "access_denied" }, "denied"],
      [{ error: "expired_token" }, "expired"],
    ];
    for (const [body, expected] of cases) {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
      expect((await githubCopilotDeviceFlow.poll("dev")).status).toBe(expected);
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "gho_abc" }), { status: 200 })) as typeof fetch;
    const done = await githubCopilotDeviceFlow.poll("dev");
    expect(done).toEqual({ status: "done", result: { secret: "gho_abc" } });
  });

  it("keeps polling on a transient non-200 rather than aborting", async () => {
    globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    expect((await githubCopilotDeviceFlow.poll("dev")).status).toBe("pending");
  });
});

describe("DeviceCodeStrategy over the GitHub flow", () => {
  it("polls to completion and persists the durable GitHub token", async () => {
    let polls = 0;
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u === DEVICE_CODE_URL) {
        return new Response(
          JSON.stringify({
            device_code: "dev-123",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 900,
          }),
          { status: 200 },
        );
      }
      if (u === ACCESS_TOKEN_URL) {
        polls++;
        // pending on the first poll, authorized on the second
        return new Response(
          JSON.stringify(
            polls < 2 ? { error: "authorization_pending" } : { access_token: "gho_final" },
          ),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const store = memStore();
    // No-wait sleep so the poll loop doesn't actually pause the test.
    const strat = new DeviceCodeStrategy(githubCopilotDeviceFlow, async () => {});
    const cred = await strat.authenticate(copilotCtx(store));
    expect(cred).toMatchObject({ kind: "apiKey", secret: "gho_final", meta: { method: "device" } });
    expect(JSON.parse((await store.get(oauthAccount("copilot")))!).secret).toBe("gho_final");
    expect(polls).toBe(2);
  });
});

describe("CopilotProvider token minting + header injection", () => {
  function mockFetch(calls: Call[], tokenExpiresInSec = 1800) {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u === TOKEN_URL) {
        return new Response(
          JSON.stringify({
            token: `cop-${calls.filter((c) => c.url === TOKEN_URL).length}`,
            expires_at: Math.floor(Date.now() / 1000) + tokenExpiresInSec,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  }

  // Reach the private custom-fetch to observe exactly what hits the wire.
  function fetchOf(p: CopilotProvider) {
    return (p as unknown as { copilotFetch: (u: string, i?: RequestInit) => Promise<Response> })
      .copilotFetch;
  }

  it("mints a Copilot token from the GitHub token and injects auth + editor headers", async () => {
    const calls: Call[] = [];
    mockFetch(calls);
    const p = new CopilotProvider("gho_ghtoken");
    await fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} });

    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect((tokenCall.init!.headers as Record<string, string>).authorization).toBe(
      "token gho_ghtoken",
    );
    const downstream = calls.find((c) => c.url.includes("githubcopilot.com/chat"))!;
    const h = downstream.init!.headers as Headers;
    expect(h.get("authorization")).toBe("Bearer cop-1");
    expect(h.get("copilot-integration-id")).toBe("vscode-chat");
    expect(h.get("editor-version")).toBeTruthy();
    expect(h.get("editor-plugin-version")).toBeTruthy();
  });

  it("caches the token across requests (mints once while valid)", async () => {
    const calls: Call[] = [];
    mockFetch(calls, 1800);
    const p = new CopilotProvider("gho");
    await fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} });
    await fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} });
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("re-mints when the token is within the refresh skew", async () => {
    const calls: Call[] = [];
    // 60s lifetime < 120s skew ⇒ always considered near-expiry ⇒ re-mint each call.
    mockFetch(calls, 60);
    const p = new CopilotProvider("gho");
    await fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} });
    await fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} });
    expect(calls.filter((c) => c.url === TOKEN_URL).length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a clear error when the GitHub account has no Copilot access", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url) === TOKEN_URL) return new Response("no access", { status: 403 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const p = new CopilotProvider("gho");
    await expect(
      fetchOf(p)("https://api.githubcopilot.com/chat/completions", { headers: {} }),
    ).rejects.toThrow(/Copilot token request failed \(403\)/);
  });
});
