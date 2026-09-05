/**
 * P10.4 — the step check across ecosystems, and the record it leaves.
 *
 * Two claims are under test here, both of which the old code could not make:
 *
 *  1. In a workspace holding several projects, the step check runs the one
 *     whose files the step touched — not all of them, and not none.
 *  2. The evidence ledger records WHICH command ran, its exit code and its
 *     duration. It used to hold a count and a boolean, so `rune audit` could
 *     report that a step was checked without being able to say by what.
 *
 * The commands here are shell builtins (`true`, `exit 3`) rather than real
 * toolchains: this file asserts the plumbing, and tests/integration/ asserts
 * that the detected commands are the right ones by running them.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandVerifier } from "../../../packages/orchestrator/src/verifier";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

const POSIX_SHELL = process.platform !== "win32";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "rune-step-check-"));
}

/** A three-project workspace: a Go service, a JS app, a Rust lib. */
function polyglot(): string {
  const dir = workspace();
  mkdirSync(join(dir, "services", "api"), { recursive: true });
  writeFileSync(join(dir, "services", "api", "go.mod"), "module api\n");
  mkdirSync(join(dir, "apps", "web"), { recursive: true });
  writeFileSync(
    join(dir, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", scripts: { typecheck: "tsc --noEmit" } }),
  );
  mkdirSync(join(dir, "libs", "core", "src"), { recursive: true });
  writeFileSync(join(dir, "libs", "core", "Cargo.toml"), "[workspace]\n[package]\nname='core'\n");
  return dir;
}

describe.skipIf(!POSIX_SHELL)("the step check picks the project the step touched", () => {
  test("a Go edit runs go build, and only that", async () => {
    const dir = polyglot();
    try {
      const v = new CommandVerifier({ workspaceRoot: dir, timeoutMs: 5_000 });
      const r = await v.verifyFast(undefined, ["services/api/main.go"]);
      const commands = (r.runs ?? []).map((x) => x.command);
      expect(commands).toEqual(["cd services/api && go build ./..."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Rust edit runs cargo check, and only that", async () => {
    const dir = polyglot();
    try {
      const v = new CommandVerifier({ workspaceRoot: dir, timeoutMs: 5_000 });
      const r = await v.verifyFast(undefined, ["libs/core/src/lib.rs"]);
      expect((r.runs ?? []).map((x) => x.command)).toEqual(["cd libs/core && cargo check --quiet"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with nothing touched, every project's compile check is fair game", async () => {
    const dir = polyglot();
    try {
      // Overridden to shell builtins so this asserts the SELECTION, not
      // whether Go, Node and Rust happen to be installed on this machine.
      const ecosystems = {
        go: { commands: ["true"] },
        js: { commands: ["true"] },
        rust: { commands: ["true"] },
      };
      const v = new CommandVerifier({ workspaceRoot: dir, timeoutMs: 5_000, ecosystems });
      const all = await v.verifyFast();
      expect((all.runs ?? []).map((x) => x.command).sort()).toEqual([
        "cd apps/web && true",
        "cd libs/core && true",
        "cd services/api && true",
      ]);
      const scoped = await v.verifyFast(undefined, ["services/api/main.go"]);
      expect((scoped.runs ?? []).map((x) => x.command)).toEqual(["cd services/api && true"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the test tier never runs at a step boundary", async () => {
    const dir = workspace();
    try {
      writeFileSync(join(dir, "go.mod"), "module x\n");
      writeFileSync(join(dir, "main_test.go"), "package main\n");
      const v = new CommandVerifier({ workspaceRoot: dir, timeoutMs: 5_000 });
      const r = await v.verifyFast(undefined, ["main.go"]);
      expect((r.runs ?? []).map((x) => x.command)).toEqual(["go build ./..."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Python project with no typechecker compiles the touched file", async () => {
    const dir = workspace();
    try {
      writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="x"\nversion="0"\n');
      writeFileSync(join(dir, "thing.py"), "def f():\n    return 1\n");
      const v = new CommandVerifier({ workspaceRoot: dir, timeoutMs: 20_000 });
      const r = await v.verifyFast(undefined, ["thing.py"]);
      expect((r.runs ?? []).map((x) => x.command)).toEqual(["python3 -m py_compile 'thing.py'"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!POSIX_SHELL)("what the verifier records about each command", () => {
  test("a passing command carries its exit code and a duration", async () => {
    const dir = workspace();
    try {
      const seen: Array<{ command: string; exitCode?: number; durationMs?: number }> = [];
      const v = new CommandVerifier({
        workspaceRoot: dir,
        commands: ["true"],
        onCheck: (run) => seen.push(run),
      });
      const r = await v.verify();
      expect(r.passed).toBe(true);
      expect(r.runs).toHaveLength(1);
      expect(r.runs![0]!.exitCode).toBe(0);
      expect(r.runs![0]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(seen[0]!.exitCode).toBe(0);
      expect(typeof seen[0]!.durationMs).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing command records the code it actually exited with", async () => {
    const dir = workspace();
    try {
      const v = new CommandVerifier({ workspaceRoot: dir, commands: ["exit 3"] });
      const r = await v.verify();
      expect(r.passed).toBe(false);
      expect(r.runs![0]!.exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent toolchain is 'cannot check', not 'check failed'", async () => {
    const dir = workspace();
    try {
      const v = new CommandVerifier({
        workspaceRoot: dir,
        commands: ["rune-no-such-compiler-xyz build ./..."],
      });
      const r = await v.verify();
      // Nothing ran, so nothing is proven — but the run is not a failure, and
      // the reason is on the record.
      expect(r.passed).toBe(true);
      expect(r.ran).toBe(false);
      expect(r.runs![0]!.skipped).toContain("rune-no-such-compiler-xyz");
      expect(r.report).toContain("not installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an OS stub binary counts as absent, whatever it exits with", async () => {
    // macOS ships /usr/bin/javac on every machine. With no JDK installed it
    // exits 1 — not 127 — with this message, and reporting "Java checks FAILED"
    // on a machine that never had a compiler would be lying about the code.
    const dir = workspace();
    try {
      const v = new CommandVerifier({
        workspaceRoot: dir,
        commands: [
          "echo 'The operation could not be completed. Unable to locate a Java Runtime.' >&2; exit 1",
        ],
      });
      const r = await v.verify();
      expect(r.passed).toBe(true);
      expect(r.ran).toBe(false);
      expect(r.runs![0]!.skipped).toContain("no JDK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a project script that exits 127 for its OWN reasons still fails", async () => {
    const dir = workspace();
    try {
      const v = new CommandVerifier({
        workspaceRoot: dir,
        // The command exists; something inside it did not.
        commands: ["bash -c 'echo inner-thing: command not found >&2; exit 127'"],
      });
      const r = await v.verify();
      expect(r.passed).toBe(false);
      expect(r.ran).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the evidence ledger keeps the command, the code and the clock", () => {
  test("a harness check lands in the spine's check list", () => {
    const ts = new TaskStateStore();
    ts.beginTurn("build the thing");
    ts.setTodos([{ content: "write the parser", status: "in_progress" }]);
    ts.noteEffect("check_pass", {
      command: "go build ./...",
      summary: "ok",
      exitCode: 0,
      durationMs: 1234,
      source: "harness",
    });

    expect(ts.checks).toHaveLength(1);
    expect(ts.checks[0]).toMatchObject({
      command: "go build ./...",
      passed: true,
      exitCode: 0,
      durationMs: 1234,
      source: "harness",
    });
    const step = ts.todos[0]!;
    expect(step.evidence?.lastCheck).toMatchObject({
      passed: true,
      command: "go build ./...",
      exitCode: 0,
      durationMs: 1234,
    });
  });

  test("a model-run check is recorded as the model's, with no invented code", () => {
    const ts = new TaskStateStore();
    ts.beginTurn("g");
    ts.setTodos([{ content: "s", status: "in_progress" }]);
    ts.noteEffect("check_fail", { command: "bun test", summary: "2 failing" });
    expect(ts.checks[0]).toMatchObject({ source: "model", passed: false });
    // No data is absent, never zero — a fabricated `exit 0` beside a failure
    // would be worse than no number at all.
    expect(ts.checks[0]!.exitCode).toBeUndefined();
    expect(ts.checks[0]!.durationMs).toBeUndefined();
  });

  test("the end-of-run verifier's commands land there too, skips excluded", () => {
    const ts = new TaskStateStore();
    ts.beginTurn("g");
    ts.noteVerification(true, true, "$ go build ./...  (ok)", [
      { command: "go build ./...", passed: true, exitCode: 0, durationMs: 900 },
      {
        command: "cargo check --quiet",
        passed: true,
        exitCode: null,
        durationMs: 2,
        skipped: "cargo is not installed on this machine",
      },
    ]);
    expect(ts.checks.map((c) => c.command)).toEqual(["go build ./..."]);
    const log = ts.snapshot().log ?? [];
    expect(log.at(-1)!.text).toContain("go build ./...");
    expect(log.at(-1)!.text).toContain("1 skipped");
  });

  test("files written since the last accepted plan are the step's own", () => {
    const ts = new TaskStateStore();
    ts.beginTurn("g");
    ts.setTodos([{ content: "step one", status: "in_progress" }]);
    for (const f of ["services/api/main.go", "services/api/util.go"]) {
      ts.noteEffect("write");
      ts.noteFileWritten(f);
    }
    expect(ts.touchedFiles).toEqual(["services/api/main.go", "services/api/util.go"]);
    // An ACCEPTED list closes the books on that step's writes.
    const verdict = ts.setTodos([{ content: "step one", status: "completed" }]);
    expect(verdict.accepted).toBe(true);
    expect(ts.touchedFiles).toEqual([]);
  });
});
