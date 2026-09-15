/**
 * M4 deliverable A — a failure has a type.
 *
 * The corpus, one block per class, held to EXAMPLES rather than to the
 * regexps' shape: the vocabulary is the whole content of the distinction
 * (`docs/program/m4-repair-and-delegation.md`, the class table). Every string
 * below is a real runner's, shell's or provider's own words.
 *
 * Two properties carry the deliverable:
 *
 *   1. **`missing_dependency` is read before `check_failed`.** A runner that
 *      never ran did not fail, and calling it a failure is how a finished run
 *      spends its last turns "fixing" a check that was never going to execute
 *      (M4 exit R9).
 *   2. **`classify` is pure.** No clock, no state, no I/O — the same fact
 *      gives the same answer on any machine, in any order, forever.
 *
 * Zero model calls; this file touches nothing but a function.
 */

import { describe, expect, test } from "bun:test";

import {
  REPAIR_AUTHORITY_KEY,
  REPAIR_CLASSES,
  classify,
  missingDependency,
  type RepairClass,
  type RepairFact,
} from "../../../packages/orchestrator/src/repair";

function classOf(fact: RepairFact): RepairClass | null {
  return classify(fact)?.cls ?? null;
}

function check(output: string, exitCode = 1): RepairFact {
  return { kind: "check_run", command: "the command is never read", exitCode, output };
}

// ─── transport ───

describe("transport — the provider, not the work", () => {
  const PROVIDER_FAILURES = [
    "fetch failed",
    "upstream connect error or disconnect/reset before headers",
    "503 Service Unavailable",
    "socket hang up",
    "The operation was aborted due to timeout",
    "Internal server error (500)",
    "stream ended unexpectedly",
  ];

  for (const message of PROVIDER_FAILURES) {
    test(`"${message.slice(0, 40)}" is transport`, () => {
      expect(classOf({ kind: "provider_error", message })).toBe("transport");
    });
  }

  test("the response is a retry, never a repair turn — the model did not fail", () => {
    const c = classify({ kind: "provider_error", message: "fetch failed" });
    expect(c?.response).toBe("retry");
  });

  test("a retry hint is carried through as a number, and a bad one is dropped", () => {
    expect(
      classify({ kind: "provider_error", message: "429", retryAfterSecs: 42 })?.retryAfterSecs,
    ).toBe(42);
    expect(
      classify({ kind: "provider_error", message: "429", retryAfterSecs: Number.NaN })
        ?.retryAfterSecs,
    ).toBeUndefined();
    expect(
      classify({ kind: "provider_error", message: "429", retryAfterSecs: null })?.retryAfterSecs,
    ).toBeUndefined();
  });

  test("a non-retryable provider error is still transport — the WORK did not fail", () => {
    expect(classOf({ kind: "provider_error", message: "no credits", retryable: false })).toBe(
      "transport",
    );
  });
});

// ─── check_failed ───

describe("check_failed — a check ran and went red", () => {
  const RED = [
    "FAIL src/parser.test.ts\n  ✗ parses a nested list\n\n1 fail, 12 pass",
    "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    "FAILED tests/test_api.py::test_create - assert 404 == 201\n1 failed, 30 passed",
    "test result: FAILED. 4 passed; 1 failed; 0 ignored",
    "--- FAIL: TestRoundTrip (0.01s)\nFAIL\nexit status 1",
    "2 problems (2 errors, 0 warnings)",
  ];

  for (const output of RED) {
    test(`"${output.split("\n")[0]!.slice(0, 44)}" is check_failed`, () => {
      expect(classOf(check(output))).toBe("check_failed");
    });
  }

  test("the response is one repair turn", () => {
    expect(classify(check("1 fail, 12 pass"))?.response).toBe("repair_turn");
  });

  test("exit 0 is not a failure at all — null, not a class", () => {
    expect(classify(check("12 pass, 0 fail", 0))).toBeNull();
  });

  test("the reason names the exit code and never the command or the output", () => {
    const c = classify({
      kind: "check_run",
      command: "bun test --token=sk-secret-value",
      exitCode: 3,
      output: "FAIL src/secret-path/thing.test.ts",
    });
    expect(c?.reason).toBe("a check exited 3");
    expect(c?.reason).not.toContain("sk-secret");
    expect(c?.reason).not.toContain("secret-path");
  });
});

// ─── missing_dependency ───

describe("missing_dependency — the `not-applicable` vocabulary", () => {
  // The shell's own words, in the three dialects a run actually meets.
  const NO_RUNNER = [
    "bash: bun: command not found",
    "sh: 1: vitest: not found",
    "zsh: command not found: cargo",
    "env: node: No such file or directory",
    "'pytest' is not recognized as an internal or external command",
  ];
  // Module and package resolution, per ecosystem.
  const NO_MODULE = [
    "Error: Cannot find module 'vitest'",
    "ModuleNotFoundError: No module named 'pytest'",
    "ImportError: No module named requests",
    "error[E0463]: can't find crate for `serde`\nerror: cannot find package",
    "Module not found: Error: Can't resolve './missing'",
  ];
  // The runner ran and collected nothing, or refused the command line —
  // `parent-check.ts`'s vocabulary, reused on purpose.
  const NOTHING_COLLECTED = [
    "No tests found, exiting with code 1",
    "collected 0 items",
    "npm ERR! missing script: test",
    "error: unknown command 'typecheck'",
    "usage: cargo <COMMAND>",
    "[no test files]",
  ];

  for (const output of [...NO_RUNNER, ...NO_MODULE, ...NOTHING_COLLECTED]) {
    test(`"${output.split("\n")[0]!.slice(0, 44)}" is missing_dependency`, () => {
      expect(classOf(check(output))).toBe("missing_dependency");
    });
  }

  test("exit 127 alone is enough — the shell's own word for it", () => {
    expect(classOf(check("", 127))).toBe("missing_dependency");
  });

  test("R9 — `bun: command not found` buys NO retry and NO repair turn", () => {
    const c = classify(check("bash: bun: command not found", 127));
    expect(c?.cls).toBe("missing_dependency");
    expect(c?.response).toBe("report_only");
  });

  test("the ordering rule — a red suite that ALSO says the runner is missing is a missing runner", () => {
    // The shape that made the rule: a wrapper prints the failure summary it
    // inherited, then the real reason. Read `check_failed` first and the run
    // spends its remaining turns on a check that cannot execute here.
    const output = "1 fail, 0 pass\nbash: bun: command not found";
    expect(classOf(check(output))).toBe("missing_dependency");
  });

  test("a plain red check is NOT a missing runner — the rule does not swallow real failures", () => {
    expect(missingDependency(1, "FAIL src/parser.test.ts\n1 fail, 12 pass")).toBe(false);
    expect(missingDependency(1, "error TS2345: Argument of type 'string'")).toBe(false);
  });

  test("an ASSERTION that says 'not found' is a red check, not a missing runner", () => {
    // The inverted failure: read these as a missing runner and the class
    // silently stops repairing real red checks. `not found` has to appear in
    // the SHELL's own line shape, not in a test's prose.
    const assertions = [
      "AssertionError: expected element not found",
      '  ✗ renders the banner\n    error: selector ".hero" not found',
      "FAIL: TestLookup — key not found",
      "Error: no such file or directory, open 'fixtures/missing.json'",
    ];
    for (const output of assertions) {
      expect(classOf(check(output))).toBe("check_failed");
    }
  });

  test("a missing MODULE is a failed check — the compiler ran and found the bug", () => {
    // V7 finding 4, the inversion shipped. `MISSING_RUNNER`'s shell
    // alternatives were carefully anchored to the shell's own line shape; the
    // module ones beside them were the BARE phrases `cannot find module` and
    // `module not found: `, matched anywhere under `im`. So the commonest
    // TypeScript error there is classified `missing_dependency` /
    // `report_only`: with `check_failed` or `missing_dependency` in
    // `[controller] authority` it bought no repair turn, and the run finished
    // saying "the check's runner is not available here, so nothing was
    // measured" about a compiler that ran perfectly and found the bug.
    //
    // A missing MODULE is a failed check. `missing_dependency` is a missing
    // RUNNER: command not found, a usage error, or a runner that collected
    // nothing. The corpus's own tsc example was TS2345, which does not carry
    // the phrase, so nothing above caught it.
    const realRedChecks = [
      "src/a.ts(3,10): error TS2307: Cannot find module './b' or its corresponding type declarations.\nFound 1 error.",
      '(fail) exec > surfaces errors\nerror: expect(received).toBe(expected)\nExpected: "bash: zzz: command not found"\nReceived: "bash: zzz: not executable"\n 1 fail',
      "bun test v1.3.14\n\n(fail) shell > reports command not found for a missing binary [2ms]\n\n 12 pass\n 1 fail\nRan 13 tests",
      "(fail) loader > rejects a bad id\nerror: expect(received).toContain(expected)\nExpected to contain: \"Cannot find module 'nope'\"\n 1 fail",
      '/src/a.ts\n  3:1  error  Import "x" — module not found:  import/no-unresolved\n\n2 problems',
    ];
    for (const output of realRedChecks) {
      expect({ head: output.split("\n")[0]!.slice(0, 40), cls: classOf(check(output)) }).toEqual({
        head: output.split("\n")[0]!.slice(0, 40),
        cls: "check_failed",
      });
      expect(missingDependency(1, output)).toBe(false);
    }
  });
});

// ─── denied ───

describe("denied — a boundary, not an obstacle", () => {
  const OUTCOMES = ["denied", "halt", "spend_cap", "ask_refused"] as const;
  for (const outcome of OUTCOMES) {
    test(`${outcome} is denied, and the response is to stop`, () => {
      const c = classify({ kind: "boundary", outcome });
      expect(c?.cls).toBe("denied");
      expect(c?.response).toBe("stop");
      // The whole point of the class: never "retry", never "repair_turn".
      // A response that is not `stop` is a route around a boundary.
      expect(c?.reason).toContain("no other route");
    });
  }

  test("allowed is not a failure", () => {
    expect(classify({ kind: "boundary", outcome: "allowed" })).toBeNull();
  });
});

// ─── acceptance_mismatch ───

describe("acceptance_mismatch — an evaluator criterion failed at the finish", () => {
  test("`failed` is acceptance_mismatch, and the response is one repair turn", () => {
    const c = classify({ kind: "criterion", status: "failed" });
    expect(c?.cls).toBe("acceptance_mismatch");
    expect(c?.response).toBe("repair_turn");
  });

  test("`needs_review` never re-prompts — a missing runner is not the model's to fix", () => {
    const c = classify({ kind: "criterion", status: "needs_review" });
    expect(c?.cls).toBe("missing_dependency");
    expect(c?.response).toBe("report_only");
  });

  for (const status of ["satisfied", "unassessed", "stale"]) {
    test(`\`${status}\` is not a failure`, () => {
      expect(classify({ kind: "criterion", status })).toBeNull();
    });
  }
});

// ─── no_progress ───

describe("no_progress — a re-read is not progress", () => {
  test("the same answer with nothing written is no_progress, and buys one nudge", () => {
    const c = classify({
      kind: "progress",
      repeats: 3,
      writeCountChanged: false,
      newEvidence: false,
    });
    expect(c?.cls).toBe("no_progress");
    expect(c?.response).toBe("nudge");
  });

  test("a write between the tries is progress, whatever the signature says", () => {
    expect(
      classify({ kind: "progress", repeats: 9, writeCountChanged: true, newEvidence: false }),
    ).toBeNull();
  });

  test("a new answer is progress — a poll is not a rut", () => {
    expect(
      classify({ kind: "progress", repeats: 9, writeCountChanged: false, newEvidence: true }),
    ).toBeNull();
  });
});

// ─── The shape of the thing ───

describe("the classifier itself", () => {
  test("every class has an authority key, and the keys are distinct", () => {
    const keys = REPAIR_CLASSES.map((c) => REPAIR_AUTHORITY_KEY[c]);
    expect(keys.length).toBe(6);
    expect(new Set(keys).size).toBe(6);
    // M3 named this one before M4 existed; a key a person may already have in
    // config.toml does not get renamed for tidiness.
    expect(REPAIR_AUTHORITY_KEY.acceptance_mismatch).toBe("acceptance");
  });

  test("it is pure — the same fact answers the same way, a hundred times", () => {
    const facts: RepairFact[] = [
      { kind: "provider_error", message: "fetch failed" },
      check("1 fail"),
      check("bun: command not found", 127),
      { kind: "boundary", outcome: "halt" },
      { kind: "criterion", status: "failed" },
      { kind: "progress", repeats: 3, writeCountChanged: false, newEvidence: false },
    ];
    const first = JSON.stringify(facts.map(classify));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(facts.map(classify))).toBe(first);
  });

  test("no classification carries the fact's own strings", () => {
    const c = classify({
      kind: "check_run",
      command: "curl -H 'Authorization: Bearer sk-live-xyz' https://example.test",
      exitCode: 22,
      output: "Authorization: Bearer sk-live-xyz\ncurl: (22) The requested URL returned error: 403",
    });
    const rendered = JSON.stringify(c);
    expect(rendered).not.toContain("sk-live");
    expect(rendered).not.toContain("example.test");
  });
});
