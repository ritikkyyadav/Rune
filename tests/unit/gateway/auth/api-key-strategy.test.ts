import { describe, it, expect } from "vitest";
import { ApiKeyStrategy } from "../../../../packages/llm-gateway/src/auth/api-key-strategy";
import type { AuthContext } from "../../../../packages/llm-gateway/src/auth/types";
import {
  getPreset,
  apiKeyAccount,
  type CredentialStore,
} from "../../../../packages/shared/src/index";

/** A tiny in-memory CredentialStore for strategy tests. */
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
    providerId: "groq",
    preset: getPreset("groq")!,
    store: memStore(),
    env: {} as NodeJS.ProcessEnv,
    ...over,
  };
}

describe("ApiKeyStrategy", () => {
  const strat = new ApiKeyStrategy();

  it("precedence: secure store > saved key > env var", async () => {
    const store = memStore({ [apiKeyAccount("groq")]: "from-store" });
    const c = await strat.loadCredentials(
      ctx({
        store,
        savedKey: "from-saved",
        env: { GROQ_API_KEY: "from-env" } as NodeJS.ProcessEnv,
      }),
    );
    expect(c?.secret).toBe("from-store");
    expect(c?.meta?.source).toBe("keychain");
  });

  it("uses the saved key when the store is empty", async () => {
    const c = await strat.loadCredentials(ctx({ savedKey: "from-saved" }));
    expect(c?.secret).toBe("from-saved");
    expect(c?.meta?.source).toBe("saved");
  });

  it("falls back to the provider's env var last", async () => {
    const c = await strat.loadCredentials(
      ctx({ env: { GROQ_API_KEY: "from-env" } as NodeJS.ProcessEnv }),
    );
    expect(c?.secret).toBe("from-env");
    expect(c?.meta?.source).toBe("env");
  });

  it("returns null when there is no key anywhere", async () => {
    expect(await strat.loadCredentials(ctx())).toBeNull();
  });

  it("validate is offline and true only for a non-empty secret", async () => {
    expect(await strat.validate(ctx(), { kind: "apiKey", secret: "x" })).toBe(true);
    expect(await strat.validate(ctx(), { kind: "apiKey", secret: "" })).toBe(false);
    expect(await strat.validate(ctx(), { kind: "none" })).toBe(false);
  });

  it("authenticate prompts, stores, and returns the key", async () => {
    const store = memStore();
    const c = await strat.authenticate(
      ctx({ store, prompt: async () => "  sk-pasted-123  ", log: () => {} }),
    );
    expect(c.secret).toBe("sk-pasted-123");
    expect(await store.get(apiKeyAccount("groq"))).toBe("sk-pasted-123");
  });

  it("logout removes the stored key and never throws", async () => {
    const store = memStore({ [apiKeyAccount("groq")]: "k" });
    await strat.logout(ctx({ store }));
    expect(await store.get(apiKeyAccount("groq"))).toBeNull();
  });
});
