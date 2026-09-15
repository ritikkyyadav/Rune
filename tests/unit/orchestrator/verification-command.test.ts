import { describe, expect, test } from "bun:test";
import { isVerificationCommand } from "../../../packages/orchestrator/src/brief";
import {
  checkRelatedness,
  commandPaths,
  commandProgramPaths,
  samePathToken,
  projectLevelCheck,
  ranZeroTests,
  assertedNothing,
} from "../../../packages/orchestrator/src/verification-command";

describe("verification commands name a check that actually executes", () => {
  test.each([
    "node browser-test.mjs",
    "node scripts/verify-ui.js",
    "node --test tests/parser.test.mjs",
    "bun tests/parser.test.ts",
    "bun run scripts/validate.ts",
    "python3 scripts/check_output.py",
    "python -m pytest tests",
    "bash scripts/smoke-test.sh",
    "./scripts/verify.sh",
    "node 'scripts with spaces/browser-test.mjs'",
    "FIELDNOTES_SCREENSHOTS=0 node browser-test.mjs",
    "env CI=1 node browser-test.mjs",
    "cd app && node browser-test.mjs && git diff --check",
    "node browser-test.mjs && printf 'complete\\n'",
    "node browser-test.mjs >check.log 2>&1",
    "bun test </dev/null",
    "node browser-test.mjs # record the exit",
    "cd app; node browser-test.mjs",
    "npm run test:e2e -- --project=chromium",
    "pnpm --filter app run typecheck",
    "yarn lint",
    "bunx tsc --noEmit",
    "npx playwright test",
    "cargo test --workspace",
    "cargo +stable clippy --all-targets",
    "go test ./...",
    "swift test",
    "./gradlew test",
    "mvn verify",
    "make check",
    `bun -e 'import assert from "node:assert/strict"; import { parseCsv } from "./csv.ts"; assert.deepEqual(parseCsv("a,b"), [["a", "b"]])'`,
    `node -e 'const { f } = require("./x"); if (f() !== 1) process.exit(1)'`,
    'python3 -c "import csv; assert csv.reader is not None"',
    "deno eval 'if (!globalThis.Deno) throw new Error(\"no deno\")'",
    "turbo typecheck",
    "turbo run test --filter=@rune/orchestrator",
    "nx test app",
    "git diff --check",
    `git diff --check && test "$(git status --short | wc -l | tr -d ' ')" = 2 && git status --short`,
    `git diff --check && test "$(git status --short | awk '{print $2}' | sort | tr '\\n' ' ')" = "csv.test.ts csv.ts " && bun -e 'import { parseCsv } from "./csv.ts"; if (typeof parseCsv !== "function") process.exit(1)'`,
    `test "$(printf '%s' "$(cat output.txt)")" = ready`,
    `test "$(printf '%s' 'a)b')" = 'a)b'`,
    'test "`cat output.txt`" = ready',
    "EXPECTED=$(cat expected.txt) node browser-test.mjs",
    'test "$((1 + (2)))" = 3',
  ])("records %s", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });

  test.each([
    "echo test",
    "printf 'node browser-test.mjs'",
    "echo 'one; node browser-test.mjs'",
    "cat browser-test.mjs",
    "rg test package.json",
    "node app.mjs browser-test.mjs",
    "node -e 'console.log(\"test\")'",
    "bun -e 'console.log(JSON.stringify(process.versions))'",
    "python3 -c \"print(open('output.txt').read())\"",
    "node -p 'process.version'",
    "node --help browser-test.mjs",
    "node --require browser-test.mjs app.mjs",
    "node --test --list-tests",
    "npm install test",
    "npm exec echo test",
    "git show HEAD:browser-test.mjs",
    "node scripts/contest.mjs",
    "node scripts/latest.mjs",
    "node browser-test.mjs || true",
    "node browser-test.mjs; echo done",
    "node browser-test.mjs | tee result.log",
    "node browser-test.mjs &",
    "node browser-test.mjs &&",
    "make -f build",
    "turbo dev",
    "nx serve app",
    "xcodebuild -list",
    "echo $(node browser-test.mjs)",
    'echo "$(node browser-test.mjs)"',
    'echo "`node browser-test.mjs`"',
    'echo $(printf "%s" "$(node browser-test.mjs)")',
    "$(echo node) browser-test.mjs",
    'node "$(echo browser)-test.mjs"',
    'bun run "test:$(echo unit)"',
    'test "$(cat output.txt)" = ready || true',
    'test "$(cat output.txt)" = ready | tee check.log',
    'test "$(cat output.txt)" = ready; echo done',
    'test "$(cat output.txt)" = ready &',
    'test "$(cat output.txt" = ready',
    'test "`cat output.txt" = ready',
    'echo "$(case x in x) echo test;; esac)"',
    "# node browser-test.mjs",
    "node 'browser-test.mjs",
  ])("does not turn output, inspection or a masked exit into a check: %s", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });
});

/**
 * Inline scripts, adversarially.
 *
 * `9984109` made `node -e '…assert…'` an eligible check with one textual
 * regex over the whole script. Measured 2026-09-10 (Lane A), that regex also
 * accepted eight shapes that establish nothing — an assertion word printed by
 * `console.log`, one sitting in a comment, one inside a string a program
 * echoes back — and one that cannot fail at all, because a `catch` eats its
 * only verdict. The classifier now reads CODE: literals and comments are
 * blanked first, and a swallowed verdict needs an exit code the script sets
 * itself. Anything it cannot parse stays unclassified, which costs a rung and
 * claims nothing.
 */
describe("an inline script is a check only when its own verdict can fail it", () => {
  test.each([
    // The assertion is code, and nothing can absorb it.
    `bun -e 'import assert from "node:assert/strict"; assert.equal(parse("a"), "a")'`,
    `node -e 'if (f() !== 1) process.exit(1)'`,
    'python3 -c "import csv; assert csv.reader is not None"',
    "deno eval 'if (!globalThis.Deno) throw new Error(\"no deno\")'",
    // A comment ALONGSIDE a real assertion changes nothing.
    `bun -e '// assert the parser round-trips\nassert.equal(parse("a"), "a")'`,
    // Caught — but the script sets the failing exit code itself.
    `node -e 'try { require("./x") } catch (e) { console.error(e); process.exit(1) }'`,
    `python3 -c "try:\n    import foo\nexcept ImportError:\n    sys.exit(1)"`,
  ])("is a check: %s", (command) => {
    expect(isVerificationCommand(command)).toBe(true);
  });

  test.each([
    // ── An assertion word that is only OUTPUT ──
    `node -e 'console.log("assert ok")'`,
    `node -e 'console.log("expect(1).toBe(1)")'`,
    `bun -e 'const banner = "throw"; console.log(banner)'`,
    `node -p '"raise"'`,
    "python3 -c \"print('assert everything is fine')\"",
    "python3 -c \"x = '''assert nothing'''; print(x)\"",
    // ── An assertion word that is only a COMMENT ──
    `node -e '// assert the parser works\nconsole.log(1)'`,
    `node -e '/* assert the parser works */ console.log(1)'`,
    'python3 -c "# assert the file parses\\nprint(1)"',
    // ── A verdict a catch absorbs: the exit code is 0 either way ──
    `node -e 'try { assert(false) } catch {}'`,
    `bun -e 'import assert from "node:assert"; try { assert.ok(false) } catch (e) { console.log("ok") }'`,
    `python3 -c "try:\n    assert False\nexcept AssertionError:\n    pass"`,
    // ── An exit status the shell masks, whatever the script asserted ──
    `node -e 'assert(false)' || true`,
    `node -e 'assert(false)' || echo failed`,
    `node -e 'assert(false)' ; true`,
    `node -e 'assert(false)' 2>/dev/null; echo done`,
    `set +e; node -e 'assert(false)'; echo done`,
    `node -e 'assert(false)' | tee check.log`,
    // ── Words printed by the shell itself ──
    'echo "assert ok"',
    "printf 'assert passed\\n'",
  ])("is not a check: %s", (command) => {
    expect(isVerificationCommand(command)).toBe(false);
  });
});

/**
 * Relatedness (Lane A2, 2026-09-10). A check that ran is not automatically a
 * check of the step that was open when it ran: Lane A left "an unrelated
 * passing command run while a step is open still closes that step" as its
 * first remaining defect. `checkRelatedness` is the scope the harness's own
 * step check has always had — `stepCheck(signal, ts.touchedFiles)` — applied
 * to the commands the MODEL runs.
 */
describe("a check speaks to the step it would close", () => {
  const touched = ["src/csv.ts"];

  test.each([
    // A project-wide runner measures whatever the step touched, by nature.
    ["bun test", "project"],
    ["npm run typecheck", "project"],
    ["cargo test --workspace", "project"],
    ["bunx tsc --noEmit -p tsconfig.json", "project"],
    ["make check", "project"],
    ["python3 -m pytest", "project"],
    ["eslint .", "project"],
    ["node --test", "project"],
    // A whole tree is still a suite; only a named FILE narrows a runner.
    ["pytest tests/", "project"],
    // The touched file, its test, and the module an inline script imports.
    ["bun test tests/unit/csv.test.ts", "file"],
    ["bun test tests/csv/parse.test.ts", "file"],
    ["python3 -m pytest tests/test_csv.py", "file"],
    [`node -e "require('./src/csv'); assert(true)"`, "file"],
    ["node src/csv.ts", "file"],
  ])("related: %s (%s)", (command, reason) => {
    expect(checkRelatedness(command, { touched })).toEqual({
      related: true,
      reason: reason as never,
      ...(reason === "file" ? { match: "src/csv.ts" } : {}),
    });
  });

  test.each([
    // Names nothing at all: it cannot be about this step's files.
    [`python3 -c "assert True"`, "names_nothing"],
    [`node -e "assert(1+1===2)"`, "names_nothing"],
    [`bun -e "if (1 + 1 !== 2) throw new Error('math')"`, "names_nothing"],
    // Names only files this step never touched.
    ["bun test tests/unit/other.test.ts", "other_files"],
    ["node tests/unit/other.test.ts", "other_files"],
    ["python3 -m pytest tests/test_other.py", "other_files"],
  ])("unrelated: %s (%s)", (command, reason) => {
    expect(checkRelatedness(command, { touched })).toEqual({
      related: false,
      reason: reason as never,
    });
  });

  test("a step that touched nothing has no file set to judge against", () => {
    // The integration suite's own shape: a verify step whose whole job is
    // running an existing check, with no writes to correlate. Keeping the
    // cheap common path is the point — this is where the rule stands down.
    expect(checkRelatedness("node browser-test.mjs", { touched: [] })).toEqual({
      related: true,
      reason: "unscoped",
    });
    expect(
      checkRelatedness(
        `bun -e 'import assert from "node:assert/strict"; assert.equal(await Bun.file("output.txt").text(), "ready")'`,
        { touched: [] },
      ).related,
    ).toBe(true);
    // A command that names nothing is unrelated even then: there is no
    // reading of it under which it is about this step.
    expect(checkRelatedness(`python3 -c "assert True"`, { touched: [] })).toEqual({
      related: false,
      reason: "names_nothing",
    });
  });

  test("a step that names its own check keeps it", () => {
    const content = "Verify the migration with `bun test tests/unit/other.test.ts`";
    expect(checkRelatedness("bun test tests/unit/other.test.ts", { content, touched })).toEqual({
      related: true,
      reason: "declared",
    });
    // A different command is still judged by the files.
    expect(
      checkRelatedness("bun test tests/unit/third.test.ts", { content, touched }).related,
    ).toBe(false);
  });

  test("project-level is a subset of check, never a superset", () => {
    // Not a check at all: `projectLevelCheck` must not invent one.
    expect(projectLevelCheck("bun run dev")).toBe(false);
    expect(projectLevelCheck("echo test")).toBe(false);
    expect(projectLevelCheck(`bun -e 'console.log("test")'`)).toBe(false);
    // A check, but one the model pointed at a file.
    expect(isVerificationCommand("node browser-test.mjs")).toBe(true);
    expect(projectLevelCheck("node browser-test.mjs")).toBe(false);
    // An inline assertion is never project-wide, whatever the program is.
    expect(isVerificationCommand(`bun -e 'assert(1)'`)).toBe(true);
    expect(projectLevelCheck(`bun -e 'assert(1)'`)).toBe(false);
  });

  test("the paths a command names include the ones inside an inline script", () => {
    expect(commandPaths(`node -e "require('./src/csv')"`)).toContain("./src/csv");
    expect(commandPaths("bun test tests/unit/csv.test.ts")).toContain("tests/unit/csv.test.ts");
    // The leading program is not a path it named.
    expect(commandPaths(`python3.11 -c "assert True"`)).toEqual([]);
  });
});

describe("the entry script, and the argv after it (V6 finding 2)", () => {
  const about = (command: string, file: string) => checkRelatedness(command, { touched: [file] });

  test("a filename the script never opens buys nothing", () => {
    expect(about("node check.mjs header.csv", "header.csv").related).toBe(false);
    expect(about("node check.mjs header.csv", "check.mjs").related).toBe(true);
  });

  test("a program that READS its arguments keeps every one of them", () => {
    // Not a script host: `grep` opens what it is handed.
    expect(about("grep -q total header.csv", "header.csv").related).toBe(true);
    // A runner subcommand is not an entry script, so both targets stay.
    expect(about("bun test a.test.ts b.test.ts", "b.test.ts").related).toBe(true);
    expect(about("python3 -m pytest tests/a.py tests/b.py", "tests/b.py").related).toBe(true);
  });

  test("the entry script is read conservatively", () => {
    expect(commandProgramPaths("node check.mjs header.csv")).toEqual(["check.mjs"]);
    expect(commandProgramPaths("sh verify-header.sh header.csv")).toEqual(["verify-header.sh"]);
    expect(commandProgramPaths("./verify.sh header.csv")).toEqual(["./verify.sh"]);
    // An inline script names no entry script: there is no file to name.
    expect(commandProgramPaths("node -e \"require('./src/csv')\"")).toEqual([]);
  });

  test("a runner's targets ARE its programs (V8 critical 4)", () => {
    // These three read `[]` until the third verifier pass, on the reasoning
    // that a runner's first positional is a subcommand and not an entry script.
    // True, and the wrong conclusion: the files a runner is POINTED AT are the
    // files it executes, which is the question `authoredThisTask` asks. The
    // consequence was that `bun test` — the shape every check in this repo is
    // run as — handed both authorship witnesses nothing, so the run's own test
    // file graded the run's own work and `authoredBy` was never set.
    //
    // V6 finding 2 is a different question and is unmoved: `commandScopePaths`
    // still refuses to credit an argv token as the check's SUBJECT, which is
    // what the `about(…)` assertions above hold.
    expect(commandProgramPaths("bun test mine.test.ts")).toEqual(["mine.test.ts"]);
    expect(commandProgramPaths("python3 -m pytest tests/a.py")).toEqual(["tests/a.py"]);
    expect(commandProgramPaths("bun test a.test.ts b.test.ts")).toEqual(["a.test.ts", "b.test.ts"]);
    // And a non-runner subcommand is still not a program: `git log check.mjs`
    // reads the file, it does not run it.
    expect(commandProgramPaths("git log check.mjs")).toEqual([]);
  });

  test("`samePathToken` is exact — the same file however it was spelled, and nothing else", () => {
    expect(samePathToken("./verify.sh", "verify.sh")).toBe(true);
    expect(samePathToken("verify.sh", "scripts/verify.sh")).toBe(true);
    // None of `pathsCorrespond`'s module fuzz: a wrong yes refuses an honest
    // citation.
    expect(samePathToken("api.test.ts", "api.ts")).toBe(false);
    expect(samePathToken("src/csv.ts", "tests/csv.test.ts")).toBe(false);
  });
});

describe("a runner that measured nothing (V7 finding 9)", () => {
  // The model wrote `test("it works", () => {})`, ran it, cited it for a
  // criterion naming no file, and the criterion derived `satisfied` with the
  // product byte-identical. The runner collected a test and asserted nothing —
  // which `ranZeroTests` cannot see, because something DID run. Bun prints its
  // assertion count only when it is positive, so the absence of the line is
  // the count. Held to the runner's real output, both ways.
  const EMPTY = " 1 pass\n 0 fail\nRan 1 test across 1 file. [10.00ms]";
  const REAL = " 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [12.00ms]";

  test("a green run with no assertions measured nothing", () => {
    expect(assertedNothing(EMPTY)).toBe(true);
    expect(ranZeroTests("bun test mine.test.ts", EMPTY)).toBe(false);
  });

  test("a green run that asserted is a measurement", () => {
    expect(assertedNothing(REAL)).toBe(false);
  });

  test("a runner that reports no assertion count at all is not judged here", () => {
    // pytest and cargo never print one, and they never print `Ran N tests
    // across` either. Refusing to guess is the same rule `ranZeroTests` keeps
    // for a `bun test` whose output it cannot read.
    expect(assertedNothing("collected 3 items\n3 passed in 0.04s")).toBe(false);
    expect(assertedNothing("test result: ok. 12 passed; 0 failed")).toBe(false);
    expect(assertedNothing(undefined)).toBe(false);
    expect(assertedNothing("")).toBe(false);
  });

  test("TAP states both counts, so the same question is asked of it (V8 finding 19)", () => {
    // `node --test`, `tap` and `tape` print `# tests N` and `# asserts N`.
    // The property was bun-scoped, and the record read as though finding 9 were
    // closed generally; it is closed for every runner that says what it
    // asserted, which is these and bun, and for no others — because there is
    // nothing in the others' output to read.
    const tapEmpty = "TAP version 13\nok 1 - it works\n1..1\n# tests 1\n# pass 1\n# asserts 0";
    const tapReal = "TAP version 13\nok 1 - it works\n1..1\n# tests 1\n# pass 1\n# asserts 4";
    expect(assertedNothing(tapEmpty)).toBe(true);
    expect(assertedNothing(tapReal)).toBe(false);
    // A TAP runner that reports no assertion line is not judged, same rule.
    expect(assertedNothing("TAP version 13\nok 1 - it works\n# tests 1\n# pass 1")).toBe(false);
  });

  test("the shell's JSON envelope is read the same way", () => {
    expect(assertedNothing(JSON.stringify({ stdout: EMPTY, stderr: "" }))).toBe(true);
    expect(assertedNothing(JSON.stringify({ stdout: REAL, stderr: "" }))).toBe(false);
  });
});
