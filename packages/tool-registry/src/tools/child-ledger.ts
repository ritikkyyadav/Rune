/**
 * A durable note of the tool children this process has running.
 *
 * `rune-tools` now watches its own parent and takes its command's process
 * group down with it (`crates/rune-sandbox/src/parent_death.rs`), which closes
 * the ordinary case in about a quarter of a second. It cannot close two:
 *
 * - `rune-tools` itself SIGKILLed — no handler runs, nothing polls, and its
 *   command's process group is left with no owner at all;
 * - Windows, where there is no `getppid()` to poll and no process group to
 *   kill.
 *
 * So the pid and the group id are also written down, in the workspace, before
 * the spawn and removed after it. A restarting engine reads the file, and for
 * every entry whose OWNER is gone but whose child is still alive, kills the
 * group and then the pid. That is the "reap leftovers from the previous run
 * before starting" half of S-1: the watchdog is the fast path, this is the one
 * that holds when the watchdog's own process was the thing that died.
 *
 * Deliberately a plain file and not the session database: this module runs
 * inside the tool registry, on the hot path of every `bash` call, and must not
 * depend on a session existing — a plugin tool, a background shell and a
 * headless one-shot all spawn children and only one of them has a session.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface ToolChildRecord {
  /** The spawned process. */
  pid: number;
  /** Its process group, when it owns one. Equal to `pid` on unix. */
  pgid?: number;
  /** The process that spawned it — the engine, or whatever hosts the registry. */
  ownerPid: number;
  /** ISO stamp, for a human reading the file. */
  at: string;
  /** Which tool, for the same reason. */
  tool?: string;
}

/** Where the ledger lives, beside the worker owner records. */
export function childLedgerPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".rune", "tool-children.jsonl");
}

/**
 * Entries older than this are ignored and dropped.
 *
 * A pid is not unique forever: a machine that has been up for weeks recycles
 * them, and killing a recycled pid would kill an unrelated process. Every
 * entry is therefore checked against a live owner AND a recent stamp, and one
 * that fails either test is forgotten rather than acted on.
 */
export const CHILD_RECORD_TTL_MS = 24 * 60 * 60_000;

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Note a child before it can outlive us. Never throws: bookkeeping is not the work. */
export function recordToolChild(workspaceRoot: string, record: ToolChildRecord): void {
  try {
    const path = childLedgerPath(workspaceRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    /* a note we could not write is a note; the watchdog is the primary path */
  }
}

/** The child exited on its own; drop its line. */
export function forgetToolChild(workspaceRoot: string, pid: number): void {
  try {
    rewrite(workspaceRoot, (entries) => entries.filter((e) => e.pid !== pid));
  } catch {
    /* a stale line is reaped by the pid check, not by this */
  }
}

function parse(text: string): ToolChildRecord[] {
  const out: ToolChildRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ToolChildRecord;
      if (typeof rec?.pid === "number" && typeof rec?.ownerPid === "number") out.push(rec);
    } catch {
      /* a torn line is dropped, not fatal */
    }
  }
  return out;
}

function rewrite(
  workspaceRoot: string,
  next: (entries: ToolChildRecord[]) => ToolChildRecord[],
): void {
  const path = childLedgerPath(workspaceRoot);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no ledger, nothing to rewrite
  }
  const kept = next(parse(text));
  if (kept.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  // Atomic, so a crash mid-rewrite cannot leave the ledger half-written and
  // strand every entry in it.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  renameSync(tmp, path);
}

export interface ReapedChild extends ToolChildRecord {
  outcome: "killed" | "gone" | "kept";
  reason?: string;
}

/**
 * Kill what the previous run left behind, and forget the rest.
 *
 * Three tests before anything is signalled, in this order, because the cost of
 * a false positive is killing a stranger's process:
 *
 * 1. the OWNER must be dead — a live owner's children are its business;
 * 2. the entry must be younger than the TTL — pids are recycled;
 * 3. the child must still be alive — most are already gone.
 *
 * `self` (default `process.pid`) is never treated as a dead owner, so an
 * engine cannot reap its own in-flight calls.
 */
export function reapToolChildren(
  workspaceRoot: string,
  opts: { pidAlive?: (pid: number) => boolean; self?: number; now?: number } = {},
): ReapedChild[] {
  const alive = opts.pidAlive ?? defaultPidAlive;
  const self = opts.self ?? process.pid;
  const now = opts.now ?? Date.now();
  const report: ReapedChild[] = [];
  try {
    rewrite(workspaceRoot, (entries) => {
      const keep: ToolChildRecord[] = [];
      for (const entry of entries) {
        if (entry.ownerPid === self || alive(entry.ownerPid)) {
          keep.push(entry);
          continue;
        }
        const stamped = Date.parse(entry.at ?? "");
        if (Number.isFinite(stamped) && now - stamped > CHILD_RECORD_TTL_MS) {
          report.push({ ...entry, outcome: "kept", reason: "older than the pid-reuse window" });
          continue; // forgotten, not killed
        }
        if (!alive(entry.pid)) {
          report.push({ ...entry, outcome: "gone" });
          continue;
        }
        report.push({ ...entry, outcome: kill(entry) ? "killed" : "kept" });
      }
      return keep;
    });
  } catch {
    /* housekeeping never blocks a start */
  }
  return report;
}

/** SIGKILL the group first, then the pid. Best-effort by definition. */
function kill(entry: ToolChildRecord): boolean {
  let signalled = false;
  const group = entry.pgid;
  if (typeof group === "number" && group > 1) {
    try {
      // A negative pid addresses the whole process group — the shell, its
      // pipelines and anything it started.
      process.kill(-group, "SIGKILL");
      signalled = true;
    } catch {
      /* the group may already be empty */
    }
  }
  try {
    process.kill(entry.pid, "SIGKILL");
    signalled = true;
  } catch {
    /* already gone between the liveness check and here */
  }
  return signalled;
}
