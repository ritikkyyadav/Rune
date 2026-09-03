/**
 * P10.4 — the step check, per ecosystem, end to end through the real engine.
 *
 * One task per ecosystem. Each scripts the same shape, which is the shape the
 * step check exists for:
 *
 *   1. plan a step
 *   2. write a file that does NOT compile
 *   3. mark the step done      → the harness runs the project's compile check,
 *                                it fails, and the completion is REFUSED
 *   4. fix the file
 *   5. mark the step done      → the check runs again, passes, step accepted
 *
 * The failure is a real compile error read by a real compiler, not a mock. That
 * is the point: before P10.4 the detection for Go, Python, Rust and the JVM did
 * not exist, so step 3 found nothing to run, the completion was accepted, and a
 * broken build closed a plan step as done.
 *
 * **Toolchains.** These tasks run whatever the machine has. CI's ubuntu runner
 * has Go, Python and Java, and installs Rust, so all of them measure there. On a
 * machine missing one, that task asserts the OTHER half of the same invariant
 * instead — that a toolchain which cannot run is recorded as absent and never
 * produces a green check — and says so in its reason. A task that quietly
 * asserted nothing would be worse than a red one.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";

import type { EvalTask } from "./harness";

// ─── Reading the spine back out of the session database ───

type Row = { seq: number; type: string; payload_json: string };

interface CheckRecord {
  command: string;
  passed: boolean;
  source: string;
  exitCode?: number;
  durationMs?: number;
}

interface SpineState {
  todos: Array<{
    content: string;
    status: string;
    unproven?: string;
    evidence?: { lastCheck?: { passed: boolean; command?: string } };
  }>;
  checks?: CheckRecord[];
}

function latestTaskState(dbPath: string, sessionId: string): SpineState | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT seq, type, payload_json FROM events WHERE session_id = ? ORDER BY seq DESC")
      .all(sessionId) as Row[];
    for (const r of rows) {
      if (r.type !== "task_state") continue;
      const parsed = JSON.parse(r.payload_json);
      return (parsed?.payload?.state ?? parsed?.state ?? null) as SpineState | null;
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Is this toolchain here AND working? `Bun.which` is not enough: macOS ships
 * `/usr/bin/javac` on every machine as a stub that exits 1 with "Unable to
 * locate a Java Runtime" when no JDK is installed.
 */
function toolchainWorks(bin: string, versionFlag: string): boolean {
  if (Bun.which(bin) == null) return false;
  try {
    return Bun.spawnSync([bin, versionFlag], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The assertion both branches share, so neither branch is a free pass.
 *
 * With the toolchain: the compile check must have RUN, must have FAILED once on
 * the broken file with a non-zero exit code, must have passed after the fix, and
 * the step must be completed clean — not `unproven`.
 *
 * Without it: nothing may claim to have passed. A verifier that cannot check is
 * allowed to say so; it is not allowed to produce a green check out of an
 * absent compiler.
 */
function judge(
  state: SpineState | null,
  opts: { available: boolean; commandMatches: RegExp; step: string; ecosystem: string },
): { pass: boolean; reason?: string } {
  if (!state) return { pass: false, reason: "no task_state snapshot in the session log" };
  const checks = (state.checks ?? []).filter(
    (c) => c.source === "harness" && opts.commandMatches.test(c.command),
  );
  const step = state.todos.find((t) => t.content.includes(opts.step));

  if (!opts.available) {
    if (checks.some((c) => c.passed)) {
      return {
        pass: false,
        reason: `${opts.ecosystem} is not installed here, yet a check for it is recorded as PASSED: ${JSON.stringify(checks)}`,
      };
    }
    return { pass: true, reason: `${opts.ecosystem} toolchain absent — absence half asserted` };
  }

  const failed = checks.filter((c) => !c.passed);
  const passed = checks.filter((c) => c.passed);
  if (failed.length === 0) {
    return {
      pass: false,
      reason: `the broken file did not fail a step check — recorded: ${JSON.stringify(state.checks ?? [])}`,
    };
  }
  if (failed.some((c) => c.exitCode === 0 || c.exitCode == null)) {
    return {
      pass: false,
      reason: `a failed check recorded no non-zero exit code: ${JSON.stringify(failed)}`,
    };
  }
  if (!failed.some((c) => typeof c.durationMs === "number")) {
    return { pass: false, reason: "a harness check recorded no duration" };
  }
  if (passed.length === 0) {
    return { pass: false, reason: "the fix was never confirmed by a passing check" };
  }
  if (!step) return { pass: false, reason: `step "${opts.step}" is not on the plan` };
  if (step.status !== "completed") {
    return { pass: false, reason: `step never completed (status ${step.status})` };
  }
  if (step.unproven) {
    return { pass: false, reason: `step landed unproven (${step.unproven}) after a passing check` };
  }
  if (step.evidence?.lastCheck?.passed !== true) {
    return { pass: false, reason: "the step's receipt does not carry a passing check" };
  }
  return { pass: true };
}

/** The five-response script every one of these tasks runs. */
function script(step: string, path: string, broken: string, fixed: string) {
  return [
    {
      text: "Recording the step before I touch anything.",
      toolCalls: [
        { name: "todo_write", args: { items: [{ content: step, status: "in_progress" }] } },
      ],
    },
    { toolCalls: [{ name: "write_file", args: { path, content: broken } }] },
    {
      text: "That should be it.",
      toolCalls: [
        { name: "todo_write", args: { items: [{ content: step, status: "completed" }] } },
      ],
    },
    {
      text: "The check caught a compile error. Fixing it.",
      toolCalls: [{ name: "write_file", args: { path, content: fixed } }],
    },
    {
      toolCalls: [
        { name: "todo_write", args: { items: [{ content: step, status: "completed" }] } },
      ],
    },
    { text: "Added the function; the project compiles." },
  ];
}

// ─── Go ───

const goStepCheck: EvalTask = {
  name: "verify_step_check_go",
  category: "core",
  description: "A Go file that does not compile must be refused by the step check.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "go.mod"), "module gearstep\n\ngo 1.21\n");
    await writeFile(join(workspace, "main.go"), "package main\n\nfunc main() {}\n");
  },
  script: script(
    "add Add to the go package",
    "add.go",
    'package main\n\nfunc Add(a int, b int) int {\n\treturn "nope"\n}\n',
    "package main\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n",
  ),
  prompts: ["add an Add function to the Go package"],
  verify: async ({ dbPath, sessionId }) =>
    judge(latestTaskState(dbPath, sessionId), {
      available: toolchainWorks("go", "version"),
      commandMatches: /^go build/,
      step: "add Add to the go package",
      ecosystem: "Go",
    }),
};

// ─── Python ───

const pythonStepCheck: EvalTask = {
  name: "verify_step_check_python",
  category: "core",
  description: "A Python file that does not compile must be refused by the step check.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "pyproject.toml"),
      '[project]\nname = "gearstep"\nversion = "0.0.0"\n',
    );
  },
  script: script(
    "add add() to the python package",
    "calc.py",
    "def add(a, b)\n    return a + b\n",
    "def add(a, b):\n    return a + b\n",
  ),
  prompts: ["add an add() function to the Python package"],
  verify: async ({ dbPath, sessionId }) =>
    judge(latestTaskState(dbPath, sessionId), {
      available: toolchainWorks("python3", "--version"),
      commandMatches: /py_compile/,
      step: "add add() to the python package",
      ecosystem: "Python",
    }),
};

// ─── Rust ───

const rustStepCheck: EvalTask = {
  name: "verify_step_check_rust",
  category: "core",
  description: "A Rust file that does not compile must be refused by the step check.",
  setup: async ({ workspace }) => {
    // `[workspace]` keeps the fixture out of any surrounding cargo workspace.
    await writeFile(
      join(workspace, "Cargo.toml"),
      '[workspace]\n\n[package]\nname = "gearstep"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
    );
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "lib.rs"), "pub fn placeholder() {}\n");
  },
  script: script(
    "add add() to the rust crate",
    "src/lib.rs",
    'pub fn add(a: i32, b: i32) -> i32 {\n    a + "b"\n}\n',
    "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
  ),
  prompts: ["add an add() function to the Rust crate"],
  verify: async ({ dbPath, sessionId }) =>
    judge(latestTaskState(dbPath, sessionId), {
      available: toolchainWorks("cargo", "--version"),
      commandMatches: /^cargo check/,
      step: "add add() to the rust crate",
      ecosystem: "Rust",
    }),
};

// ─── JVM (Java) ───

const javaStepCheck: EvalTask = {
  name: "verify_step_check_java",
  category: "core",
  description: "A Java file that does not compile must be refused by the step check.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "Placeholder.java"),
      "public class Placeholder {\n    static int zero() {\n        return 0;\n    }\n}\n",
    );
  },
  script: script(
    "add Adder to the java sources",
    "Adder.java",
    'public class Adder {\n    static int add(int a, int b) {\n        return "nope";\n    }\n}\n',
    "public class Adder {\n    static int add(int a, int b) {\n        return a + b;\n    }\n}\n",
  ),
  prompts: ["add an Adder class to the Java sources"],
  verify: async ({ dbPath, sessionId }) =>
    judge(latestTaskState(dbPath, sessionId), {
      available: toolchainWorks("javac", "-version"),
      commandMatches: /javac/,
      step: "add Adder to the java sources",
      ecosystem: "Java",
    }),
};

// ─── JS/TS ───
//
// The compile check here is the project's own `typecheck` script, which is
// `bun build` — a real compiler that is guaranteed present (the suite runs on
// Bun) and reaches no network. `bunx tsc` would try to install TypeScript into
// a temp workspace, which detection is not allowed to do and a test must not.

const jsStepCheck: EvalTask = {
  name: "verify_step_check_js",
  category: "core",
  description: "A TypeScript file that does not parse must be refused by the step check.",
  setup: async ({ workspace }) => {
    await writeFile(join(workspace, "bun.lock"), "");
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify(
        { name: "gearstep", scripts: { typecheck: "bun build ./add.ts --outdir dist" } },
        null,
        2,
      ) + "\n",
    );
  },
  script: script(
    "add add() to the ts module",
    "add.ts",
    "export function add(a: number, b: number): number {\n  return a + b;\n",
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  ),
  prompts: ["add an add() function to the TypeScript module"],
  verify: async ({ dbPath, sessionId }) =>
    judge(latestTaskState(dbPath, sessionId), {
      available: true, // bun is running this suite
      commandMatches: /run typecheck/,
      step: "add add() to the ts module",
      ecosystem: "JS/TS",
    }),
};

export const VERIFIER_ECOSYSTEM_TASKS: EvalTask[] = [
  jsStepCheck,
  goStepCheck,
  pythonStepCheck,
  rustStepCheck,
  javaStepCheck,
];
