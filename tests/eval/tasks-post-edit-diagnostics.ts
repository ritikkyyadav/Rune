/**
 * P10.1 — post-edit diagnostics, measured.
 *
 * The two pre-existing families this item was told to measure on
 * (fix-failing-test, multi-file-refactor) sit at 100% and contain no type
 * error anywhere: every scripted edit is already correct, so no feedback
 * channel can move them. They cannot show this feature's delta, and saying
 * otherwise would be inventing one.
 *
 * So this pair measures it directly, as a controlled experiment. Both tasks
 * are the same brief, the same script and the same responder; the ONLY
 * difference is whether the language server publishes. The model's first edit
 * introduces a genuine SEMANTIC error — `const discount: number = "0.2"` —
 * that the syntax pass parses without complaint and that JavaScript's own
 * coercion hides at runtime (`1 - "0.2"` is 0.8, so the behavioural test still
 * passes). Only a type-aware checker objects, which is precisely the class of
 * mistake this feature exists to catch.
 *
 *   treatment — the server publishes: the diagnostics block reaches the model
 *               in the edit's own tool result and it corrects the literal in
 *               the same turn.
 *   control   — the server publishes nothing (--mute): the model has no
 *               evidence, so the type error ships. The task PASSES by
 *               asserting that it shipped; a control arm that silently agreed
 *               with the treatment would prove nothing.
 *
 * Determinism: both point GEAR_LSP_SERVERS at the fake stdio server in
 * tests/fixtures/lsp, so neither depends on typescript-language-server being
 * installed. The env is set in setup(), which runs before the Engine is built
 * and therefore before the server table is read.
 */
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";

import { resetServerTable } from "@gear/tool-registry";
import type { EvalTask } from "./harness";
import type { ScriptedResponse } from "./mock-provider";

const FAKE_SERVER = join(import.meta.dir, "..", "fixtures", "lsp", "fake-lsp-server.ts");

/** Point the whole process's LSP table at the fake server, in a chosen mode. */
function useFakeServer(args: string[]): void {
  process.env.GEAR_LSP_SERVERS = JSON.stringify([
    { id: `fake-${args.join("")}`, extensions: [".ts"], command: ["bun", FAKE_SERVER, ...args] },
  ]);
  // The table is cached per process and the two arms want different modes.
  resetServerTable();
}

/**
 * Hand the process back its real table the moment the run is over. Without
 * this the arm that happened to run last would decide what every LATER task in
 * the suite sees, which is exactly the kind of order dependence that makes a
 * suite unreproducible.
 */
function restoreServerTable(): void {
  delete process.env.GEAR_LSP_SERVERS;
  resetServerTable();
}

const ORIGINAL = `export interface Item {
  price: number;
  qty: number;
}

export function total(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`;

/** The edit the model makes first — correct JavaScript, wrong TypeScript. */
const WITH_TYPE_ERROR = `  const discount: number = "0.2";
  return items.reduce((sum, i) => sum + i.price * i.qty, 0) * (1 - discount);`;

/** What it writes once the diagnostics block tells it the literal is a string. */
const CORRECTED = `  const discount: number = 0.2;
  return items.reduce((sum, i) => sum + i.price * i.qty, 0) * (1 - discount);`;

const PROMPT = "Apply a 20% discount inside total() in total.ts. Keep the return type number.";

async function setupWorkspace(workspace: string): Promise<void> {
  // A package.json is what makes this a TypeScript workspace for the
  // default-on check; the fake server standing in for tsserver is what makes
  // it resolve on any machine.
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "discount" }));
  await writeFile(join(workspace, "total.ts"), ORIGINAL);
  await writeFile(
    join(workspace, "total.test.ts"),
    `import { expect, test } from "bun:test";
import { total } from "./total";
test("applies the discount", () => {
  expect(total([{ price: 100, qty: 1 }])).toBeCloseTo(80);
});
`,
  );
}

/** The shared two-step script: read the file, then make the wrong edit. */
const SCRIPT = [
  {
    text: "Reading total.ts before changing it.",
    toolCalls: [{ name: "read_file", args: { path: "total.ts" } }],
  },
  {
    text: "Adding the discount.",
    toolCalls: [
      {
        name: "edit_file",
        args: {
          path: "total.ts",
          old_text: "  return items.reduce((sum, i) => sum + i.price * i.qty, 0);",
          new_text: WITH_TYPE_ERROR,
        },
      },
    ],
  },
  { text: "Discount applied." },
];

/**
 * The state machine that makes this a MEASUREMENT rather than a script: the
 * corrective edit happens if and only if the transcript carries the language
 * server's verdict. Returning null falls through to the script above.
 */
const responder = (request: {
  messages: Array<{ content: unknown[] }>;
}): ScriptedResponse | null => {
  const transcript = JSON.stringify(request.messages);
  // Checked first: once the fix is on the wire, the diagnostics text is still
  // in the transcript and would otherwise re-trigger the edit forever.
  if (transcript.includes("const discount: number = 0.2;")) {
    return { text: "The language server flagged the string literal; corrected it to a number." };
  }
  if (transcript.includes("not assignable to type 'number'")) {
    return {
      text: "The diagnostics block says the discount literal is a string. Fixing it.",
      toolCalls: [
        {
          name: "edit_file",
          args: { path: "total.ts", old_text: WITH_TYPE_ERROR, new_text: CORRECTED },
        },
      ],
    };
  }
  return null;
};

function runTests(workspace: string): { exitCode: number; output: string } {
  const r = spawnSync("bun", ["test", "total.test.ts"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30000,
  });
  return { exitCode: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

const withDiagnostics: EvalTask = {
  name: "fix_type_error_from_diagnostics",
  category: "fix-failing-test",
  description:
    "TREATMENT: an edit introduces a type error and the post-edit diagnostics block gets it fixed in the same turn.",
  setup: async ({ workspace }) => {
    useFakeServer(["--case=typecheck"]);
    await setupWorkspace(workspace);
  },
  script: SCRIPT,
  responder,
  prompts: [PROMPT],
  verify: async ({ workspace }) => {
    restoreServerTable();
    const content = await readFile(join(workspace, "total.ts"), "utf8");
    if (content.includes('"0.2"') || content.includes("'0.2'")) {
      return {
        pass: false,
        reason: "the type error survived — the diagnostics block did not reach the model",
      };
    }
    if (!content.includes("const discount: number = 0.2;")) {
      return { pass: false, reason: "the discount literal was never corrected to a number" };
    }
    const { exitCode, output } = runTests(workspace);
    if (exitCode !== 0) {
      return {
        pass: false,
        reason: `behaviour broke while fixing the type: ${output.slice(0, 300)}`,
      };
    }
    return { pass: true };
  },
};

const withoutDiagnostics: EvalTask = {
  name: "type_error_ships_without_diagnostics",
  category: "fix-failing-test",
  description:
    "CONTROL: identical run with a language server that publishes nothing — the same type error ships, which is what the treatment is measured against.",
  setup: async ({ workspace }) => {
    useFakeServer(["--mute"]);
    await setupWorkspace(workspace);
  },
  script: SCRIPT,
  responder,
  prompts: [PROMPT],
  verify: async ({ workspace }) => {
    restoreServerTable();
    const content = await readFile(join(workspace, "total.ts"), "utf8");
    if (!content.includes('"0.2"')) {
      return {
        pass: false,
        reason:
          "the control arm corrected the type error without any diagnostics — the treatment's delta is not attributable to the block",
      };
    }
    // The point of the control: the behavioural test still passes, because
    // JavaScript coerces the string. Nothing but a type checker was ever
    // going to catch this, which is the whole argument for the feature.
    const { exitCode } = runTests(workspace);
    if (exitCode !== 0) {
      return {
        pass: false,
        reason: "the control's runtime behaviour changed, so the two arms are not comparable",
      };
    }
    return { pass: true };
  },
};

export const POST_EDIT_DIAGNOSTICS_TASKS: EvalTask[] = [withDiagnostics, withoutDiagnostics];
