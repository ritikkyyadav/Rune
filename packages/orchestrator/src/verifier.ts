// ─── Verification ───
//
// Turns "the agent stopped" into "the agent's work actually checks out" by
// running the project's own checks (typecheck / tests / cargo check) after the
// agent claims it's done, and feeding any failure back so it can self-correct.
//
// Design notes:
//  - If we cannot detect any check for a workspace, verification PASSES
//    trivially (ran:false). We never fail a task just because we couldn't
//    figure out how to verify it.
//  - Commands run scoped to the workspace, with a hard timeout, capturing both
//    stdout and stderr so the report is useful to the model.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

export interface VerifyResult {
  /** true when checks pass OR no checks are applicable. */
  passed: boolean;
  /** true when at least one check command actually ran. */
  ran: boolean;
  /** Human-readable report (command + trimmed output) to feed back to the agent. */
  report: string;
}

export interface Verifier {
  verify(signal?: AbortSignal): Promise<VerifyResult>;
}

export interface CommandVerifierConfig {
  workspaceRoot: string;
  /** Explicit override commands. When set and non-empty, detection is skipped. */
  commands?: string[];
  /** Per-command timeout in ms. Default 120_000. */
  timeoutMs?: number;
}

// ─── Package-manager / runner detection ───

type Pm = "bun" | "pnpm" | "yarn" | "npm";

function detectPm(workspaceRoot: string): Pm {
  const has = (f: string) => existsSync(join(workspaceRoot, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

/** The "run a package binary" form for each package manager (for tsc, etc.). */
function pmx(pm: Pm): string {
  switch (pm) {
    case "bun":
      return "bunx";
    case "pnpm":
      return "pnpm dlx";
    case "yarn":
      return "yarn dlx";
    default:
      return "npx";
  }
}

function hasTestFiles(workspaceRoot: string): boolean {
  try {
    return readdirSync(workspaceRoot).some((f) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  } catch {
    return false;
  }
}

/**
 * Detect sensible verification commands for a workspace by inspecting common
 * project manifests. Order matters: a fast typecheck before the (slower) test
 * run, so the agent gets the cheapest failing signal first.
 *
 * Returns [] when nothing is detected.
 */
export function detectVerifyCommands(workspaceRoot: string): string[] {
  const cmds: string[] = [];
  const has = (f: string) => existsSync(join(workspaceRoot, f));
  const pm = detectPm(workspaceRoot);

  let scripts: Record<string, string> = {};
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      scripts = pkg.scripts ?? {};
    } catch {
      // malformed package.json — treat as no scripts
    }
  }

  // 1. Typecheck (fast, deterministic).
  if (scripts.typecheck) cmds.push(`${pm} run typecheck`);
  else if (has("tsconfig.json")) cmds.push(`${pmx(pm)} tsc --noEmit`);

  // 2. Tests.
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    cmds.push(`${pm === "npm" ? "npm test" : `${pm} test`}`);
  } else if (!scripts.test && hasTestFiles(workspaceRoot)) {
    // Manifest-less / scriptless project with raw test files — Alan runs on Bun,
    // which can execute bun:test files directly.
    cmds.push("bun test");
  }

  // 3. Rust.
  if (has("Cargo.toml")) cmds.push("cargo check --quiet");

  return cmds;
}

// ─── Command execution ───

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[${s.length - max} more chars]` : s;
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, output: `${stdout}${stderr}`.trim(), timedOut };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ─── CommandVerifier ───

export class CommandVerifier implements Verifier {
  constructor(private readonly config: CommandVerifierConfig) {}

  async verify(signal?: AbortSignal): Promise<VerifyResult> {
    const timeoutMs = this.config.timeoutMs ?? 120_000;
    const commands =
      this.config.commands && this.config.commands.length > 0
        ? this.config.commands
        : detectVerifyCommands(this.config.workspaceRoot);

    if (commands.length === 0) {
      return { passed: true, ran: false, report: "No verification commands detected." };
    }

    const reports: string[] = [];
    for (const cmd of commands) {
      if (signal?.aborted) break;
      const { exitCode, output, timedOut } = await runCommand(
        cmd,
        this.config.workspaceRoot,
        timeoutMs,
        signal,
      );
      if (timedOut) {
        reports.push(`$ ${cmd}\n[timed out after ${timeoutMs}ms]`);
        return { passed: false, ran: true, report: reports.join("\n\n") };
      }
      if (exitCode !== 0) {
        reports.push(`$ ${cmd}  (exit ${exitCode})\n${truncate(output, 2000)}`);
        return { passed: false, ran: true, report: reports.join("\n\n") };
      }
      reports.push(`$ ${cmd}  (ok)`);
    }

    return { passed: true, ran: true, report: reports.join("\n\n") };
  }
}
