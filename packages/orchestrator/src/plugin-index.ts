// ─── The plugin index: how `gear plugin add <name>` finds a name ───
//
// Before this, a plugin could only be installed from something the user
// already knew: a path, a git URL, an npm spec. There was no way to ASK what
// exists. The index is that answer — one versioned JSON document, served raw
// from the repository, listing every plugin with the four facts a person needs
// before running someone else's bundle: what it does, where it comes from,
// which Gear it fits, and what it is allowed to do.
//
//   gear plugin search fmt          text search over the index
//   gear plugin add gear-example-tools     resolves through the index
//
// Three properties are load-bearing:
//
//  1. **Schema-validated.** A malformed index is refused with per-entry
//     reasons rather than half-loaded. The index is fetched over the network;
//     it is exactly the input that must not be trusted structurally.
//  2. **Integrity-checked.** Each entry carries the sha256 of the plugin tree
//     (`computeIntegrity`, the same digest `gear plugin add` writes). It is
//     verified against the STAGED tree before installation — after install the
//     manifest is rewritten with `name`/`source`, which changes the digest by
//     construction, so the check has exactly one honest moment to happen in.
//  3. **Offline-tolerant.** The last successfully fetched copy is cached in
//     `~/.gear/plugin-index.json` and used when the network is unreachable,
//     marked stale so the caller can say so. A source checkout also carries
//     `plugins/index.json` beside the code; that is the last resort, and the
//     one that makes the whole thing work with no network at all.
//
// `[extensions] index` (or `GEAR_PLUGIN_INDEX`) points at a different index:
// a company's internal list, or a local file during development.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gearHomePath } from "@gear/shared";

import { computeIntegrity, satisfiesGearVersion, GEAR_VERSION } from "./plugins";

/** Where the public index lives when nothing overrides it. */
export const DEFAULT_PLUGIN_INDEX_URL =
  "https://raw.githubusercontent.com/ritikkyyadav/Alan/gear/phase-0-stabilize/plugins/index.json";

/**
 * What a plugin is allowed to contribute, as a closed vocabulary.
 *
 * The four declarative kinds are what v1 plugins ship. The `tools:*` entries
 * name the OS-sandbox capability an executable tool runs under (D6 v2) — the
 * single most important thing to read before installing a stranger's bundle,
 * so it belongs in the index rather than only in the manifest you get after
 * you have already downloaded it.
 */
export const PLUGIN_CAPABILITIES = [
  "skills",
  "commands",
  "hooks",
  "mcp",
  "tools:none",
  "tools:workspace-read",
  "tools:workspace-write",
  "tools:network",
] as const;

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface PluginIndexEntry {
  name: string;
  description: string;
  /** A git URL, or a path relative to the index file (local indexes only). */
  source: string;
  version: string;
  /** Semver range of Gear the plugin supports. */
  gearVersion?: string;
  capabilities: PluginCapability[];
  /** `sha256-…` over the pristine plugin tree, as `computeIntegrity` computes it. */
  integrity?: string;
  maintainer: string;
  /** Optional homepage for the bundle. */
  homepage?: string;
}

export interface PluginIndex {
  version: 1;
  /** ISO date the list was last edited. Informational. */
  updated?: string;
  plugins: PluginIndexEntry[];
}

export type PluginIndexValidation =
  { ok: true; index: PluginIndex } | { ok: false; errors: string[] };

const NAME_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an index document. Every problem is reported, not just the first —
 * a maintainer fixing an index wants the whole list, and a user refusing one
 * wants to see why in a single message.
 */
export function validatePluginIndex(raw: unknown): PluginIndexValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["index is not a JSON object"] };
  if (raw.version !== 1) {
    errors.push(`index version must be 1 (got ${JSON.stringify(raw.version)})`);
  }
  if (raw.updated !== undefined && typeof raw.updated !== "string") {
    errors.push("index.updated must be a string when present");
  }
  if (!Array.isArray(raw.plugins)) {
    errors.push("index.plugins must be an array");
    return { ok: false, errors };
  }

  const seen = new Set<string>();
  const entries: PluginIndexEntry[] = [];
  raw.plugins.forEach((candidate, i) => {
    const at = `plugins[${i}]`;
    if (!isRecord(candidate)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const name = candidate.name;
    const label = typeof name === "string" && name ? `"${name}"` : at;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      errors.push(`${at}.name must be letters, digits, - or _`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`${label} is listed twice`);
      return;
    }
    seen.add(name);

    for (const field of ["description", "source", "version", "maintainer"] as const) {
      const value = candidate[field];
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`${label}.${field} is required and must be a non-empty string`);
      }
    }
    if (candidate.gearVersion !== undefined && typeof candidate.gearVersion !== "string") {
      errors.push(`${label}.gearVersion must be a string when present`);
    }
    if (candidate.homepage !== undefined && typeof candidate.homepage !== "string") {
      errors.push(`${label}.homepage must be a string when present`);
    }
    if (candidate.integrity !== undefined) {
      if (
        typeof candidate.integrity !== "string" ||
        !/^sha256-[0-9a-f]{64}$/.test(candidate.integrity)
      ) {
        errors.push(`${label}.integrity must look like "sha256-<64 hex>"`);
      }
    }
    const caps = candidate.capabilities;
    if (!Array.isArray(caps) || caps.length === 0) {
      errors.push(`${label}.capabilities must be a non-empty array`);
    } else {
      for (const cap of caps) {
        if (typeof cap !== "string" || !(PLUGIN_CAPABILITIES as readonly string[]).includes(cap)) {
          errors.push(
            `${label}.capabilities contains ${JSON.stringify(cap)} — allowed: ${PLUGIN_CAPABILITIES.join(", ")}`,
          );
        }
      }
    }
    entries.push(candidate as unknown as PluginIndexEntry);
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    index: {
      version: 1,
      ...(typeof raw.updated === "string" ? { updated: raw.updated } : {}),
      plugins: entries,
    },
  };
}

// ─── Search and resolution ───

/**
 * Rank matches: exact name, then name prefix, then name substring, then a hit
 * anywhere in the description or the capability list. An empty query lists
 * everything, which is what `gear plugin search` with no argument should do.
 */
export function searchPluginIndex(index: PluginIndex, query: string): PluginIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...index.plugins].sort((a, b) => a.name.localeCompare(b.name));
  const scored: Array<{ entry: PluginIndexEntry; score: number }> = [];
  for (const entry of index.plugins) {
    const name = entry.name.toLowerCase();
    let score = -1;
    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 2;
    else if (entry.description.toLowerCase().includes(q)) score = 1;
    else if (entry.capabilities.some((c) => c.toLowerCase().includes(q))) score = 0;
    if (score >= 0) scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((s) => s.entry);
}

export function resolvePluginIndexEntry(index: PluginIndex, name: string): PluginIndexEntry | null {
  return index.plugins.find((p) => p.name === name) ?? null;
}

/** Whether this build of Gear satisfies the entry's declared range. */
export function entryFitsThisGear(entry: PluginIndexEntry, version = GEAR_VERSION): boolean {
  return satisfiesGearVersion(version, entry.gearVersion);
}

/**
 * Turn an entry's `source` into something `gear plugin add` can stage.
 *
 * A relative path is meaningful only against a local index file — a remote
 * index that says `../examples/foo` is describing a directory on a machine
 * that is not yours, and guessing what it meant is how a plugin installer
 * ends up installing the wrong directory.
 */
export function entrySourceSpec(
  entry: PluginIndexEntry,
  opts: { indexDir?: string } = {},
): { spec: string } | { error: string } {
  const source = entry.source.trim();
  if (/^(https?:\/\/|git@|git\+|ssh:\/\/)/.test(source) || source.endsWith(".git")) {
    return { spec: source };
  }
  if (isAbsolute(source)) return { spec: source };
  if (!opts.indexDir) {
    return {
      error:
        `"${entry.name}" lists a relative source (${source}) but the index came from a URL — ` +
        `a relative path only means something next to a local index file`,
    };
  }
  return { spec: resolve(opts.indexDir, source) };
}

/**
 * Verify a staged plugin tree against the digest the index published.
 *
 * Called BEFORE installation rewrites the manifest: `gear plugin add` stamps
 * `name` and `source` into plugin.json and then recomputes the digest, so the
 * installed tree legitimately hashes differently from the published one.
 */
export function verifyIndexIntegrity(
  entry: PluginIndexEntry,
  treeRoot: string,
):
  { ok: true; digest: string; checked: boolean } | { ok: false; expected: string; actual: string } {
  const actual = computeIntegrity(treeRoot);
  if (!entry.integrity) return { ok: true, digest: actual, checked: false };
  if (entry.integrity === actual) return { ok: true, digest: actual, checked: true };
  return { ok: false, expected: entry.integrity, actual };
}

// ─── Loading: config → env → default URL, with a cache and a bundled copy ───

export type PluginIndexOrigin = "config" | "url" | "file" | "cache" | "bundled";

export interface PluginIndexLoad {
  index: PluginIndex | null;
  /** Where it actually came from (URL or absolute path). */
  origin: string | null;
  originKind: PluginIndexOrigin | null;
  /** Directory of the index FILE, when it was local — relative sources resolve here. */
  indexDir: string | null;
  /** True when the network copy was unreachable and something older was used. */
  stale: boolean;
  /** ISO timestamp of the cached copy, when one was used. */
  fetchedAt: string | null;
  errors: string[];
}

interface CachedIndex {
  fetchedAt: string;
  origin: string;
  index: unknown;
}

function cachePath(): string {
  return gearHomePath("plugin-index.json");
}

function readCache(): { load: CachedIndex; index: PluginIndex } | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as CachedIndex;
    const validated = validatePluginIndex(raw?.index);
    if (!validated.ok) return null;
    return { load: raw, index: validated.index };
  } catch {
    return null;
  }
}

function writeCache(origin: string, index: PluginIndex): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: CachedIndex = { fetchedAt: new Date().toISOString(), origin, index };
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  } catch {
    // A machine that cannot write the cache still gets a working search.
  }
}

/**
 * The copy that ships beside the code. Walks up from this module looking for
 * `plugins/index.json`, so a source checkout and an installed tree both find
 * it without a build step knowing about it.
 */
export function findBundledIndexPath(startDir = import.meta.dir): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "plugins", "index.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readLocalIndex(path: string): { index: PluginIndex } | { errors: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return { errors: [`could not read ${path}: ${err instanceof Error ? err.message : err}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { errors: [`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`] };
  }
  const validated = validatePluginIndex(parsed);
  return validated.ok ? { index: validated.index } : { errors: validated.errors };
}

function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

function refToPath(ref: string): string {
  if (ref.startsWith("file://")) {
    try {
      return fileURLToPath(ref);
    } catch {
      return ref.slice("file://".length);
    }
  }
  return ref;
}

export interface LoadPluginIndexOptions {
  /** `[extensions] index` / `GEAR_PLUGIN_INDEX` / a flag. */
  ref?: string;
  /** Milliseconds before a network index is considered unreachable. */
  timeoutMs?: number;
  /** Test seam: fetch implementation. */
  fetchImpl?: typeof fetch;
  /** Skip the on-disk cache (tests). */
  useCache?: boolean;
  /** Where to start looking for the bundled copy. */
  bundledFrom?: string;
}

/**
 * Resolve the index. A configured ref wins; otherwise the public URL is
 * fetched; a failure degrades to the cached copy and then to the bundled one.
 * Never throws — a missing index is a search that says so, not a crash.
 */
export async function loadPluginIndex(opts: LoadPluginIndexOptions = {}): Promise<PluginIndexLoad> {
  const errors: string[] = [];
  const useCache = opts.useCache !== false;
  const ref = opts.ref?.trim() || DEFAULT_PLUGIN_INDEX_URL;

  const bundled = (): PluginIndexLoad | null => {
    const path = findBundledIndexPath(opts.bundledFrom ?? import.meta.dir);
    if (!path) return null;
    const read = readLocalIndex(path);
    if ("errors" in read) {
      errors.push(...read.errors);
      return null;
    }
    return {
      index: read.index,
      origin: path,
      originKind: "bundled",
      indexDir: dirname(path),
      stale: true,
      fetchedAt: null,
      errors,
    };
  };

  const cached = (): PluginIndexLoad | null => {
    if (!useCache) return null;
    const hit = readCache();
    if (!hit) return null;
    return {
      index: hit.index,
      origin: hit.load.origin,
      originKind: "cache",
      indexDir: null,
      stale: true,
      fetchedAt: hit.load.fetchedAt,
      errors,
    };
  };

  if (!isUrl(ref)) {
    const path = isAbsolute(refToPath(ref))
      ? refToPath(ref)
      : resolve(process.cwd(), refToPath(ref));
    const read = readLocalIndex(path);
    if ("index" in read) {
      return {
        index: read.index,
        origin: path,
        originKind: opts.ref ? "config" : "file",
        indexDir: dirname(path),
        stale: false,
        fetchedAt: null,
        errors,
      };
    }
    errors.push(...read.errors);
    return cached() ?? bundled() ?? emptyLoad(errors);
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(ref, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const validated = validatePluginIndex(await response.json());
    if (!validated.ok) {
      errors.push(`index at ${ref} is malformed: ${validated.errors.join("; ")}`);
      return cached() ?? bundled() ?? emptyLoad(errors);
    }
    if (useCache) writeCache(ref, validated.index);
    return {
      index: validated.index,
      origin: ref,
      originKind: "url",
      indexDir: null,
      stale: false,
      fetchedAt: null,
      errors,
    };
  } catch (err) {
    errors.push(`could not fetch ${ref}: ${err instanceof Error ? err.message : String(err)}`);
    return cached() ?? bundled() ?? emptyLoad(errors);
  }
}

function emptyLoad(errors: string[]): PluginIndexLoad {
  return {
    index: null,
    origin: null,
    originKind: null,
    indexDir: null,
    stale: false,
    fetchedAt: null,
    errors,
  };
}
