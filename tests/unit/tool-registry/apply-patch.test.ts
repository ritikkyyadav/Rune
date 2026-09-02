import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  createApplyPatchHandler,
  parsePatch,
  patchTargetPaths,
} from "../../../packages/tool-registry/src/tools/apply-patch";
import { LspServerManager } from "../../../packages/tool-registry/src/tools/lsp/manager";
import { setLspAutoFeedback } from "../../../packages/tool-registry/src/tools/lsp/feedback";
import { ToolRegistry, modelUsesApplyPatch } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";

// P3: apply_patch — the Codex-family edit envelope, applied through Gear's
// own matcher with validate-everything-then-write semantics. The acceptance
// list from the prescription plan: multi-hunk, create/delete file, context
// mismatch → clean error, NEVER partial application.

let workspace: string;
const handler = createApplyPatchHandler();

async function run(patch: string) {
  return handler.execute({
    callId: "t1",
    toolName: "apply_patch",
    args: { patch },
    workspaceRoot: workspace,
    sessionId: "s1",
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "gear-apply-patch-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("parsePatch", () => {
  test("parses add + update + delete in one envelope", () => {
    const ops = parsePatch(`*** Begin Patch
*** Add File: new.ts
+export const NEW = 1;
*** Update File: old.ts
@@
 context
-removed
+added
*** Delete File: dead.ts
*** End Patch`);
    expect(ops.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
    expect(ops[0]).toMatchObject({ path: "new.ts", content: "export const NEW = 1;\n" });
    expect(ops[1]).toMatchObject({
      path: "old.ts",
      edits: [{ old_text: "context\nremoved", new_text: "context\nadded" }],
    });
  });

  test("multiple hunks per file, implicit first @@, and Move to", () => {
    const ops = parsePatch(`*** Begin Patch
*** Update File: src/a.ts
*** Move to: src/b.ts
 top
-one
+ONE
@@ function two
 mid
-two
+TWO
*** End Patch`);
    expect(ops).toHaveLength(1);
    const up = ops[0];
    if (up.kind !== "update") throw new Error("expected update");
    expect(up.moveTo).toBe("src/b.ts");
    expect(up.edits).toHaveLength(2);
    expect(up.edits[1]).toEqual({ old_text: "mid\ntwo", new_text: "mid\nTWO" });
  });

  test("missing envelope / garbage headers / add-only hunks fail with line numbers", () => {
    expect(() => parsePatch("no envelope")).toThrow(/Begin Patch/);
    expect(() =>
      parsePatch(`*** Begin Patch
random junk
*** End Patch`),
    ).toThrow(/line 2/);
    expect(() =>
      parsePatch(`*** Begin Patch
*** Update File: a.ts
@@
+only additions no anchor
*** End Patch`),
    ).toThrow(/anchor/);
  });

  test("patchTargetPaths surfaces every touched path incl. move destinations", () => {
    const paths = patchTargetPaths(`*** Begin Patch
*** Update File: a.ts
*** Move to: b/c.ts
 x
-y
+z
*** Delete File: d.ts
*** End Patch`);
    expect(paths).toEqual(["a.ts", "b/c.ts", "d.ts"]);
    expect(patchTargetPaths("garbage")).toEqual([]);
  });
});

describe("apply_patch execution", () => {
  test("multi-hunk update across two files applies atomically", async () => {
    await writeFile(
      join(workspace, "math.ts"),
      "export function add(a, b) {\n  return a - b;\n}\nexport function mul(a, b) {\n  return a + b;\n}\n",
    );
    await writeFile(join(workspace, "index.ts"), "import { add } from './math';\n");

    const out = await run(`*** Begin Patch
*** Update File: math.ts
@@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
@@
 export function mul(a, b) {
-  return a + b;
+  return a * b;
 }
*** Update File: index.ts
@@
-import { add } from './math';
+import { add, mul } from './math';
*** End Patch`);

    expect(out.success).toBe(true);
    const math = await readFile(join(workspace, "math.ts"), "utf8");
    expect(math).toContain("return a + b;");
    expect(math).toContain("return a * b;");
    expect(await readFile(join(workspace, "index.ts"), "utf8")).toContain("add, mul");
    const result = JSON.parse(out.result);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].edits_applied).toBe(2);
  });

  test("create and delete files", async () => {
    await writeFile(join(workspace, "dead.ts"), "// dead\n");
    const out = await run(`*** Begin Patch
*** Add File: fresh/created.ts
+export const CREATED = true;
*** Delete File: dead.ts
*** End Patch`);
    expect(out.success).toBe(true);
    expect(await readFile(join(workspace, "fresh/created.ts"), "utf8")).toBe(
      "export const CREATED = true;\n",
    );
    expect(await Bun.file(join(workspace, "dead.ts")).exists()).toBe(false);
  });

  test("context mismatch in ANY hunk applies NOTHING (no partial application)", async () => {
    await writeFile(join(workspace, "one.ts"), "const a = 1;\n");
    await writeFile(join(workspace, "two.ts"), "const b = 2;\n");
    const out = await run(`*** Begin Patch
*** Update File: one.ts
@@
-const a = 1;
+const a = 100;
*** Update File: two.ts
@@
-THIS CONTEXT DOES NOT EXIST
+whatever
*** End Patch`);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/);
    // File one must be untouched even though ITS hunk was valid.
    expect(await readFile(join(workspace, "one.ts"), "utf8")).toBe("const a = 1;\n");
    expect(await readFile(join(workspace, "two.ts"), "utf8")).toBe("const b = 2;\n");
  });

  test("move with edit, whitespace-drifted context still matches", async () => {
    await writeFile(join(workspace, "loc.ts"), "function f() {\n    return 1;   \n}\n");
    const out = await run(`*** Begin Patch
*** Update File: loc.ts
*** Move to: moved.ts
@@
 function f() {
-    return 1;
+    return 2;
 }
*** End Patch`);
    expect(out.success).toBe(true);
    expect(await Bun.file(join(workspace, "loc.ts")).exists()).toBe(false);
    expect(await readFile(join(workspace, "moved.ts"), "utf8")).toContain("return 2;");
    expect(JSON.parse(out.result).files[0].action).toBe("moved");
  });

  test("add of an existing file / delete of a missing file / workspace escape all refuse", async () => {
    await writeFile(join(workspace, "exists.ts"), "x\n");
    const dup = await run(`*** Begin Patch
*** Add File: exists.ts
+y
*** End Patch`);
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/already exists/);

    const gone = await run(`*** Begin Patch
*** Delete File: never.ts
*** End Patch`);
    expect(gone.success).toBe(false);
    expect(gone.error).toMatch(/does not exist/);

    const escape = await run(`*** Begin Patch
*** Add File: ../outside.ts
+nope
*** End Patch`);
    expect(escape.success).toBe(false);
    expect(escape.error).toMatch(/escapes the workspace/);
    expect(await Bun.file(join(workspace, "..", "outside.ts")).exists()).toBe(false);
  });

  test("syntax issues in the patched result are reported per file", async () => {
    await writeFile(join(workspace, "code.ts"), "function ok() {\n  return 1;\n}\n");
    const out = await run(`*** Begin Patch
*** Update File: code.ts
@@
 function ok() {
   return 1;
-}
+
*** End Patch`);
    expect(out.success).toBe(true); // the EDIT applied; the syntax note rides along
    const files = JSON.parse(out.result).files;
    expect(files[0].syntax_issues?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("per-model-family tool advertisement", () => {
  const fakeTool = (name: string): ToolHandler => ({
    schema: {
      name,
      version: "0",
      description: "t",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async () => ({
      callId: "x",
      toolName: name,
      success: true,
      result: "",
      durationMs: 0,
    }),
  });

  test("modelUsesApplyPatch matches the Codex lineage only", () => {
    for (const m of [
      "gpt-5",
      "gpt-4o-mini",
      "o3",
      "o4-mini",
      "codex-mini-latest",
      "gpt-oss-120b",
    ]) {
      expect(modelUsesApplyPatch(m)).toBe(true);
    }
    for (const m of [
      "claude-sonnet-5",
      "gemini-2.5-flash",
      "qwen3-coder-next",
      "olmo-2",
      "llama3",
    ]) {
      expect(modelUsesApplyPatch(m)).toBe(false);
    }
  });

  test("apply_patch advertised to OpenAI family, hidden otherwise, executable regardless", () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool("read_file"));
    registry.register(createApplyPatchHandler());

    const forGpt = registry.toLlmTools("gpt-5").map((t) => t.name);
    const forClaude = registry.toLlmTools("claude-sonnet-5").map((t) => t.name);
    const forUnknown = registry.toLlmTools().map((t) => t.name);

    expect(forGpt).toContain("apply_patch");
    expect(forClaude).not.toContain("apply_patch");
    expect(forUnknown).not.toContain("apply_patch");
    // Ungated tools are always advertised.
    for (const list of [forGpt, forClaude, forUnknown]) expect(list).toContain("read_file");
    // Execution is family-agnostic: a hidden tool still runs if called.
    expect(registry.get("apply_patch")).toBeDefined();
  });
});

// ─── P10.1: the patch carries the language server's verdict too ───
//
// withLspFeedback is single-path and cannot wrap this tool, so apply_patch
// collects its own block for every file it touched, under ONE shared budget.
// The fake stdio server (tests/fixtures/lsp) keeps it machine-independent.

describe("apply_patch post-edit diagnostics", () => {
  const FIXTURE = join(import.meta.dir, "../../fixtures/lsp/fake-lsp-server.ts");
  const managers: LspServerManager[] = [];

  function fakeManager(args: string[] = []): LspServerManager {
    const m = new LspServerManager({
      serversOverride: [
        {
          extensions: [".fake"],
          spec: {
            id: "fake",
            command: ["bun", FIXTURE, ...args],
            installHint: "cannot happen — bun is the test runtime",
            languageId: () => "fake",
          },
        },
      ],
    });
    managers.push(m);
    return m;
  }

  afterAll(async () => {
    for (const m of managers) await m.stopAll();
    setLspAutoFeedback(false);
  });
  afterEach(() => setLspAutoFeedback(false));

  const patch = (body: string) => `*** Begin Patch\n${body}*** End Patch\n`;

  test("one block covers every file the patch touched", async () => {
    setLspAutoFeedback(true);
    const h = createApplyPatchHandler(fakeManager(["--case=typecheck"]));
    const out = await h.execute({
      callId: "t1",
      toolName: "apply_patch",
      args: {
        patch: patch(
          "*** Add File: a.fake\n+const a: number = 'one';\n" +
            "*** Add File: b.fake\n+const b: number = 2;\n" +
            "*** Add File: c.fake\n+const c: number = 'three';\n",
        ),
      },
      workspaceRoot: workspace,
      sessionId: "s1",
    });

    expect(out.success).toBe(true);
    const result = JSON.parse(out.result) as { files: unknown[]; diagnostics?: string };
    expect(result.files).toHaveLength(3);
    // b.fake is clean, so it contributes nothing; the other two do.
    expect(result.diagnostics?.split("\n")).toEqual([
      "a.fake:1:17 error Type 'string' is not assignable to type 'number'.",
      "c.fake:1:17 error Type 'string' is not assignable to type 'number'.",
    ]);
  });

  test("no manager, or the feature off, leaves the result exactly as it was", async () => {
    const noManager = await createApplyPatchHandler().execute({
      callId: "t1",
      toolName: "apply_patch",
      args: { patch: patch("*** Add File: a.fake\n+const a: number = 'one';\n") },
      workspaceRoot: workspace,
      sessionId: "s1",
    });
    expect(JSON.parse(noManager.result).diagnostics).toBeUndefined();

    const off = await createApplyPatchHandler(fakeManager(["--case=typecheck"])).execute({
      callId: "t2",
      toolName: "apply_patch",
      args: { patch: patch("*** Add File: d.fake\n+const d: number = 'one';\n") },
      workspaceRoot: workspace,
      sessionId: "s1",
    });
    expect(JSON.parse(off.result).diagnostics).toBeUndefined();
  });

  test("the shared budget bounds the whole patch, not each file in it", async () => {
    setLspAutoFeedback(true);
    const h = createApplyPatchHandler(fakeManager(["--mute"]));
    const body = ["a", "b", "c", "d"]
      .map((n) => `*** Add File: ${n}.fake\n+const ${n}: number = 'x';\n`)
      .join("");

    const start = performance.now();
    const out = await h.execute({
      callId: "t1",
      toolName: "apply_patch",
      args: { patch: patch(body) },
      workspaceRoot: workspace,
      sessionId: "s1",
    });
    const elapsed = performance.now() - start;

    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).diagnostics).toBeUndefined();
    // One 2s budget plus spawn slack — never 4 × 2s.
    expect(elapsed).toBeLessThan(5000);
  });
});
