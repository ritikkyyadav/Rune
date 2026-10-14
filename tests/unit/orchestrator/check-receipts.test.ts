/**
 * A pass the runtime already watched is reused only when it IS that pass.
 *
 * check-receipts.ts lets the end-of-turn verifier skip a check the run itself
 * ran green on the unchanged tree. Three mechanical answers stand between that
 * and a verification that verified nothing, and each is held here from the
 * side that matters:
 *
 *   · "this line's exit status speaks for that command" — wrong, and a failing
 *     suite hidden behind `| tail` is recorded as a pass. So the claim is
 *     tested against real shells, not against the recogniser's own idea of a
 *     shell: every line it accepts is run with the check failing, and has to
 *     fail.
 *   · "the tree is what it was" — wrong, and a pass is carried across an edit.
 *   · "these two commands are the same check" — wrong, and a pass of one
 *     suite stands in for another.
 *
 * A wrong "no" in any of them costs one repeated check. A wrong "yes" costs
 * the verdict.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PassLedger,
  equivalentCommands,
  faithfullyReports,
  shellHonoursPipeIdioms,
  workTreeFingerprint,
} from "../../../packages/orchestrator/src/check-receipts";
import { rmTemp } from "../../helpers/tmp";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmTemp(dir);
});
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const speaksFor = (line: string) => faithfullyReports(line, { pipeIdioms: true });

describe("which commands a line's exit status speaks for", () => {
  const yes: Array<[string, string, string[]]> = [
    ["a command alone", "bun test tests/unit/", ["bun test tests/unit/"]],
    [
      "each link of an && chain",
      "bun run typecheck && bun run test",
      ["bun run typecheck", "bun run test"],
    ],
    ["a command with its errors folded into its output", "bun test 2>&1", ["bun test"]],
    [
      "the recorded line: the option, then the suite through tail",
      "set -o pipefail; bun test tests/unit/ 2>&1 | tail -n 8",
      ["bun test tests/unit/"],
    ],
    [
      "the option with the other strictness letters",
      "set -euo pipefail; bun test | tail -5",
      ["bun test"],
    ],
    [
      "the other recorded line: the first stage's status asked for by name",
      "bun run --cwd packages/shared test 2>&1 | tail -n 7; test ${PIPESTATUS[0]} -eq 0",
      ["bun run --cwd packages/shared test"],
    ],
    ["the same in brackets", "bun test | head -n 20; [ ${PIPESTATUS[0]} -eq 0 ]", ["bun test"]],
    [
      "a chain before the guarded pipe",
      "set -o pipefail; bun run typecheck && bun test | tail -n 3",
      ["bun run typecheck", "bun test"],
    ],
    ["a check somewhere else keeps where", "cd api && go test ./...", ["cd api && go test ./..."]],
    [
      "a quoted argument holding an operator",
      `bun test "a && b.test.ts"`,
      [`bun test "a && b.test.ts"`],
    ],
    ["a line continued with a backslash", "bun test \\\n  tests/unit/", ["bun test tests/unit/"]],
    ["extra spaces", "bun   test    tests/unit/", ["bun test tests/unit/"]],
  ];
  for (const [why, line, commands] of yes) {
    test(`${why}: ${line.replace(/\n/g, " ⏎ ")}`, () => {
      expect(speaksFor(line)).toEqual(commands);
    });
  }

  const no: Array<[string, string]> = [
    ["a pipe with nothing guarding it speaks for its last stage", "bun test | tail -n 8"],
    ["the same with errors folded in", "bun test tests/unit/ 2>&1 | tail -n 8"],
    [
      "the option set only if something else succeeded",
      "rm -rf dist && set -o pipefail; bun test | tail -n 8",
    ],
    ["the option set after the pipe", "bun test | tail -n 8; set -o pipefail"],
    ["the option switched off again", "set -o pipefail; set +o pipefail; bun test | tail -n 8"],
    ["a fallback after the check", "bun test || true"],
    ["a fallback inside the chain", "bun run typecheck || true && bun test"],
    ["a status check with no pipe to be about", "bun test; test ${PIPESTATUS[0]} -eq 0"],
    [
      "the second stage's status, not the first",
      "bun test | tail -n 8; test ${PIPESTATUS[1]} -eq 0",
    ],
    [
      "a status check that is not the last thing",
      "bun test | tail; test ${PIPESTATUS[0]} -eq 0; echo done",
    ],
    [
      "the status spelling that passes when the name is empty",
      "bun test | tail -n 8; exit ${PIPESTATUS[0]}",
    ],
    ["the other one", "bun test | tail -n 8; [[ ${PIPESTATUS[0]} -eq 0 ]]"],
    [
      "a quoted name, which some shells read as zero",
      'bun test | tail -n 8; test "${PIPESTATUS[0]}" -eq 0',
    ],
    ["a stage that is not a trimmer", "set -o pipefail; bun test | grep -v skip"],
    ["a trimmer that can do more", "set -o pipefail; bun test | tail -n 8 -f"],
    ["two pipes", "set -o pipefail; bun test | sort | tail -n 8"],
    ["an earlier list, whose failure the shell discards", "rm -rf dist; bun test"],
    ["a list that could redefine the command", "alias bun=true; bun test"],
    ["output sent to a file", "bun test > /tmp/out.log 2>&1"],
    ["input from a file", "bun test < /dev/null"],
    ["a substitution", "bun test $(ls tests)"],
    ["a backtick substitution", "bun test `ls tests`"],
    ["a substitution in a quoted argument", 'bun test "$(ls tests)"'],
    ["a subshell", "(bun test)"],
    ["a group", "{ bun test; }"],
    ["a function", "bun() { true; }; bun test"],
    ["a background job", "bun test &"],
    ["a comment that could hide the rest", "bun test # || true"],
    ["an unclosed quote", "bun test 'tests"],
    ["a change of directory in the middle", "bun run typecheck && cd api && go test ./..."],
    ["two changes of directory", "cd a && cd b && bun test"],
    ["a shell option among the commands", "set -e && bun test"],
    ["nothing", ""],
    ["only separators", " ; "],
  ];
  for (const [why, line] of no) {
    test(`not ${why}: ${line}`, () => {
      expect(speaksFor(line)).toEqual([]);
    });
  }

  test("an environment prefix, a wrapper and a negation are other commands, not this one", () => {
    // Reported, verbatim — and so never equal to the check they wrap.
    expect(speaksFor("CI=1 bun test")).toEqual(["CI=1 bun test"]);
    expect(speaksFor("time bun test")).toEqual(["time bun test"]);
    expect(speaksFor("! bun test")).toEqual(["! bun test"]);
  });

  test("where the shell is not known to mean the pipe idioms, they are not read", () => {
    const plain = (line: string) => faithfullyReports(line, { pipeIdioms: false });
    expect(plain("set -o pipefail; bun test | tail -n 8")).toEqual([]);
    expect(plain("bun test | tail -n 8; test ${PIPESTATUS[0]} -eq 0")).toEqual([]);
    // A chain needs no idiom.
    expect(plain("bun run typecheck && bun test")).toEqual(["bun run typecheck", "bun test"]);
  });
});

describe("the shell that runs the agent's commands", () => {
  test("the default `/bin/sh` is trusted; a chosen shell only when it is bash by name", () => {
    expect(shellHonoursPipeIdioms({}, "darwin")).toBe(true);
    expect(shellHonoursPipeIdioms({ RUNE_SHELL: "" }, "linux")).toBe(true);
    expect(shellHonoursPipeIdioms({ RUNE_SHELL: "/bin/bash" }, "linux")).toBe(true);
    expect(shellHonoursPipeIdioms({ RUNE_SHELL: "/bin/sh" }, "linux")).toBe(true);
    for (const shell of ["/usr/bin/fish", "/bin/zsh", "/bin/ksh", "nu", "/opt/x/bash-like"]) {
      expect(shellHonoursPipeIdioms({ RUNE_SHELL: shell }, "linux")).toBe(false);
    }
    // Windows may be running `cmd.exe`, where none of this is syntax.
    expect(shellHonoursPipeIdioms({}, "win32")).toBe(false);
    expect(shellHonoursPipeIdioms({ RUNE_SHELL: "C:\\Git\\bin\\bash.exe" }, "win32")).toBe(false);
  });
});

// Real shells, at their usual paths: none of this is reachable on Windows,
// where there is no `/bin/sh` to run — and where `shellHonoursPipeIdioms` says
// no to all of it anyway.
describe.skipIf(!existsSync("/bin/sh"))(
  "every accepted line, run in a real shell with the check failing, fails",
  () => {
    // `./check` exits with whatever `status` holds. A line is run twice in each
    // shell: once with the check passing, once failing. If the recogniser says
    // the line speaks for `./check`, the failing run has to exit non-zero —
    // whatever the shell, because a shell that reads an idiom differently must
    // read it as a failure, never as a pass.
    const LINES = [
      "./check",
      "./check && true",
      "true && ./check",
      "./check 2>&1",
      "set -o pipefail; ./check | tail -n 8",
      "set -o pipefail; ./check 2>&1 | tail -n 8",
      "set -euo pipefail; ./check | tail -5",
      "set -o pipefail; true && ./check | head -n 3",
      "./check | tail -n 8; test ${PIPESTATUS[0]} -eq 0",
      "./check 2>&1 | tail -n 7; test ${PIPESTATUS[0]} -eq 0",
      "./check | head -n 20; [ ${PIPESTATUS[0]} -eq 0 ]",
      "true && ./check | tail -n 2; test ${PIPESTATUS[0]} -eq 0",
      // Lines the recogniser must NOT accept, here so that the table shows why:
      // each of these exits 0 with the check failing in at least one shell.
      "./check | tail -n 8",
      "./check || true",
      "./check; true",
      "./check | tail -n 8; exit ${PIPESTATUS[0]}",
      "./check | tail -n 8; [[ ${PIPESTATUS[0]} -eq 0 ]]",
      // The option is set only if the command before it succeeded. Here it did
      // not, so the pipe runs unguarded — which is why a conditional `set` is
      // refused even though the same line is honest whenever that command passes.
      "false && set -o pipefail; ./check | tail -n 8",
    ];
    const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash", "/bin/ksh"].filter((s) =>
      existsSync(s),
    );

    function fixture(): string {
      const dir = scratch("rune-receipt-shell-");
      writeFileSync(join(dir, "check"), '#!/bin/sh\necho checked\nexit "$(cat status)"\n');
      chmodSync(join(dir, "check"), 0o755);
      return dir;
    }
    const exitOf = (shell: string, line: string, dir: string, status: 0 | 1): number | null => {
      writeFileSync(join(dir, "status"), String(status));
      return spawnSync(shell, ["-c", line], { cwd: dir, stdio: "ignore", timeout: 10_000 }).status;
    };

    test.each(SHELLS)("%s", (shell) => {
      const dir = fixture();
      const wrong: string[] = [];
      let accepted = 0;
      for (const line of LINES) {
        if (!speaksFor(line).includes("./check")) continue;
        accepted++;
        if (exitOf(shell, line, dir, 1) === 0) wrong.push(line);
      }
      // The property: no accepted line hides a failing check, in this shell.
      expect(wrong).toEqual([]);
      expect(accepted).toBe(12);
    });

    // `/bin/sh` is bash on a Mac and dash on Debian and Ubuntu, and dash has
    // neither `pipefail` nor `PIPESTATUS`: there a line that uses them is an
    // error whatever the check said. An error is never a receipt, so nothing
    // false follows from it — which is why what is held here is "passes wherever
    // the shell has the idiom", asked of each shell rather than assumed of the
    // platform. (The first run on Ubuntu's CI runner is how this was learned.)
    test.each(SHELLS)(
      "%s: a passing check passes each of them, wherever the shell has the idiom",
      (shell) => {
        const dir = fixture();
        const has = (probe: string): boolean => exitOf(shell, probe, dir, 0) === 0;
        const pipefail = has("set -o pipefail");
        const pipestatus = has("true | true; test ${PIPESTATUS[0]} -eq 0");
        let plain = 0;
        for (const line of LINES) {
          if (!speaksFor(line).includes("./check")) continue;
          const needs = { pipefail: /pipefail/.test(line), pipestatus: /PIPESTATUS/.test(line) };
          const supported = (!needs.pipefail || pipefail) && (!needs.pipestatus || pipestatus);
          if (!needs.pipefail && !needs.pipestatus) plain++;
          expect({ line, passes: exitOf(shell, line, dir, 0) === 0 }).toEqual({
            line,
            passes: supported,
          });
        }
        // Four of the twelve ask nothing of the shell, and pass in every one.
        expect(plain).toBe(4);
      },
    );

    test("the refused lines are refused for cause: each hides a failing check in the shells named", () => {
      const dir = fixture();
      // Where each one exits 0 with the check failing. Most need no particular
      // shell. The two that read `PIPESTATUS` through `exit` or `[[ ]]` hide the
      // failure only where that is not bash's variable — zsh and ksh — and a
      // machine with neither (Ubuntu's runner, for one) has nowhere to show it.
      // The table says where; the shells this machine has are the ones run.
      const hidesIn: Record<string, "every shell" | readonly string[]> = {
        "./check | tail -n 8": "every shell",
        "./check || true": "every shell",
        "./check; true": "every shell",
        "false && set -o pipefail; ./check | tail -n 8": "every shell",
        "./check | tail -n 8; exit ${PIPESTATUS[0]}": ["/bin/zsh", "/bin/ksh"],
        "./check | tail -n 8; [[ ${PIPESTATUS[0]} -eq 0 ]]": ["/bin/zsh", "/bin/ksh"],
      };
      const refused = LINES.filter((line) => !speaksFor(line).includes("./check"));
      expect([...refused].sort()).toEqual(Object.keys(hidesIn).sort());
      for (const line of refused) {
        const where = hidesIn[line]!;
        const shells = where === "every shell" ? SHELLS : SHELLS.filter((s) => where.includes(s));
        for (const shell of shells) {
          expect({ line, shell, exit: exitOf(shell, line, dir, 1) }).toEqual({
            line,
            shell,
            exit: 0,
          });
        }
      }
    });
  },
);

describe("the same check by another name", () => {
  function project(scripts: Record<string, string>, at = ""): string {
    const root = scratch("rune-receipt-pkg-");
    mkdirSync(join(root, at), { recursive: true });
    writeFileSync(join(root, at, "package.json"), JSON.stringify({ name: "x", scripts }));
    return root;
  }

  test("a package script that is one plain command is that command", () => {
    const root = project({ test: "bun test tests/unit/", typecheck: "tsc  --noEmit" });
    expect(equivalentCommands(root, "bun run test")).toEqual([
      "bun run test",
      "bun test tests/unit/",
    ]);
    expect(equivalentCommands(root, "npm test")).toEqual(["npm test", "bun test tests/unit/"]);
    expect(equivalentCommands(root, "pnpm run typecheck")).toEqual([
      "pnpm run typecheck",
      "tsc --noEmit",
    ]);
  });

  test("in a sub-project, both names keep where they run", () => {
    const root = project({ test: "vitest run" }, "apps/web");
    expect(equivalentCommands(root, "cd apps/web && npm run test")).toEqual([
      "cd apps/web && npm run test",
      "cd apps/web && vitest run",
    ]);
    // The root has no such script: nothing is invented for it.
    expect(equivalentCommands(root, "npm run test")).toEqual(["npm run test"]);
  });

  test("`bun test` is Bun's runner, not a script named test", () => {
    const root = project({ test: "echo not this" });
    expect(equivalentCommands(root, "bun test")).toEqual(["bun test"]);
  });

  const notPlain: Array<[string, Record<string, string>]> = [
    ["a script with a step before it", { pretest: "bun run build", test: "bun test" }],
    ["a script with a step after it", { test: "bun test", posttest: "bun run lint" }],
    ["a script that is two commands", { test: "bun run build && bun test" }],
    ["a script that pipes", { test: "bun test | tee out.log" }],
    ["a script with a fallback", { test: "bun test || true" }],
    ["a script that substitutes", { test: "bun test $(cat list)" }],
    ["no such script", { lint: "eslint ." }],
  ];
  for (const [why, scripts] of notPlain) {
    test(`${why} has only its own name`, () => {
      expect(equivalentCommands(project(scripts), "bun run test")).toEqual(["bun run test"]);
    });
  }

  test("a command that runs no script, and a project with no manifest, have only their own names", () => {
    expect(equivalentCommands(project({ test: "bun test" }), "cargo test")).toEqual(["cargo test"]);
    expect(equivalentCommands(scratch("rune-receipt-bare-"), "npm test")).toEqual(["npm test"]);
  });
});

function repo(): string {
  const root = scratch("rune-receipt-tree-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore" },
    );
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
  git("init", "-q", "--initial-branch=main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  return root;
}

describe("is the tree what it was", () => {
  test("the same bytes are the same tree, and any other bytes are not", () => {
    const root = repo();
    const clean = workTreeFingerprint(root);
    expect(clean).toMatch(/^[0-9a-f]{24}$/);
    expect(workTreeFingerprint(root)).toBe(clean);

    const seen = new Set<string | null>([clean]);
    const differs = (what: string) => {
      const now = workTreeFingerprint(root);
      expect({ what, isNew: !seen.has(now), known: now !== null }).toEqual({
        what,
        isNew: true,
        known: true,
      });
      seen.add(now);
      return now;
    };

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    const edited = differs("a tracked file edited");
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    differs("the same file edited again, same size");
    writeFileSync(join(root, "new.test.ts"), "test\n");
    differs("an untracked file added");
    writeFileSync(join(root, "new.test.ts"), "tesT\n");
    differs("the untracked file's content changed");
    rmSync(join(root, "src", "b.ts"));
    differs("a tracked file deleted");

    // Put back, byte for byte: it is the tree it was, and reads as that tree.
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    rmSync(join(root, "new.test.ts"));
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    expect(workTreeFingerprint(root)).toBe(edited);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    expect(workTreeFingerprint(root)).toBe(clean);
  });

  test("a file that is gone is not a file that is empty", () => {
    const root = repo();
    writeFileSync(join(root, "a.ts"), "");
    const empty = workTreeFingerprint(root);
    rmSync(join(root, "a.ts"));
    const gone = workTreeFingerprint(root);
    expect(gone).not.toBeNull();
    expect(gone).not.toBe(empty);
  });

  test("a commit moves it even when no file differs from the new commit", () => {
    const root = repo();
    const before = workTreeFingerprint(root);
    writeFileSync(join(root, "a.ts"), "export const a = 9;\n");
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qam",
        "next",
      ],
      { cwd: root, stdio: "ignore" },
    );
    expect(workTreeFingerprint(root)).not.toBe(before);
  });

  test("what the project ignores, and what Rune itself writes, are not the work", () => {
    const root = repo();
    const before = workTreeFingerprint(root);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "built\n");
    mkdirSync(join(root, ".rune"));
    writeFileSync(join(root, ".rune", "tool-children.jsonl"), "{}\n");
    expect(workTreeFingerprint(root)).toBe(before);
  });

  test("a folder that is not a repository has no answer, which matches nothing", () => {
    expect(workTreeFingerprint(scratch("rune-receipt-norepo-"))).toBeNull();
  });
});

describe("the ledger", () => {
  const at = Date.UTC(2026, 9, 13);

  test("a pass is found while the tree stands, lost when it moves, and found again when it is put back", () => {
    const root = repo();
    const ledger = new PassLedger(() => workTreeFingerprint(root), true);
    ledger.noteShell("set -o pipefail; bun test tests/unit/ 2>&1 | tail -n 8", {
      at,
      durationMs: 51_970,
    });

    const found = ledger.fresh(["bun run test", "bun test tests/unit/"]);
    expect(found).toMatchObject({
      command: "bun test tests/unit/",
      ranAs: "set -o pipefail; bun test tests/unit/ 2>&1 | tail -n 8",
      at,
      durationMs: 51_970,
    });
    // Another check is another check.
    expect(ledger.fresh(["bun run typecheck"])).toBeUndefined();
    expect(ledger.fresh(["bun test"])).toBeUndefined();
    expect(ledger.fresh([])).toBeUndefined();

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    expect(ledger.fresh(["bun test tests/unit/"])).toBeUndefined();
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    expect(ledger.fresh(["bun test tests/unit/"])).toBeDefined();
  });

  test("a pass of one check on this tree is not a pass of another that passed on an earlier one", () => {
    // The suite passed, a file changed, the typecheck passed. Asked about the
    // suite, the answer is no: the only pass on THIS tree is the typecheck's.
    const root = repo();
    const ledger = new PassLedger(() => workTreeFingerprint(root), true);
    ledger.noteShell("bun test tests/unit/", { at });
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    ledger.noteShell("bun run typecheck", { at: at + 1 });

    expect(ledger.fresh(["bun test tests/unit/"])).toBeUndefined();
    expect(ledger.fresh(["bun run typecheck"])).toMatchObject({ command: "bun run typecheck" });
    // …and back on the first tree it is the other way round.
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    expect(ledger.fresh(["bun test tests/unit/"])).toMatchObject({
      command: "bun test tests/unit/",
    });
    expect(ledger.fresh(["bun run typecheck"])).toBeUndefined();
  });

  test("a line that does not speak for the check leaves nothing, and neither does a command that is no check", () => {
    const root = repo();
    const ledger = new PassLedger(() => workTreeFingerprint(root), true);
    ledger.noteShell("bun test tests/unit/ | tail -n 8", { at });
    ledger.noteShell("bun test tests/unit/ || true", { at });
    ledger.noteShell("rm -rf dist; bun test tests/unit/", { at });
    expect(ledger.fresh(["bun test tests/unit/"])).toBeUndefined();
    // Exits 0 all day, and is not a check: no receipt, and no git call spent on it.
    let asked = 0;
    const counting = new PassLedger(() => (asked++, workTreeFingerprint(root)), true);
    counting.noteShell("ls -la", { at });
    counting.noteShell("git status --short", { at });
    expect(asked).toBe(0);
    expect(counting.fresh(["ls -la"])).toBeUndefined();
  });

  test("with the pipe idioms not trusted, a piped pass leaves nothing", () => {
    const root = repo();
    const ledger = new PassLedger(() => workTreeFingerprint(root), false);
    ledger.noteShell("set -o pipefail; bun test tests/unit/ 2>&1 | tail -n 8", { at });
    expect(ledger.fresh(["bun test tests/unit/"])).toBeUndefined();
    ledger.noteShell("bun test tests/unit/", { at });
    expect(ledger.fresh(["bun test tests/unit/"])).toBeDefined();
  });

  test("the newest pass on this tree is the one returned, and a tree that cannot be read matches nothing", () => {
    const root = repo();
    const ledger = new PassLedger(() => workTreeFingerprint(root), true);
    ledger.noteCheck("bun run test", { at, durationMs: 10 });
    ledger.noteCheck("bun run test", { at: at + 5, durationMs: 20 });
    expect(ledger.fresh(["bun run test"])).toMatchObject({ at: at + 5, durationMs: 20 });

    let readable = true;
    const flaky = new PassLedger(() => (readable ? "aaaaaaaaaaaaaaaaaaaaaaaa" : null), true);
    flaky.noteCheck("bun run test", { at });
    expect(flaky.fresh(["bun run test"])).toBeDefined();
    readable = false;
    expect(flaky.fresh(["bun run test"])).toBeUndefined();
    // And a pass taken while it could not be read was never kept.
    flaky.noteCheck("bun run lint", { at });
    readable = true;
    expect(flaky.fresh(["bun run lint"])).toBeUndefined();
  });
});
