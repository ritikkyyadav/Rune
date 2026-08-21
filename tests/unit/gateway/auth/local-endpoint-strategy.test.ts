import { describe, it, expect, afterEach } from "bun:test";
import { LocalEndpointStrategy } from "../../../../packages/llm-gateway/src/auth/local-endpoint-strategy";
import type { AuthContext } from "../../../../packages/llm-gateway/src/auth/types";
import { getPreset, type CredentialStore } from "../../../../packages/shared/src/index";

const noopStore: CredentialStore = {
  backend: "file",
  secure: false,
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    providerId: "ollama",
    preset: getPreset("ollama")!,
    store: noopStore,
    env: {} as NodeJS.ProcessEnv,
    ...over,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("LocalEndpointStrategy", () => {
  const strat = new LocalEndpointStrategy();

  it("loads a keyless credential carrying the base URL", async () => {
    const c = await strat.loadCredentials(ctx({ baseUrl: "http://box:11434" }));
    expect(c).toEqual({
      kind: "none",
      baseUrl: "http://box:11434",
      meta: { method: "local" },
    });
  });

  it("falls back to the preset base URL when none is supplied", async () => {
    const c = await strat.loadCredentials(ctx());
    expect(c?.baseUrl).toBe(getPreset("ollama")!.baseUrl);
  });

  it("validate() is true when the endpoint answers (any status)", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 404 })) as typeof fetch;
    expect(await strat.validate(ctx(), { kind: "none", baseUrl: "http://box:11434" })).toBe(true);
  });

  it("validate() is false (never throws) when the endpoint is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await strat.validate(ctx(), { kind: "none", baseUrl: "http://box:11434" })).toBe(false);
  });

  it("stores/logout are no-ops", async () => {
    await expect(strat.storeCredentials(ctx(), { kind: "none" })).resolves.toBeUndefined();
    await expect(strat.logout(ctx())).resolves.toBeUndefined();
  });
});
