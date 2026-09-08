import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";

/** Bounded process-tree lifetime, argument arrays, and streaming logs. No shell
 * interpolation of model prompts or benchmark problem statements. */
export async function runProcess(options: {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  onLine?: (line: string) => boolean;
}): Promise<{ exitCode: number | null; durationMs: number; stopped?: string }> {
  const start = Date.now();
  const out = openSync(options.stdoutPath, "w", 0o600),
    err = openSync(options.stderrPath, "w", 0o600);
  return new Promise((resolveResult, reject) => {
    let stopped: string | undefined,
      pending = "",
      done = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(options.command[0]!, options.command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stop = (reason: string) => {
      stopped ??= reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      grace ??= setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 2000);
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const hard = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, options.timeoutMs + 2000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(hard);
      clearTimeout(grace);
      closeSync(out);
      closeSync(err);
    };
    child.stdout?.on("data", (chunk) => {
      writeSync(out, chunk);
      pending += chunk.toString();
      if (pending.length > 2_000_000) {
        stop("oversized event");
        pending = "";
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (options.onLine?.(line)) stop("cost limit");
    });
    child.stderr?.on("data", (chunk) => writeSync(err, chunk));
    const events = child as unknown as {
      on(event: "error", listener: (error: Error) => void): void;
      on(event: "close", listener: (code: number | null) => void): void;
    };
    events.on("error", (error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    });
    events.on("close", (code) => {
      if (done) return;
      done = true;
      cleanup();
      resolveResult({
        exitCode: code,
        durationMs: Date.now() - start,
        ...(stopped ? { stopped } : {}),
      });
    });
  });
}
