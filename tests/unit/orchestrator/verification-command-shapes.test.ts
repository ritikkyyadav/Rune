/**
 * The inline-check classifier and the relatedness rule, on the shapes that
 * used to walk past both.
 *
 * Written by an independent verifier; the two asymmetries it found are fixed
 * here:
 *  1. `inlineCheck` strips comments and string literals before it looks for
 *     an assertion (a printed word is not a check), but relatedness read the
 *     RAW command — so a file named only in a COMMENT or a log string bought
 *     the correspondence that closes a step. `commandScopePaths` now reads
 *     arguments raw and inline SCRIPT bodies stripped.
 *  2. `projectLevelCheck` is relatedness's blanket "related to everything"
 *     clause, and it accepted runs guaranteed to execute nothing.
 */

import { describe, expect, test } from "bun:test";
import {
  checkRelatedness,
  commandPaths,
  isVerificationCommand,
  projectLevelCheck,
} from "../../../packages/orchestrator/src/verification-command";

const NL = String.fromCharCode(10);

describe("classifier shapes at the edge of the parse", () => {
  test.each([
    // [label, command, expected isVerificationCommand]
    [
      "a heredoc script is unclassified (demotion)",
      `bash <<'EOF'${NL}node -e 'assert(false)'${NL}EOF`,
      false,
    ],
    [
      "a JS template literal holding the word is not code",
      "node -e 'console.log(`assert ok`)'",
      false,
    ],
    [
      "a flag before -e loses the inline script",
      "node --experimental-strip-types -e 'assert(1===1)'",
      false,
    ],
    ["a swallowed assertion is demoted", "node -e 'try { assert(false) } catch {}'", false],
    [
      "a swallowed assertion that sets the code is a check",
      "node -e 'try { assert(false) } catch (e) { process.exit(1) }'",
      true,
    ],
    ["|| true is not a check", "bun test || true", false],
    ["; true is not a check", "bun test; true", false],
    ["a pipe is not a check", "bun test | tee out.txt", false],
  ])("%s", (_label, command, expected) => {
    expect(isVerificationCommand(command)).toBe(expected);
  });

  test("a Python assertion inside `if False:` still classifies as a check", () => {
    // The documented residual: the classifier is textual and cannot prove the
    // assertion runs. Pinned so the limit is a fact, not a footnote.
    const cmd = `python3 -c "if False:${NL}    assert 1 == 2${NL}print('done')"`;
    expect(isVerificationCommand(cmd)).toBe(true);
  });
});

describe("relatedness reads the code, not the text around it", () => {
  test.each([
    ["a comment naming the touched file", `node -e "// src/csv.ts${NL}assert(1===1)"`],
    ["a log string naming the touched file", `node -e "assert(1===1); console.log('src/csv.ts')"`],
    ["a Python comment naming the touched file", `python3 -c "# src/csv.py${NL}assert True"`],
  ])("%s does not make an unrelated inline assertion related", (_label, command) => {
    const touched = command.includes(".py") ? ["src/csv.py"] : ["src/csv.ts"];
    // The same script with the mention removed is correctly set aside...
    const bare = command
      .replace(/(?:\/\/ |# )src\/csv\.(?:ts|py)\n?/, "")
      .replace("; console.log('src/csv.ts')", "");
    expect(checkRelatedness(bare, { touched }).related).toBe(false);
    // ...and adding the mention, in text `stripLiterals` blanks before the
    // assertion test runs, is enough to close the step.
    expect(commandPaths(command)).toContain(touched[0]!);
    expect(checkRelatedness(command, { touched })).toEqual({
      related: false,
      reason: "other_files",
    });
  });

  test.each([
    ["bun test with a pattern that matches nothing", "bun test --test-name-pattern zzzznope"],
    ["cargo test with everything skipped", "cargo test -- --skip everything"],
    ["pytest with a selector that matches nothing", "pytest -k zzzznope"],
  ])("%s runs nothing, so it is not a whole-project verdict", (_label, command) => {
    expect(isVerificationCommand(command)).toBe(true);
    // A run that executes zero assertions and exits 0 is treated as a
    // whole-project verdict and is related to every step by construction.
    expect(projectLevelCheck(command)).toBe(false);
    expect(checkRelatedness(command, { touched: ["src/csv.ts"] }).related).toBe(false);
  });
});
