import { spawn, spawnSync } from "node:child_process";

/** The same native profile as the worker shell, with a bounded output and process lifetime. */
export async function runContainedCheck(
  binary: string,
  cwd: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
  env: Record<string, string> = {},
): Promise<{ passed: boolean; detail: string }> {
  if (signal?.aborted) return { passed: false, detail: "cancelled before execution" };
  const plan = spawnSync(binary, ["--workspace", cwd, "shell-plan"], {
    input: JSON.stringify({ command, network: false }),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  let shell: { program: string; args: string[]; env: Record<string, string> };
  try {
    const parsed = JSON.parse(plan.stdout ?? "");
    if (
      plan.status !== 0 ||
      parsed.success !== true ||
      parsed.result?.sandboxed !== true ||
      typeof parsed.result.program !== "string" ||
      !Array.isArray(parsed.result.args)
    )
      throw new Error();
    shell = parsed.result;
  } catch {
    return { passed: false, detail: "OS isolation unavailable: worker check was not started" };
  }
  if (signal?.aborted) return { passed: false, detail: "cancelled before execution" };
  return new Promise((resolve) => {
    const child = spawn(shell.program, shell.args, {
      cwd,
      env: { ...shell.env, ...env, RUNE_WORKER_CHECK: "1" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      stopped: string | undefined,
      settled = false;
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-32_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const stop = (reason: string) => {
      stopped = reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (passed: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ passed, detail });
    };
    const events = child as unknown as {
      on(event: "error", callback: (error: Error) => void): void;
      on(event: "close", callback: (code: number | null) => void): void;
    };
    events.on("error", (error) => finish(false, error.message));
    events.on("close", (code) =>
      finish(
        code === 0 && !stopped,
        stopped ??
          `exit ${code}${output.trim() ? `: ${output.replace(/\s+/g, " ").trim().slice(-400)}` : ""}`,
      ),
    );
    if (signal?.aborted) abort();
  });
}
