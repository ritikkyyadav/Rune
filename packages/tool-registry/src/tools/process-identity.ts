/**
 * What a pid actually names, right now.
 *
 * A pid is a number the kernel hands back out. The restart reaper
 * (`child-ledger.ts`) SIGKILLs a process group on the strength of a line in a
 * file, and until this module existed the only questions it asked were "is the
 * owner gone?" and "does something answer to this number?" — neither of which
 * ties the number to the process the line was written for. V1's
 * `v1-child-ledger-pid-reuse` proved the consequence: a `/bin/sleep` this
 * engine never spawned, named by a ledger row, was killed.
 *
 * The tie is the process's START TIME. It is assigned by the kernel at fork
 * and never changes — not on `exec`, not on reparenting — so a pid plus a
 * start time is a name no recycled pid can answer to. It is also cheap:
 *
 * - Linux: field 22 of `/proc/<pid>/stat`, in clock ticks since boot. One read.
 * - macOS: `proc_pidinfo(PROC_PIDTBSDINFO)` through `bun:ffi`, which gives the
 *   start `timeval` to the microsecond, the `comm` and the run state in one
 *   syscall. No `ps` fork — and `ps` is not always executable anyway (a
 *   restrictive Seatbelt profile refuses it), where a syscall always is.
 *
 * `crates/rune-sandbox/src/child_ledger.rs` reads the SAME two sources and
 * formats the token identically, because the two ledgers write into one file
 * and this reaper has to verify rows it did not write.
 *
 * The command name is read alongside and recorded, but it is not the tie: a
 * process keeps its start time across `exec` and does NOT keep its `comm`.
 * Measured on this machine — `/bin/sh -c "sleep 90"` is `sh` at spawn and
 * `sleep` 30 ms later, same pid, same start time. Requiring `comm` to match
 * would refuse to kill exactly the orphans this mechanism exists for.
 */

import { readFileSync } from "node:fs";

/** A process's kernel-assigned identity, or why we could not read one. */
export type ProcessProbe =
  /** The pid names a live process, and this is who it is. */
  | { state: "identity"; start: string; command: string; zombie: boolean }
  /** No process answers to that pid. */
  | { state: "gone" }
  /** There may or may not be a process; this machine cannot tell us who. */
  | { state: "unknown"; reason: string };

/**
 * Platforms whose identity we can read. Elsewhere — Windows — the reaper keeps
 * its pre-identity behaviour rather than losing the ability to reap at all;
 * see `reapToolChildren`.
 */
export function processIdentitySupported(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

/**
 * Command names are an identity field written into a JSONL line, not display
 * text: reduce them to a character set that cannot need escaping, and cap the
 * length. Mirrored byte-for-byte by `sanitize_command` in `child_ledger.rs`.
 */
export function sanitizeCommand(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._+@:/-]/g, "_").slice(0, 64);
}

/** Who is at `pid`? */
export function probeProcess(pid: number): ProcessProbe {
  if (!Number.isInteger(pid) || pid <= 1) return { state: "gone" };
  if (process.platform === "linux") return probeLinux(pid);
  if (process.platform === "darwin") return probeDarwin(pid);
  return { state: "unknown", reason: `no start-time probe on ${process.platform}` };
}

/**
 * Two start tokens name the same process run.
 *
 * Exact string equality: both sides are produced by the same platform reader,
 * so a difference is a difference in the kernel's answer, never in formatting.
 */
export function sameProcessRun(recorded: string | undefined, live: string): boolean {
  return typeof recorded === "string" && recorded.length > 0 && recorded === live;
}

// ─── Linux: /proc/<pid>/stat ───

function probeLinux(pid: number): ProcessProbe {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return { state: "gone" };
    return { state: "unknown", reason: `/proc/${pid}/stat: ${code ?? String(err)}` };
  }
  // `comm` is the second field, in parentheses, and may itself contain spaces
  // and ')' — so the last ')' is the only reliable split point.
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close <= open) {
    return { state: "unknown", reason: `/proc/${pid}/stat has no comm field` };
  }
  const command = sanitizeCommand(raw.slice(open + 1, close));
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state), so field N is rest[N - 3]: starttime is 22.
  const runState = rest[0] ?? "";
  const startTicks = rest[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    return { state: "unknown", reason: `/proc/${pid}/stat has no starttime field` };
  }
  return {
    state: "identity",
    start: `linux:${startTicks}`,
    command,
    zombie: runState.startsWith("Z"),
  };
}

// ─── macOS: proc_pidinfo(PROC_PIDTBSDINFO) ───

/** `PROC_PIDTBSDINFO`, from `<sys/proc_info.h>`. */
const PROC_PIDTBSDINFO = 3;
/** `sizeof(struct proc_bsdinfo)`. */
const PROC_BSDINFO_SIZE = 136;
/** `SZOMB`, from `<sys/proc.h>`: in the process table, but already dead. */
const SZOMB = 5;

type DarwinReader = (pid: number) => ProcessProbe;
/** `undefined` = not tried yet; `null` = tried and this machine cannot. */
let darwinReader: DarwinReader | null | undefined;
let darwinReason = "";

function probeDarwin(pid: number): ProcessProbe {
  if (darwinReader === undefined) darwinReader = loadDarwinReader();
  if (darwinReader === null) return { state: "unknown", reason: darwinReason };
  return darwinReader(pid);
}

function loadDarwinReader(): DarwinReader | null {
  try {
    // Required rather than imported so that a runtime without `bun:ffi`
    // degrades to "unknown" — which the reaper refuses to act on — instead of
    // failing this module's import and taking the whole tool registry down.
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("libSystem.B.dylib", {
      proc_pidinfo: {
        args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    const decoder = new TextDecoder();
    return (pid: number): ProcessProbe => {
      const buf = new Uint8Array(PROC_BSDINFO_SIZE);
      const filled = lib.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(buf), buf.length);
      // 0 is "no such process" in every case we can produce (our own children,
      // our own uid). A denied read would land here too, and is then forgotten
      // rather than killed — the safe direction.
      if (filled < PROC_BSDINFO_SIZE) return { state: "gone" };
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const status = view.getUint32(4, true);
      const comm = decoder.decode(buf.subarray(48, 64)).replace(/\0.*$/s, "");
      const sec = view.getBigUint64(120, true);
      const usec = view.getBigUint64(128, true);
      return {
        state: "identity",
        start: `darwin:${sec}.${usec}`,
        command: sanitizeCommand(comm),
        zombie: status === SZOMB,
      };
    };
  } catch (err) {
    darwinReason = `libproc is unreadable here: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}
