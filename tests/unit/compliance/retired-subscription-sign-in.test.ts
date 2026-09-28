/**
 * The Claude subscription sign-in is retired. What that means for a person who
 * signed in with it before, pinned against fake credential stores only:
 *
 *   • the stored token is ignored: nothing resolves it, nothing registers it;
 *   • they are told why, once per process, and what to use instead;
 *   • the token is never deleted behind their back;
 *   • `rune logout anthropic` is what removes it;
 *   • `rune login anthropic --method oauth` is refused by name, with the reason.
 *
 * Background: docs/program/compliance-subscription-routes.md.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  RETIRED_OAUTH_NOTICES,
  retiredOAuthNotices,
  makeOAuthStrategy,
} from "../../../packages/llm-gateway/src/auth/oauth-registry";
import { getStrategy } from "../../../packages/llm-gateway/src/auth/registry";
import {
  buildGateway,
  resolveProviderCredentials,
} from "../../../packages/orchestrator/src/provider-registry";
import { runLogin, runLogout } from "../../../packages/orchestrator/src/bin/login-cli";
import { oauthAccount, type CredentialStore } from "../../../packages/shared/src/credential-store";
import { PROVIDER_PRESETS } from "../../../packages/shared/src/providers";

const noEnv = {} as NodeJS.ProcessEnv;

/** A stored Claude subscription session, as an older Rune wrote it. */
const LEGACY_BLOB = JSON.stringify({
  secret: "sk-ant-oat01-legacy",
  refreshToken: "sk-ant-ort01-legacy",
  expiresAt: Date.now() + 3_600_000,
  method: "oauth",
});

/** An in-memory store that records every delete. */
function fakeStore(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  const deleted: string[] = [];
  const store: CredentialStore = {
    backend: "file",
    secure: true,
    async get(a) {
      return m.get(a) ?? null;
    },
    async set(a, s) {
      m.set(a, s);
    },
    async delete(a) {
      deleted.push(a);
      m.delete(a);
    },
    async list() {
      return [...m.keys()];
    },
  };
  return { store, deleted, has: (a: string) => m.has(a) };
}

/** Run `fn` with stdout captured; returns what it printed. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const real = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = real;
  }
  return out;
}

afterEach(() => {
  process.exitCode = 0;
});

describe("a stored Claude subscription token is ignored", () => {
  test("no OAuth strategy exists for anthropic", () => {
    expect(makeOAuthStrategy("anthropic")).toBeUndefined();
    expect(getStrategy("oauth", "anthropic")).toBeUndefined();
    expect(getStrategy("device", "anthropic")).toBeUndefined();
  });

  test("credential resolution skips it — even with an `oauth` override in config", async () => {
    const { store } = fakeStore({ [oauthAccount("anthropic")]: LEGACY_BLOB });
    const onlyAnthropic = new Set(
      PROVIDER_PRESETS.map((p) => p.id).filter((id) => id !== "anthropic"),
    );
    for (const authOverrides of [undefined, { anthropic: "oauth" as const }]) {
      const creds = await resolveProviderCredentials({
        store,
        keys: {},
        active: "anthropic",
        disabled: onlyAnthropic,
        authOverrides,
        env: noEnv,
      });
      expect(creds.anthropic).toBeUndefined();
      // …so with no API key anywhere, Anthropic is simply not registered.
      const gw = buildGateway({ provider: "anthropic", keys: {}, credentials: creds, env: noEnv });
      expect(gw.getRegisteredProviderNames()).not.toContain("anthropic");
    }
  });
});

describe("the notice", () => {
  test("is owed once to someone with a stored token, and says why and what to use", async () => {
    const { store, deleted, has } = fakeStore({ [oauthAccount("anthropic")]: LEGACY_BLOB });
    const seen = new Set<string>();
    const first = await retiredOAuthNotices(store, seen);
    expect(first).toEqual([RETIRED_OAUTH_NOTICES.anthropic]);
    const [line] = first;
    expect(line).toContain("retired");
    expect(line).toContain("Anthropic's terms");
    expect(line).toContain("API key");
    expect(line).toContain("Bedrock");
    expect(line).toContain("Vertex");
    expect(line).toContain("rune logout anthropic");
    // Once per process.
    expect(await retiredOAuthNotices(store, seen)).toEqual([]);
    // Never deleted automatically.
    expect(deleted).toEqual([]);
    expect(has(oauthAccount("anthropic"))).toBe(true);
  });

  test("is not owed to anyone without a stored token", async () => {
    const { store } = fakeStore({ "provider:anthropic": "sk-ant-api-key" });
    expect(await retiredOAuthNotices(store, new Set())).toEqual([]);
  });

  test("a store that cannot answer owes no notice and throws nothing", async () => {
    const broken = {
      async get(): Promise<string | null> {
        throw new Error("keychain locked");
      },
    };
    expect(await retiredOAuthNotices(broken, new Set())).toEqual([]);
  });
});

describe("the CLI", () => {
  test("`rune logout anthropic` removes the stored token", async () => {
    const { store, has } = fakeStore({ [oauthAccount("anthropic")]: LEGACY_BLOB });
    const out = await captureStdout(() => runLogout(["anthropic"], { store }));
    expect(has(oauthAccount("anthropic"))).toBe(false);
    expect(out).toContain("Logged out");
  });

  test("`rune login anthropic --method oauth` is refused with the reason", async () => {
    // No stored token, so the refusal is the only thing that can say it.
    const { store } = fakeStore();
    const out = await captureStdout(() => runLogin(["anthropic"], { method: "oauth" }, { store }));
    expect(process.exitCode).toBe(1);
    expect(out).toContain("Claude subscription sign-in is retired");
    expect(out).not.toContain("doesn't support");
  });

  test("with a stored token too, the reason is said once, and the token is left alone", async () => {
    const { store, deleted } = fakeStore({ [oauthAccount("anthropic")]: LEGACY_BLOB });
    const out = await captureStdout(() => runLogin(["anthropic"], { method: "oauth" }, { store }));
    expect(process.exitCode).toBe(1);
    // Not once as a refusal and again as a stored-token notice.
    expect(out.split("is retired").length - 1).toBe(1);
    expect(deleted).toEqual([]);
  });
});
