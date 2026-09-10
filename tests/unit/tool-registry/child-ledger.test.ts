/**
 * The pid ledger behind S-1's second half.
 *
 * `rune-tools` dies with its engine now (a `getppid()` watchdog in
 * `crates/rune-sandbox/src/parent_death.rs`), which closes the case Lane S
 * measured. It cannot close a `rune-tools` that was itself SIGKILLed — no
 * handler runs — or Windows, where there is no parent to poll. Both spawn
 * paths therefore write the pid down, and a restarting engine reads the file.
 *
 * The tests below are about the three refusals, not the kill: the cost of a
 * false positive here is SIGKILLing a stranger's process.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CHILD_RECORD_TTL_MS,
  childLedgerPath,
  forgetToolChild,
  reapToolChildren,
  recordToolChild,
} from "../../../packages/tool-registry/src/tools/child-ledger";
import type { ProcessProbe } from "../../../packages/tool-registry/src/tools/process-identity";

const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* a temp directory the OS will reap is not a test result */
    }
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-child-ledger-"));
  dirs.push(dir);
  return dir;
}

/** A pid that is certainly not running: the kernel's own maximum, plus one. */
const DEAD_PID = 4_194_305;

/**
 * A stand-in kernel, so the decisions can be tested without spawning anything.
 * `probeProcess` reads /proc or libproc for real; these tests are about what
 * the reaper DOES with the answer, and a real process would prove less.
 */
function fakeKernel(table: Record<number, { start: string; command?: string; zombie?: boolean }>) {
  return (pid: number): ProcessProbe => {
    const row = table[pid];
    if (!row) return { state: "gone" };
    return {
      state: "identity",
      start: row.start,
      command: row.command ?? "sleep",
      zombie: row.zombie ?? false,
    };
  };
}

test("a noted child is written, and forgotten when it exits", () => {
  const root = workspace();
  recordToolChild(root, {
    pid: 4242,
    pgid: 4242,
    ownerPid: process.pid,
    at: new Date().toISOString(),
    tool: "bash",
  });
  const text = readFileSync(childLedgerPath(root), "utf8");
  expect(text).toContain('"pid":4242');
  expect(text).toContain('"pgid":4242');

  forgetToolChild(root, 4242);
  // The last line went, so the file goes with it rather than being left as an
  // empty ledger every later start has to parse.
  expect(existsSync(childLedgerPath(root))).toBe(false);
});

test("a live owner's children are its own business", () => {
  const root = workspace();
  // Owned by THIS process, which is alive by definition. Two Runes in one
  // workspace must not kill each other's in-flight calls.
  recordToolChild(root, {
    pid: 1234,
    pgid: 1234,
    ownerPid: process.pid,
    at: new Date().toISOString(),
  });
  const killed: number[] = [];
  const report = reapToolChildren(root, {
    self: DEAD_PID, // not us, so the entry is judged on its owner's liveness
    pidAlive: (pid) => {
      if (pid === process.pid) return true;
      killed.push(pid);
      return true;
    },
  });
  expect(report).toEqual([]);
  expect(killed).not.toContain(1234);
  // And the line stays, because the call it describes is still running.
  expect(readFileSync(childLedgerPath(root), "utf8")).toContain('"pid":1234');
});

test("a dead owner's live child is killed, group first", () => {
  const root = workspace();
  recordToolChild(root, {
    pid: 5555,
    pgid: 5555,
    ownerPid: DEAD_PID,
    at: new Date().toISOString(),
    tool: "bash",
    start: "test:5555@1",
  });
  const signals: Array<number | string> = [];
  const realKill = process.kill.bind(process);
  // Intercept rather than spawn: this test is about WHICH signals are sent to
  // WHICH ids, and a real kill of a real child proves less and risks more.
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: string | number) => {
    if (signal === 0) return true as never;
    signals.push(pid);
    return true as never;
  }) as typeof process.kill;
  try {
    const report = reapToolChildren(root, {
      self: process.pid,
      pidAlive: (pid) => pid !== DEAD_PID,
      probe: fakeKernel({ 5555: { start: "test:5555@1" } }),
    });
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ pid: 5555, outcome: "killed", tool: "bash" });
  } finally {
    (process as { kill: typeof process.kill }).kill = realKill;
  }
  // The negative pid first — the whole group, so a shell's pipelines and
  // anything it started go with it — then the pid itself.
  expect(signals).toEqual([-5555, 5555]);
  // Reaped means forgotten: the ledger is empty and the file is gone.
  expect(existsSync(childLedgerPath(root))).toBe(false);
});

test("a child whose owner AND self are both gone is reported, not signalled", () => {
  const root = workspace();
  recordToolChild(root, {
    pid: DEAD_PID,
    pgid: DEAD_PID,
    ownerPid: DEAD_PID,
    at: new Date().toISOString(),
  });
  const report = reapToolChildren(root, {
    self: process.pid,
    pidAlive: () => false,
    probe: fakeKernel({}),
  });
  expect(report).toHaveLength(1);
  expect(report[0]).toMatchObject({ outcome: "gone" });
});

test("an entry older than the pid-reuse window is forgotten, never killed", () => {
  const root = workspace();
  const old = new Date(Date.now() - CHILD_RECORD_TTL_MS - 60_000).toISOString();
  recordToolChild(root, {
    pid: 7777,
    pgid: 7777,
    ownerPid: DEAD_PID,
    at: old,
    start: "test:7777@1",
  });
  const signals: number[] = [];
  const realKill = process.kill.bind(process);
  (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: string | number) => {
    if (signal === 0) return true as never;
    signals.push(pid);
    return true as never;
  }) as typeof process.kill;
  let report;
  try {
    report = reapToolChildren(root, {
      self: process.pid,
      pidAlive: (p) => p !== DEAD_PID,
      probe: fakeKernel({ 7777: { start: "test:7777@1" } }),
    });
  } finally {
    (process as { kill: typeof process.kill }).kill = realKill;
  }
  // Pids are recycled. An entry a day old names a number, not a process, and
  // killing it would kill whatever inherited that number.
  expect(signals).toEqual([]);
  expect(report?.[0]).toMatchObject({ outcome: "kept" });
  expect(String(report?.[0]?.reason)).toContain("pid-reuse");
});

test("a torn line is dropped rather than taking the ledger down", () => {
  const root = workspace();
  const path = childLedgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `{"pid":1,"ownerPid":\n{"pid":2,"pgid":2,"ownerPid":${DEAD_PID},"at":"x"}\n`);
  const report = reapToolChildren(root, {
    self: process.pid,
    pidAlive: () => false,
    probe: fakeKernel({}),
  });
  expect(report.map((r) => r.pid)).toEqual([2]);
});

test("no ledger is not an error", () => {
  expect(reapToolChildren(workspace())).toEqual([]);
});
