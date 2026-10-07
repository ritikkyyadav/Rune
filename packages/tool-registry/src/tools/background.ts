// ─── Background Shell Processes ───
//
// Lets the agent start long-running commands (dev servers, watch builds, log
// tails) without blocking the loop or hitting the foreground timeout:
//
//   bash { command, run_in_background: true }  → returns a shell_id instantly
//   bash_output { shell_id }                   → new output since last read
//   kill_shell { shell_id }                    → SIGTERM the process
//
// Background commands use the same native sandbox profile as foreground bash.
// A server can request network access while keeping filesystem isolation.

import { spawn, type ChildProcess } from "node:child_process";
import { resolveSandboxLaunch, sandboxPathsFor } from "../sandbox-mode";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

/** Cap the retained output per shell — a chatty server must not eat memory. */
const MAX_BUFFER_CHARS = 200_000;

/**
 * How long a stopped shell gets to exit on SIGTERM before its group is killed.
 * The polite signal alone let a shell that ignores it — `trap '' TERM`, a
 * wedged watcher — outlive its engine, its `kill_shell` and Rune itself
 * (changelog-mining pilot, T20: tests/unit/probes/t20-background-lifecycle.test.ts).
 */
const KILL_GRACE_MS = 2000;

export type ShellStatus = "running" | "completed" | "failed" | "killed";

interface BackgroundShell {
  id: string;
  command: string;
  proc: ChildProcess;
  buffer: string;
  /** Where the last bash_output read ended (offset into buffer). */
  readOffset: number;
  /** Chars dropped from the front of buffer when the cap was hit. */
  dropped: number;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
  /** The leader's exit was seen: from here its number can be recycled once the group empties. */
  leaderExited: boolean;
  /** The group was seen empty, or someone else's, once. A number seen free is never ours again. */
  groupGone: boolean;
}

/** Sends `signal` to a pid, or to a process group when `pid` is negative; `0` only probes. */
export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

export class BackgroundShellManager {
  private shells = new Map<string, BackgroundShell>();
  private nextId = 1;
  private readonly signal: SignalFn;

  constructor(
    private readonly binaryPath?: string,
    opts: { signal?: SignalFn } = {},
  ) {
    this.signal = opts.signal ?? ((pid, signal) => void process.kill(pid, signal));
    // Never leave orphaned servers behind when Rune exits. An exit handler
    // cannot wait, so this one does not ask twice: see killAll.
    process.on("exit", () => this.killAll());
  }

  start(
    command: string,
    cwd: string,
    network = false,
    opts: { unsandboxed?: boolean; denyWrite?: readonly string[] } = {},
  ): { shellId: string; sandboxed: boolean } {
    let program = "bash";
    let args = ["-lc", command];
    let env: NodeJS.ProcessEnv | undefined;
    let sandboxed = false;
    // The same launch decision as foreground bash: the sandbox mode, the
    // excluded-command list and the fallback override all apply, and a strict
    // policy refuses an `unsandboxed` request here exactly as it does there.
    const launch = resolveSandboxLaunch({
      command,
      network,
      unsandboxed: opts.unsandboxed === true,
    });
    if (launch.refusal) throw new Error(launch.refusal);
    if (launch.sandboxed) {
      if (!this.binaryPath)
        throw new Error(
          "Cannot start a contained background shell: rune-tools is unavailable. Install the native tools before running this command.",
        );
      const plan = Bun.spawnSync([this.binaryPath, "--workspace", cwd, "shell-plan"], {
        stdin: new TextEncoder().encode(
          JSON.stringify({
            command,
            network,
            sandbox_paths: sandboxPathsFor(cwd, opts.denyWrite),
          }),
        ),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      if (plan.exitCode !== 0)
        throw new Error(
          "Cannot start a contained background shell: " +
            new TextDecoder().decode(plan.stdout.length ? plan.stdout : plan.stderr),
        );
      const parsed = JSON.parse(new TextDecoder().decode(plan.stdout));
      if (
        parsed.success !== true ||
        parsed.result?.sandboxed !== true ||
        !Array.isArray(parsed.result.args)
      ) {
        throw new Error(
          "The shell planner did not provide OS isolation. Background command was not started.",
        );
      }
      ({ program, args, env, sandboxed } = parsed.result);
    }
    const id = `shell_${this.nextId++}`;
    // detached → the shell leads its own process group, so kill() can take
    // down the ENTIRE tree (bash + the dev server it spawned), not just bash —
    // a leader-only kill leaves grandchildren running and holding ports.
    const proc: ChildProcess = spawn(program, args, {
      cwd,
      ...(env ? { env } : {}),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const shell: BackgroundShell = {
      id,
      command,
      proc,
      buffer: "",
      readOffset: 0,
      dropped: 0,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      leaderExited: false,
      groupGone: false,
    };
    this.shells.set(id, shell);

    const append = (chunk: string) => {
      shell.buffer += chunk;
      if (shell.buffer.length > MAX_BUFFER_CHARS) {
        const cut = shell.buffer.length - MAX_BUFFER_CHARS;
        shell.buffer = shell.buffer.slice(cut);
        shell.dropped += cut;
        shell.readOffset = Math.max(0, shell.readOffset - cut);
      }
    };
    proc.stdout?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    // Bun's node:child_process type shim omits the EventEmitter surface; the
    // runtime implements it fully.
    const procEvents = proc as unknown as {
      on(event: "error", cb: (err: Error) => void): void;
      on(event: "exit", cb: (code: number | null) => void): void;
    };
    procEvents.on("error", (error) => {
      append(`Failed to start background command: ${error.message}\n`);
      if (shell.status === "running") shell.status = "failed";
    });
    procEvents.on("exit", (code) => {
      shell.leaderExited = true;
      this.groupAlive(shell); // latches groupGone when the group left with its leader
      if (shell.status === "running") {
        shell.status = code === 0 ? "completed" : "failed";
      }
      shell.exitCode = code;
    });

    return { shellId: id, sandboxed };
  }

  /** Signal the shell's whole process group; falls back to the leader only. */
  private signalTree(shell: BackgroundShell, signal: NodeJS.Signals): void {
    const pid = shell.proc.pid;
    try {
      if (pid) {
        this.signal(-pid, signal); // negative pid → whole process group
        return;
      }
    } catch {
      // Group gone or unsupported — fall through to the leader.
    }
    try {
      shell.proc.kill(signal);
    } catch {
      // Already dead.
    }
  }

  /** New output since the last read, plus current status. */
  read(shellId: string): {
    found: boolean;
    status?: ShellStatus;
    exitCode?: number | null;
    output?: string;
    command?: string;
  } {
    const shell = this.shells.get(shellId);
    if (!shell) return { found: false };
    const output = shell.buffer.slice(shell.readOffset);
    shell.readOffset = shell.buffer.length;
    return {
      found: true,
      status: shell.status,
      exitCode: shell.exitCode,
      output,
      command: shell.command,
    };
  }

  kill(shellId: string): { found: boolean; status?: ShellStatus } {
    const shell = this.shells.get(shellId);
    if (!shell) return { found: false };
    // "killed" must come true: TERM now, KILL the group if it is still there
    // after the grace. The timer never holds the process open.
    if (shell.status === "running") {
      const timer = setTimeout(() => {
        if (this.groupAlive(shell)) this.signalTree(shell, "SIGKILL");
      }, KILL_GRACE_MS);
      (timer as { unref?: () => void }).unref?.();
    }
    if (shell.status === "running") {
      shell.status = "killed";
      this.signalTree(shell, "SIGTERM");
    }
    return { found: true, status: shell.status };
  }

  list(): Array<{ id: string; command: string; status: ShellStatus }> {
    return [...this.shells.values()].map((s) => ({
      id: s.id,
      command: s.command,
      status: s.status,
    }));
  }

  /**
   * The process-exit path. Nothing here can wait, so a shell that ignored the
   * first signal would be orphaned the moment this returns: TERM, then KILL at
   * once for any group still standing.
   */
  killAll(): void {
    for (const shell of this.shells.values()) {
      if (shell.status === "running") shell.status = "killed";
      if (!this.groupAlive(shell)) continue;
      this.signalTree(shell, "SIGTERM");
      this.signalTree(shell, "SIGKILL");
    }
  }

  /**
   * Stop every shell this manager started and wait for them to be gone:
   * SIGTERM to each process group, then SIGKILL to any group still alive after
   * `graceMs`. For an owner that closes and keeps running — an engine in a
   * long-lived host — where waiting is possible and a polite signal is owed.
   */
  async stopAll(graceMs = KILL_GRACE_MS): Promise<void> {
    const live = [...this.shells.values()].filter((shell) => this.groupAlive(shell));
    for (const shell of live) {
      if (shell.status === "running") shell.status = "killed";
      this.signalTree(shell, "SIGTERM");
    }
    const deadline = Date.now() + graceMs;
    while (live.some((shell) => this.groupAlive(shell)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const shell of live) {
      if (this.groupAlive(shell)) this.signalTree(shell, "SIGKILL");
    }
  }

  /**
   * Whether anything in the shell's process group is still running — and is
   * still the shell's. A group's number is recycled once the group is empty,
   * and the leader's pid with it, so a stop asked about a shell that ended
   * hours ago must not mistake a newcomer's group for this one:
   *
   *   - a group seen gone stays gone;
   *   - once the leader has exited, the group counts only while no live
   *     process holds the leader's pid. The number cannot be reused while the
   *     group stands, so a process holding it now is a newcomer, and the group
   *     it leads is its own. The shell's orphans have no leader.
   */
  private groupAlive(shell: BackgroundShell): boolean {
    const pid = shell.proc.pid;
    if (pid === undefined || shell.groupGone) return false;
    try {
      this.signal(-pid, 0);
    } catch {
      // No such group — or a platform without detached groups: the leader alone.
      if (!shell.leaderExited && this.holdsPid(pid)) return true;
      shell.groupGone = true;
      return false;
    }
    if (shell.leaderExited && this.holdsPid(pid)) {
      shell.groupGone = true;
      return false;
    }
    return true;
  }

  /** Whether a live process holds `pid` (one we may not signal still holds it). */
  private holdsPid(pid: number): boolean {
    try {
      this.signal(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}

// ─── Tool handlers ───

export const BASH_OUTPUT_SCHEMA: ToolSchema = {
  name: "bash_output",
  version: "0.1.0",
  description:
    "Read NEW output from a background shell started with bash's run_in_background. Returns output since your last read plus the shell's status (running/completed/failed/killed). Poll this to monitor servers, builds, or long test runs.",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "The shell_id returned when the command started" },
    },
    required: ["shell_id"],
  },
  permissionLevel: "auto",
  category: "read",
};

export const KILL_SHELL_SCHEMA: ToolSchema = {
  name: "kill_shell",
  version: "0.1.0",
  description: "Terminate a background shell started with bash's run_in_background.",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "The shell_id to terminate" },
    },
    required: ["shell_id"],
  },
  permissionLevel: "auto",
  category: "execute",
};

export function createBashOutputHandler(manager: BackgroundShellManager): ToolHandler {
  return {
    schema: BASH_OUTPUT_SCHEMA,
    validate: (args) =>
      typeof args.shell_id === "string" && args.shell_id.length > 0
        ? { valid: true }
        : { valid: false, error: "shell_id is required" },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const r = manager.read(String(input.args.shell_id));
      if (!r.found) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: `No background shell with id ${input.args.shell_id}. Active: ${
            manager
              .list()
              .map((s) => s.id)
              .join(", ") || "(none)"
          }`,
          durationMs: 0,
        };
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({
          status: r.status,
          exit_code: r.exitCode,
          output: r.output || "(no new output)",
        }),
        durationMs: 0,
      };
    },
  };
}

export function createKillShellHandler(manager: BackgroundShellManager): ToolHandler {
  return {
    schema: KILL_SHELL_SCHEMA,
    validate: (args) =>
      typeof args.shell_id === "string" && args.shell_id.length > 0
        ? { valid: true }
        : { valid: false, error: "shell_id is required" },
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const r = manager.kill(String(input.args.shell_id));
      if (!r.found) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: `No background shell with id ${input.args.shell_id}`,
          durationMs: 0,
        };
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify({ status: r.status }),
        durationMs: 0,
      };
    },
  };
}

/**
 * Wrap the (Rust-backed) bash handler: `run_in_background: true` routes to the
 * background manager and returns a shell_id immediately; everything else goes
 * to the sandboxed foreground path unchanged.
 */
export function withBackgroundSupport(
  bashHandler: ToolHandler,
  manager: BackgroundShellManager,
): ToolHandler {
  return {
    schema: bashHandler.schema,
    validate: (args) => bashHandler.validate(args),
    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      if (input.args.run_in_background === true) {
        if (input.signal?.aborted)
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: "Interrupted before start.",
            durationMs: 0,
          };
        const command = String(input.args.command ?? "");
        if (!command.trim()) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: "command is required",
            durationMs: 0,
          };
        }
        let started: { shellId: string; sandboxed: boolean };
        try {
          started = manager.start(command, input.workspaceRoot, input.args.network === true, {
            unsandboxed: input.args.unsandboxed === true,
            ...(input.denyWrite ? { denyWrite: input.denyWrite } : {}),
          });
        } catch (error) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: error instanceof Error ? error.message : String(error),
            durationMs: 0,
          };
        }
        const { shellId, sandboxed } = started;
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: JSON.stringify({
            shell_id: shellId,
            sandboxed,
            status: "running",
            note: "Command started in the background. Poll bash_output with this shell_id for output; kill_shell to stop it.",
          }),
          durationMs: 0,
        };
      }
      return bashHandler.execute(input);
    },
  };
}
