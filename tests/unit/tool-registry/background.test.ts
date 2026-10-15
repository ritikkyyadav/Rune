/**
 * Background shells: bash run_in_background → shell_id; bash_output polls new
 * output incrementally; kill_shell terminates; buffers are capped.
 */

import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundShellManager,
  createBashOutputHandler,
  createKillShellHandler,
  DEFAULT_SHELL_LIFETIME_MS,
  isLongCommand,
  setDefaultShellLifetime,
  withBackgroundSupport,
} from "../../../packages/tool-registry/src/tools/background";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";
import {
  resetSandboxPolicyForTest,
  setSandboxMode,
} from "../../../packages/tool-registry/src/sandbox-mode";

// These lifecycle fixtures intentionally exercise the host-shell path. Native
// containment and missing-planner refusal are covered by the integration suite.
beforeEach(() => setSandboxMode("off"));
afterEach(() => resetSandboxPolicyForTest());

function makeInput(toolName: string, args: Record<string, unknown>): ToolCallInput {
  return { toolName, callId: "c1", args, sessionId: "s1", workspaceRoot: "/tmp" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` is true or `timeoutMs` elapses (then let the caller's
 *  own assertion report the real failure) — avoids racing a fixed sleep
 *  against a background process's timing on a slow/loaded runner. */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) return;
    await sleep(intervalMs);
  }
}

/**
 * POSIX-only. Background shells run their command through the Rust executor's `sh`, and the fixtures are `sh` one-liners.
 *
 * Rune has no Windows shell contract yet — nothing decides whether a command
 * string means cmd.exe, PowerShell or Git Bash — so there is no Windows
 * behaviour to assert, only a decision to make. Logged in
 * docs/program/backlog.md.
 */
const POSIX_SHELL = process.platform !== "win32";

describe.skipIf(!POSIX_SHELL)("BackgroundShellManager", () => {
  test("start → read output → completed", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("echo hello && echo world", "/tmp");

    // read() drains — accumulate what each poll returns rather than assume
    // a read after the loop sees everything (see the note in the next test).
    let output = "";
    let status: string | undefined;
    let exitCode: number | null | undefined;
    await waitFor(() => {
      const r = m.read(shellId);
      output += r.output ?? "";
      status = r.status;
      exitCode = r.exitCode;
      return status !== "running";
    });
    expect(output).toContain("hello");
    expect(output).toContain("world");
    expect(status).toBe("completed");
    expect(exitCode).toBe(0);
  });

  test("read is incremental — second read returns only new output", async () => {
    // read() drains: each call returns only output new since the previous
    // call. Polling it must accumulate what each poll drains rather than
    // assume one final read sees everything — otherwise a poll iteration
    // could silently consume "first" before the real assertion runs.
    const m = new BackgroundShellManager();
    const { shellId } = m.start("echo first; sleep 0.3; echo second", "/tmp");

    let out1 = "";
    let status1: string | undefined;
    await waitFor(() => {
      const r = m.read(shellId);
      out1 += r.output ?? "";
      status1 = r.status;
      return out1.includes("first");
    });
    expect(out1).toContain("first");
    expect(out1).not.toContain("second");
    expect(status1).toBe("running");

    let out2 = "";
    let status2: string | undefined;
    await waitFor(() => {
      const r = m.read(shellId);
      out2 += r.output ?? "";
      status2 = r.status;
      return status2 !== "running";
    });
    expect(out2).toContain("second");
    expect(out2).not.toContain("first");
  });

  test("kill terminates a running shell", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("sleep 30", "/tmp");
    await sleep(50);
    const k = m.kill(shellId);
    expect(k.found).toBe(true);
    expect(k.status).toBe("killed");
    await sleep(100);
    expect(m.read(shellId).status).toBe("killed");
  });

  test("failing command reports failed status", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("exit 3", "/tmp");
    let status: string | undefined;
    let exitCode: number | null | undefined;
    await waitFor(() => {
      const r = m.read(shellId);
      status = r.status;
      exitCode = r.exitCode;
      return status !== "running";
    });
    expect(status).toBe("failed");
    expect(exitCode).toBe(3);
  });
});

describe.skipIf(!POSIX_SHELL)("tool handlers", () => {
  test("bash with run_in_background returns shell_id; bash_output reads it", async () => {
    const m = new BackgroundShellManager();
    const fgBash: ToolHandler = {
      schema: {
        name: "bash",
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        permissionLevel: "sandbox",
        category: "execute",
      },
      validate: () => ({ valid: true }),
      execute: async () => {
        throw new Error("foreground path must not run");
      },
    };
    const bash = withBackgroundSupport(fgBash, m);
    const out = await bash.execute(
      makeInput("bash", { command: "echo bg-works", run_in_background: true }),
    );
    expect(out.success).toBe(true);
    const { shell_id } = JSON.parse(out.result);
    expect(shell_id).toMatch(/^shell_/);

    const reader = createBashOutputHandler(m);
    let output = "";
    let status: string | undefined;
    let lastSuccess = false;
    await waitFor(async () => {
      const read = await reader.execute(makeInput("bash_output", { shell_id }));
      lastSuccess = read.success;
      if (read.success) {
        const parsed = JSON.parse(read.result);
        output += parsed.output ?? "";
        status = parsed.status;
      }
      return status !== "running";
    });
    expect(lastSuccess).toBe(true);
    expect(output).toContain("bg-works");
    expect(status).toBe("completed");
  });

  test("bash_output on unknown shell lists active shells in the error", async () => {
    const m = new BackgroundShellManager();
    const reader = createBashOutputHandler(m);
    const out = await reader.execute(makeInput("bash_output", { shell_id: "shell_999" }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("shell_999");
  });

  test("kill_shell stops a running shell via the tool", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("sleep 30", "/tmp");
    const killer = createKillShellHandler(m);
    const out = await killer.execute(makeInput("kill_shell", { shell_id: shellId }));
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).status).toBe("killed");
  });
});

/**
 * R6 of docs/program/rune-reliability-plan-20261014.md: a long command that
 * reaches its timeout is handed over as a background shell instead of being
 * killed; every such shell, and every shell of an unattended run, has a
 * lifetime.
 */
describe("long commands keep their work", () => {
  test("the record's long commands are recognised, and ordinary ones are not", () => {
    for (const long of [
      "npm install",
      "npm i express socket.io chess.js",
      "bun test 2>&1 | tail -200",
      "bun run typecheck",
      "npx --yes playwright@1.55.0 install chromium",
      "ollama pull qwen2.5:1.5b",
      ".venv/bin/pip install -e '.[dev]'",
      "cd web && npm ci",
      "time pytest -q",
      "./gradlew build",
    ]) {
      expect(isLongCommand(long), long).toBe(true);
    }
    for (const ordinary of [
      "ls -la",
      "git status",
      "echo npm install",
      "./scripts/verify-live.sh",
      "sleep 30 && npm test",
      "python3 -m http.server 8080",
    ]) {
      expect(isLongCommand(ordinary), ordinary).toBe(false);
    }
  });
});

const HAS_MAKE = POSIX_SHELL && Bun.which("make") !== null;

describe.skipIf(!HAS_MAKE)("a long command through the bash wrapper", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-long-"));
    writeFileSync(
      join(dir, "Makefile"),
      "quick:\n\t@echo quick-done\nslow:\n\t@echo slow-start\n\t@sleep 2\n\t@echo slow-done\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const neverForeground: ToolHandler = {
    schema: { name: "bash" } as never,
    validate: () => ({ valid: true }),
    execute: async () => {
      throw new Error("a long command must not reach the native foreground path");
    },
  };
  const input = (args: Record<string, unknown>): ToolCallInput => ({
    toolName: "bash",
    callId: "c1",
    args,
    sessionId: "s1",
    workspaceRoot: dir,
  });

  test("one that finishes in time returns a foreground result and leaves no shell", async () => {
    const m = new BackgroundShellManager();
    const bash = withBackgroundSupport(neverForeground, m);
    const out = await bash.execute(input({ command: "make quick", timeout_ms: 10_000 }));
    expect(out.success).toBe(true);
    const r = JSON.parse(out.result);
    expect(r.stdout).toContain("quick-done");
    expect(r.exit_code).toBe(0);
    expect(r.timed_out).toBe(false);
    expect(r.backgrounded).toBeUndefined();
    expect(m.list()).toEqual([]);
  });

  test("one that outlives its timeout is handed over, not killed, and finishes", async () => {
    const m = new BackgroundShellManager();
    const bash = withBackgroundSupport(neverForeground, m);
    const out = await bash.execute(input({ command: `cd ${dir} && make slow`, timeout_ms: 400 }));
    const r = JSON.parse(out.result);
    expect(r.timed_out).toBe(true);
    expect(r.backgrounded).toBe(true);
    expect(r.exit_code).toBeNull();
    expect(r.stdout).toContain("slow-start");
    expect(r.note).toContain(`background shell ${r.shell_id}`);
    expect(r.note).toContain("its work continues");
    // R6.3: the `cd` stays with that shell.
    expect(r.note).toContain("next command starts in the workspace root");

    const reader = createBashOutputHandler(m);
    let output = "";
    let status = "running";
    await waitFor(async () => {
      const read = JSON.parse(
        (await reader.execute(makeInput("bash_output", { shell_id: r.shell_id }))).result,
      );
      output += read.output;
      status = read.status;
      return status !== "running";
    }, 10_000);
    expect(status).toBe("completed");
    expect(output).toContain("slow-done");
  });

  test("a shell the wrapper starts always has the default lifetime", async () => {
    const asked: Array<number | undefined> = [];
    class Spy extends BackgroundShellManager {
      override start(...args: Parameters<BackgroundShellManager["start"]>) {
        asked.push(args[3]?.maxLifetimeMs);
        return super.start(...args);
      }
    }
    const bash = withBackgroundSupport(neverForeground, new Spy());
    await bash.execute(input({ command: "make quick", timeout_ms: 10_000 }));
    expect(asked).toEqual([DEFAULT_SHELL_LIFETIME_MS]);
  });

  test("Esc while waiting stops it", async () => {
    const m = new BackgroundShellManager();
    const bash = withBackgroundSupport(neverForeground, m);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await bash.execute({
      ...input({ command: "make slow", timeout_ms: 10_000 }),
      signal: ac.signal,
    });
    expect(out.success).toBe(false);
    expect(out.error).toBe("Interrupted by user.");
    expect(m.list()[0]?.status).toBe("killed");
  });
});

describe.skipIf(!POSIX_SHELL)("shell lifetimes", () => {
  afterEach(() => setDefaultShellLifetime(null));

  test("a shell with a lifetime is stopped when it is reached, and says so", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("sleep 30", "/tmp", false, { maxLifetimeMs: 150 });
    await waitFor(() => m.read(shellId).status !== "running", 3_000);
    const read = m.read(shellId);
    expect(read.status).toBe("killed");
    expect(read.expired).toBe(true);
    const out = await createBashOutputHandler(m).execute(
      makeInput("bash_output", { shell_id: shellId }),
    );
    expect(JSON.parse(out.result).note).toContain("time limit");
  });

  test("an unattended run gives every shell the default, capped at two hours", async () => {
    setDefaultShellLifetime(150);
    const m = new BackgroundShellManager();
    const { shellId } = m.start("sleep 30", "/tmp");
    await waitFor(() => m.read(shellId).status !== "running", 3_000);
    expect(m.read(shellId).expired).toBe(true);
  });

  test("a shell asked for without a lifetime, outside an unattended run, has none", async () => {
    const m = new BackgroundShellManager();
    const { shellId } = m.start("sleep 1", "/tmp");
    await sleep(300);
    expect(m.read(shellId).status).toBe("running");
    m.kill(shellId);
  });
});
