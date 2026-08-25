import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runUse,
  runProviders,
  runModels,
} from "../../../packages/orchestrator/src/bin/providers-cli";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { runLogin, runLogout } from "../../../packages/orchestrator/src/bin/login-cli";
import {
  loadLastModel,
  setProviderKey,
  apiKeyAccount,
  oauthAccount,
  openCredentialStore,
} from "../../../packages/shared/src/index";

let dir: string;
const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gear-pcli-"));
  process.env.GEAR_SECRETS_PATH = join(dir, "secrets.json");
  process.env.GEAR_MODEL_PATH = join(dir, "model.json");
  process.env.GEAR_CREDENTIAL_BACKEND = "file";
  process.env.GEAR_CREDENTIALS_PATH = join(dir, "credentials.json");
  process.env.GEAR_CREDENTIAL_INDEX_PATH = join(dir, "credentials.index.json");
  // Clear provider env keys so provider listing/discovery is deterministic + offline.
  for (const k of PROVIDER_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PROVIDER_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const k of [
    "GEAR_SECRETS_PATH",
    "GEAR_MODEL_PATH",
    "GEAR_CREDENTIAL_BACKEND",
    "GEAR_CREDENTIALS_PATH",
    "GEAR_CREDENTIAL_INDEX_PATH",
  ]) {
    delete process.env[k];
  }
  process.exitCode = 0;
  rmSync(dir, { recursive: true, force: true });
});

/** Run `fn`, capturing everything it writes to stdout. */
async function capture(fn: () => Promise<void> | void): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((s: string | Uint8Array) => {
    buf += typeof s === "string" ? s : Buffer.from(s).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf;
}

describe("gear use", () => {
  it("writes the active provider + default model to model.json", async () => {
    await capture(() => runUse(["openrouter"]));
    // The catalog default tracks OpenRouter's live free tier (qwen3-coder:free
    // was retired 2026-07-15).
    expect(loadLastModel()).toEqual({ provider: "openrouter", model: "minimax/minimax-m3:free" });
  });

  it("honors an explicit model argument", async () => {
    await capture(() => runUse(["anthropic", "claude-opus-4-8"]));
    expect(loadLastModel()).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("rejects an unknown provider and sets a nonzero exit code", async () => {
    const out = await capture(() => runUse(["nope"]));
    expect(out).toMatch(/Unknown provider/);
    expect(process.exitCode).toBe(1);
    expect(loadLastModel()).toBeNull();
  });

  it("prints usage when no provider is given", async () => {
    const out = await capture(() => runUse([]));
    expect(out).toMatch(/gear use <provider>/);
    expect(process.exitCode).toBe(1);
  });
});

describe("gear providers", () => {
  it("lists every provider with its auth method + credential backend", async () => {
    const out = await capture(() => runProviders());
    expect(out).toMatch(/Providers/);
    expect(out).toMatch(/OpenRouter/);
    expect(out).toMatch(/api_key/);
    expect(out).toMatch(/local/); // ollama/lmstudio
    // file backend forced → the insecure notice must be present
    expect(out).toMatch(/unencrypted/);
  });

  it("keeps every column aligned for active and inactive rows (NO_COLOR regression)", async () => {
    // Make one row active so both padEnd paths render.
    setProviderKey("groq", "gsk_saved_key_123456");
    await capture(() => runUse(["groq"]));
    const out = await capture(() => runProviders());
    const rows = out
      .split("\n")
      .map((row) => stripAnsi(row).trimStart())
      .filter((row) => /^[●○] /.test(row));
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.some((row) => row.startsWith("●"))).toBe(true);
    // marker(1) + space + name padded to 22 + space → the method column starts
    // at index 25 on EVERY row. Padding the styled string instead of the label
    // broke this whenever the active row's escapes (or their absence under
    // NO_COLOR) changed the string length.
    for (const row of rows) {
      expect(row[24]).toBe(" ");
      expect(row[25]).not.toBe(" ");
    }
  });

  it("shows a provider as signed-in once a key is stored", async () => {
    setProviderKey("groq", "gsk_saved_key_123456");
    const out = await capture(() => runProviders());
    expect(out).toMatch(/signed in/);
  });
});

describe("gear models", () => {
  it("falls back to the curated preset list when there is no live endpoint", async () => {
    // No env key + file store → provider isn't registered → static fallback, offline.
    const out = await capture(() => runModels(["anthropic"]));
    expect(out).toMatch(/curated/);
    expect(out).toMatch(/anthropic\/claude-opus-4-8/);
  });

  it("rejects an unknown provider", async () => {
    const out = await capture(() => runModels(["nope"]));
    expect(out).toMatch(/Unknown provider/);
    expect(process.exitCode).toBe(1);
  });
});

describe("gear login --migrate", () => {
  it("copies legacy secrets.json keys into the credential store", async () => {
    setProviderKey("openrouter", "sk-or-legacy-abcdef");
    const out = await capture(() => runLogin([], { migrate: true }));
    expect(out).toMatch(/Migrated 1 key/);
    const store = await openCredentialStore({ forceBackend: "file", env: process.env });
    expect(await store.get(apiKeyAccount("openrouter"))).toBe("sk-or-legacy-abcdef");
  });

  it("prints usage for `login` with no provider on a non-TTY", async () => {
    const out = await capture(() => runLogin([], {}));
    expect(out).toMatch(/gear login/);
    expect(out).toMatch(/Providers:/);
  });
});

describe("gear logout", () => {
  it("removes a stored key AND oauth session, leaving env/config to fall back", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env: process.env });
    await store.set(apiKeyAccount("openrouter"), "sk-stored");
    await store.set(oauthAccount("openrouter"), JSON.stringify({ secret: "sk-oauth" }));
    const out = await capture(() => runLogout(["openrouter"]));
    expect(out).toMatch(/Logged out/);
    expect(await store.get(apiKeyAccount("openrouter"))).toBeNull();
    expect(await store.get(oauthAccount("openrouter"))).toBeNull();
  });

  it("rejects an unknown provider", async () => {
    const out = await capture(() => runLogout(["nope"]));
    expect(out).toMatch(/Unknown provider/);
    expect(process.exitCode).toBe(1);
  });
});
