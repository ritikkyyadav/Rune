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
  /**
   * Called once per command the verifier actually ran, with the exit code IT
   * read. Wired by the Engine to the same CheckLog the `bash` tool feeds.
   *
   * Without this there were two verification systems that never spoke: the
   * end-of-turn verifier ran the project's checks through its own spawner,
   * while the evidence ledger only ever saw checks the MODEL chose to run.
   * A criterion therefore could not cite the very checks the harness ran on
   * its behalf. Both now write to one log, so a rung can be derived from
   * either source.
   */
  onCheck?: (run: { command: string; passed: boolean; summary?: string }) => void;
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

// Directories a detection walk must never descend into.
const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
]);

/**
 * Bounded recursive scan for files matching `pattern`. The old detection was a
 * NON-recursive readdir of the workspace root — a repo with tests in `tests/`
 * or `src/**` read as having none, so "run the tests" verification silently
 * never fired on most real projects.
 */
function walkHas(root: string, pattern: RegExp, maxDepth = 4, budget = { n: 2000 }): boolean {
  if (maxDepth < 0 || budget.n <= 0) return false;
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (budget.n-- <= 0) return false;
    if (e.isFile() && pattern.test(e.name)) return true;
  }
  for (const e of entries) {
    if (e.isDirectory() && !WALK_SKIP.has(e.name) && !e.name.startsWith(".")) {
      if (walkHas(join(root, e.name), pattern, maxDepth - 1, budget)) return true;
    }
  }
  return false;
}

const JS_TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function readScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/** Commands for one JS/TS project directory (root or a nested app). */
function jsCommands(dir: string, isMonorepoRoot: boolean): string[] {
  const cmds: string[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  const pm = detectPm(dir);
  const scripts = readScripts(dir);

  // 1. Typecheck (fast, deterministic).
  if (scripts.typecheck) cmds.push(`${pm} run typecheck`);
  else if (has("tsconfig.json")) cmds.push(`${pmx(pm)} tsc --noEmit`);

  // 2. Tests. In a monorepo, ONLY trust root scripts (they fan out properly);
  // running `bun test` over the whole tree would double-run packages.
  if (scripts.test && !/no test specified/i.test(scripts.test)) {
    cmds.push(`${pm === "npm" ? "npm test" : `${pm} test`}`);
  } else if (!scripts.test && !isMonorepoRoot && walkHas(dir, JS_TEST_FILE)) {
    // Scriptless project with raw test files — Gear runs on Bun, which can
    // execute bun:test files directly.
    cmds.push("bun test");
  }

  // 3. Lint, when the project declares it (last: functional failures first).
  if (scripts.lint) cmds.push(`${pm} run lint`);

  // 4. Build as a compile-at-least fallback when nothing else was detected.
  if (cmds.length === 0 && scripts.build) cmds.push(`${pm} run build`);

  return cmds;
}

/**
 * Detect sensible verification commands for a workspace by inspecting common
 * project manifests. Order matters: a fast typecheck before the (slower) test
 * run, so the agent gets the cheapest failing signal first.
 *
 * Detection rules (each anchored to a real observed miss):
 *  - Monorepo (root `workspaces` / turbo.json): trust root scripts only.
 *  - No root manifest but exactly ONE nested package.json at depth ≤2 (the
 *    "built a self-contained app in a subdirectory" case): detect there and
 *    prefix the commands with `cd <dir> &&`.
 *  - Test files are found by a bounded recursive walk, not a root readdir.
 *  - Rust / Go get their standard compile checks.
 *
 * Returns [] when nothing is detected.
 */
export function detectVerifyCommands(workspaceRoot: string): string[] {
  const has = (f: string) => existsSync(join(workspaceRoot, f));
  const cmds: string[] = [];

  const rootHasPkg = has("package.json");
  const isMonorepoRoot =
    has("turbo.json") ||
    (rootHasPkg &&
      (() => {
        try {
          const pkg = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
            workspaces?: unknown;
          };
          return pkg.workspaces != null;
        } catch {
          return false;
        }
      })());

  if (rootHasPkg || has("tsconfig.json")) {
    cmds.push(...jsCommands(workspaceRoot, isMonorepoRoot));
  } else {
    // No root manifest: a single self-contained app in a subdirectory is the
    // common greenfield shape ("build me X" into <workspace>/x/).
    const nested = findSingleNestedPackage(workspaceRoot);
    if (nested) {
      cmds.push(...jsCommands(nested.dir, false).map((c) => `cd ${nested.rel} && ${c}`));
    } else if (walkHas(workspaceRoot, JS_TEST_FILE)) {
      cmds.push("bun test");
    }
  }

  // Rust.
  if (has("Cargo.toml")) cmds.push("cargo check --quiet");

  // Go: the compiler is the cheapest honest check; tests only when they exist.
  if (has("go.mod")) {
    cmds.push("go build ./...");
    if (walkHas(workspaceRoot, /_test\.go$/)) cmds.push("go test ./...");
  }

  return cmds;
}

/** Exactly one package.json in an immediate or second-level subdirectory. */
function findSingleNestedPackage(root: string): { dir: string; rel: string } | null {
  const found: Array<{ dir: string; rel: string }> = [];
  let level1: import("fs").Dirent[];
  try {
    level1 = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const a of level1) {
    if (!a.isDirectory() || WALK_SKIP.has(a.name) || a.name.startsWith(".")) continue;
    const d1 = join(root, a.name);
    if (existsSync(join(d1, "package.json"))) {
      found.push({ dir: d1, rel: a.name });
      continue;
    }
    let level2: import("fs").Dirent[];
    try {
      level2 = readdirSync(d1, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const b of level2) {
      if (!b.isDirectory() || WALK_SKIP.has(b.name) || b.name.startsWith(".")) continue;
      const d2 = join(d1, b.name);
      if (existsSync(join(d2, "package.json"))) found.push({ dir: d2, rel: `${a.name}/${b.name}` });
    }
    if (found.length > 1) return null;
  }
  return found.length === 1 ? found[0] : null;
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
      // Word this as the finding it is: after a session that WROTE files,
      // "nothing runnable" usually means the work produced static files, not a
      // project — the exact signature of a mock delivered as an app. The report
      // reaches both the task-state block and the UI's verification line.
      return {
        passed: true,
        ran: false,
        report:
          "Nothing runnable detected — no manifest, test, or build configuration found, so no command was executed.",
      };
    }

    const reports: string[] = [];
    /** Report every command we ran to the check log — pass or fail, always. */
    const note = (command: string, passed: boolean, summary?: string): void => {
      try {
        this.config.onCheck?.({ command, passed, summary });
      } catch {
        // Evidence bookkeeping must never break verification itself.
      }
    };
    for (const cmd of commands) {
      if (signal?.aborted) break;
      const { exitCode, output, timedOut } = await runCommand(
        cmd,
        this.config.workspaceRoot,
        timeoutMs,
        signal,
      );
      if (timedOut) {
        note(cmd, false, `timed out after ${timeoutMs}ms`);
        reports.push(`$ ${cmd}\n[timed out after ${timeoutMs}ms]`);
        return { passed: false, ran: true, report: reports.join("\n\n") };
      }
      if (exitCode !== 0) {
        note(cmd, false, `exit ${exitCode}`);
        reports.push(`$ ${cmd}  (exit ${exitCode})\n${truncate(output, 2000)}`);
        return { passed: false, ran: true, report: reports.join("\n\n") };
      }
      note(cmd, true, "ok");
      reports.push(`$ ${cmd}  (ok)`);
    }

    return { passed: true, ran: true, report: reports.join("\n\n") };
  }
}
