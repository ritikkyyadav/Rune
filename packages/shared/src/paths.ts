// ─── Rune data paths ───
// ONE place that knows where Rune keeps its data:
//
//   home  — `~/.rune`   (override: RUNE_HOME; the previous name's GEAR_HOME honored)
//   ws    — `<workspace>/.rune`  (legacy `<workspace>/.gear` and `.alan` still read)
//
// Migration: the product has been renamed twice (Alan → Gear → Rune).
// `migrateLegacyHome()` — called by the CLI and the engine host at startup,
// never by library import — MOVES the newest old home (`~/.gear`, else
// `~/.alan`) to `~/.rune` when `~/.rune` does not exist yet (sessions, secrets,
// model.json, theme.json, black box, notebook — everything) and leaves the old
// path behind as a symlink, so anything still pointing at it (shell aliases,
// `~/.gear/bin` on PATH, other tools) keeps working. An older `~/.alan` that is
// already a symlink into `~/.gear` keeps resolving through the chain. Inside
// the home, the session database `gear.db` (or `alan.db`) becomes `rune.db` and
// the global instructions file `GEAR.md` becomes `RUNE.md`. Nothing is copied
// twice and nothing is deleted.
//
// `getRuneHome()` itself has no side effects: it resolves to `~/.rune` when
// that exists, to the newest not-yet-migrated real legacy directory otherwise
// (so data is never split across two homes), and to `~/.rune` for a fresh
// machine.
//
// Workspace-local config (`.rune/`) is NOT auto-migrated: it lives inside the
// user's repository, so we read the legacy `.gear/` (or `.alan/`) when `.rune/`
// is absent and let the user rename it when they choose. New writes always go
// to `.rune/`.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
} from "fs";
import { isAbsolute, join, relative, resolve } from "path";

// ─── Containment ───

/**
 * Whether `target` IS `root` or lives inside it.
 *
 * The one implementation, because the hand-rolled ones were not portable:
 * `abs.startsWith(root + "/")` is never true on Windows, where `resolve`
 * produces backslashes and the drive letter's case is whatever the process that
 * built the string happened to use. The delegation-evidence gate, the plugin
 * manifest guard and the dashboard's export and watch paths all carried that
 * shape, and all three misbehaved on Windows — the gate refused every
 * sub-agent finish, the other two refused every path (P10.2).
 *
 * `relative` knows the platform's separator and folds case where the filesystem
 * does, so the answer is right on all three OSes. A relative `target` is
 * resolved against `root`, which is the only reading that makes sense for a
 * containment question.
 *
 * This is a STRING test, not a filesystem one: it does not resolve symlinks. A
 * caller that must not be fooled by a symlink out of the tree canonicalizes
 * both sides first (the Rust executor does; so does the dashboard's watch path).
 */
export function isPathInside(root: string, target: string): boolean {
  const absRoot = resolve(root);
  const abs = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
  const rel = relative(absRoot, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export const RUNE_HOME_DIRNAME = ".rune";
/**
 * Homes of the earlier names, newest first. Read when `~/.rune` does not exist
 * yet; the newest real one is moved to `~/.rune` once by `migrateLegacyHome`.
 */
export const LEGACY_HOME_DIRNAMES: readonly string[] = [".gear", ".alan"];
export const RUNE_WS_DIRNAME = ".rune";
export const LEGACY_WS_DIRNAMES: readonly string[] = [".gear", ".alan"];
export const RUNE_DB_FILENAME = "rune.db";
export const LEGACY_DB_FILENAMES: readonly string[] = ["gear.db", "alan.db"];
export const RUNE_MEMORY_FILENAME = "RUNE.md";
export const LEGACY_MEMORY_FILENAMES: readonly string[] = ["GEAR.md", "ALAN.md"];
/** The previous name's environment prefix: every `GEAR_<X>` still sets `RUNE_<X>` when unset. */
export const LEGACY_ENV_PREFIX = "GEAR_";

function osHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ?? env.USERPROFILE ?? "~";
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The files whose presence means a home holds a person's data. A `~/.rune`
 * with none of them is FRESH — created by a test's `ensureRuneHome()`, by a
 * `--version` run, by an installer's `mkdir -p` — and must not stop the old
 * home from being moved in, or the rename silently strands every session and
 * credential behind a directory that looks migrated and is empty.
 */
const HOME_DATA_MARKERS: readonly string[] = [
  "rune.db",
  "gear.db",
  "alan.db",
  "secrets.json",
  "config.toml",
  "model.json",
  "credentials.index.json",
];

function isFreshHome(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    const entries = new Set(readdirSync(dir));
    return !HOME_DATA_MARKERS.some((m) => entries.has(m));
  } catch {
    return false;
  }
}

/**
 * Move the newest real legacy home onto `modern`. When `modern` already exists
 * as a fresh directory, its entries are set aside first and folded back in
 * afterwards (a legacy entry of the same name wins — it is the one with data).
 * Returns the note to print, or null when nothing moved.
 */
function moveLegacyHomeInto(modern: string, legacy: string): string | null {
  let parked: string | null = null;
  if (existsSync(modern)) {
    parked = `${modern}.fresh-${Date.now()}`;
    try {
      renameSync(modern, parked);
    } catch {
      return null;
    }
  }
  try {
    renameSync(legacy, modern);
  } catch {
    // Could not move (permissions, cross-device): put the fresh dir back and
    // keep using the legacy dir rather than splitting data across two homes.
    if (parked) {
      try {
        renameSync(parked, modern);
      } catch {
        // Nothing sensible left to do; the next start retries from scratch.
      }
    }
    return null;
  }
  try {
    symlinkSync(modern, legacy, "dir");
  } catch {
    // The symlink is a courtesy for old paths; the move already succeeded.
  }
  if (parked) {
    for (const entry of readdirSync(parked)) {
      const target = join(modern, entry);
      if (existsSync(target)) continue;
      try {
        renameSync(join(parked, entry), target);
      } catch {
        // Left behind in the parked directory, which is kept for that reason.
      }
    }
    try {
      rmdirSync(parked);
    } catch {
      // Not empty: something collided; the parked copy stays for the user.
    }
  }
  return `moved ${legacy} → ${modern} (a symlink ${legacy} → ${modern} keeps old paths working)`;
}

/** The newest legacy home that is a real directory (a symlink is a migrated one). */
function firstRealLegacyDir(base: string, names: readonly string[]): string | null {
  for (const name of names) {
    const candidate = join(base, name);
    if (isRealDir(candidate)) return candidate;
  }
  return null;
}

let cache: { key: string; home: string } | null = null;
let migrationNote: string | null = null;

function homeOverride(env: NodeJS.ProcessEnv): string | undefined {
  return env.RUNE_HOME ?? env.GEAR_HOME;
}

function cacheKey(env: NodeJS.ProcessEnv): string {
  return [env.RUNE_HOME, env.GEAR_HOME, env.HOME, env.USERPROFILE].map((v) => v ?? "").join("\0");
}

/**
 * Resolve Rune's home directory (no side effects). Memoized per
 * (RUNE_HOME, GEAR_HOME, HOME, USERPROFILE), so a test that swaps HOME sees
 * the change and a long-running process pays the lookup once.
 */
export function getRuneHome(env: NodeJS.ProcessEnv = process.env): string {
  const key = cacheKey(env);
  if (cache && cache.key === key) return cache.home;
  const override = homeOverride(env);
  let home: string;
  if (override) {
    home = override;
  } else {
    const base = osHome(env);
    const modern = join(base, RUNE_HOME_DIRNAME);
    const legacy = firstRealLegacyDir(base, LEGACY_HOME_DIRNAMES);
    // A fresh `~/.rune` beside a real legacy home is not the home yet: the
    // migration has not run, and reading from the empty one would present a
    // person with no sessions and no keys.
    home = existsSync(modern) && !(legacy && isFreshHome(modern)) ? modern : (legacy ?? modern);
  }
  cache = { key, home };
  return home;
}

/** Rename a SQLite file together with its -wal/-shm/-journal siblings. */
function renameWithSiblings(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time data migration for the rename; call at process start (CLI, engine
 * host) before anything opens a database. Moves the newest real legacy home
 * (`~/.gear`, else `~/.alan`) to `~/.rune` (symlink left behind) when the new
 * home does not exist — or exists but holds no data yet — then renames `gear.db` / `alan.db` → `rune.db` (with
 * their -wal/-shm siblings) and `GEAR.md` / `ALAN.md` → `RUNE.md` inside the
 * home when the new name is absent. Never throws; returns a one-line human note
 * when something moved, else null. An explicit RUNE_HOME/GEAR_HOME override
 * disables the directory move (the override IS the home).
 */
export function migrateLegacyHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const notes: string[] = [];
  const override = homeOverride(env);
  let home: string;
  if (override) {
    home = override;
  } else {
    const base = osHome(env);
    const modern = join(base, RUNE_HOME_DIRNAME);
    if (!existsSync(modern) || isFreshHome(modern)) {
      const legacy = firstRealLegacyDir(base, LEGACY_HOME_DIRNAMES);
      if (legacy) {
        const moved = moveLegacyHomeInto(modern, legacy);
        if (moved) notes.push(moved);
      }
    }
    home = existsSync(modern) ? modern : (firstRealLegacyDir(base, LEGACY_HOME_DIRNAMES) ?? modern);
  }
  if (existsSync(home)) {
    const newDb = join(home, RUNE_DB_FILENAME);
    for (const legacyName of LEGACY_DB_FILENAMES) {
      const oldDb = join(home, legacyName);
      if (!existsSync(oldDb)) continue;
      if (!existsSync(newDb)) {
        if (renameWithSiblings(oldDb, newDb)) {
          notes.push(`renamed ${legacyName} → ${RUNE_DB_FILENAME} in ${home}`);
        }
        // Otherwise the old name keeps working for this run; next start retries.
        continue;
      }
      // BOTH exist, so the rename above can never fire and the legacy file is
      // stranded — permanently, and silently, which is the part that bites.
      // This is not merely pre-rename residue: a build that resolved the home
      // differently (an older installed binary, a stale GEAR_HOME) will open
      // the legacy name and write real sessions into it, and nothing ever
      // tells the user those sessions have stopped appearing in `/sessions`.
      //
      // Merging is not attempted here: two live databases can hold colliding
      // ids and diverged schemas, and quietly interleaving a user's history is
      // a worse failure than leaving it in place. Say so instead, so the data
      // is recoverable by someone who knows what it is.
      notes.push(
        `${legacyName} still exists alongside ${RUNE_DB_FILENAME} in ${home} — ` +
          `its sessions are NOT visible to this build; nothing was deleted`,
      );
    }
    // The user's global instructions follow the same rule: one rename, never a
    // merge. A RUNE.md that already exists wins and the old file is left alone.
    const newMemory = join(home, RUNE_MEMORY_FILENAME);
    for (const legacyName of LEGACY_MEMORY_FILENAMES) {
      const oldMemory = join(home, legacyName);
      if (!existsSync(oldMemory) || existsSync(newMemory)) continue;
      try {
        renameSync(oldMemory, newMemory);
        notes.push(`renamed ${legacyName} → ${RUNE_MEMORY_FILENAME} in ${home}`);
      } catch {
        // Next start retries; the loader still reads the old name meanwhile.
      }
    }
  }
  cache = null;
  if (notes.length === 0) return null;
  migrationNote = notes.join("; ");
  return migrationNote;
}

/** The one-line migration notice for the CLI to print once, or null. */
export function takeHomeMigrationNote(): string | null {
  const n = migrationNote;
  migrationNote = null;
  return n;
}

/** Test seam: forget the memoized home (after changing HOME / RUNE_HOME). */
export function resetRuneHomeCache(): void {
  cache = null;
  migrationNote = null;
}

/** `<home>/<parts…>`, creating nothing. */
export function runeHomePath(...parts: string[]): string {
  return join(getRuneHome(), ...parts);
}

/** Ensure Rune's home exists and return it. */
export function ensureRuneHome(): string {
  const dir = getRuneHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** The newest legacy workspace directory that exists, or null. */
function existingLegacyWorkspaceDir(workspaceRoot: string): string | null {
  for (const name of LEGACY_WS_DIRNAMES) {
    const candidate = join(workspaceRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The workspace-local Rune directory: `<root>/.rune` when it exists, else the
 * newest legacy `<root>/.gear` or `<root>/.alan` that exists (read-through for
 * repos configured before a rename), else `<root>/.rune` (where new files will
 * be written).
 */
export function workspaceConfigDir(workspaceRoot: string): string {
  const modern = join(workspaceRoot, RUNE_WS_DIRNAME);
  if (existsSync(modern)) return modern;
  return existingLegacyWorkspaceDir(workspaceRoot) ?? modern;
}

/** `<root>/.rune/<parts…>` (or the legacy dir when only it exists). */
export function workspaceConfigPath(workspaceRoot: string, ...parts: string[]): string {
  return join(workspaceConfigDir(workspaceRoot), ...parts);
}

/** True when the workspace still uses a legacy `.gear/` or `.alan/` directory. */
export function usesLegacyWorkspaceDir(workspaceRoot: string): boolean {
  return (
    !existsSync(join(workspaceRoot, RUNE_WS_DIRNAME)) &&
    existingLegacyWorkspaceDir(workspaceRoot) !== null
  );
}

/**
 * Legacy environment names: every `GEAR_<X>` still sets `RUNE_<X>` when the
 * latter is unset, so old shells, launchd plists and CI configs keep working.
 * Idempotent; called at process start and again (harmlessly) by config loading.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const modern = "RUNE_" + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[modern] === undefined) {
      env[modern] = value;
      adopted.push(key);
    }
  }
  return adopted;
}
