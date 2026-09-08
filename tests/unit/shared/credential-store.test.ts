import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openCredentialStore,
  FileCredentialStore,
  migrateLegacySecrets,
  apiKeyAccount,
  oauthAccount,
  describeCredentialBackend,
  type CredentialCommandRunner,
} from "../../../packages/shared/src/credential-store";
import { setProviderKey } from "../../../packages/shared/src/secrets";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rune-cred-"));
  env = {
    HOME: dir,
    RUNE_CREDENTIALS_PATH: join(dir, "credentials.json"),
    RUNE_CREDENTIAL_INDEX_PATH: join(dir, "credentials.index.json"),
  } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── A Map-backed fake of the macOS `security` CLI ───
function fakeKeychain(): { runner: CredentialCommandRunner; store: Map<string, string> } {
  const store = new Map<string, string>();
  const arg = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const runner: CredentialCommandRunner = async (cmd, args) => {
    if (cmd !== "security") return { code: 127, stdout: "", stderr: "not found" };
    const sub = args[0];
    if (sub === "help") return { code: 0, stdout: "", stderr: "" };
    const account = arg(args, "-a")!;
    if (sub === "add-generic-password") {
      store.set(account, arg(args, "-w") ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (sub === "find-generic-password") {
      if (!store.has(account)) return { code: 44, stdout: "", stderr: "not found" };
      // `security -w` prints the password with a trailing newline.
      return { code: 0, stdout: store.get(account) + "\n", stderr: "" };
    }
    if (sub === "delete-generic-password") {
      const had = store.delete(account);
      return { code: had ? 0 : 44, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  return { runner, store };
}

// ─── A stdin-based fake of Linux `secret-tool` ───
function fakeSecretTool(): { runner: CredentialCommandRunner } {
  const store = new Map<string, string>();
  const arg = (args: string[], flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const runner: CredentialCommandRunner = async (cmd, args, opts) => {
    if (cmd !== "secret-tool") return { code: 127, stdout: "", stderr: "not found" };
    if (args[0] === "--version") return { code: 0, stdout: "secret-tool 0.20", stderr: "" };
    const account = arg(args, "account")!;
    if (args[0] === "store") {
      store.set(account, opts?.stdin ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup") {
      if (!store.has(account)) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: store.get(account)!, stderr: "" };
    }
    if (args[0] === "clear") {
      store.delete(account);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  return { runner };
}

describe("FileCredentialStore", () => {
  it("round-trips set/get/delete/list at 0600", async () => {
    const store = await openCredentialStore({ forceBackend: "file", env });
    expect(store.backend).toBe("file");
    expect(store.secure).toBe(false);

    await store.set(apiKeyAccount("openrouter"), "sk-or-secret");
    expect(await store.get(apiKeyAccount("openrouter"))).toBe("sk-or-secret");

    const path = join(dir, "credentials.json");
    expect(existsSync(path)).toBe(true);
    // POSIX-only: Windows has no rwx mode bits and reports a synthetic 0666.
    // The store still writes with mode 0o600, which is simply a no-op there.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(await store.list()).toEqual([apiKeyAccount("openrouter")]);

    await store.delete(apiKeyAccount("openrouter"));
    expect(await store.get(apiKeyAccount("openrouter"))).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("returns null for a missing account without throwing", async () => {
    const store = new FileCredentialStore(env);
    expect(await store.get("provider:nope")).toBeNull();
  });
});

describe("keychain backend (macOS security, faked)", () => {
  it("is secure and round-trips through the CLI", async () => {
    const { runner } = fakeKeychain();
    const store = await openCredentialStore({ forceBackend: "keychain", runner, env });
    expect(store.backend).toBe("keychain");
    expect(store.secure).toBe(true);

    await store.set(oauthAccount("openrouter"), '{"access":"tok"}');
    // strips the trailing newline `security -w` appends
    expect(await store.get(oauthAccount("openrouter"))).toBe('{"access":"tok"}');
    // list() comes from the non-secret index file
    expect(await store.list()).toEqual([oauthAccount("openrouter")]);

    await store.delete(oauthAccount("openrouter"));
    expect(await store.get(oauthAccount("openrouter"))).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it("get() returns null when the item is absent (nonzero exit)", async () => {
    const { runner } = fakeKeychain();
    const store = await openCredentialStore({ forceBackend: "keychain", runner, env });
    expect(await store.get(apiKeyAccount("ghost"))).toBeNull();
  });

  it("get() skips the subprocess entirely when the account isn't indexed", async () => {
    let calls = 0;
    const runner: CredentialCommandRunner = async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    };
    const store = await openCredentialStore({ forceBackend: "keychain", runner, env });
    // Nothing stored → index absent → get must not spawn `security` at all.
    expect(await store.get(apiKeyAccount("unset"))).toBeNull();
    expect(calls).toBe(0);
  });

  it("reads credentials saved under the migration-era service namespace", async () => {
    const account = apiKeyAccount("openrouter");
    writeFileSync(env.RUNE_CREDENTIAL_INDEX_PATH!, JSON.stringify({ accounts: [account] }));
    const services: string[] = [];
    const runner: CredentialCommandRunner = async (_cmd, args) => {
      const service = args[args.indexOf("-s") + 1]!;
      services.push(service);
      return service === "gear"
        ? { code: 0, stdout: "legacy-secret\n", stderr: "" }
        : { code: 44, stdout: "", stderr: "not found" };
    };
    const store = await openCredentialStore({ forceBackend: "keychain", runner, env });

    expect(await store.get(account)).toBe("legacy-secret");
    expect(services[0]).toBe("rune");
    expect(services).toContain("gear");
    expect(services.indexOf("gear")).toBeLessThan(
      services.indexOf("alan") === -1 ? Infinity : services.indexOf("alan"),
    );
  });

  it("set() throws when the backend hard-fails", async () => {
    const runner: CredentialCommandRunner = async () => ({ code: 1, stdout: "", stderr: "denied" });
    const store = await openCredentialStore({ forceBackend: "keychain", runner, env });
    await expect(store.set(apiKeyAccount("x"), "k")).rejects.toThrow(/keychain write failed/);
  });
});

describe("secret-service backend (Linux secret-tool, faked)", () => {
  it("passes the secret over stdin and round-trips", async () => {
    const { runner } = fakeSecretTool();
    const store = await openCredentialStore({ forceBackend: "secret-service", runner, env });
    expect(store.backend).toBe("secret-service");
    expect(store.secure).toBe(true);

    await store.set(apiKeyAccount("groq"), "gsk_secret");
    expect(await store.get(apiKeyAccount("groq"))).toBe("gsk_secret");
    await store.delete(apiKeyAccount("groq"));
    expect(await store.get(apiKeyAccount("groq"))).toBeNull();
  });
});

describe("openCredentialStore backend selection", () => {
  it("falls back to the file store when no secure tool is available", async () => {
    // A runner that reports every tool as 'not found' (127) → file fallback.
    const runner: CredentialCommandRunner = async () => ({ code: 127, stdout: "", stderr: "" });
    const store = await openCredentialStore({ runner, env });
    expect(store.backend).toBe("file");
    expect(store.secure).toBe(false);
  });

  it("honors RUNE_CREDENTIAL_BACKEND=file", async () => {
    const store = await openCredentialStore({
      env: { ...env, RUNE_CREDENTIAL_BACKEND: "file" } as NodeJS.ProcessEnv,
    });
    expect(store.backend).toBe("file");
  });

  it("describes each backend for the status readout", async () => {
    const file = await openCredentialStore({ forceBackend: "file", env });
    expect(describeCredentialBackend(file)).toMatch(/plaintext/);
  });
});

describe("migrateLegacySecrets", () => {
  it("copies provider AND search-engine keys, skips unknown ids, and never deletes secrets.json", async () => {
    process.env.RUNE_SECRETS_PATH = join(dir, "secrets.json");
    try {
      setProviderKey("openrouter", "sk-or-legacy-123456");
      setProviderKey("groq", "gsk_legacy_123456");
      // A web-search key is a first-class connection now (`/login` → Web
      // search) and migrates into the same account shape.
      setProviderKey("tavily", "tvly-legacy-123456");
      setProviderKey("not-a-thing", "xx-unknown-123456"); // no roster knows it: skipped

      const store = await openCredentialStore({ forceBackend: "file", env });
      const result = await migrateLegacySecrets(store);

      expect(result.migrated).toBe(3);
      expect(result.providerIds.sort()).toEqual(["groq", "openrouter", "tavily"]);
      expect(await store.get(apiKeyAccount("openrouter"))).toBe("sk-or-legacy-123456");
      expect(await store.get(apiKeyAccount("tavily"))).toBe("tvly-legacy-123456");
      expect(await store.get(apiKeyAccount("not-a-thing"))).toBeNull(); // skipped
      // non-destructive: the legacy file survives
      expect(existsSync(join(dir, "secrets.json"))).toBe(true);
    } finally {
      delete process.env.RUNE_SECRETS_PATH;
    }
  });

  it("does not overwrite an account already in the store", async () => {
    process.env.RUNE_SECRETS_PATH = join(dir, "secrets.json");
    try {
      setProviderKey("openrouter", "sk-or-legacy");
      const store = await openCredentialStore({ forceBackend: "file", env });
      await store.set(apiKeyAccount("openrouter"), "sk-or-newer");
      const result = await migrateLegacySecrets(store);
      expect(result.migrated).toBe(0);
      expect(await store.get(apiKeyAccount("openrouter"))).toBe("sk-or-newer");
    } finally {
      delete process.env.RUNE_SECRETS_PATH;
    }
  });
});
