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
import { rmTemp } from "../../helpers/tmp";

const POSIX = process.platform !== "win32";
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
  test("closing an engine stops the background shells its bash started", async () => {
    const engine = new Engine({
      model: "llama3",
      provider: "ollama",
      workspaceRoot: root,
      dbPath: join(root, "rune.db"),
      toolsBinaryPath: "rune-tools",
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
    const bash = (engine as unknown as { registry: { get(n: string): any } }).registry.get("bash");
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
  });

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
