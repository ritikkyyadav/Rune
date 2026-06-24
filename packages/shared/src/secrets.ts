// ─── Secrets store ───
// Bring-your-own-key storage for provider API keys entered through the `/keys`
// panel. Kept OUT of the repo and apart from the human-edited config.toml: a
// dedicated JSON file at ~/.alan/secrets.json, written with mode 0600.
//
// The resolved key for a provider follows the precedence:
//     secrets.json  →  config.toml  →  env var
// so a key typed in the UI wins, but env keys still work out of the box.
//
// Loading is lenient by design (mirrors config.ts / commands.ts): a missing or
// malformed file is treated as empty and never throws.

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { CUSTOM_PROVIDER_ID } from "./providers.js";

/** A user-defined OpenAI-compatible endpoint (base URL + model + key). */
export interface CustomEndpoint {
  baseUrl: string;
  model: string;
  key: string;
  label?: string;
}

export interface SecretsFile {
  /** providerId → apiKey for the named presets. */
  keys: Record<string, string>;
  /** Single user-defined OpenAI-compatible endpoint. */
  custom?: CustomEndpoint;
  /** Provider ids the user toggled off (key kept, excluded from use). */
  disabled?: string[];
  /**
   * Base URLs for local runtimes (ollama / lmstudio), keyed by provider id.
   * Not secret, but co-located here because the `/keys` panel edits them live and
   * applies them the same way it applies keys. Overrides the config.toml/default.
   */
  endpoints?: Record<string, string>;
}

/**
 * Resolve the secrets file path. Honors `ALAN_SECRETS_PATH` (used by tests and
 * advanced setups); otherwise `~/.alan/secrets.json`. Computed per-call so the
 * env override always takes effect.
 */
export function getSecretsPath(): string {
  if (process.env.ALAN_SECRETS_PATH) return process.env.ALAN_SECRETS_PATH;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return join(home, ".alan", "secrets.json");
}

/** Load the secrets file. Missing/malformed → an empty store (never throws). */
export function loadSecrets(): SecretsFile {
  const path = getSecretsPath();
  try {
    if (!existsSync(path)) return { keys: {} };
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const keysRaw = raw?.keys;
    const keys: Record<string, string> = {};
    if (keysRaw && typeof keysRaw === "object") {
      for (const [k, v] of Object.entries(keysRaw as Record<string, unknown>)) {
        if (typeof v === "string" && v) keys[k] = v;
      }
    }
    const custom = isCustomEndpoint(raw?.custom) ? (raw.custom as CustomEndpoint) : undefined;
    const disabled = Array.isArray(raw?.disabled)
      ? (raw.disabled as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;
    const endpoints: Record<string, string> = {};
    if (raw?.endpoints && typeof raw.endpoints === "object") {
      for (const [k, v] of Object.entries(raw.endpoints as Record<string, unknown>)) {
        if (typeof v === "string" && v) endpoints[k] = v;
      }
    }
    return {
      keys,
      ...(custom ? { custom } : {}),
      ...(disabled && disabled.length ? { disabled } : {}),
      ...(Object.keys(endpoints).length ? { endpoints } : {}),
    };
  } catch {
    return { keys: {} };
  }
}

/** Persist the secrets file with locked-down permissions (0600). */
export function saveSecrets(s: SecretsFile): void {
  const path = getSecretsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const body =
    JSON.stringify(
      {
        keys: s.keys ?? {},
        ...(s.custom ? { custom: s.custom } : {}),
        ...(s.disabled && s.disabled.length ? { disabled: s.disabled } : {}),
        ...(s.endpoints && Object.keys(s.endpoints).length ? { endpoints: s.endpoints } : {}),
      },
      null,
      2,
    ) + "\n";

  writeFileSync(path, body, { mode: 0o600 });
  // writeFileSync's mode only applies on create; force 0600 on existing files too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort — non-POSIX filesystems may not support chmod.
  }
}

// ─── Mutators (load → modify → save) ───

/** Save (or overwrite) a named provider's key and clear its disabled flag. */
export function setProviderKey(id: string, key: string): SecretsFile {
  const s = loadSecrets();
  s.keys[id] = key.trim();
  if (s.disabled) {
    s.disabled = s.disabled.filter((d) => d !== id);
    if (s.disabled.length === 0) delete s.disabled;
  }
  saveSecrets(s);
  return s;
}

/** Remove a named provider's key. */
export function clearProviderKey(id: string): SecretsFile {
  const s = loadSecrets();
  delete s.keys[id];
  saveSecrets(s);
  return s;
}

/** Set the single custom OpenAI-compatible endpoint. */
export function setCustomEndpoint(ep: CustomEndpoint): SecretsFile {
  const s = loadSecrets();
  s.custom = { ...ep, key: ep.key.trim(), baseUrl: ep.baseUrl.trim() };
  if (s.disabled) {
    s.disabled = s.disabled.filter((d) => d !== CUSTOM_PROVIDER_ID);
    if (s.disabled.length === 0) delete s.disabled;
  }
  saveSecrets(s);
  return s;
}

/** Remove the custom endpoint. */
export function clearCustomEndpoint(): SecretsFile {
  const s = loadSecrets();
  delete s.custom;
  saveSecrets(s);
  return s;
}

/** Set (or, with empty/undefined, reset) the base URL for a local runtime. */
export function setLocalEndpoint(id: string, baseUrl: string | undefined): SecretsFile {
  const s = loadSecrets();
  const url = baseUrl?.trim();
  if (url) {
    s.endpoints = { ...(s.endpoints ?? {}), [id]: url };
  } else if (s.endpoints) {
    delete s.endpoints[id];
    if (Object.keys(s.endpoints).length === 0) delete s.endpoints;
  }
  saveSecrets(s);
  return s;
}

/** Toggle a provider on/off without deleting its key. */
export function setProviderDisabled(id: string, disabled: boolean): SecretsFile {
  const s = loadSecrets();
  const set = new Set(s.disabled ?? []);
  if (disabled) set.add(id);
  else set.delete(id);
  if (set.size > 0) s.disabled = [...set];
  else delete s.disabled;
  saveSecrets(s);
  return s;
}

// ─── Web-search backend keys ───
// Tavily/Brave keys live in the SAME secrets file (under `keys`, ids "tavily"
// and "brave") but are NOT LLM providers, so they're invisible to the gateway
// (which only knows PROVIDER_PRESETS). The web_search backends read them from
// the environment, so a saved key is copied into process.env at startup and
// whenever it changes via the `/keys` panel.

export interface SearchKeyPreset {
  id: string;
  label: string;
  /** Primary env var the backend reads. */
  envVar: string;
  /** Optional alternate env var also honored by the backend. */
  altEnvVar?: string;
  docsUrl: string;
  keyHint: string;
}

export const SEARCH_KEY_PRESETS: SearchKeyPreset[] = [
  {
    id: "tavily",
    label: "Tavily",
    envVar: "TAVILY_API_KEY",
    docsUrl: "https://app.tavily.com/home",
    keyHint: "tvly-…",
  },
  {
    id: "brave",
    label: "Brave Search",
    envVar: "BRAVE_API_KEY",
    altEnvVar: "BRAVE_SEARCH_API_KEY",
    docsUrl: "https://brave.com/search/api/",
    keyHint: "BSA…",
  },
];

export interface SearchKeyStatusRow {
  id: string;
  label: string;
  hasKey: boolean;
  source: "saved" | "env" | "none";
  masked: string;
  docsUrl: string;
  keyHint: string;
}

/** Per-backend status for the keys panel. Reveals no raw keys. */
export function searchKeyStatus(env: NodeJS.ProcessEnv = process.env): SearchKeyStatusRow[] {
  const s = loadSecrets();
  return SEARCH_KEY_PRESETS.map((p) => {
    const saved = s.keys[p.id];
    const envKey = !saved
      ? env[p.envVar] || (p.altEnvVar ? env[p.altEnvVar] : undefined)
      : undefined;
    const source: SearchKeyStatusRow["source"] = saved ? "saved" : envKey ? "env" : "none";
    return {
      id: p.id,
      label: p.label,
      hasKey: !!(saved || envKey),
      source,
      masked: saved ? maskKey(saved) : envKey ? maskKey(envKey) : "",
      docsUrl: p.docsUrl,
      keyHint: p.keyHint,
    };
  });
}

/**
 * Copy saved search keys into the environment so the web_search backends
 * (which read env at call time) pick them up. A saved key wins over an existing
 * env var, mirroring provider-key precedence.
 */
export function applySearchKeysToEnv(env: NodeJS.ProcessEnv = process.env): void {
  const s = loadSecrets();
  for (const p of SEARCH_KEY_PRESETS) {
    const key = s.keys[p.id];
    if (key) env[p.envVar] = key;
  }
}

// ─── Helpers ───

/**
 * Mask a key for display: first 4 and last 4 characters with an ellipsis,
 * or all dots for short keys. Never reveals the secret middle.
 */
export function maskKey(key?: string): string {
  if (!key) return "";
  const k = key.trim();
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function isCustomEndpoint(v: unknown): boolean {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as CustomEndpoint).baseUrl === "string" &&
    typeof (v as CustomEndpoint).key === "string"
  );
}

/** Best-effort check that the secrets file is not world/group readable. */
export function secretsArePrivate(): boolean {
  const path = getSecretsPath();
  try {
    if (!existsSync(path)) return true;
    const mode = statSync(path).mode & 0o077;
    return mode === 0;
  } catch {
    return true;
  }
}
