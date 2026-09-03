// ─── The live model catalogue cache ───
//
// `gear models <provider>` asks the provider's own list endpoint what it
// serves, because a hand-maintained catalogue rots: this repo has lost runs to
// `qwen3-coder:480b` and its announced successor both 410'ing on the same day,
// and to OpenRouter withdrawing two `:free` ids to paid. Live discovery is the
// answer to rot the presets cannot give.
//
// Live discovery is also a network round trip on a command people run to *look
// at a list*, which is why it is cached for an hour. An hour is chosen against
// the failure it protects against: model catalogues change on the order of
// weeks, and a stale row costs one confusing `/model` pick that the next
// refresh fixes — while an uncached list costs a round trip every time someone
// opens the picker.
//
// The cache is a plain JSON file under the gear home, keyed by provider id. It
// holds **model ids and labels only** — no credential, no endpoint, nothing
// account-specific beyond which models that account can see. `--refresh` (or a
// deleted file) forces a fresh call.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGearHome } from "./paths.js";

/** One discovered model, as the cache stores it. */
export interface CachedModel {
  id: string;
  label?: string;
}

interface CacheFile {
  version: 1;
  providers: Record<string, { fetchedAt: number; models: CachedModel[] }>;
}

/** How long a discovered catalogue stays fresh. */
export const MODEL_CACHE_TTL_MS = 60 * 60_000;

/** The cache file path. Honors GEAR_HOME like every other sidecar. */
export function getModelCachePath(): string {
  return join(getGearHome(), "model-cache.json");
}

function readCache(path: string): CacheFile {
  try {
    if (!existsSync(path)) return { version: 1, providers: {} };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    if (parsed?.version !== 1 || typeof parsed.providers !== "object") {
      return { version: 1, providers: {} };
    }
    return parsed;
  } catch {
    // A corrupt cache is an empty cache, never a failed command.
    return { version: 1, providers: {} };
  }
}

/**
 * The cached catalogue for a provider, or null when absent or stale.
 *
 * @param now Injectable clock, so a test can age an entry without sleeping.
 */
export function loadCachedModels(
  providerId: string,
  opts: { path?: string; now?: number; ttlMs?: number } = {},
): CachedModel[] | null {
  const path = opts.path ?? getModelCachePath();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? MODEL_CACHE_TTL_MS;
  const entry = readCache(path).providers[providerId];
  if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return null;
  if (now - entry.fetchedAt > ttl) return null;
  return entry.models;
}

/**
 * Store a freshly discovered catalogue. Failures are swallowed: a read-only
 * home should cost a cache, not the command the user actually ran.
 */
export function saveCachedModels(
  providerId: string,
  models: CachedModel[],
  opts: { path?: string; now?: number } = {},
): void {
  const path = opts.path ?? getModelCachePath();
  try {
    const cache = readCache(path);
    cache.providers[providerId] = {
      fetchedAt: opts.now ?? Date.now(),
      models: models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}) })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Best effort.
  }
}

/** Forget one provider's catalogue, or all of them. */
export function clearCachedModels(providerId?: string, opts: { path?: string } = {}): void {
  const path = opts.path ?? getModelCachePath();
  try {
    if (!providerId) {
      writeFileSync(path, JSON.stringify({ version: 1, providers: {} }, null, 2), { mode: 0o600 });
      return;
    }
    const cache = readCache(path);
    delete cache.providers[providerId];
    writeFileSync(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Best effort.
  }
}

/** How old a provider's cached catalogue is, in ms, or null when absent. */
export function cachedModelsAge(
  providerId: string,
  opts: { path?: string; now?: number } = {},
): number | null {
  const entry = readCache(opts.path ?? getModelCachePath()).providers[providerId];
  if (!entry) return null;
  return (opts.now ?? Date.now()) - entry.fetchedAt;
}

/** A human "3 minutes ago" for the one line `gear models` prints. */
export function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}
