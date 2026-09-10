/**
 * The restart reaper refuses a pid it cannot tie to the row that names it.
 *
 * `reapToolChildren` SIGKILLs a process GROUP on the strength of a line in a
 * file. Until V1 the only questions it asked were "is the recorded `ownerPid`
 * gone?", "is the row younger than `CHILD_RECORD_TTL_MS`?" and "does something
 * answer to this number?" — and none of those ties the number to the process
 * the row was written for. macOS recycles pids above 99999, so "younger than
 * 24 hours" is not a proof that a number still names the same process, which
 * is exactly what it was being asked to be.
 *
 * Every row now carries the kernel's START TIME for its pid
 * (`process-identity.ts`), and the reaper re-reads it immediately before it
 * signals anything. A row whose identity does not match — or that carries none
 * at all, like the hand-written row below — is forgotten rather than acted on.
 *
 * This test never arranges a real pid collision (it cannot force one). It
 * proves the check the collision would need: a live process this engine never
 * spawned, named by a ledger row, is left alone.
 */
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import {
  childLedgerPath,
  reapToolChildren,
} from "../../../packages/tool-registry/src/tools/child-ledger";

const dirs: string[] = [];
const strangers: number[] = [];

afterEach(() => {
  for (const pid of strangers.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A pid that named a process a moment ago and does not now. `spawnSync` waits
 * for the exit AND reaps it, so the number is free by the time it returns.
 */
function recentlyDeadPid(): number {
  const doomed = spawnSync("/usr/bin/true", [], { stdio: "ignore" });
  if (doomed.error || typeof doomed.pid !== "number" || doomed.pid <= 1) {
    throw new Error(`could not spawn /usr/bin/true: ${doomed.error?.message ?? "no pid"}`);
  }
  return doomed.pid;
}

/**
 * A long-lived process in ITS OWN session/process group — the stand-in for
 * whatever unrelated program inherited the recycled number. `detached` is
 * what makes the group kill safe to demonstrate: it can only reach this tree.
 */
function stranger(): number {
  const proc = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });
  proc.unref();
  strangers.push(proc.pid!);
  return proc.pid!;
}

test("a live process the ledger cannot vouch for is left alone, not killed", async () => {
  const workspace = mkdtempSync(`${tmpdir()}/rune-child-ledger-identity-`);
  dirs.push(workspace);

  const deadOwner = recentlyDeadPid();
  const victim = stranger();
  await Bun.sleep(120);

  // Preconditions, so a failure below can only mean what the test says.
  expect(alive(deadOwner)).toBe(false);
  expect(alive(victim)).toBe(true);

  // The ledger row a crashed engine would have left: recent (inside the TTL),
  // owner gone, child "alive". Every field is the shape rune-tools and the
  // bridge actually write — minus the identity, which is what a row naming a
  // recycled pid would be missing or wrong about.
  const path = childLedgerPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      pid: victim,
      pgid: victim,
      ownerPid: deadOwner,
      at: new Date().toISOString(),
      tool: "bash",
    })}\n`,
  );

  const report = reapToolChildren(workspace);
  await Bun.sleep(250);

  expect(report.map((r) => r.outcome)).not.toContain("killed");
  expect(report[0]?.reason ?? "").toContain("identity mismatch");
  expect(alive(victim)).toBe(true);
});
