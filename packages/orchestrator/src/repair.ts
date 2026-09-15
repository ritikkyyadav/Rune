/**
 * A failure has a type, and the type decides the response (M4).
 *
 * `docs/program/m4-repair-and-delegation.md`, "the one rule". Before this file
 * the loop's retries were scattered guards with their own counters: three
 * consecutive provider errors, three verification attempts, one replan nudge,
 * one stuck nudge — each a number in a different local, each with its own idea
 * of what had just gone wrong. Nothing in the run said WHAT KIND of failure it
 * was, so nothing could bound the response to it: a missing test runner, a red
 * typecheck and a dead socket all bought the same retries.
 *
 * This file names the six kinds and nothing else. It is the same shape as
 * `arbiter.ts`: a pure function over runtime facts, with no clock, no module
 * state, no `this`, and no path from a string to an action. It reads only what
 * the RUNTIME saw — a provider error's own retry hint, a check's exit code and
 * output, the permission broker's answer, the criterion status the contract
 * derived, the progress counters — and never model prose. A classifier that
 * read the model's account of its own failure would be asking the thing that
 * failed to grade itself.
 *
 * ```
 * transport            provider stream error, 5xx, timeout, rate wait
 * check_failed         a project check or an evaluator command exited non-zero
 * acceptance_mismatch  an evaluator criterion `failed` at the finish gate
 * missing_dependency   `not-applicable`-shaped output: no runner, module not found
 * denied               permission denied, containment halt, spend cap, ask refused
 * no_progress          E9/E10/E12 signatures with no evidence or artifact change
 * ```
 *
 * The one ordering rule that carries weight: **`missing_dependency` is read
 * before `check_failed`**. A runner that never ran did not fail; saying it did
 * is how a run spends its remaining budget "fixing" a check that was never
 * going to execute here. The vocabulary for that is `parent-check.ts`'s
 * `couldNotRunOnParent` — the same words, on purpose, because "the runner
 * refused to run" is one question however many trees it is asked about — plus
 * the shapes that mean the RUNNER ITSELF is absent, which a parent-tree check
 * never sees (the runner is either installed for both trees or neither).
 */

import { couldNotRunOnParent } from "./parent-check";

// ─── The vocabulary ───

export type RepairClass =
  | "transport"
  | "check_failed"
  | "acceptance_mismatch"
  | "missing_dependency"
  | "denied"
  | "no_progress";

export const REPAIR_CLASSES: readonly RepairClass[] = [
  "transport",
  "check_failed",
  "acceptance_mismatch",
  "missing_dependency",
  "denied",
  "no_progress",
];

/**
 * The bounded response a class names, as one word.
 *
 * Deliberately NOT a transition: a transition is the arbiter's answer, decided
 * from the snapshot and the ladder. This is only what the class TABLE says the
 * shape of the response is, so a row can carry it and a reader can see that a
 * `denied` never bought a retry.
 */
export type RepairResponse =
  /** Wait per the hint or back off, and send the same request again. */
  | "retry"
  /** One repair turn, naming what failed and the tail of its output. */
  | "repair_turn"
  /** Say so and carry on to the finish; nothing is retried. */
  | "report_only"
  /** Stop that action. No alternative route. */
  | "stop"
  /** One nudge, then the run is abandoned on no progress. */
  | "nudge";

export interface RepairClassification {
  readonly cls: RepairClass;
  readonly response: RepairResponse;
  /** Why, in the runtime's own terms. Never model prose, never a command. */
  readonly reason: string;
  /** The provider's own retry hint, in seconds, when it advertised one. */
  readonly retryAfterSecs?: number;
}

// ─── The facts ───

/**
 * What the runtime saw. One variant per site that can fail.
 *
 * `message` and `output` are the only free strings, they are read ONLY by the
 * regexps below, and neither is ever returned: a `RepairClassification` is an
 * enum, a sentence the harness wrote, and a number.
 */
export type RepairFact =
  | {
      readonly kind: "provider_error";
      readonly message: string;
      readonly retryable?: boolean;
      /** A parsed `Retry-After`, when the provider advertised one. */
      readonly retryAfterSecs?: number | null;
    }
  | {
      readonly kind: "check_run";
      readonly command: string;
      readonly exitCode: number;
      readonly output: string;
    }
  | {
      readonly kind: "boundary";
      readonly outcome: "allowed" | "denied" | "halt" | "spend_cap" | "ask_refused";
    }
  | {
      readonly kind: "criterion";
      /** `criterionStatus`'s own word for it (`contract.ts`). */
      readonly status: string;
    }
  | {
      readonly kind: "progress";
      /** How many times the runtime saw the same signature back. */
      readonly repeats: number;
      readonly writeCountChanged: boolean;
      readonly newEvidence: boolean;
    };

// ─── The missing-runner vocabulary ───

/**
 * The shapes that mean the RUNNER is not here, as opposed to the code failing.
 *
 * `couldNotRunOnParent` covers "the runner ran and collected nothing" and "the
 * command line was not understood". It cannot cover these, because a parent
 * check is run by the same shell on the same machine: `bun` is installed for
 * both trees or for neither, so "bun: command not found" is a shape that
 * question never has to ask. Here it is the first thing to ask — it was
 * `bun: command not found` that used to buy three repair turns, on a run whose
 * work was finished.
 *
 * Held to examples in `repair-classifier.test.ts` rather than to the regexp's
 * shape: the vocabulary IS the content of the distinction.
 */
const MISSING_RUNNER = new RegExp(
  [
    // POSIX shells, four dialects of the same sentence. Every one is anchored
    // to the shell's OWN line shape (`sh: 1: vitest: not found`, `bash: bun:
    // command not found`, `zsh: command not found: bun`) rather than to the
    // bare words, because "expected element not found" is an assertion failing
    // and reading it as a missing runner silently stops repairing real red
    // checks — the exact failure this class exists to prevent, inverted.
    //
    // V7 finding 4 is that inversion, shipped: `command not found`,
    // `cannot find module` and `module not found: ` were BARE alternatives
    // beside the anchored ones, matched anywhere under `im`. So
    // `src/a.ts(3,10): error TS2307: Cannot find module './b'` — the commonest
    // TypeScript error there is — classified `missing_dependency` /
    // `report_only`, bought no repair turn, and the run finished saying the
    // runner was not available about a compiler that ran and found the bug. So
    // did a bun test NAMED after a shell error, a test ASSERTING on one, a
    // loader test asserting `Cannot find module`, and an eslint
    // `import/no-unresolved` report. A missing MODULE is a failed check; only
    // a missing RUNNER is this class.
    "^[^\\n]{0,40}:\\s*[\\w./+-]+:\\s*(?:command not found|not found)\\s*$",
    "^[^\\n]{0,40}:\\s*command not found:\\s*[\\w./+-]+\\s*$", // zsh
    "^[^\\n]{0,20}:\\s*[\\w./+-]+:\\s*no such file or directory\\s*$",
    "^[^\\n]{0,60}is not recognized as an internal or external command", // cmd.exe
    "^[^\\n]{0,80}executable file not found",
    // Module and package resolution, per ecosystem — each anchored to the
    // START of the line the runtime itself prints, which is what a compiler
    // diagnostic (`<file>(<line>,<col>): error TSxxxx: …`) and a test
    // assertion (`Expected to contain: "…"`) never are.
    "^\\s*(?:uncaught\\s+)?(?:\\w*error)?:?\\s*cannot find module\\b",
    "^\\s*module not found:\\s",
    "^\\s*modulenotfounderror\\b",
    "^\\s*importerror:\\s*no module named",
    "^[^\\n]{0,60}cannot find package\\b",
    "^[^\\n]{0,60}no such command\\b",
  ].join("|"),
  "im",
);

/** Exit 127 is the shell's own word for "I could not find that". */
const EXIT_NO_COMMAND = 127;

/**
 * A line only a runner that RAN can print: its own count, or its own verdict.
 *
 * V8 finding 17. `missingDependency` opened with `if (exitCode ===
 * EXIT_NO_COMMAND) return true`, read BEFORE the output, so no evidence in the
 * output could overturn it. A check that exits 127 while printing a complete
 * assertion failure classified `missing_dependency` / `report_only`: it bought
 * no repair turn and the run reported the runner was absent about a runner that
 * ran and found the bug. That is V7 finding 4's own shape, moved from the
 * vocabulary to the exit code — and 127 is reachable with real output, because
 * a runner's own harness can exit 127 and a `&&` chain carries the last status.
 *
 * Anchored to what a RUNTIME prints about a measurement, never to words a test
 * name or a diff could contain.
 */
const MEASURED = new RegExp(
  [
    "^\\s*\\d+ (?:pass|fail|passed|failed|skipped|tests?|assertions?)\\b",
    "^\\s*(?:tests?|suites?|assertions?):\\s*\\d+",
    "^\\s*expected:\\s",
    "^\\s*received:\\s",
    "\\bexpect\\(received\\)",
    "^\\s*assertionerror\\b",
    "^\\s*(?:ok|not ok) \\d+\\b",
    "^\\s*#\\s*(?:pass|fail|asserts)\\s+\\d+",
    "^\\s*(?:FAIL|PASS)\\s+\\S+\\.(?:[cm]?[jt]sx?|py|rb|go|rs)\\b",
  ].join("|"),
  "im",
);

/**
 * Whether this check output says the runner never ran.
 *
 * Exported because it is the `not-applicable` half of the class table and the
 * corpus tests it directly; `classify` reads it first.
 */
export function missingDependency(exitCode: number, output: string): boolean {
  // The output first, always: the shell's word for "I could not find that" is
  // a strong signal and it is not evidence ABOUT the check, and a runner that
  // printed a measurement measured something whatever it exited with.
  if (MISSING_RUNNER.test(output)) return true;
  if (exitCode === EXIT_NO_COMMAND) return !MEASURED.test(output);
  return couldNotRunOnParent(output);
}

// ─── The classifier ───

/**
 * One fact in, one class out — or `null` when the fact is not a failure.
 *
 * Pure: no clock, no state, no I/O. `null` is not "unknown": it is "the
 * runtime saw this and nothing went wrong", which is a different answer and
 * the one that keeps a healthy turn out of the repair machinery entirely.
 */
export function classify(fact: RepairFact): RepairClassification | null {
  switch (fact.kind) {
    case "boundary": {
      // First, and above every other class: a boundary is not a failure to
      // work around. The response is to stop that action and say so — there
      // is no second route to a place permission was refused.
      switch (fact.outcome) {
        case "allowed":
          return null;
        case "halt":
          return {
            cls: "denied",
            response: "stop",
            reason: "a containment halt stopped the run; no other route exists",
          };
        case "spend_cap":
          return {
            cls: "denied",
            response: "stop",
            reason: "the spend cap refused this action; no other route exists",
          };
        case "ask_refused":
          return {
            cls: "denied",
            response: "stop",
            reason: "the user refused this action; no other route exists",
          };
        case "denied":
          return {
            cls: "denied",
            response: "stop",
            reason: "permission was denied for this action; no other route exists",
          };
      }
      return null;
    }
    case "provider_error": {
      const hint =
        typeof fact.retryAfterSecs === "number" && Number.isFinite(fact.retryAfterSecs)
          ? Math.max(0, fact.retryAfterSecs)
          : undefined;
      return {
        cls: "transport",
        response: "retry",
        reason:
          hint === undefined
            ? "the provider failed to answer; the failure is in the transport, not the work"
            : `the provider advertised a ${hint}s retry window`,
        ...(hint === undefined ? {} : { retryAfterSecs: hint }),
      };
    }
    case "check_run": {
      if (fact.exitCode === 0) return null;
      // ── The ordering rule ──
      // A runner that never ran did not fail. Read before `check_failed`, and
      // it buys no repair turn at all.
      if (missingDependency(fact.exitCode, fact.output)) {
        return {
          cls: "missing_dependency",
          response: "report_only",
          reason: "the check's runner is not available here, so nothing was measured",
        };
      }
      return {
        cls: "check_failed",
        response: "repair_turn",
        reason: `a check exited ${fact.exitCode}`,
      };
    }
    case "criterion": {
      if (fact.status === "failed") {
        return {
          cls: "acceptance_mismatch",
          response: "repair_turn",
          reason: "an evaluator criterion failed at the finish gate",
        };
      }
      if (fact.status === "needs_review") {
        // `needs_review` never re-prompts — a missing runner is not the
        // model's to fix (`m3-first-migration.md`, the second branch).
        return {
          cls: "missing_dependency",
          response: "report_only",
          reason: "the criterion could not be settled mechanically here",
        };
      }
      return null;
    }
    case "progress": {
      if (fact.newEvidence || fact.writeCountChanged) return null;
      return {
        cls: "no_progress",
        response: "nudge",
        reason: `the same answer came back ${fact.repeats} times with nothing written between`,
      };
    }
  }
  return null;
}

/**
 * The `[controller] authority` key that owns a class.
 *
 * `acceptance_mismatch`'s key is `acceptance` because M3 named it that before
 * M4 existed (`m3-first-migration.md`, "the second branch"), and a key that a
 * person may already have in `config.toml` does not get renamed for tidiness.
 */
export const REPAIR_AUTHORITY_KEY: Readonly<Record<RepairClass, string>> = {
  transport: "transport",
  check_failed: "check_failed",
  acceptance_mismatch: "acceptance",
  missing_dependency: "missing_dependency",
  denied: "denied",
  no_progress: "no_progress",
};
