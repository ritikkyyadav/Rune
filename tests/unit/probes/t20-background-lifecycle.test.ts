/**
 * Changelog-mining pilot, failure type T20 (subagent/background lifecycle),
 * 2026-09-27.
 *
 * Mechanisms transferred (another agent's public changelog; our wording): idle
 * background sessions kept their processes alive indefinitely; processes were
 * orphaned after the terminal went away; a stop that did not actually stop
 * left the task shown as stopped.
 *
 * Checked and held, not probed here: Rune's scouts are read-only and cannot
 * spawn scouts (depth is bounded by construction), they run inside the
 * parent's tool call (a headless run cannot hang on one), and a scout cut off
 * mid-investigation returns its partial trail — pinned already by
 * tests/unit/orchestrator/subagent-no-summary.test.ts.
 *
 * What did not hold: `engine.close()` stops MCP servers, plugin processes and
 * language servers — its own comment names the leak "for anything that closes
 * an engine and keeps running" — but not the background shells the engine's
 * bash started. And every stop sent SIGTERM only, so a process that ignores it
 * survived: past the engine, past `kill_shell` (which then reported it
 * "killed"), and past Rune's own exit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../../../packages/orchestrator/src/engine";
import { BackgroundShellManager } from "../../../packages/tool-registry/src/tools/background";
import {
  resetSandboxPolicyForTest,
  setSandboxMode,
} from "../../../packages/tool-registry/src/sandbox-mode";
import { describeNativeBinary, resolveRuneToolsBinary } from "../../helpers/native-binary";
import { rmTemp } from "../../helpers/tmp";

const POSIX = process.platform !== "win32";
// The engine's bash runs through the native tools binary, background shells
// included. This test named it `rune-tools` and left the finding to $PATH, so
// it passed on a machine with Rune installed and failed everywhere else — CI's
// unit job, which builds no Rust, among them — with "Executable not found".
// It now uses the binary this checkout built, and says so when there is none.
const native = resolveRuneToolsBinary();
if (!native.exists) {
  console.warn(`[t20-background-lifecycle] one test skipped: ${describeNativeBinary(native)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await sleep(25);
}

async function pidFrom(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim().length > 0);
  return Number(readFileSync(file, "utf8").trim());
}

/** A shell that records its pid and shrugs off SIGTERM, like a stubborn watcher. */
const stubborn = (pidFile: string) =>
  `echo $$ > "${pidFile}"; trap '' TERM; while :; do sleep 0.2; done`;

let root: string;
const strays: number[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rune-probe-t20-"));
  setSandboxMode("off");
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  resetSandboxPolicyForTest();
  rmTemp(root);
});

describe.skipIf(!POSIX)("T20 — a background shell ends with what started it", () => {
  test.skipIf(!native.exists)(
    "closing an engine stops the background shells its bash started",
    async () => {
      const engine = new Engine({
        model: "llama3",
        provider: "ollama",
        workspaceRoot: root,
        dbPath: join(root, "rune.db"),
        toolsBinaryPath: native.path,
        permissionMode: "auto",
        enableCheckpoints: false,
        enableSecurity: false,
        enableRateLimiting: false,
        enableHooks: false,
        enableMcp: false,
        enableSkills: false,
        enableVerification: false,
        memory: { enabled: false },
      });
      const sessionId = engine.createSession();
      const bash = (engine as unknown as { registry: { get(n: string): any } }).registry.get(
        "bash",
      );
      const pidFile = join(root, "server.pid");
      const out = await bash.execute({
        toolName: "bash",
        callId: "c1",
        args: { command: `echo $$ > "${pidFile}"; exec sleep 30`, run_in_background: true },
        sessionId,
        workspaceRoot: root,
      });
      expect(out.success).toBe(true);
      const pid = await pidFrom(pidFile);
      strays.push(pid);
      expect(alive(pid)).toBe(true);

      engine.close();
      await waitFor(() => !alive(pid), 4000);
      expect(alive(pid)).toBe(false);
    },
  );

  test("stopping a manager stops a shell that ignores SIGTERM", async () => {
    const m = new BackgroundShellManager();
    const pidFile = join(root, "stubborn.pid");
    m.start(stubborn(pidFile), root);
    const pid = await pidFrom(pidFile);
    strays.push(pid);

    await m.stopAll(300);
    await waitFor(() => !alive(pid), 2000);
    expect(alive(pid)).toBe(false);
  });

  test("kill_shell does not report a shell killed while it still runs", async () => {
    const m = new BackgroundShellManager();
    const pidFile = join(root, "kill.pid");
    const { shellId } = m.start(stubborn(pidFile), root);
    const pid = await pidFrom(pidFile);
    strays.push(pid);

    expect(m.kill(shellId).status).toBe("killed");
    await waitFor(() => !alive(pid), 4000);
    expect(alive(pid)).toBe(false);
  });

  // ── Whose group is it? ──
  //
  // A stop signals a shell's process group by number, and a number is recycled
  // once its group is empty. The escalation added above asks "is the group
  // still there?" of every shell ever started — including one that ended hours
  // ago — so without an identity check, Rune's exit could SIGKILL an unrelated
  // group that happens to hold a finished shell's old number. These play the
  // kernel's answers through the manager's signal seam; nothing real is sent.

  /** A manager whose signals land in `sent`, answering probes from `world`. */
  function fakeKernel() {
    const k = {
      // gone: our group left with its leader. orphans: the leader exited, its
      // group lives on. recycled: the number now leads someone else's group.
      world: "gone" as "gone" | "orphans" | "recycled",
      sent: [] as Array<[number, string]>,
    };
    const manager = new BackgroundShellManager(undefined, {
      signal: (pid, signal) => {
        if (signal !== 0) {
          k.sent.push([pid, signal]);
          return;
        }
        const live = pid < 0 ? k.world !== "gone" : k.world === "recycled";
        if (!live) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });
    return { k, manager };
  }

  async function finishedShell(m: BackgroundShellManager): Promise<void> {
    const { shellId } = m.start("true", root);
    await waitFor(() => m.read(shellId).status !== "running");
    expect(m.read(shellId).status).toBe("completed");
  }

  test("a finished shell's recycled number is never signalled (its group left with it)", async () => {
    const { k, manager } = fakeKernel();
    await finishedShell(manager);
    k.world = "recycled";
    manager.killAll();
    await manager.stopAll(50);
    expect(k.sent).toEqual([]);
  });

  test("a finished shell's recycled number is never signalled (its orphans left later)", async () => {
    const { k, manager } = fakeKernel();
    k.world = "orphans";
    await finishedShell(manager);
    k.world = "recycled";
    manager.killAll();
    expect(k.sent).toEqual([]);
  });

  test("a group seen gone stays gone, even when a leaderless group holds its number later", async () => {
    const { k, manager } = fakeKernel();
    await finishedShell(manager); // the group left with its leader, and was seen to
    k.world = "orphans"; // a newcomer took the number, then left orphans of its own
    manager.killAll();
    expect(k.sent).toEqual([]);
  });

  test("orphans a finished shell left in its group are still stopped", async () => {
    const { k, manager } = fakeKernel();
    k.world = "orphans";
    await finishedShell(manager);
    manager.killAll();
    expect(k.sent.map(([pid, signal]) => [pid < 0, signal])).toEqual([
      [true, "SIGTERM"],
      [true, "SIGKILL"],
    ]);
  });

  test("a process exit leaves no background shell behind, even one that ignores SIGTERM", async () => {
    const pidFile = join(root, "exit.pid");
    const script = join(root, "child.ts");
    await Bun.write(
      script,
      `import { BackgroundShellManager } from ${JSON.stringify(
        join(import.meta.dir, "../../../packages/tool-registry/src/tools/background"),
      )};
       import { setSandboxMode } from ${JSON.stringify(
         join(import.meta.dir, "../../../packages/tool-registry/src/sandbox-mode"),
       )};
       setSandboxMode("off");
       const m = new BackgroundShellManager();
       m.start(${JSON.stringify(stubborn(pidFile))}, ${JSON.stringify(root)});
       while (!(await Bun.file(${JSON.stringify(pidFile)}).exists())) await Bun.sleep(20);
       await Bun.sleep(100);
       process.exit(0);`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "inherit" });
    await child.exited;
    const pid = await pidFrom(pidFile);
    strays.push(pid);
    await waitFor(() => !alive(pid), 2000);
    expect(alive(pid)).toBe(false);
  });
});
