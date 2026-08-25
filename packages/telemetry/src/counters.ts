// ─── Usage counters (durable accumulator) ───
// Coarse, anonymous COUNTS only — sessions started, incidents observed, and any
// feature tallies a surface chooses to bump. Never any content, path, argument,
// or identifier. They accumulate in ~/.gear/telemetry-usage.json between
// heartbeats; the daily heartbeat reads-and-resets them. Every operation fails
// safe — a counter must never be the thing that crashed the app.
//
// Read-modify-write is last-writer-wins: two concurrent Gear tabs can drop an
// increment. That is fine — these are coarse adoption stats, not billing.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type UsageCounters = Record<string, number>;

export function usageCountersPath(home: string): string {
  return join(home, "telemetry-usage.json");
}

function read(path: string): UsageCounters {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: UsageCounters = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(path: string, counters: UsageCounters): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(counters));
  renameSync(tmp, path);
}

/** Add `n` to `key`. */
export function bumpUsage(home: string, key: string, n = 1): void {
  try {
    const path = usageCountersPath(home);
    const counters = read(path);
    counters[key] = (counters[key] ?? 0) + n;
    write(path, counters);
  } catch {
    // best-effort
  }
}

/** Read the counters and reset the file to empty — called by the heartbeat. */
export function takeUsage(home: string): UsageCounters {
  try {
    const path = usageCountersPath(home);
    const counters = read(path);
    write(path, {});
    return counters;
  } catch {
    return {};
  }
}

/** Peek without resetting — for `telemetry preview` / `status`. */
export function peekUsage(home: string): UsageCounters {
  return read(usageCountersPath(home));
}
