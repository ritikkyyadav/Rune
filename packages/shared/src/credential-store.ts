// ─── Credential store ───
// A secure, OS-native place to keep provider secrets — API keys AND OAuth tokens
// — behind one small port. This is the "never store credentials in plaintext when
// a secure store is available" half of BYOP.
//
// Backend selection (best available wins, degrades gracefully):
//   1. macOS  → `security`   (Keychain)                    secure
//   2. Linux  → `secret-tool` (libsecret / Secret Service)  secure
//   3. Windows→ PowerShell    (DPAPI, per-user)             secure
//   4. anywhere→ FileCredentialStore (~/.alan/credentials.json, 0600)  INSECURE
//
// The secure backends shell out to first-party OS tools rather than a native
// N-API module: that keeps `bun build --compile` single-file releases working on
// every platform (a native keychain module is not guaranteed to bundle) and adds
// zero dependencies. When no secure backend is reachable we fall to the 0600 file
// store with `secure=false`, and every caller is expected to surface the notice.
//
// Everything is testable: the shell-out backends take an injectable command
// runner, and backend selection honors BERNE_CREDENTIAL_BACKEND so tests never
// touch the real keychain.

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { loadSecrets } from "./secrets.js";
import { PROVIDER_PRESETS } from "./providers.js";

export type CredentialBackend = "keychain" | "secret-service" | "wincred" | "file";

export interface CredentialStore {
  /** Which backend this store resolved to. */
  readonly backend: CredentialBackend;
  /** false ⇒ the plaintext file fallback is in use; callers must warn the user. */
  readonly secure: boolean;
  /** Read a secret by account, or null if absent. Never throws. */
  get(account: string): Promise<string | null>;
  /** Write (or overwrite) a secret. Throws only if a secure backend hard-fails. */
  set(account: string, secret: string): Promise<void>;
  /** Delete a secret. Never throws. */
  delete(account: string): Promise<void>;
  /** List the accounts this store knows about. Never throws. */
  list(): Promise<string[]>;
}

/** Default keychain service namespace; every account is scoped under it. */
export const CREDENTIAL_SERVICE = "berne";

// ─── Injectable command runner (so shell-out backends are unit-testable) ───

export interface CredentialCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CredentialCommandRunner = (
  cmd: string,
  args: string[],
  opts?: { stdin?: string },
) => Promise<CredentialCommandResult>;

/** Spawn a child process with args passed as an array (no shell → no injection). */
const defaultRunner: CredentialCommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      // ENOENT etc. — tool not installed. 127 == "command not found".
      resolve({ code: 127, stdout: "", stderr: String(err) });
      return;
    }
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => resolve({ code: 127, stdout, stderr: stderr || String(err) }));
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    try {
      if (opts?.stdin != null) proc.stdin?.write(opts.stdin);
      proc.stdin?.end();
    } catch {
      // stdin may already be closed if the process errored — ignored.
    }
  });

// ─── File paths (env-overridable for tests) ───

function alanDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".alan");
}

function credentialsFilePath(env: NodeJS.ProcessEnv): string {
  return env.BERNE_CREDENTIALS_PATH ?? join(alanDir(env), "credentials.json");
}

/**
 * A non-secret list of account names held in a secure backend, so `list()` works
 * uniformly without dumping the keychain (which would prompt / be slow). Leaks
 * account names only (e.g. "provider:openrouter:oauth"), never secrets.
 */
function indexFilePath(env: NodeJS.ProcessEnv): string {
  return env.BERNE_CREDENTIAL_INDEX_PATH ?? join(alanDir(env), "credentials.index.json");
}

function readJsonMap(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function readIndex(env: NodeJS.ProcessEnv): Set<string> {
  const path = indexFilePath(env);
  try {
    if (!existsSync(path)) return new Set();
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const accounts = (raw as { accounts?: unknown })?.accounts;
    if (Array.isArray(accounts))
      return new Set(accounts.filter((a): a is string => typeof a === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function writeIndex(env: NodeJS.ProcessEnv, accounts: Set<string>): void {
  try {
    writeJson(indexFilePath(env), { accounts: [...accounts].sort() });
  } catch {
    // The index is a convenience for list(); a write failure is non-fatal.
  }
}

// ─── File backend (last resort, plaintext 0600) ───

export class FileCredentialStore implements CredentialStore {
  readonly backend: CredentialBackend = "file";
  readonly secure = false;
  private readonly path: string;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.path = credentialsFilePath(env);
  }

  async get(account: string): Promise<string | null> {
    return readJsonMap(this.path)[account] ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    const map = readJsonMap(this.path);
    map[account] = secret;
    writeJson(this.path, map);
  }

  async delete(account: string): Promise<void> {
    const map = readJsonMap(this.path);
    if (account in map) {
      delete map[account];
      writeJson(this.path, map);
    }
  }

  async list(): Promise<string[]> {
    return Object.keys(readJsonMap(this.path)).sort();
  }
}

// ─── macOS Keychain (`security`) ───

class KeychainStore implements CredentialStore {
  readonly backend: CredentialBackend = "keychain";
  readonly secure = true;

  constructor(
    private readonly service: string,
    private readonly run: CredentialCommandRunner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async get(account: string): Promise<string | null> {
    // Fast path: the index is our manifest of stored accounts. If it's not
    // listed, skip the (subprocess) keychain lookup — this keeps startup free of
    // `security` calls in the common "nothing stored yet" case (fresh users).
    if (!readIndex(this.env).has(account)) return null;
    const r = await this.run("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
    ]);
    if (r.code !== 0) return null;
    // `-w` prints just the password; strip the trailing newline `security` adds.
    return r.stdout.replace(/\n$/, "");
  }

  async set(account: string, secret: string): Promise<void> {
    // `-U` updates in place if the item exists; `-w <value>` sets the password.
    // The value is passed as an argv element (no shell), so it is never subject
    // to shell interpolation.
    const r = await this.run("security", [
      "add-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-U",
      "-w",
      secret,
    ]);
    if (r.code !== 0) {
      throw new Error(`keychain write failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    const idx = readIndex(this.env);
    idx.add(account);
    writeIndex(this.env, idx);
  }

  async delete(account: string): Promise<void> {
    await this.run("security", ["delete-generic-password", "-a", account, "-s", this.service]);
    const idx = readIndex(this.env);
    if (idx.delete(account)) writeIndex(this.env, idx);
  }

  async list(): Promise<string[]> {
    return [...readIndex(this.env)].sort();
  }
}

// ─── Linux Secret Service (`secret-tool` / libsecret) ───

class SecretServiceStore implements CredentialStore {
  readonly backend: CredentialBackend = "secret-service";
  readonly secure = true;

  constructor(
    private readonly service: string,
    private readonly run: CredentialCommandRunner,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async get(account: string): Promise<string | null> {
    // Fast path via the index — skip the subprocess when nothing is stored.
    if (!readIndex(this.env).has(account)) return null;
    const r = await this.run("secret-tool", [
      "lookup",
      "service",
      this.service,
      "account",
      account,
    ]);
    if (r.code !== 0) return null;
    // secret-tool lookup prints the secret with no trailing newline.
    return r.stdout.length ? r.stdout.replace(/\n$/, "") : null;
  }

  async set(account: string, secret: string): Promise<void> {
    // `secret-tool store` reads the secret from stdin — never the command line.
    const r = await this.run(
      "secret-tool",
      [
        "store",
        "--label",
        `${this.service}: ${account}`,
        "service",
        this.service,
        "account",
        account,
      ],
      { stdin: secret },
    );
    if (r.code !== 0) {
      throw new Error(`secret-service write failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    const idx = readIndex(this.env);
    idx.add(account);
    writeIndex(this.env, idx);
  }

  async delete(account: string): Promise<void> {
    await this.run("secret-tool", ["clear", "service", this.service, "account", account]);
    const idx = readIndex(this.env);
    if (idx.delete(account)) writeIndex(this.env, idx);
  }

  async list(): Promise<string[]> {
    return [...readIndex(this.env)].sort();
  }
}

// ─── Windows DPAPI (PowerShell, per-user) ───

class WinCredStore implements CredentialStore {
  readonly backend: CredentialBackend = "wincred";
  readonly secure = true;
  private readonly path: string;

  constructor(
    _service: string,
    private readonly run: CredentialCommandRunner,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    // DPAPI encrypts to a per-user blob; we store the ciphertext (never plaintext)
    // in a file. Distinct from the plaintext FileCredentialStore path.
    this.path =
      env.BERNE_CREDENTIALS_PATH?.replace(/\.json$/, ".win.json") ??
      join(alanDir(env), "credentials.win.json");
  }

  private async ps(script: string, stdin?: string): Promise<CredentialCommandResult> {
    return this.run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      stdin != null ? { stdin } : undefined,
    );
  }

  async get(account: string): Promise<string | null> {
    const cipher = readJsonMap(this.path)[account];
    if (!cipher) return null;
    // Decrypt the DPAPI blob back to plaintext (user scope, current machine).
    const script =
      `$s = ConvertTo-SecureString -String '${cipher.replace(/'/g, "''")}'; ` +
      `$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ` +
      `[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)`;
    const r = await this.ps(script);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\r?\n$/, "");
  }

  async set(account: string, secret: string): Promise<void> {
    // Encrypt via DPAPI: SecureString → ConvertFrom-SecureString yields a hex blob
    // only this user on this machine can decrypt. Secret is fed on stdin.
    const script =
      `$in = [Console]::In.ReadToEnd(); ` +
      `$s = ConvertTo-SecureString -String $in -AsPlainText -Force; ` +
      `ConvertFrom-SecureString -SecureString $s`;
    const r = await this.ps(script, secret);
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Error(`DPAPI write failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    const map = readJsonMap(this.path);
    map[account] = r.stdout.trim();
    writeJson(this.path, map);
  }

  async delete(account: string): Promise<void> {
    const map = readJsonMap(this.path);
    if (account in map) {
      delete map[account];
      writeJson(this.path, map);
    }
  }

  async list(): Promise<string[]> {
    return Object.keys(readJsonMap(this.path)).sort();
  }
}

// ─── Backend selection ───

/** Is a shell-out tool present and runnable? Cheap probe, no secret access. */
async function toolAvailable(
  run: CredentialCommandRunner,
  cmd: string,
  probeArgs: string[],
): Promise<boolean> {
  const r = await run(cmd, probeArgs);
  // 127 == our runner's "spawn failed / not found" sentinel. Any other exit
  // (including a nonzero "help" code) means the binary ran, i.e. it exists.
  return r.code !== 127;
}

export interface OpenCredentialStoreOpts {
  /** Keychain service namespace (default "berne"). */
  service?: string;
  /** Injected env for path + selection overrides (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injected command runner (default: real child_process). */
  runner?: CredentialCommandRunner;
  /** Force a backend, bypassing platform detection (tests / power users). */
  forceBackend?: CredentialBackend;
}

/**
 * Open the best available credential store for this machine. Never throws —
 * on any failure it returns the plaintext FileCredentialStore with `secure=false`
 * so the caller can warn the user rather than crash. Honors
 * `BERNE_CREDENTIAL_BACKEND` (e.g. "file") for forcing a backend in tests.
 */
export async function openCredentialStore(
  opts: OpenCredentialStoreOpts = {},
): Promise<CredentialStore> {
  const env = opts.env ?? process.env;
  const run = opts.runner ?? defaultRunner;
  const service = opts.service ?? CREDENTIAL_SERVICE;
  const forced =
    opts.forceBackend ?? (env.BERNE_CREDENTIAL_BACKEND as CredentialBackend | undefined);

  if (forced === "file") return new FileCredentialStore(env);
  if (forced === "keychain") return new KeychainStore(service, run, env);
  if (forced === "secret-service") return new SecretServiceStore(service, run, env);
  if (forced === "wincred") return new WinCredStore(service, run, env);

  try {
    if (process.platform === "darwin") {
      if (await toolAvailable(run, "security", ["help"]))
        return new KeychainStore(service, run, env);
    } else if (process.platform === "linux") {
      if (await toolAvailable(run, "secret-tool", ["--version"]))
        return new SecretServiceStore(service, run, env);
    } else if (process.platform === "win32") {
      if (
        await toolAvailable(run, "powershell", [
          "-NoProfile",
          "-Command",
          "$PSVersionTable.PSVersion.Major",
        ])
      )
        return new WinCredStore(service, run, env);
    }
  } catch {
    // Fall through to the file store.
  }
  return new FileCredentialStore(env);
}

/** One-line human description of where credentials live, for status readouts. */
export function describeCredentialBackend(store: CredentialStore): string {
  switch (store.backend) {
    case "keychain":
      return "macOS Keychain";
    case "secret-service":
      return "Secret Service (libsecret)";
    case "wincred":
      return "Windows DPAPI";
    case "file":
      return "plaintext file (~/.alan/credentials.json)";
  }
}

// ─── Account naming convention ───
// Every credential is scoped to a provider id. Keeping the naming here (in the
// shared store) rather than in the gateway auth layer lets the legacy-migration
// helper below reuse it without the wrong-way dependency (gateway → shared, not
// the reverse).

/** Account name for a provider's API key / bearer secret. */
export function apiKeyAccount(providerId: string): string {
  return `provider:${providerId}`;
}

/** Account name for a provider's stored OAuth session (a JSON blob). */
export function oauthAccount(providerId: string): string {
  return `provider:${providerId}:oauth`;
}

export interface MigrationResult {
  /** Number of legacy API keys copied into the secure store. */
  migrated: number;
  /** The provider ids that were migrated. */
  providerIds: string[];
}

/**
 * Opportunistically copy API keys from the legacy `~/.alan/secrets.json` into a
 * (secure) credential store. Non-destructive by contract: it only writes
 * accounts that are not already present and NEVER deletes secrets.json, so the
 * old path keeps working and rollback stays trivial. Web-search keys
 * (tavily/brave) and the custom endpoint are intentionally skipped — the former
 * aren't providers, the latter carries a base URL + model the store can't hold.
 */
export async function migrateLegacySecrets(store: CredentialStore): Promise<MigrationResult> {
  const providerIds = new Set(PROVIDER_PRESETS.map((p) => p.id));
  const secrets = loadSecrets();
  const migrated: string[] = [];
  for (const [id, key] of Object.entries(secrets.keys)) {
    if (!providerIds.has(id) || !key) continue;
    const account = apiKeyAccount(id);
    const existing = await store.get(account);
    if (existing) continue;
    try {
      await store.set(account, key);
      migrated.push(id);
    } catch {
      // A single failed write shouldn't abort the whole migration.
    }
  }
  return { migrated: migrated.length, providerIds: migrated };
}
