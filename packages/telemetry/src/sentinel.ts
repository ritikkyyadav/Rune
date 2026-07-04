// ─── Crash sentinel ───
// A marker file armed at startup and disarmed on clean exit. If it is present
// at the NEXT startup, the previous process died dirty (SIGKILL, panic, power
// loss) — the one failure mode no in-process handler can record. The consumer
// synthesizes a `crash.dirty_exit` incident, using the trail spool the
// recorder mirrors to disk as the flight data.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
