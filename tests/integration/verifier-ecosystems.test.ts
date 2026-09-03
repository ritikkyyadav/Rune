/**
 * P10.4 — the detected commands, actually run.
 *
 * The unit tests assert what detection EMITS from a directory layout. This file
 * asserts that what it emits works: the passing fixture verifies green, the
 * failing fixture verifies red, and the step check refuses a step that broke the
 * build. A detection table nobody ever executed is a table of guesses.
 *
 * Every case skips cleanly, with a printed reason, when its toolchain is not on
 * the machine. CI's ubuntu runner has Go, Python and Java preinstalled and Rust
 * from the existing toolchain step, so all four run there; a developer laptop
 * runs whatever it has and says which it did not.
 *
 * The fixtures are copied to a temp directory before anything runs: `go build`
 * and `cargo check` write into the tree, and a test suite must not dirty the
 * repository it lives in.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandVerifier, detectVerifyCommands } from "../../packages/orchestrator/src/verifier";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "verifier");

/**
 * Is this toolchain on the machine, and does it WORK?
 *
 * `Bun.which` is not enough. macOS ships `/usr/bin/javac` on every machine as a
 * stub that exits 1 with "Unable to locate a Java Runtime" when no JDK is
 * installed — a which-based probe says Java is present and the suite then fails
 * on a machine that never had a compiler. The probe has to run the thing.
 */
function have(bin: string, versionFlag = "--version"): boolean {
  if (Bun.which(bin) == null) return false;
  try {
    const proc = Bun.spawnSync([bin, versionFlag], { stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const TOOLCHAINS = {
  go: have("go", "version"),
  python: have("python3"),
  rust: have("cargo"),
  java: have("javac", "-version"),
} as const;

/**
 * On a laptop a missing toolchain is a clean skip. In CI it is a hole in the
 * gate: the ubuntu runner ships Go, Python and Java, and the workflow installs
 * Rust, so a skip there means the ecosystem went unproven while the job stayed
 * green. `GEAR_VERIFIER_REQUIRE_TOOLCHAINS` (set by ci.yml) turns the skip into
 * a failure that names what is missing.
 */
const REQUIRED = (process.env.GEAR_VERIFIER_REQUIRE_TOOLCHAINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// One line, at load, saying exactly what this run proved and what it did not.
// A silently skipped suite reads as a passing one.
console.log(
  `\n  verifier integration — toolchains on this machine: ` +
    Object.entries(TOOLCHAINS)
      .map(([name, ok]) => `${name} ${ok ? "yes" : "NO (skipping)"}`)
      .join(" · ") +
    (REQUIRED.length > 0 ? `  [required here: ${REQUIRED.join(", ")}]` : "") +
    "\n",
);

const temps: string[] = [];

/** A throwaway copy of a fixture: these commands write into the tree. */
function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gear-verify-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  temps.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** Toolchain builds can be slow on a cold cache; give them room. */
const TIMEOUT = 240_000;

describe("Go", () => {
  test.skipIf(!TOOLCHAINS.go)(
    "the passing fixture builds, vets and tests green",
    async () => {
      const dir = copyFixture("go-pass");
      expect(detectVerifyCommands(dir)).toEqual([
        "go build ./...",
        "go test ./...",
        "go vet ./...",
      ]);
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verify();
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(true);
      expect((r.runs ?? []).every((x) => x.exitCode === 0)).toBe(true);
    },
    TIMEOUT,
  );

  test.skipIf(!TOOLCHAINS.go)(
    "the failing fixture is refused by the step check",
    async () => {
      const dir = copyFixture("go-fail");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verifyFast(
        undefined,
        ["main.go"],
      );
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.runs![0]!.command).toBe("go build ./...");
      expect(r.runs![0]!.exitCode).not.toBe(0);
      expect(r.report).toContain("main.go");
    },
    TIMEOUT,
  );
});

describe("Python", () => {
  test.skipIf(!TOOLCHAINS.python)(
    "the passing fixture's unittest discovery runs green",
    async () => {
      const dir = copyFixture("python-pass");
      expect(detectVerifyCommands(dir)).toEqual(["python3 -m unittest discover -q"]);
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 60_000 }).verify();
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(true);
    },
    TIMEOUT,
  );

  test.skipIf(!TOOLCHAINS.python)(
    "a file that does not compile is refused by the step check",
    async () => {
      const dir = copyFixture("python-fail");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 60_000 }).verifyFast(
        undefined,
        ["calc.py"],
      );
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.runs![0]!.command).toBe("python3 -m py_compile 'calc.py'");
      expect(r.report).toMatch(/SyntaxError|invalid syntax/);
    },
    TIMEOUT,
  );
});

describe("Rust", () => {
  test.skipIf(!TOOLCHAINS.rust)(
    "the passing fixture checks and tests green",
    async () => {
      const dir = copyFixture("rust-pass");
      expect(detectVerifyCommands(dir)).toEqual(["cargo check --quiet", "cargo test --quiet"]);
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verify();
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(true);
    },
    TIMEOUT,
  );

  test.skipIf(!TOOLCHAINS.rust)(
    "the failing fixture is refused by the step check",
    async () => {
      const dir = copyFixture("rust-fail");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verifyFast(
        undefined,
        ["src/lib.rs"],
      );
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.runs![0]!.command).toBe("cargo check --quiet");
      expect(r.report).toMatch(/mismatched types|cannot add/);
    },
    TIMEOUT,
  );
});

describe("Java", () => {
  test.skipIf(!TOOLCHAINS.java)(
    "a bare Java tree compiles with javac",
    async () => {
      const dir = copyFixture("java-pass");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 120_000 }).verify();
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(true);
      expect(r.runs![0]!.command).toStartWith('javac -d "$(mktemp -d)"');
    },
    TIMEOUT,
  );

  test.skipIf(!TOOLCHAINS.java)(
    "a broken Java file is refused by the step check",
    async () => {
      const dir = copyFixture("java-fail");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 120_000 }).verifyFast(
        undefined,
        ["Main.java"],
      );
      expect(r.ran).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.report).toContain("Main.java");
    },
    TIMEOUT,
  );
});

describe("a monorepo runs each project's checks", () => {
  test.skipIf(!TOOLCHAINS.go)(
    "the step check compiles only the Go service when only it changed",
    async () => {
      const dir = copyFixture("monorepo");
      const r = await new CommandVerifier({ workspaceRoot: dir, timeoutMs: 180_000 }).verifyFast(
        undefined,
        ["services/api/main.go"],
      );
      expect((r.runs ?? []).map((x) => x.command)).toEqual(["cd services/api && go build ./..."]);
      expect(r.passed).toBe(true);
      expect(r.ran).toBe(true);
    },
    TIMEOUT,
  );
});

describe("the environment this suite ran in", () => {
  test("every toolchain this environment promised is actually here", () => {
    const missing = REQUIRED.filter((name) => !TOOLCHAINS[name as keyof typeof TOOLCHAINS]);
    expect(
      missing,
      `GEAR_VERIFIER_REQUIRE_TOOLCHAINS names ${REQUIRED.join(", ")}, but ${missing.join(
        ", ",
      )} could not run here — those ecosystems went unproven while this job stayed green.`,
    ).toEqual([]);
  });
});

describe("an absent toolchain", () => {
  test("is reported as skipped rather than failing the run", async () => {
    const dir = copyFixture("go-pass");
    const r = await new CommandVerifier({
      workspaceRoot: dir,
      // Stand in for the machine that has no Go: the same shape, a name that
      // is guaranteed absent everywhere.
      commands: ["gear-absent-toolchain-probe build ./..."],
      timeoutMs: 30_000,
    }).verify();
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(false);
    expect(r.runs![0]!.skipped).toContain("not installed");
  });
});
