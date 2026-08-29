// ─── Gear data paths ───
// ONE place that knows where Gear keeps its data:
//
//   home  — `~/.gear`   (override: GEAR_HOME; legacy ALAN_HOME honored)
//   ws    — `<workspace>/.gear`  (legacy `<workspace>/.alan` still read)
//
// Migration: the product was renamed (Alan → Gear). `migrateLegacyHome()` —
// called by the CLI and the desktop engine host at startup, never by library
// import — MOVES an old `~/.alan` to `~/.gear` when `~/.gear` does not exist
// yet (sessions, secrets, model.json, theme.json, black box, notebook —
// everything) and leaves `~/.alan` behind as a symlink, so anything still
// pointing at the old path (shell aliases, ~/.alan/bin on PATH, other tools)
// keeps working. Inside the home, the session database `alan.db` becomes
// `gear.db`. Nothing is copied twice and nothing is deleted.
//
// `getGearHome()` itself has no side effects: it resolves to `~/.gear` when
// that exists, to a not-yet-migrated real `~/.alan` directory otherwise (so
// data is never split across two homes), and to `~/.gear` for a fresh machine.
//
// Workspace-local config (`.gear/`) is NOT auto-migrated: it lives inside the
// user's repository, so we read the legacy `.alan/` when `.gear/` is absent and
// let the user rename it when they choose. New writes always go to `.gear/`.

import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "fs";
import { join } from "path";

export const GEAR_HOME_DIRNAME = ".gear";
export const LEGACY_HOME_DIRNAME = ".alan";
export const GEAR_WS_DIRNAME = ".gear";
export const LEGACY_WS_DIRNAME = ".alan";
export const GEAR_DB_FILENAME = "gear.db";
export const LEGACY_DB_FILENAME = "alan.db";

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

let cache: { key: string; home: string } | null = null;
let migrationNote: string | null = null;

function cacheKey(env: NodeJS.ProcessEnv): string {
  return [env.GEAR_HOME, env.ALAN_HOME, env.HOME, env.USERPROFILE].map((v) => v ?? "").join("\0");
}

/**
 * Resolve Gear's home directory (no side effects). Memoized per
 * (GEAR_HOME, ALAN_HOME, HOME, USERPROFILE), so a test that swaps HOME sees
 * the change and a long-running process pays the lookup once.
 */
export function getGearHome(env: NodeJS.ProcessEnv = process.env): string {
  const key = cacheKey(env);
  if (cache && cache.key === key) return cache.home;
  const override = env.GEAR_HOME ?? env.ALAN_HOME;
  let home: string;
  if (override) {
    home = override;
  } else {
    const base = osHome(env);
    const modern = join(base, GEAR_HOME_DIRNAME);
    const legacy = join(base, LEGACY_HOME_DIRNAME);
    home = existsSync(modern) ? modern : isRealDir(legacy) ? legacy : modern;
  }
  cache = { key, home };
  return home;
}

/**
 * One-time data migration for the rename; call at process start (CLI, desktop
 * engine host) before anything opens a database. Moves `~/.alan` → `~/.gear`
 * (symlink left behind) when the new home does not exist, then renames
 * `alan.db` → `gear.db` (with its -wal/-shm siblings) inside the home when
 * `gear.db` is absent. Never throws; returns a one-line human note when
 * something moved, else null. An explicit GEAR_HOME/ALAN_HOME override
 * disables the directory move (the override IS the home).
 */
export function migrateLegacyHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const notes: string[] = [];
  const override = env.GEAR_HOME ?? env.ALAN_HOME;
  let home: string;
  if (override) {
    home = override;
  } else {
    const base = osHome(env);
    const modern = join(base, GEAR_HOME_DIRNAME);
    const legacy = join(base, LEGACY_HOME_DIRNAME);
    if (!existsSync(modern) && isRealDir(legacy)) {
      try {
        renameSync(legacy, modern);
        try {
          symlinkSync(modern, legacy, "dir");
        } catch {
          // The symlink is a courtesy for old paths; the move already succeeded.
        }
        notes.push(
          `moved ${legacy} → ${modern} (a symlink ${legacy} → ${modern} keeps old paths working)`,
        );
      } catch {
        // Could not move (permissions, cross-device): keep using the legacy dir
        // rather than splitting data across two homes.
      }
    }
    home = existsSync(modern) ? modern : isRealDir(legacy) ? legacy : modern;
  }
  if (existsSync(home)) {
    const oldDb = join(home, LEGACY_DB_FILENAME);
    const newDb = join(home, GEAR_DB_FILENAME);
    if (existsSync(oldDb) && !existsSync(newDb)) {
      try {
        renameSync(oldDb, newDb);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          if (existsSync(oldDb + suffix)) renameSync(oldDb + suffix, newDb + suffix);
        }
        notes.push(`renamed ${LEGACY_DB_FILENAME} → ${GEAR_DB_FILENAME} in ${home}`);
      } catch {
        // The old name keeps working for this run; next start retries.
      }
    } else if (existsSync(oldDb) && existsSync(newDb)) {
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
        `${LEGACY_DB_FILENAME} still exists alongside ${GEAR_DB_FILENAME} in ${home} — ` +
          `its sessions are NOT visible to this build; nothing was deleted`,
      );
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

/** Test seam: forget the memoized home (after changing HOME / GEAR_HOME). */
export function resetGearHomeCache(): void {
  cache = null;
  migrationNote = null;
}

/** `<home>/<parts…>`, creating nothing. */
export function gearHomePath(...parts: string[]): string {
  return join(getGearHome(), ...parts);
}

/** Ensure Gear's home exists and return it. */
export function ensureGearHome(): string {
  const dir = getGearHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The workspace-local Gear directory: `<root>/.gear` when it exists, else the
 * legacy `<root>/.alan` when THAT exists (read-through for repos configured
 * before the rename), else `<root>/.gear` (where new files will be written).
 */
export function workspaceConfigDir(workspaceRoot: string): string {
  const modern = join(workspaceRoot, GEAR_WS_DIRNAME);
  if (existsSync(modern)) return modern;
  const legacy = join(workspaceRoot, LEGACY_WS_DIRNAME);
  if (existsSync(legacy)) return legacy;
  return modern;
}

/** `<root>/.gear/<parts…>` (or the legacy dir when only it exists). */
export function workspaceConfigPath(workspaceRoot: string, ...parts: string[]): string {
  return join(workspaceConfigDir(workspaceRoot), ...parts);
}

/** True when the workspace still uses the legacy `.alan/` directory. */
export function usesLegacyWorkspaceDir(workspaceRoot: string): boolean {
  return (
    !existsSync(join(workspaceRoot, GEAR_WS_DIRNAME)) &&
    existsSync(join(workspaceRoot, LEGACY_WS_DIRNAME))
  );
}

/**
 * Legacy environment names: every `ALAN_<X>` still sets `GEAR_<X>` when the
 * latter is unset, so old shells, launchd plists and CI configs keep working.
 * Idempotent; called at process start and again (harmlessly) by config loading.
 */
export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("ALAN_") || value === undefined) continue;
    const modern = "GEAR_" + key.slice("ALAN_".length);
    if (env[modern] === undefined) {
      env[modern] = value;
      adopted.push(key);
    }
  }
  return adopted;
}
