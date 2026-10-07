import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  CommandVerifier,
  detectVerifyCommands,
  verifyOutcome,
} from "../../../packages/orchestrator/src/verifier";

async function tmpWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rune-verify-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe("detectVerifyCommands", () => {
  test("package.json typecheck+test scripts + bun.lock → bun run typecheck, bun run test", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test" } }),
      "bun.lock": "",
    });
    expect(detectVerifyCommands(dir)).toEqual(["bun run typecheck", "bun run test"]);
    await rm(dir, { recursive: true, force: true });
  });

  // A declared test script is dispatched through the package manager's SCRIPT
  // runner. For npm, pnpm and yarn `<pm> test` is that runner; `bun test` is
  // not — it is Bun's own test runner, and it never reads `scripts.test`.
  test.each([
    ["bun.lock", "bun run test"],
    ["bun.lockb", "bun run test"],
    ["pnpm-lock.yaml", "pnpm test"],
    ["yarn.lock", "yarn test"],
    ["package-lock.json", "npm test"],
  ])("a declared test script with %s → %s", async (lockfile, expected) => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      [lockfile]: "",
    });
    expect(detectVerifyCommands(dir)).toEqual([expected]);
    await rm(dir, { recursive: true, force: true });
  });

  test("a bun project with NO test script keeps the raw bun test fallback", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: {} }),
      "bun.lock": "",
      "thing.test.ts": "// test",
    });
    expect(detectVerifyCommands(dir)).toEqual(["bun test"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("tsconfig only, no manifest → npx tsc --noEmit", async () => {
    const dir = await tmpWorkspace({ "tsconfig.json": "{}" });
    expect(detectVerifyCommands(dir)).toEqual(["npx tsc --noEmit"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("raw test files, no manifest → bun test", async () => {
    const dir = await tmpWorkspace({ "thing.test.ts": "// test" });
    expect(detectVerifyCommands(dir)).toEqual(["bun test"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("Cargo.toml → cargo check, then cargo test (P10.4)", async () => {
    const dir = await tmpWorkspace({ "Cargo.toml": "[package]" });
    expect(detectVerifyCommands(dir)).toEqual(["cargo check --quiet", "cargo test --quiet"]);
    await rm(dir, { recursive: true, force: true });
  });

  test("empty workspace → no commands", async () => {
    const dir = await tmpWorkspace({});
    expect(detectVerifyCommands(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * POSIX-only. `CommandVerifier` runs each check through `Bun.spawn(["bash", "-c", …])` (verifier.ts:280).
 *
 * Rune has no Windows shell contract yet — nothing decides whether a command
 * string means cmd.exe, PowerShell or Git Bash — so there is no Windows
 * behaviour to assert, only a decision to make. Logged in
 * docs/program/backlog.md.
 */
const POSIX_SHELL = process.platform !== "win32";

describe.skipIf(!POSIX_SHELL)("CommandVerifier", () => {
  test("passing command → passed:true, ran:true", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({ workspaceRoot: dir, commands: ["true"] }).verify();
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("failing command → passed:false with exit code + output in report", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["echo boom >&2; exit 3"],
    }).verify();
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(true);
    expect(r.report).toContain("exit 3");
    expect(r.report).toContain("boom");
    await rm(dir, { recursive: true, force: true });
  });

  test("stops at the first failing command", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["exit 1", "echo SHOULD_NOT_RUN"],
    }).verify();
    expect(r.passed).toBe(false);
    expect(r.report).not.toContain("SHOULD_NOT_RUN");
    await rm(dir, { recursive: true, force: true });
  });

  // This used to assert `passed: true` — "verification passes trivially when
  // nothing can be checked". Nothing having been checked is not a pass.
  test("no detected commands → inconclusive(no_checks): not failed, and not passed", async () => {
    const dir = await tmpWorkspace({ "readme.md": "# nothing to verify" });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toBe("no_checks");
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("timeout → inconclusive, not failed, with 'timed out' in the report", async () => {
    const dir = await tmpWorkspace({});
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      commands: ["sleep 5"],
      timeoutMs: 200,
    }).verify();
    expect(r.status).toBe("inconclusive");
    expect(r.reason).toBe("timeout");
    expect(r.report).toContain("timed out");
    // Neither half of the old pair may read as a verdict.
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * V2a — a verification has three outcomes, and only one of them is a failure.
 *
 * `passed` means the checks ran and were green. `failed` means a check ran to
 * completion and went red. Everything else — a deadline, a cancelled run, a
 * missing toolchain, nothing to run — is `inconclusive` with its reason, and is
 * neither a failure of the work nor a receipt for it.
 */
describe.skipIf(!POSIX_SHELL)("verification outcome", () => {
  /** A verifier over explicit commands, recording what reaches the check log. */
  function rig(commands: string[], timeoutMs = 120_000) {
    const logged: Array<{ command: string; passed: boolean }> = [];
    const verifier = new CommandVerifier({
      workspaceRoot: tmpdir(),
      commands,
      timeoutMs,
      onCheck: (run) => logged.push({ command: run.command, passed: run.passed }),
    });
    return { verifier, logged };
  }

  test("green checks → passed", async () => {
    const { verifier, logged } = rig(["true", "true"]);
    const r = await verifier.verify();
    expect(verifyOutcome(r)).toEqual({ status: "passed" });
    expect(r.reason).toBeUndefined();
    expect(logged).toEqual([
      { command: "true", passed: true },
      { command: "true", passed: true },
    ]);
  });

  test("a check that ran and went red → failed, and is logged as red", async () => {
    const { verifier, logged } = rig(["exit 3"]);
    const r = await verifier.verify();
    expect(verifyOutcome(r)).toEqual({ status: "failed" });
    expect(logged).toEqual([{ command: "exit 3", passed: false }]);
  });

  test("a pass followed by a timeout is inconclusive — the pass is kept, the kill is not a red check", async () => {
    const { verifier, logged } = rig(["true", "sleep 5", "echo SHOULD_NOT_RUN"], 200);
    const r = await verifier.verify();
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "timeout" });
    expect(r.runs?.map((x) => [x.command, x.passed, x.timedOut ?? false])).toEqual([
      ["true", true, false],
      ["sleep 5", false, true],
    ]);
    // The check log is evidence about the code. The first command is; a
    // command killed at its deadline is not, in either direction.
    expect(logged).toEqual([{ command: "true", passed: true }]);
    expect(r.report).not.toContain("SHOULD_NOT_RUN");
  });

  test("every check skipped for an absent toolchain → inconclusive(missing_runner)", async () => {
    const { verifier, logged } = rig(["rune-no-such-runner-a --version", "rune-no-such-runner-b"]);
    const r = await verifier.verify();
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "missing_runner" });
    expect(r.runs?.every((x) => typeof x.skipped === "string")).toBe(true);
    expect(logged).toEqual([]);
  });

  test("nothing to run → inconclusive(no_checks)", async () => {
    const dir = await tmpWorkspace({ "readme.md": "# nothing to verify" });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "no_checks" });
    await rm(dir, { recursive: true, force: true });
  });

  test("cancelled before the first check → inconclusive(cancelled), nothing run", async () => {
    const { verifier, logged } = rig(["echo SHOULD_NOT_RUN"]);
    const ac = new AbortController();
    ac.abort();
    const r = await verifier.verify(ac.signal);
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "cancelled" });
    expect(r.runs).toEqual([]);
    expect(logged).toEqual([]);
  });

  test("cancelled between two checks is not a pass, even though everything that ran was green", async () => {
    const ac = new AbortController();
    const logged: string[] = [];
    const verifier = new CommandVerifier({
      workspaceRoot: tmpdir(),
      commands: ["true", "echo SHOULD_NOT_RUN"],
      // The first command finishes green; the run is cancelled as it is logged.
      onCheck: (run) => {
        logged.push(run.command);
        ac.abort();
      },
    });
    const r = await verifier.verify(ac.signal);
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "cancelled" });
    expect(r.passed).toBe(false);
    expect(logged).toEqual(["true"]);
    expect(r.report).not.toContain("SHOULD_NOT_RUN");
  });

  test("cancelled while a check is running → inconclusive(cancelled), and no red check is logged", async () => {
    const { verifier, logged } = rig(["sleep 5", "echo SHOULD_NOT_RUN"]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const started = Date.now();
    const r = await verifier.verify(ac.signal);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "cancelled" });
    expect(r.runs?.map((x) => [x.command, x.cancelled ?? false])).toEqual([["sleep 5", true]]);
    expect(logged).toEqual([]);
  });

  // V2c. Killing only the shell left its child holding the output pipes, so
  // the read waited for the child to finish: the deadline bounded nothing for
  // any command of the shape `a && b` — which every nested project's check is.
  test("the deadline bounds a compound command, not just a bare one", async () => {
    const { verifier } = rig(["true && sleep 5"], 200);
    const started = Date.now();
    const r = await verifier.verify();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "timeout" });
  });

  test("a cancelled run stops a compound command promptly", async () => {
    const { verifier } = rig(["true && sleep 5"]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const started = Date.now();
    const r = await verifier.verify(ac.signal);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(verifyOutcome(r)).toEqual({ status: "inconclusive", reason: "cancelled" });
  });
});

/**
 * A `Verifier` an embedder wrote against the two-boolean contract returns no
 * `status`. It is read the way that contract always meant it — with the one
 * correction that a run marked `timedOut` did not fail.
 */
describe("verifyOutcome reads a pre-tri-state result", () => {
  const legacy = (passed: boolean, ran: boolean, runs?: Array<Record<string, unknown>>) =>
    ({ passed, ran, report: "", ...(runs ? { runs } : {}) }) as Parameters<typeof verifyOutcome>[0];

  test.each([
    ["ran and passed", legacy(true, true), { status: "passed" }],
    ["ran and failed", legacy(false, true), { status: "failed" }],
    ["did not run", legacy(true, false), { status: "inconclusive", reason: "no_checks" }],
    [
      "did not run, passed false",
      legacy(false, false),
      { status: "inconclusive", reason: "no_checks" },
    ],
    [
      "failed, but the run was a timeout",
      legacy(false, true, [{ command: "x", passed: false, timedOut: true }]),
      { status: "inconclusive", reason: "timeout" },
    ],
    [
      "failed, but the run was cancelled",
      legacy(false, true, [{ command: "x", passed: false, cancelled: true }]),
      { status: "inconclusive", reason: "cancelled" },
    ],
  ])("%s", (_name, result, expected) => {
    expect(verifyOutcome(result)).toEqual(expected as ReturnType<typeof verifyOutcome>);
  });

  test("a stated status wins over the legacy pair", () => {
    expect(
      verifyOutcome({ status: "inconclusive", reason: "timeout", passed: true, ran: true }),
    ).toEqual({ status: "inconclusive", reason: "timeout" });
  });
});

/**
 * V1 — the project's own test script is what runs.
 *
 * These assert BEHAVIOUR, not the command string: each fixture is a real Bun
 * project that the verifier actually executes. `bun test` in place of
 * `bun run test` fails both — the first by collecting a suite the script
 * excludes, the second by dropping the environment the script sets.
 */
const BUN_TEST = (name: string, body: string) =>
  `import { test, expect } from "bun:test";\ntest(${JSON.stringify(name)}, () => { ${body} });\n`;

describe.skipIf(!POSIX_SHELL)("a declared test script is what runs", () => {
  test("the script's suite passes even though an unrelated suite in the tree fails", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "bun test unit" } }),
      "bun.lock": "",
      "unit/ok.test.ts": BUN_TEST("declared suite", "expect(1).toBe(1);"),
      "outside/unrelated.test.ts": BUN_TEST("excluded suite", "expect(1).toBe(2);"),
    });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("the script's arguments and setup reach the run", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "FROM_SCRIPT=1 bun test unit" } }),
      "bun.lock": "",
      "unit/env.test.ts": BUN_TEST(
        "sees the script's setup",
        'expect(process.env.FROM_SCRIPT).toBe("1");',
      ),
    });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("a script that really fails still fails", async () => {
    const dir = await tmpWorkspace({
      "package.json": JSON.stringify({ scripts: { test: "bun test unit" } }),
      "bun.lock": "",
      "unit/red.test.ts": BUN_TEST("declared and red", "expect(1).toBe(2);"),
    });
    const r = await new CommandVerifier({ workspaceRoot: dir }).verify();
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
