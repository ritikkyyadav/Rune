import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSecrets,
  setProviderKey,
  clearProviderKey,
  setCustomEndpoint,
  clearCustomEndpoint,
  setProviderDisabled,
  maskKey,
  getSecretsPath,
  secretsArePrivate,
} from "../../../packages/shared/src/secrets";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-secrets-"));
  process.env.ALAN_SECRETS_PATH = join(dir, "secrets.json");
});

afterEach(() => {
  delete process.env.ALAN_SECRETS_PATH;
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

  it("writes the file with 0600 permissions", () => {
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
