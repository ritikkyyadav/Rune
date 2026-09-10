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
 * every entry whose OWNER is gone but whose child is still alive AND STILL THE
 * PROCESS THE ROW NAMES, kills the group and then the pid. That is the "reap
 * leftovers from the previous run before starting" half of S-1: the watchdog
 * is the fast path, this is the one that holds when the watchdog's own process
 * was the thing that died.
 *
 * The identity clause is load-bearing and was missing until V1 proved it: a
 * pid is a number the kernel hands back out, so each row also carries the
 * kernel's start time for that pid (`process-identity.ts`) and the reaper
 * re-reads it before it signals anything. A row it cannot verify is forgotten
 * rather than acted on.
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

import {
  probeProcess,
  processIdentitySupported,
  sameProcessRun,
  type ProcessProbe,
} from "./process-identity";

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
  /**
   * The kernel's start time for `pid`, from `probeProcess` — the one field
   * that makes this row a name for a PROCESS rather than for a number. A row
   * without it is never signalled; see `reapToolChildren`.
   */
  start?: string;
  /**
   * Its `comm` when the row was written. Recorded and reported, not required
   * to match: a process survives `exec` with a new command and the same start
   * time, and `/bin/sh -c "…"` does exactly that within milliseconds.
   */
  command?: string;
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

/**
 * The identity fields for a pid we have just spawned, for a caller building a
 * row by hand. `recordToolChild` calls this itself; it is exported because a
 * row without these fields is one the reaper will refuse to act on, so
 * anything that writes a row needs the same two values.
 */
export function toolChildIdentity(pid: number): Pick<ToolChildRecord, "start" | "command"> {
  const live = probeProcess(pid);
  return live.state === "identity" ? { start: live.start, command: live.command } : {};
}

/** Note a child before it can outlive us. Never throws: bookkeeping is not the work. */
export function recordToolChild(workspaceRoot: string, record: ToolChildRecord): void {
  try {
    // Probed here rather than at the call site: every spawn path has to record
    // the same identity or the reaper cannot verify the row, and the one place
    // that cannot forget is the one place that writes the line.
    const stamped: ToolChildRecord =
      record.start === undefined ? { ...record, ...toolChildIdentity(record.pid) } : record;
    const path = childLedgerPath(workspaceRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(stamped)}\n`);
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

/** How many times one reap re-judges the rows a previous pass changed. */
const REAP_PASSES = 3;

/**
 * Kill what the previous run left behind, and forget the rest.
 *
 * Four tests before anything is signalled, because the cost of a false
 * positive is SIGKILLing a stranger's process GROUP:
 *
 * 1. the OWNER must be gone — a live owner's children are its business;
 * 2. the entry must be younger than the TTL — pids are recycled;
 * 3. the child must still be alive, and a zombie is not alive: it is in the
 *    process table and nothing else, holding no port and no file;
 * 4. the live process at that pid must be the one the row was written for —
 *    same kernel start time. A row that cannot be verified is FORGOTTEN, not
 *    killed. This is the check V1 found missing: without it, "younger than 24
 *    hours" was doing the whole job of proving a number still named the same
 *    process, which is not something it can prove.
 *
 * The rows are judged in passes. A row's owner may be another row's child —
 * the bridge writes `rune-tools`, and `rune-tools` writes the command it runs
 * — so killing an owner makes the row underneath it reapable, in the same
 * reap. A SIGKILLed process also lingers as a zombie until its parent reaps
 * it, so the pids this reap has signalled are remembered and read as dead for
 * the rest of it; without that the orphan was kept and only the NEXT restart
 * killed it.
 *
 * `self` (default `process.pid`) is never treated as a dead owner, so an
 * engine cannot reap its own in-flight calls.
 */
export function reapToolChildren(
  workspaceRoot: string,
  opts: {
    pidAlive?: (pid: number) => boolean;
    /** Who is at this pid. Overridable so a test need not spawn real processes. */
    probe?: (pid: number) => ProcessProbe;
    self?: number;
    now?: number;
  } = {},
): ReapedChild[] {
  const probe = opts.probe ?? probeProcess;
  // A caller that brings its own probe is asking to be verified whatever the
  // platform. Otherwise identity is required exactly where it can be read:
  // Windows has no start time to read, and losing the reaper there would be a
  // worse trade than the pid-reuse risk it carries.
  const identityRequired = opts.probe !== undefined || processIdentitySupported();
  const self = opts.self ?? process.pid;
  const now = opts.now ?? Date.now();
  const report: ReapedChild[] = [];
  const signalled = new Set<number>();

  const alive = (pid: number): boolean => {
    if (signalled.has(pid)) return false;
    if (opts.pidAlive) return opts.pidAlive(pid);
    if (!identityRequired) return defaultPidAlive(pid);
    const live = probe(pid);
    if (live.state === "identity") return !live.zombie;
    if (live.state === "gone") return false;
    return defaultPidAlive(pid);
  };

  const signal = (entry: ToolChildRecord, note?: string): ReapedChild => {
    const killed = kill(entry, signalled);
    return {
      ...entry,
      outcome: killed ? "killed" : "kept",
      reason: killed ? note : "could not be signalled",
    };
  };

  /** A verdict, or `undefined` for "leave this row alone". */
  const judge = (entry: ToolChildRecord): ReapedChild | undefined => {
    if (entry.ownerPid === self || alive(entry.ownerPid)) return undefined;

    const stamped = Date.parse(entry.at ?? "");
    if (Number.isFinite(stamped) && now - stamped > CHILD_RECORD_TTL_MS) {
      return { ...entry, outcome: "kept", reason: "older than the pid-reuse window" };
    }

    if (!identityRequired) {
      if (!defaultPidAlive(entry.pid)) return { ...entry, outcome: "gone" };
      return signal(entry, `no start-time probe on ${process.platform}: killed on liveness alone`);
    }

    const live = probe(entry.pid);
    if (live.state === "gone") return { ...entry, outcome: "gone" };
    if (live.state === "unknown") {
      return { ...entry, outcome: "kept", reason: `identity unverifiable: ${live.reason}` };
    }
    if (live.zombie) {
      return { ...entry, outcome: "gone", reason: "a zombie: in the table, already dead" };
    }
    if (!sameProcessRun(entry.start, live.start)) {
      return {
        ...entry,
        outcome: "kept",
        reason: entry.start
          ? `identity mismatch: pid ${entry.pid} started at ${live.start}, not ${entry.start}`
          : "identity mismatch: the record carries no start time",
      };
    }
    // Same pid and same start time is the same process run, whatever it is
    // running now: `exec` keeps the start time and replaces the command.
    const execd =
      entry.command && live.command && entry.command !== live.command
        ? `exec'd since it was recorded: ${entry.command} → ${live.command}`
        : undefined;
    return signal(entry, execd);
  };

  try {
    rewrite(workspaceRoot, (entries) => {
      let pending = entries;
      for (let pass = 0; pass < REAP_PASSES && pending.length > 0; pass++) {
        const keep: ToolChildRecord[] = [];
        let changed = false;
        for (const entry of pending) {
          const verdict = judge(entry);
          if (verdict === undefined) {
            keep.push(entry);
            continue;
          }
          report.push(verdict);
          changed = true;
        }
        pending = keep;
        if (!changed) break;
      }
      return pending;
    });
  } catch {
    /* housekeeping never blocks a start */
  }
  return report;
}

/**
 * SIGKILL the group first, then the pid. Best-effort by definition.
 *
 * Every pid it reaches goes into `signalled`, which the rest of this reap
 * reads as dead — a just-killed process answers `kill(pid, 0)` until its
 * parent collects it.
 */
function kill(entry: ToolChildRecord, signalled: Set<number>): boolean {
  let ok = false;
  const group = entry.pgid;
  if (typeof group === "number" && group > 1) {
    try {
      // A negative pid addresses the whole process group — the shell, its
      // pipelines and anything it started.
      process.kill(-group, "SIGKILL");
      signalled.add(group);
      ok = true;
    } catch {
      /* the group may already be empty */
    }
  }
  try {
    process.kill(entry.pid, "SIGKILL");
    ok = true;
  } catch {
    /* already gone between the liveness check and here */
  }
  if (ok) signalled.add(entry.pid);
  return ok;
}
