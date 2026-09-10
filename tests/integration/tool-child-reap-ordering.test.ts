/**
 * One reap finishes the job the ledger exists for.
 *
 * The ledger is a two-level tree, by design:
 *
 *   bridge row : {pid: <rune-tools>, ownerPid: <engine>}       (no pgid)
 *   rust row   : {pid: <command>, pgid: <command>, ownerPid: <rune-tools>}
 *
 * so one row's OWNER is another row's CHILD. `reapToolChildren` walks the rows
 * and asks, per row, whether `ownerPid` is alive. The bridge row is written
 * first, so by the time the command's row is judged the reaper has already
 * SIGKILLed its owner — one iteration earlier, in the same pass. A just-killed
 * process is still in the process table (a zombie until its parent collects
 * it), so a plain `kill(pid, 0)` answered TRUE, the command's row took the
 * "a live owner's children are its own business" branch, and the orphan this
 * whole mechanism exists for was KEPT. V1 measured it: a SECOND
 * `reapToolChildren` is what killed the command, so the port or the file the
 * orphan held survived the restart that was supposed to release it.
 *
 * The reaper now remembers the pids it has signalled and reads them as dead
 * for the rest of the pass, then re-judges what is left (bounded, three
 * passes). A zombie counts as gone for the same reason: it holds no port and
 * no file.
 *
 * Driven against the real thing — a real `rune-tools`, a real `sleep 90`, and
 * the rust row written by the Rust ledger — so it needs the native binary
 * (`RUNE_TOOLS_BIN=$PWD/target/debug/rune-tools`) and skips loudly without it.
 */
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  childLedgerPath,
  reapToolChildren,
  toolChildIdentity,
} from "../../packages/tool-registry/src/tools/child-ledger";
import { describeNativeBinary, resolveRuneToolsBinary } from "../helpers/native-binary";

const repoRoot = resolve(import.meta.dir, "../..");
const nativeBinary = resolveRuneToolsBinary();
const CAN_RUN = nativeBinary.exists && ["darwin", "linux"].includes(process.platform);
if (!CAN_RUN) {
  console.warn(`[tool-child-reap-ordering] skipped: ${describeNativeBinary(nativeBinary)}`);
}

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* gone */
      }
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

/** Stands in for the engine: spawns rune-tools, never exits on its own. */
const SHIM = `
const [bin, ws] = process.argv.slice(2);
const tools = Bun.spawn([bin, "--workspace", ws, "bash"], {
  stdin: new TextEncoder().encode(JSON.stringify({ command: "sleep 90", timeout_ms: 90000 })),
  stdout: "pipe",
  stderr: "pipe",
});
console.log(JSON.stringify({ shim: process.pid, tools: tools.pid }));
await new Promise(() => {});
`;

/** A pid that named a process a moment ago: `spawnSync` waits AND reaps it. */
function deadPid(): number {
  const doomed = spawnSync("/usr/bin/true", [], { stdio: "ignore" });
  if (doomed.error || typeof doomed.pid !== "number" || doomed.pid <= 1) {
    throw new Error(`could not spawn /usr/bin/true: ${doomed.error?.message ?? "no pid"}`);
  }
  return doomed.pid;
}

test.skipIf(!CAN_RUN)(
  "one reap kills the orphan whose owner it killed in the same pass",
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rune-reap-ordering-"));
    dirs.push(workspace);
    const shimPath = join(workspace, "shim.mjs");
    writeFileSync(shimPath, SHIM);

    const shim = spawn(process.execPath, ["run", shimPath, nativeBinary.path, workspace], {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    pids.push(shim.pid!);
    const line = await new Promise<string>((ok, no) => {
      let buf = "";
      const timer = setTimeout(() => no(new Error(`shim printed nothing: ${buf}`)), 20_000);
      shim.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("\n")) {
          clearTimeout(timer);
          ok(buf.split("\n")[0]!);
        }
      });
    });
    const { tools } = JSON.parse(line) as { shim: number; tools: number };

    // rune-tools records its command itself; wait for that row to land.
    const path = childLedgerPath(workspace);
    let command: number | undefined;
    for (let i = 0; i < 200 && command === undefined; i++) {
      if (existsSync(path)) {
        command = readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { pid: number; ownerPid: number })
          .find((r) => r.ownerPid === tools)?.pid;
      }
      if (command === undefined) await Bun.sleep(25);
    }
    expect(command).toBeDefined();
    expect(alive(command!)).toBe(true);

    // The row the bridge writes for rune-tools, with an engine that is gone —
    // prepended, because the bridge writes it before rune-tools writes its own.
    const rust = readFileSync(path, "utf8");
    writeFileSync(
      path,
      `${JSON.stringify({
        pid: tools,
        ownerPid: deadPid(),
        at: new Date().toISOString(),
        tool: "bash",
        // Exactly what `recordToolChild` stamps on it: a row without the
        // kernel's identity for the pid is one the reaper refuses to act on.
        ...toolChildIdentity(tools),
      })}\n${rust}`,
    );

    const report = reapToolChildren(workspace);
    await Bun.sleep(500);

    // One restart must finish the job the ledger exists for.
    expect(report.some((r) => r.pid === command && r.outcome === "killed")).toBe(true);
    expect(alive(command!)).toBe(false);
  },
  90_000,
);
