/**
 * Count only real failures (the founder's call, 2026-10-22).
 *
 * The dogfood re-run on 1.4.14: every end-of-turn check passed on Rune's own
 * source and the request check found 13 of 13 asks, and `done` was still
 * refused, by what the agent saw while investigating a test that failed only
 * inside its sandbox:
 *   - that test file's red run, which the suite that passed also ran;
 *   - the same file run in a copy of the repository the agent built;
 *   - `test -d … && rm -r …`, the shell's own conditional, logged as a check.
 * Each rule has a test that breaks if the rule goes, and each refusal a test
 * that breaks if the rule starts excusing too much.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVerificationCommand } from "../../../packages/orchestrator/src/brief";
import { coveredBySuite, ranInScratchCopy } from "../../../packages/orchestrator/src/check-scope";
import { bunTestRun } from "../../../packages/orchestrator/src/verification-command";
import { bunTestScope, type DetectedCheck } from "../../../packages/orchestrator/src/verifier";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("the shell's own `test` and `[` are not checks", () => {
  test.each([
    "test -d node_modules/.bun && test -d .copy/node_modules/.bun && rm -r .copy",
    "[ -f dist/index.js ]",
    "test -e out.txt",
  ])("%s", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });

  test("a script named test is still one", () => {
    expect(isVerificationCommand("./test --all")).toBe(true);
    expect(isVerificationCommand("scripts/test")).toBe(true);
  });

  test("a real check after a conditional still counts", () => {
    expect(isVerificationCommand("test -d node_modules && bun test tests/unit")).toBe(true);
  });
});

describe("reading a `bun test` run", () => {
  test("its targets, past the options that take a value", () => {
    expect(
      bunTestRun('bun test --preload "$PWD/x/setup.ts" --timeout 9000 tests/unit/a.test.ts'),
    ).toEqual({ cds: [], targets: ["tests/unit/a.test.ts"] });
  });

  test("where it moved to first, and everything after `--`", () => {
    expect(bunTestRun("cd packages/app && bun test -- src")).toEqual({
      cds: ["packages/app"],
      targets: ["src"],
    });
  });

  test("not `bun test`, or a substitution in a place: nothing to read", () => {
    expect(bunTestRun("npx vitest run")).toBeNull();
    expect(bunTestRun("bun test $(ls tests)")).toBeNull();
  });
});

/** A committed repository with tracked `tests/` and `src/`. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "rune-check-scope-"));
  made.push(root);
  mkdirSync(join(root, "tests", "unit"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tests", "unit", "a.test.ts"), "// a\n");
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // A copy of the project, made during the run, that git tracks nothing in.
  mkdirSync(join(root, ".copy", "tests", "unit"), { recursive: true });
  writeFileSync(join(root, ".copy", "tests", "unit", "a.test.ts"), "// copy\n");
  // A new test file the run wrote: untracked, but under tracked `tests/`.
  writeFileSync(join(root, "tests", "unit", "new.test.ts"), "// new\n");
  return root;
}

describe("a test run against a copy of the project is not the project's check", () => {
  test("files in a folder git tracks nothing in: a copy", () => {
    const root = repo();
    expect(ranInScratchCopy('bun test "$PWD/.copy/tests/unit/a.test.ts"', root)).toBe(true);
    expect(ranInScratchCopy("bun test .copy/tests/unit", root)).toBe(true);
    expect(ranInScratchCopy("cd .copy && bun test tests/unit/a.test.ts", root)).toBe(true);
  });

  test("files outside the workspace: a copy", () => {
    const root = repo();
    expect(ranInScratchCopy("bun test /tmp/rune-copy-abc/tests/unit/a.test.ts", root)).toBe(true);
  });

  test("a new test file the run wrote is the project's", () => {
    const root = repo();
    expect(ranInScratchCopy("bun test tests/unit/new.test.ts", root)).toBe(false);
    expect(ranInScratchCopy("bun test tests/unit/a.test.ts", root)).toBe(false);
  });

  test("a new folder of new tests mirrors nothing: it stays the project's check", () => {
    // Untracked like a copy, but no tail of its path is a tracked path. A run
    // that adds a test suite in a new folder and sees it fail must not have
    // that failure called someone else's.
    const root = repo();
    mkdirSync(join(root, "e2e"));
    writeFileSync(join(root, "e2e", "flow.test.ts"), "// new suite\n");
    expect(ranInScratchCopy("bun test e2e/flow.test.ts", root)).toBe(false);
    expect(ranInScratchCopy("bun test /tmp/elsewhere/flow.test.ts", root)).toBe(false);
  });

  test("a package that mirrors the root's layout is still the project's", () => {
    // `web/src/x.test.ts` has a tail, `src/x.test.ts`, that git tracks at the
    // root too; but `web/` is tracked, so it is a package, not a copy.
    const root = repo();
    mkdirSync(join(root, "web", "src"), { recursive: true });
    writeFileSync(join(root, "src", "x.test.ts"), "// root\n");
    writeFileSync(join(root, "web", "src", "x.test.ts"), "// package\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "pkg"],
      { cwd: root, stdio: "ignore" },
    );
    expect(ranInScratchCopy("bun test web/src/x.test.ts", root)).toBe(false);
  });

  test("one target in the project is enough to keep it the project's", () => {
    const root = repo();
    expect(ranInScratchCopy("bun test .copy/tests/unit tests/unit/a.test.ts", root)).toBe(false);
  });

  test("what cannot be read is the project's: no targets, a variable, no git", () => {
    const root = repo();
    expect(ranInScratchCopy("bun test", root)).toBe(false);
    expect(ranInScratchCopy("bun test $COPY/tests", root)).toBe(false);
    const plain = mkdtempSync(join(tmpdir(), "rune-check-scope-nogit-"));
    made.push(plain);
    mkdirSync(join(plain, ".copy"));
    expect(ranInScratchCopy("bun test .copy/a.test.ts", plain)).toBe(false);
  });
});

describe("a red test-file run is covered by a suite that passed and ran it", () => {
  test("inside the suite's scope, however the path is spelled", () => {
    for (const command of [
      "bun test tests/unit/probes/t20-background-lifecycle.test.ts",
      "bun test ./tests/unit/a.test.ts",
      "bun test $PWD/tests/unit/a.test.ts",
      "bun test tests/unit",
    ]) {
      expect(coveredBySuite(command, ["tests/unit"]), command).toBe(true);
    }
  });

  test("outside it, or not readable as a place in it: not covered", () => {
    for (const command of [
      "bun test tests/integration/x.test.ts",
      "bun test tests/unit/a.test.ts tests/integration/x.test.ts",
      "bun test tests",
      "bun test",
      "cd tests && bun test unit/a.test.ts",
      // Really `web/tests/unit/a.test.ts`: read from the root it would look covered.
      "cd web && bun test tests/unit/a.test.ts",
      "bun test /abs/tests/unit/a.test.ts",
      "bun test $HOME/tests/unit/a.test.ts",
      "bun test ../tests/unit/a.test.ts",
      "npx vitest run tests/unit/a.test.ts",
    ]) {
      expect(coveredBySuite(command, ["tests/unit"]), command).toBe(false);
    }
  });

  test("a suite of the whole workspace covers any file in it; no suite covers nothing", () => {
    expect(coveredBySuite("bun test tests/integration/x.test.ts", [""])).toBe(true);
    expect(coveredBySuite("bun test tests/unit/a.test.ts", [])).toBe(false);
  });
});

describe("what a passing suite covers, read from its own script", () => {
  function project(
    scripts: Record<string, string>,
    nested = "",
  ): { root: string; check: DetectedCheck } {
    const root = mkdtempSync(join(tmpdir(), "rune-suite-scope-"));
    made.push(root);
    mkdirSync(join(root, nested), { recursive: true });
    writeFileSync(join(root, nested, "package.json"), JSON.stringify({ name: "app", scripts }));
    return {
      root,
      check: { ecosystem: "js", kind: "test", project: nested, command: "bun run test" },
    };
  }

  test("the folders its script names", () => {
    const { root, check } = project({ test: "bun test tests/unit/" });
    expect(bunTestScope(root, check)).toEqual(["tests/unit"]);
  });

  test("none named: the whole project, prefixed by where the project is", () => {
    const top = project({ test: "bun test" });
    expect(bunTestScope(top.root, top.check)).toEqual([""]);
    const nested = project({ test: "bun test src" }, "web");
    expect(bunTestScope(nested.root, nested.check)).toEqual(["web/src"]);
  });

  test("not a bun test suite, or not readable: no scope", () => {
    const vitest = project({ test: "vitest run" });
    expect(bunTestScope(vitest.root, vitest.check)).toBeNull();
    const variable = project({ test: "bun test $SUITE" });
    expect(bunTestScope(variable.root, variable.check)).toBeNull();
    const typecheck = project({ typecheck: "tsc" });
    expect(
      bunTestScope(typecheck.root, {
        ...typecheck.check,
        kind: "typecheck",
        command: "bun run typecheck",
      }),
    ).toBeNull();
  });
});
