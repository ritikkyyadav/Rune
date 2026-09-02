import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSecrets,
  setProviderKey,
  addProviderKey,
  removeProviderKey,
  setActiveProviderKey,
  clearProviderKey,
  providerKeyEntries,
  setCustomEndpoint,
  clearCustomEndpoint,
  setProviderDisabled,
  maskKey,
  getSecretsPath,
  secretsArePrivate,
} from "../../../packages/shared/src/secrets";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-secrets-"));
  process.env.GEAR_SECRETS_PATH = join(dir, "secrets.json");
});

afterEach(() => {
  delete process.env.GEAR_SECRETS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("secrets store", () => {
  it("returns an empty store when the file is missing", () => {
    expect(loadSecrets()).toEqual({ keys: {} });
  });

  it("round-trips a provider key", () => {
    setProviderKey("groq", "gsk_test_123456789");
    expect(loadSecrets().keys.groq).toBe("gsk_test_123456789");
  });

  // POSIX-only: Windows has no rwx mode bits — `statSync().mode` reports a
  // synthetic 0666/0444 there, and file privacy is an ACL question this code
  // does not (yet) answer. The BEHAVIOUR is POSIX-specific, not the test.
  it.skipIf(process.platform === "win32")("writes the file with 0600 permissions", () => {
    setProviderKey("anthropic", "sk-ant-abcdefgh");
    expect(existsSync(getSecretsPath())).toBe(true);
    expect(statSync(getSecretsPath()).mode & 0o777).toBe(0o600);
    expect(secretsArePrivate()).toBe(true);
  });

  it("clears a key", () => {
    setProviderKey("xai", "xai-123456789");
    clearProviderKey("xai");
    expect(loadSecrets().keys.xai).toBeUndefined();
  });

  it("stores and clears a custom endpoint", () => {
    setCustomEndpoint({ baseUrl: "https://api.example.com/v1", model: "m", key: "k-123456" });
    expect(loadSecrets().custom?.baseUrl).toBe("https://api.example.com/v1");
    clearCustomEndpoint();
    expect(loadSecrets().custom).toBeUndefined();
  });

  it("toggles a provider off and re-enables it when a key is re-set", () => {
    setProviderDisabled("deepseek", true);
    expect(loadSecrets().disabled).toContain("deepseek");
    setProviderKey("deepseek", "sk-xyz-123456");
    expect(loadSecrets().disabled ?? []).not.toContain("deepseek");
  });

  it("treats a malformed file as empty (never throws)", () => {
    writeFileSync(getSecretsPath(), "{ not json");
    expect(loadSecrets()).toEqual({ keys: {} });
  });

  it("ignores non-string key values on load", () => {
    writeFileSync(getSecretsPath(), JSON.stringify({ keys: { a: 1, b: "ok" } }));
    expect(loadSecrets().keys).toEqual({ b: "ok" });
  });
});

describe("multi-key pool", () => {
  it("adds several keys to one provider and keeps them all", () => {
    addProviderKey("ollama-turbo", "key-account-one-1111", "personal");
    addProviderKey("ollama-turbo", "key-account-two-2222", "work");
    addProviderKey("ollama-turbo", "key-account-three-33", "side");
    const entries = providerKeyEntries(loadSecrets(), "ollama-turbo");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.label)).toEqual(["personal", "work", "side"]);
  });

  it("stamps each added key with an ISO add-date", () => {
    addProviderKey("groq", "gsk_abcd1234efgh");
    const [entry] = providerKeyEntries(loadSecrets(), "groq");
    expect(entry.addedAt).toBeTruthy();
    expect(() => new Date(entry.addedAt!).toISOString()).not.toThrow();
  });

  it("mirrors the newest added key as the active one for the gateway", () => {
    addProviderKey("xai", "xai-first-000000");
    addProviderKey("xai", "xai-second-11111");
    // keys[id] is what buildGateway reads — it must equal the active entry.
    expect(loadSecrets().keys.xai).toBe("xai-second-11111");
  });

  it("switches the active key without losing the others", () => {
    const { entry: first } = addProviderKey("deepseek", "sk-first-000000");
    addProviderKey("deepseek", "sk-second-11111");
    setActiveProviderKey("deepseek", first.id);
    const s = loadSecrets();
    expect(s.keys.deepseek).toBe("sk-first-000000");
    expect(providerKeyEntries(s, "deepseek")).toHaveLength(2);
  });

  it("removes one key from the pool and re-points active to a survivor", () => {
    addProviderKey("openrouter", "sk-or-one-000000");
    const { entry: two } = addProviderKey("openrouter", "sk-or-two-111111");
    removeProviderKey("openrouter", two.id); // active one removed
    const s = loadSecrets();
    expect(providerKeyEntries(s, "openrouter")).toHaveLength(1);
    expect(s.keys.openrouter).toBe("sk-or-one-000000");
  });

  it("removing the last key clears the provider entirely", () => {
    const { entry } = addProviderKey("groq", "gsk_only_key_here");
    removeProviderKey("groq", entry.id);
    const s = loadSecrets();
    expect(s.keys.groq).toBeUndefined();
    expect(providerKeyEntries(s, "groq")).toHaveLength(0);
  });

  it("migrates a legacy single key into a one-entry pool view (no fabricated date)", () => {
    // A pre-multi-key file: just keys, no keyEntries.
    writeFileSync(getSecretsPath(), JSON.stringify({ keys: { anthropic: "sk-ant-legacy1234" } }));
    const entries = providerKeyEntries(loadSecrets(), "anthropic");
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("sk-ant-legacy1234");
    expect(entries[0].addedAt).toBeUndefined();
  });

  it("adds a second key onto a legacy single key without clobbering it", () => {
    writeFileSync(getSecretsPath(), JSON.stringify({ keys: { anthropic: "sk-ant-legacy1234" } }));
    addProviderKey("anthropic", "sk-ant-new-567890");
    const s = loadSecrets();
    expect(providerKeyEntries(s, "anthropic")).toHaveLength(2);
    expect(s.keys.anthropic).toBe("sk-ant-new-567890"); // newest is active
  });

  it("setProviderKey replaces the whole pool with one key", () => {
    addProviderKey("groq", "gsk_one_1111111");
    addProviderKey("groq", "gsk_two_2222222");
    setProviderKey("groq", "gsk_replacement");
    const s = loadSecrets();
    expect(providerKeyEntries(s, "groq")).toHaveLength(1);
    expect(s.keys.groq).toBe("gsk_replacement");
  });

  it("clearProviderKey wipes the entire pool", () => {
    addProviderKey("xai", "xai-a-0000000");
    addProviderKey("xai", "xai-b-1111111");
    clearProviderKey("xai");
    const s = loadSecrets();
    expect(s.keys.xai).toBeUndefined();
    expect(s.keyEntries?.xai).toBeUndefined();
  });

  it("repairs a hand-edited mirror so keys[id] matches the active entry", () => {
    // File claims keys.groq = "wrong" but the active pool entry is "right".
    writeFileSync(
      getSecretsPath(),
      JSON.stringify({
        keys: { groq: "wrong-stale-value" },
        keyEntries: { groq: [{ id: "k_a", key: "right-active-value" }] },
        activeKeyId: { groq: "k_a" },
      }),
    );
    expect(loadSecrets().keys.groq).toBe("right-active-value");
  });
});

describe("maskKey", () => {
  it("shows first and last 4 for long keys, hiding the middle", () => {
    expect(maskKey("sk-ant-abcd1234")).toBe("sk-a…1234");
    expect(maskKey("sk-ant-abcd1234")).not.toContain("ant-abcd");
  });

  it("dots short keys entirely", () => {
    expect(maskKey("abcd")).toBe("••••");
  });

  it("returns empty for an undefined key", () => {
    expect(maskKey(undefined)).toBe("");
  });
});
