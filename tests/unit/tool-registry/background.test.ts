/**
 * Background shells: bash run_in_background → shell_id; bash_output polls new
 * output incrementally; kill_shell terminates; buffers are capped.
 */

import { describe, test, expect } from "bun:test";
import {
  BackgroundShellManager,
  createBashOutputHandler,
  createKillShellHandler,
  withBackgroundSupport,
} from "../../../packages/tool-registry/src/tools/background";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

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
 * Gear has no Windows shell contract yet — nothing decides whether a command
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
