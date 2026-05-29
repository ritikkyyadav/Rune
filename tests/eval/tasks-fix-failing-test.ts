/**
 * Fix-failing-test tasks: setup() writes a tiny repo with a failing test,
 * verify() runs the test command and checks exit 0.
 *
 * The mock scripts simulate what the agent would do (read test, find bug, fix it).
 */
import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import type { EvalTask } from "./harness";

function runTest(workspace: string, args: string[]): { exitCode: number; output: string } {
  const result = spawnSync("bun", ["test", ...args], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? 1,
    output: (result.stdout ?? "") + (result.stderr ?? ""),
  };
}

// ─── Fix-failing-test Task 1: off-by-one in array slice ───

const fixOffByOne: EvalTask = {
  name: "fix_off_by_one",
  category: "fix-failing-test",
  description: "Agent finds and fixes an off-by-one error in a slice function.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "slice.ts"),
      `export function firstN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n - 1); // BUG: should be n, not n-1
}
`,
    );
    await writeFile(
      join(workspace, "slice.test.ts"),
      `import { expect, test } from "bun:test";
import { firstN } from "./slice";
test("firstN returns correct count", () => {
  expect(firstN([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
});
`,
    );
  },
  script: [
    {
      text: "Reading the failing test and the implementation.",
      toolCalls: [{ name: "read_file", args: { path: "slice.ts" } }],
    },
    {
      text: "Found the bug: slice(0, n-1) should be slice(0, n). Fixing.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "slice.ts",
            old_text: "n - 1",
            new_text: "n",
            expected_hash: createHash("sha256")
              .update(
                `export function firstN<T>(arr: T[], n: number): T[] {\n  return arr.slice(0, n - 1); // BUG: should be n, not n-1\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Fixed the off-by-one error. The test should pass now." },
  ],
  prompts: ["The test in slice.test.ts is failing. Find the bug in slice.ts and fix it."],
  verify: async ({ workspace }) => {
    const content = await readFile(join(workspace, "slice.ts"), "utf8");
    if (content.includes("n - 1")) {
      return { pass: false, reason: "off-by-one bug still present in slice.ts" };
    }
    const { exitCode, output } = runTest(workspace, ["slice.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `test still fails (exit ${exitCode}): ${output.slice(0, 300)}` };
    }
    return { pass: true };
  },
};

// ─── Fix-failing-test Task 2: wrong comparison operator ───

const fixWrongOperator: EvalTask = {
  name: "fix_wrong_operator",
  category: "fix-failing-test",
  description: "Agent fixes a > vs >= comparison bug in a min-value guard.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "clamp.ts"),
      `export function clampMin(value: number, min: number): number {
  if (value > min) return min; // BUG: should be <
  return value;
}
`,
    );
    await writeFile(
      join(workspace, "clamp.test.ts"),
      `import { expect, test } from "bun:test";
import { clampMin } from "./clamp";
test("clampMin returns value when above min", () => {
  expect(clampMin(10, 5)).toBe(10);
});
test("clampMin returns min when below min", () => {
  expect(clampMin(2, 5)).toBe(5);
});
`,
    );
  },
  script: [
    {
      text: "Reading clamp.ts to find the bug.",
      toolCalls: [{ name: "read_file", args: { path: "clamp.ts" } }],
    },
    {
      text: "Bug found: `value > min` should be `value < min`. Fixing.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "clamp.ts",
            old_text: "if (value > min) return min;",
            new_text: "if (value < min) return min;",
            expected_hash: createHash("sha256")
              .update(
                `export function clampMin(value: number, min: number): number {\n  if (value > min) return min; // BUG: should be <\n  return value;\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Fixed the operator. Both tests should pass now." },
  ],
  prompts: ["The tests in clamp.test.ts are failing. Fix the bug in clamp.ts."],
  verify: async ({ workspace }) => {
    const content = await readFile(join(workspace, "clamp.ts"), "utf8");
    if (content.includes("value > min")) {
      return { pass: false, reason: "wrong operator still present" };
    }
    if (!content.includes("value < min")) {
      return { pass: false, reason: "expected fix not found in clamp.ts" };
    }
    const { exitCode, output } = runTest(workspace, ["clamp.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `test still fails: ${output.slice(0, 300)}` };
    }
    return { pass: true };
  },
};

// ─── Fix-failing-test Task 3: missing return in async function ───

const fixMissingReturn: EvalTask = {
  name: "fix_missing_return",
  category: "fix-failing-test",
  description: "Agent adds a missing return statement in an async function.",
  setup: async ({ workspace }) => {
    await writeFile(
      join(workspace, "fetch-util.ts"),
      `export async function parseJson<T>(text: string): Promise<T> {
  const parsed = JSON.parse(text) as T;
  // BUG: missing return
}
`,
    );
    await writeFile(
      join(workspace, "fetch-util.test.ts"),
      `import { expect, test } from "bun:test";
import { parseJson } from "./fetch-util";
test("parseJson parses correctly", async () => {
  const result = await parseJson<{ x: number }>('{"x": 42}');
  expect(result.x).toBe(42);
});
`,
    );
  },
  script: [
    {
      text: "Reading the implementation to find the bug.",
      toolCalls: [{ name: "read_file", args: { path: "fetch-util.ts" } }],
    },
    {
      text: "Missing return statement after parsing. Adding it.",
      toolCalls: [
        {
          name: "edit_file",
          args: {
            path: "fetch-util.ts",
            old_text: "  const parsed = JSON.parse(text) as T;\n  // BUG: missing return\n}",
            new_text: "  const parsed = JSON.parse(text) as T;\n  return parsed;\n}",
            expected_hash: createHash("sha256")
              .update(
                `export async function parseJson<T>(text: string): Promise<T> {\n  const parsed = JSON.parse(text) as T;\n  // BUG: missing return\n}\n`,
              )
              .digest("hex"),
          },
        },
      ],
    },
    { text: "Added the missing return. Test should pass now." },
  ],
  prompts: ["The test in fetch-util.test.ts is failing. Fix the bug in fetch-util.ts."],
  verify: async ({ workspace }) => {
    const content = await readFile(join(workspace, "fetch-util.ts"), "utf8");
    if (!content.includes("return parsed")) {
      return { pass: false, reason: "return statement not added" };
    }
    const { exitCode, output } = runTest(workspace, ["fetch-util.test.ts"]);
    if (exitCode !== 0) {
      return { pass: false, reason: `test still fails: ${output.slice(0, 300)}` };
    }
    return { pass: true };
  },
};

export const FIX_FAILING_TEST_TASKS: EvalTask[] = [
  fixOffByOne,
  fixWrongOperator,
  fixMissingReturn,
];
