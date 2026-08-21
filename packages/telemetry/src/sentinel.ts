// ─── Crash sentinel ───
// A marker file armed at startup and disarmed on clean exit. If it is present
// at the NEXT startup, the previous process died dirty (SIGKILL, panic, power
// loss) — the one failure mode no in-process handler can record. The consumer
// synthesizes a `crash.dirty_exit` incident, using the trail spool the
// recorder mirrors to disk as the flight data.
//
// Sentinels are PID-SCOPED files in a directory, not one shared file: with a
// single file, a second concurrent Gear instance would "consume" the first
// instance's live sentinel as a dirty exit (false positive, observed live
// 2026-07-07 with two terminal tabs), overwrite it, and then have its own
// marker deleted by the first instance's exit hook. The sweep checks pid
// liveness and only consumes markers whose owner is actually dead.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TrailEntry } from "@alan/shared";

export interface SentinelMeta {
  pid: number;
  version: string;
  sessionId: string | null;
  startedAt: string;
  spoolPath: string | null;
}

export interface DirtyExit {
  meta: SentinelMeta;
  trail: TrailEntry[];
}

export function armSentinel(path: string, meta: SentinelMeta): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(meta));
  } catch {
    // If we can't arm, we can't detect a dirty exit — degrade silently.
  }
}

export function disarmSentinel(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}

/** The sentinel file for one process inside the sentinel directory. */
export function sentinelPathFor(dir: string, pid: number): string {
  return join(dir, `sentinel-${pid}.json`);
}

/** Whether a pid belongs to a live process (EPERM still means "alive"). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * Sweep the sentinel directory (plus the legacy single-file path, if given)
 * for markers left by DEAD processes. Live instances' markers are skipped —
 * a concurrently running Gear is not a crash. Each consumed marker yields
 * one DirtyExit with whatever trail its spool preserved.
 */
export function sweepDirtyExits(
  dir: string,
  opts: { legacyPath?: string; isAlive?: (pid: number) => boolean } = {},
): DirtyExit[] {
  const alive = opts.isAlive ?? isPidAlive;
  const candidates: string[] = [];
  try {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (/^sentinel-\d+\.json$/.test(name)) candidates.push(join(dir, name));
      }
    }
  } catch {
    // unreadable dir — degrade silently
  }
  if (opts.legacyPath && existsSync(opts.legacyPath)) candidates.push(opts.legacyPath);

  const found: DirtyExit[] = [];
  for (const path of candidates) {
    try {
      const meta = JSON.parse(readFileSync(path, "utf-8")) as SentinelMeta;
      if (alive(meta.pid)) continue; // another Gear is running — leave its marker
      const dirty = consumeDirtyExit(path);
      if (dirty) found.push(dirty);
    } catch {
      // Corrupt marker: remove so it can't wedge every future startup.
      try {
        rmSync(path, { force: true });
      } catch {
        // give up
      }
    }
  }
  return found;
}

/**
 * Check for a leftover sentinel from a previous run. If found, consume it
 * (delete) and return its meta plus whatever trail the spool preserved.
 * Returns null on a clean previous exit.
 */
export function consumeDirtyExit(path: string): DirtyExit | null {
  try {
    if (!existsSync(path)) return null;
    const meta = JSON.parse(readFileSync(path, "utf-8")) as SentinelMeta;
    rmSync(path, { force: true });
    let trail: TrailEntry[] = [];
    if (meta.spoolPath && existsSync(meta.spoolPath)) {
      try {
        const spool = JSON.parse(readFileSync(meta.spoolPath, "utf-8")) as {
          trail?: TrailEntry[];
        };
        trail = spool.trail ?? [];
        rmSync(meta.spoolPath, { force: true });
      } catch {
        // spool unreadable — the dirty-exit incident still stands, trailless
      }
    }
    return { meta, trail };
  } catch {
    // A corrupt sentinel must never block startup.
    try {
      rmSync(path, { force: true });
    } catch {
      // give up
    }
    return null;
  }
}
