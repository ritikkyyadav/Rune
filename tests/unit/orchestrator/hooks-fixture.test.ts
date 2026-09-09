/**
 * The documented hooks config, run.
 *
 * `docs/hooks.md` prints `tests/fixtures/hooks/hooks.json` as its worked
 * example. A documented example that nothing executes rots quietly, so this
 * test installs THAT FILE — not a copy retyped here — into a temp workspace and
 * drives all four events through the real runner.
 *
 * Every assertion below is a sentence in the docs:
 *   preToolUse blocking non-zero  → the call is vetoed, with the stderr line
 *   preToolUse non-blocking       → the call proceeds
 *   postToolUse stdout            → returned to the caller for the model
 *   sessionStart / sessionEnd     → run, report-only
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { HookRunner, loadHookConfig } from "../../../packages/orchestrator/src/hooks";

const FIXTURE = resolve(import.meta.dir, "../../fixtures/hooks");

let workspace: string;
let log: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rune-hooks-fixture-"));
  log = join(workspace, "hooks.log");
  // The layout the docs describe: hooks.json under .rune, the scripts it names
  // resolved against the workspace root (hooks run with cwd = workspace root).
  mkdirSync(join(workspace, ".rune"), { recursive: true });
  cpSync(join(FIXTURE, "hooks.json"), join(workspace, ".rune", "hooks.json"));
  cpSync(join(FIXTURE, "scripts"), join(workspace, "scripts"), { recursive: true });
  for (const name of ["no-secrets.sh", "changed-note.sh"]) {
    chmodSync(join(workspace, "scripts", name), 0o755);
  }
  process.env.RUNE_HOOK_LOG = log;
});

afterEach(() => {
  delete process.env.RUNE_HOOK_LOG;
  rmSync(workspace, { recursive: true, force: true });
});

function logLines(): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
}

/**
 * Tests that actually EXECUTE a hook, as opposed to loading or matching one.
 *
 * `hooks.ts` spawns every hook through a hardcoded `/bin/sh -c`, and the
 * fixture the docs print is a pair of `.sh` scripts. Rune has no Windows shell
 * contract yet — `crates/rune-sandbox/src/shell.rs` resolves one for the Rust
 * half (Git for Windows' bash, else `cmd.exe /C`, `RUNE_SHELL` overriding) and
 * the TypeScript callers have not been routed through the same rule — so on
 * Windows the spawn fails with ENOENT and hooks are inert with nothing said
 * about it. That is the open defect recorded in docs/program/backlog.md (found
 * in P10.2, alongside verifier.ts and worker-worktree.ts); asserting a shell
 * this platform has no contract for would test the machine, not Rune. The same
 * reason skips worker-worktree.test.ts. Everything that does NOT spawn — the
 * loader, the match rules, the empty runner — still runs on Windows.
 */
const runsAHook = test.skipIf(process.platform === "win32");

describe("the documented hooks fixture", () => {
  test("loads with every event the matrix documents", async () => {
    const config = await loadHookConfig(workspace);
    expect(Object.keys(config).sort()).toEqual([
      "postToolUse",
      "preToolUse",
      "sessionEnd",
      "sessionStart",
    ]);
    expect(config.preToolUse?.[0]?.blocking).toBe(true);
    expect(config.preToolUse?.[0]?.timeoutMs).toBe(5000);
    expect(config.postToolUse?.[0]?.match).toBe("*_file");
  });

  runsAHook("a blocking preToolUse hook that exits non-zero vetoes the call", async () => {
    const runner = await HookRunner.load(workspace);
    const decision = await runner.runPreToolUse("write_file", { path: ".env", content: "KEY=1" });
    expect(decision.allow).toBe(false);
    // The refusal carries the hook's own stderr, which is what reaches the agent.
    expect(decision.reason).toContain("secret-looking path");
  });

  runsAHook("the same hook allows an ordinary path", async () => {
    const runner = await HookRunner.load(workspace);
    const decision = await runner.runPreToolUse("write_file", {
      path: "src/parser.ts",
      content: "export {}",
    });
    expect(decision.allow).toBe(true);
  });

  test("a non-matching tool skips the guard entirely", async () => {
    const runner = await HookRunner.load(workspace);
    // `match: "write_file"` — a read of the same secret path is not this hook's
    // business, and the guard must not fire on it.
    const decision = await runner.runPreToolUse("read_file", { path: ".env" });
    expect(decision.allow).toBe(true);
  });

  runsAHook("a non-blocking preToolUse hook runs and never vetoes", async () => {
    const runner = await HookRunner.load(workspace);
    const decision = await runner.runPreToolUse("bash", { command: "ls" });
    expect(decision.allow).toBe(true);
    expect(logLines()).toContain("pre bash");
  });

  runsAHook("postToolUse stdout comes back for the model to read", async () => {
    const runner = await HookRunner.load(workspace);
    const feedback = await runner.runPostToolUse("write_file", { path: "src/parser.ts" });
    expect(feedback).toContain("formatting reminder");
    expect(feedback).toContain("write_file");
  });

  test("postToolUse returns null when nothing matches", async () => {
    const runner = await HookRunner.load(workspace);
    expect(await runner.runPostToolUse("bash", { exit_code: 0 })).toBeNull();
  });

  runsAHook("the lifecycle hooks run and report the event they were given", async () => {
    const runner = await HookRunner.load(workspace);
    await runner.runSessionStart();
    await runner.runSessionEnd();
    expect(logLines()).toEqual(["sessionStart", "sessionEnd"]);
  });

  test("a workspace with no hooks.json is a no-op runner", async () => {
    const bare = mkdtempSync(join(tmpdir(), "rune-hooks-bare-"));
    try {
      const runner = await HookRunner.load(bare);
      expect(runner.isEmpty()).toBe(true);
      expect((await runner.runPreToolUse("write_file", { path: ".env" })).allow).toBe(true);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
