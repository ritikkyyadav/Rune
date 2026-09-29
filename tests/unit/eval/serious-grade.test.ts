// ─── The serious family's grader ───
//
// tests/eval/serious/grade.ts turns bun's JUnit report into one status per
// hidden test, and a graded tree into the parity Outcome. These tests pin the
// rules a mined task's score rests on: what counts as a pass, what never enters
// the denominator, what a regression is, and when a build counts as broken.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { quality } from "../../eval/parity/types";
import {
  decodeXml,
  heldPackages,
  outcomeOf,
  parseJunit,
  runHiddenTests,
  testEnv,
  testKey,
  type GradeSpec,
} from "../../eval/serious/grade";

const FIXTURE = join(import.meta.dir, "../../fixtures/serious/junit-nested.xml");
const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "serious-grade-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("bun's JUnit report → one status per test", () => {
  const results = parseJunit(readFileSync(FIXTURE, "utf8"));

  test("a test's key is its file and the describe path down to it", () => {
    expect(
      results[testKey("tests/unit/a.test.ts", ["outer", "inner & <deep>", 'a "quoted" name'])],
    ).toBe("pass");
    expect(results["tests/unit/a.test.ts :: a test outside any describe"]).toBe("pass");
  });

  test("a failure or an error fails a test, a skip skips it, anything else passes", () => {
    expect(results["tests/unit/b.test.ts :: d > fails"]).toBe("fail");
    expect(results["tests/unit/b.test.ts :: d > errors"]).toBe("fail");
    expect(results["tests/unit/b.test.ts :: d > is skipped"]).toBe("skip");
  });

  test("two tests with one path keep both results, in report order", () => {
    expect(results["tests/unit/b.test.ts :: d > same name"]).toBe("pass");
    expect(results["tests/unit/b.test.ts :: d > same name #2"]).toBe("fail");
  });

  test("names are decoded once: an escaped entity in a name stays escaped", () => {
    expect(results["tests/unit/b.test.ts :: d > an escaped &lt; stays escaped"]).toBe("pass");
    expect(decodeXml("&amp;lt; &#65;&#x42; &quot;")).toBe('&lt; AB "');
  });

  test("exactly the report's tests, nothing invented", () => {
    expect(Object.keys(results)).toHaveLength(8);
  });

  test("a leading ./ is not part of a file's name", () => {
    expect(testKey("./tests/unit/x.test.ts", ["t"])).toBe("tests/unit/x.test.ts :: t");
  });
});

describe("a hidden-test run", () => {
  test("a file that fails to load contributes no test, so none of its tests passes", async () => {
    const tree = join(scratch, "load-error");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "mod.ts"), "export const yes = 1;\n");
    writeFileSync(
      join(tree, "a.test.ts"),
      'import { test, expect } from "bun:test";\nimport { nope } from "./mod";\ntest("uses nope", () => expect(nope).toBe(1));\n',
    );
    writeFileSync(
      join(tree, "b.test.ts"),
      'import { describe, test, expect } from "bun:test";\ndescribe("b", () => { test("passes", () => expect(1).toBe(1)); test("fails", () => expect(1).toBe(2)); });\n',
    );
    const run = await runHiddenTests(tree, ["a.test.ts", "b.test.ts"], {
      evidenceDir: join(scratch, "load-error-evidence"),
      label: "base-1",
    });
    expect(run.results).toEqual({
      "b.test.ts :: b > passes": "pass",
      "b.test.ts :: b > fails": "fail",
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.reportMissing).toBe(false);
    expect(existsSync(join(scratch, "load-error-evidence", "base-1.junit.xml"))).toBe(true);
    expect(existsSync(join(scratch, "load-error-evidence", "base-1.log"))).toBe(true);
  });

  test("the environment: a scratch HOME with a git identity, and no credentials", () => {
    const env = testEnv(join(scratch, "env"), {
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-real",
      ANTHROPIC_AUTH_TOKEN: "real",
      GITHUB_TOKEN: "real",
      AWS_SECRET: "real",
      RUNE_TEST_FAKE_API_KEY: "fake",
      RUNE_HOME: "/Users/someone/.rune",
      GEAR_HOME: "/Users/someone/.gear",
      RUNE_EVAL_REAL: "1",
    });
    expect(env.HOME).toBe(join(scratch, "env", "home"));
    expect(env.PATH).toBe("/usr/bin");
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET",
      "RUNE_HOME",
      "GEAR_HOME",
      "RUNE_EVAL_REAL",
    ])
      expect(env[name]).toBeUndefined();
    expect(env.RUNE_TEST_FAKE_API_KEY).toBe("fake");
    expect(readFileSync(env.GIT_CONFIG_GLOBAL!, "utf8")).toContain("name = Serious Grader");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("a graded tree → Outcome", () => {
  const spec: GradeSpec = {
    f2p: ["t :: a", "t :: b"],
    p2p: ["t :: c", "t :: d"],
    impossible: ["t :: e"],
    typecheckPackages: ["packages/x", "packages/y", "packages/z"],
    typecheckBaseClean: { "packages/x": true, "packages/y": false, "packages/z": true },
    typecheckFixedClean: { "packages/x": true, "packages/y": true, "packages/z": false },
  };

  test("only fail-to-pass checks count: an impossible check never enters the total, even when it passes", () => {
    const outcome = outcomeOf(
      spec,
      { "t :: a": "pass", "t :: c": "pass", "t :: d": "pass", "t :: e": "pass" },
      {},
    );
    expect(outcome).toEqual({
      hiddenPassed: 1,
      hiddenTotal: 2,
      regressionsIntroduced: 0,
      buildBroken: false,
      impossible: ["t :: e"],
    });
  });

  test("a check listed both as fail-to-pass and impossible is impossible", () => {
    const both = { ...spec, f2p: [...spec.f2p, "t :: e"] };
    expect(outcomeOf(both, { "t :: e": "pass" }, {}).hiddenTotal).toBe(2);
  });

  test("a pass-to-pass check that fails, is skipped or did not run is a regression", () => {
    const outcome = outcomeOf(spec, { "t :: a": "pass", "t :: b": "pass", "t :: c": "skip" }, {});
    expect(outcome.hiddenPassed).toBe(2);
    expect(outcome.regressionsIntroduced).toBe(2);
    expect(quality(outcome)).toBe(0.5);
  });

  test("a build is broken only where the parent's typecheck was clean", () => {
    expect(outcomeOf(spec, {}, { "packages/x": false }).buildBroken).toBe(true);
    expect(outcomeOf(spec, {}, { "packages/y": false }).buildBroken).toBe(false);
    expect(outcomeOf(spec, {}, { "packages/x": true }).buildBroken).toBe(false);
  });

  test("a typecheck the reference fix fails holds no one", () => {
    expect(heldPackages(spec)).toEqual(["packages/x"]);
    expect(outcomeOf(spec, {}, { "packages/z": false }).buildBroken).toBe(false);
  });

  test("a broken build zeroes quality whatever passed", () => {
    const outcome = outcomeOf(
      spec,
      { "t :: a": "pass", "t :: b": "pass" },
      { "packages/x": false },
    );
    expect(quality(outcome)).toBe(0);
  });
});
