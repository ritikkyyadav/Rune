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

/**
 * One stored API key for a provider, with the metadata the `/keys` panel shows:
 * a stable id (to select/remove it), an optional human label (e.g. "work
 * account"), and when it was added. `addedAt` is an ISO-8601 timestamp; it is
 * absent for keys that predate multi-key storage (we don't fabricate a date for
 * a key we didn't watch get added — the panel shows "—" for those).
 */
export interface StoredKey {
  /** Stable id for this entry, e.g. "k_lz4f8a2c". */
  id: string;
  /** The secret. */
  key: string;
  /** Optional user label to tell accounts apart. */
  label?: string;
  /** ISO-8601 time the key was added; absent for pre-multi-key entries. */
  addedAt?: string;
}

export interface SecretsFile {
  /**
   * providerId → the ACTIVE apiKey for the named presets. This is the mirror the
   * gateway reads: it always equals the active entry in `keyEntries[id]` when a
   * provider has a multi-key pool. Single-key providers (and the non-provider
   * search keys, ids "tavily"/"brave") live here alone with no `keyEntries`.
   */
  keys: Record<string, string>;
  /**
   * providerId → every key stored for that provider, in the order they were
   * added. Present only for providers the user manages as a pool (added a second
   * key, or opened the per-provider manager). Absent ⇒ the single `keys[id]` (if
   * any) is the only key. This is where dates/labels/counts come from.
   */
  keyEntries?: Record<string, StoredKey[]>;
  /**
   * providerId → the id of the active `StoredKey`. Absent ⇒ the first entry is
   * active. Kept in sync with the `keys` mirror on every mutation.
   */
  activeKeyId?: Record<string, string>;
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
  const override =
    process.env.GEAR_SECRETS_PATH ?? process.env.ELIO_SECRETS_PATH ?? process.env.ALAN_SECRETS_PATH;
  if (override) return override;
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
    const keyEntries = parseKeyEntries(raw?.keyEntries);
    const activeKeyId: Record<string, string> = {};
    if (raw?.activeKeyId && typeof raw.activeKeyId === "object") {
      for (const [k, v] of Object.entries(raw.activeKeyId as Record<string, unknown>)) {
        if (typeof v === "string" && v) activeKeyId[k] = v;
      }
    }
    const file: SecretsFile = {
      keys,
      ...(Object.keys(keyEntries).length ? { keyEntries } : {}),
      ...(Object.keys(activeKeyId).length ? { activeKeyId } : {}),
      ...(custom ? { custom } : {}),
      ...(disabled && disabled.length ? { disabled } : {}),
      ...(Object.keys(endpoints).length ? { endpoints } : {}),
    };
    // Repair the mirror in-memory so every consumer sees keys[id] === active
    // entry, even if the file was hand-edited. Never writes back here.
    normalizeMirror(file);
    return file;
  } catch {
    return { keys: {} };
  }
}

/** Parse the persisted `keyEntries` map leniently — drop anything malformed. */
function parseKeyEntries(raw: unknown): Record<string, StoredKey[]> {
  const out: Record<string, StoredKey[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const entries: StoredKey[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      if (typeof e.key !== "string" || !e.key) continue;
      entries.push({
        id: typeof e.id === "string" && e.id ? e.id : genKeyId(),
        key: e.key,
        ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
        ...(typeof e.addedAt === "string" && e.addedAt ? { addedAt: e.addedAt } : {}),
      });
    }
    if (entries.length) out[id] = entries;
  }
  return out;
}

/** Persist the secrets file with locked-down permissions (0600). */
export function saveSecrets(s: SecretsFile): void {
  const path = getSecretsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Guarantee the on-disk mirror is coherent (keys[id] === active entry) and
  // drop empty pools so the file stays tidy.
  normalizeMirror(s);

  const body =
    JSON.stringify(
      {
        keys: s.keys ?? {},
        ...(s.keyEntries && Object.keys(s.keyEntries).length ? { keyEntries: s.keyEntries } : {}),
        ...(s.activeKeyId && Object.keys(s.activeKeyId).length
          ? { activeKeyId: s.activeKeyId }
          : {}),
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

// ─── Multi-key store ───
// A provider can hold a POOL of keys (e.g. 10 Ollama Cloud keys from different
// accounts). The pool lives in `keyEntries[id]`; one entry is active, mirrored
// into `keys[id]` so the whole gateway/resolution path (which reads the single
// `keys[id]`) is unchanged. These helpers keep the mirror honest and expose the
// pool with dates for the panel.

/** A short, collision-resistant id for a stored key ("k_" + time/rand base36). */
export function genKeyId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `k_${t}${r}`;
}

/**
 * The DETERMINISTIC entry id for a provider's migrated single key. Both the
 * read-only view (`providerKeyEntries`) and the in-place promotion
 * (`materializePool`) use it, so a legacy key shows the same id before and after
 * it's first mutated — the panel can select/remove it without an id mismatch.
 */
function legacyEntryId(providerId: string): string {
  return `legacy_${providerId}`;
}

/** The active entry of a pool: the one `activeKeyId` names, else the first. */
function activeEntry(entries: StoredKey[], activeId?: string): StoredKey | undefined {
  if (!entries.length) return undefined;
  if (activeId) {
    const found = entries.find((e) => e.id === activeId);
    if (found) return found;
  }
  return entries[0];
}

/**
 * Re-derive the `keys[id]` mirror from each pool's active entry, and prune empty
 * pools / stale active-ids. Providers WITHOUT a pool (`keyEntries[id]` absent)
 * are left untouched — that's how single legacy keys and the search-backend keys
 * (tavily/brave) keep working without being dragged into the pool model.
 */
function normalizeMirror(s: SecretsFile): void {
  if (!s.keys) s.keys = {};
  if (!s.keyEntries) return;
  for (const id of Object.keys(s.keyEntries)) {
    const entries = s.keyEntries[id]!;
    if (!entries.length) {
      // Empty pool — collapse it back to "no key for this provider".
      delete s.keyEntries[id];
      delete s.keys[id];
      if (s.activeKeyId) delete s.activeKeyId[id];
      continue;
    }
    const active = activeEntry(entries, s.activeKeyId?.[id]);
    if (active) {
      s.keys[id] = active.key;
      // Persist the resolved active id so first-entry-wins is explicit and stable.
      s.activeKeyId = { ...(s.activeKeyId ?? {}), [id]: active.id };
    }
  }
  if (s.keyEntries && Object.keys(s.keyEntries).length === 0) delete s.keyEntries;
  if (s.activeKeyId && Object.keys(s.activeKeyId).length === 0) delete s.activeKeyId;
}

/**
 * The pool for a provider as the panel should show it: the stored entries if the
 * provider has a pool, otherwise a single synthesized entry from the legacy
 * `keys[id]` (with no date — we don't know when it was added), otherwise empty.
 * Read-only; does not mutate the store.
 */
export function providerKeyEntries(s: SecretsFile, id: string): StoredKey[] {
  const pool = s.keyEntries?.[id];
  if (pool && pool.length) return pool;
  const single = s.keys?.[id];
  if (single) return [{ id: legacyEntryId(id), key: single }];
  return [];
}

/**
 * Materialize a provider's pool in place: if it only had a legacy single key,
 * turn that into the first entry so subsequent adds append rather than clobber.
 * Returns the (now guaranteed) entries array held inside `s`.
 */
function materializePool(s: SecretsFile, id: string): StoredKey[] {
  if (!s.keyEntries) s.keyEntries = {};
  if (!s.keyEntries[id] || !s.keyEntries[id]!.length) {
    const single = s.keys?.[id];
    s.keyEntries[id] = single ? [{ id: legacyEntryId(id), key: single }] : [];
  }
  return s.keyEntries[id]!;
}

function clearDisabled(s: SecretsFile, id: string): void {
  if (s.disabled) {
    s.disabled = s.disabled.filter((d) => d !== id);
    if (s.disabled.length === 0) delete s.disabled;
  }
}

// ─── Mutators (load → modify → save) ───

/**
 * Set a named provider's key, REPLACING any existing key(s) with this single one
 * and clearing its disabled flag. This is the "this is now the key" primitive —
 * `addProviderKey` is the one that grows a multi-account pool. Records the add
 * time so the panel can show it.
 */
export function setProviderKey(id: string, key: string): SecretsFile {
  const s = loadSecrets();
  const trimmed = key.trim();
  const entry: StoredKey = { id: genKeyId(), key: trimmed, addedAt: new Date().toISOString() };
  if (!s.keyEntries) s.keyEntries = {};
  s.keyEntries[id] = [entry];
  s.keys[id] = trimmed;
  s.activeKeyId = { ...(s.activeKeyId ?? {}), [id]: entry.id };
  clearDisabled(s, id);
  saveSecrets(s);
  return s;
}

/**
 * Add ANOTHER key to a provider's pool (e.g. a second Ollama Cloud account) and
 * make it the active one, keeping the existing keys. Clears the disabled flag.
 * Use this — not `setProviderKey` — when the user is collecting keys from several
 * accounts. Returns the updated store and the new entry.
 */
export function addProviderKey(
  id: string,
  key: string,
  label?: string,
): { file: SecretsFile; entry: StoredKey } {
  const s = loadSecrets();
  const pool = materializePool(s, id);
  const entry: StoredKey = {
    id: genKeyId(),
    key: key.trim(),
    ...(label && label.trim() ? { label: label.trim() } : {}),
    addedAt: new Date().toISOString(),
  };
  pool.push(entry);
  s.activeKeyId = { ...(s.activeKeyId ?? {}), [id]: entry.id };
  s.keys[id] = entry.key;
  clearDisabled(s, id);
  saveSecrets(s);
  return { file: s, entry };
}

/**
 * Remove one key from a provider's pool by entry id. If it was the active key,
 * the first remaining key becomes active; if it was the last key, the provider
 * goes back to having no key at all. No-op if the entry isn't found.
 */
export function removeProviderKey(id: string, entryId: string): SecretsFile {
  const s = loadSecrets();
  const pool = materializePool(s, id);
  const next = pool.filter((e) => e.id !== entryId);
  if (next.length === pool.length) return s; // nothing matched
  if (next.length === 0) {
    delete s.keyEntries![id];
    delete s.keys[id];
    if (s.activeKeyId) delete s.activeKeyId[id];
  } else {
    s.keyEntries![id] = next;
    if (s.activeKeyId?.[id] === entryId || !s.activeKeyId?.[id]) {
      s.activeKeyId = { ...(s.activeKeyId ?? {}), [id]: next[0]!.id };
    }
    s.keys[id] = activeEntry(next, s.activeKeyId?.[id])!.key;
  }
  saveSecrets(s);
  return s;
}

/** Choose which key in a provider's pool is active (the one the gateway uses). */
export function setActiveProviderKey(id: string, entryId: string): SecretsFile {
  const s = loadSecrets();
  const pool = materializePool(s, id);
  const found = pool.find((e) => e.id === entryId);
  if (!found) return s;
  s.activeKeyId = { ...(s.activeKeyId ?? {}), [id]: entryId };
  s.keys[id] = found.key;
  clearDisabled(s, id);
  saveSecrets(s);
  return s;
}

/** Remove ALL of a named provider's keys (the whole pool). */
export function clearProviderKey(id: string): SecretsFile {
  const s = loadSecrets();
  delete s.keys[id];
  if (s.keyEntries) delete s.keyEntries[id];
  if (s.activeKeyId) delete s.activeKeyId[id];
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
