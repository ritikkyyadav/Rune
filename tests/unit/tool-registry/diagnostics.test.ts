/**
 * Post-edit syntax diagnostics: broken files are reported back in the tool
 * result the moment they're written — TS via the compiler API (syntactic
 * pass), JSON via parse, bash via -n, python via ast.parse. All best-effort:
 * unknown types and unavailable checkers yield null, never failures.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSyntax,
  formatIssues,
  withSyntaxCheck,
} from "../../../packages/tool-registry/src/tools/diagnostics";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

describe("checkSyntax", () => {
  test("catches broken TypeScript (unbalanced brace)", async () => {
    const issues = await checkSyntax("/x/broken.ts", "export function f() {\n  return 1;\n");
    expect(issues).not.toBeNull();
    expect(issues!.length).toBeGreaterThan(0);
    expect(issues![0].message).toMatch(/expected/i);
  });

  test("clean TypeScript passes", async () => {
    const issues = await checkSyntax(
      "/x/clean.ts",
      "export function f(): number {\n  return 1;\n}\n",
    );
    expect(issues).toEqual([]);
  });

  test("TSX is parsed as TSX", async () => {
    const issues = await checkSyntax(
      "/x/comp.tsx",
      'export const C = () => <div className="a">hi</div>;\n',
    );
    expect(issues).toEqual([]);
  });

  test("does NOT flag unresolved imports (syntactic pass only)", async () => {
    const issues = await checkSyntax(
      "/x/imports.ts",
      'import { thing } from "./does-not-exist";\nexport const x = thing;\n',
    );
    expect(issues).toEqual([]);
  });

  test("catches broken JSON and passes clean JSON", async () => {
    expect((await checkSyntax("/x/a.json", '{"a": 1,}'))!.length).toBeGreaterThan(0);
    expect(await checkSyntax("/x/a.json", '{"a": 1}')).toEqual([]);
  });

  test("catches broken bash via -n", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-"));
    const bad = join(dir, "bad.sh");
    writeFileSync(bad, "if true; then\necho unclosed\n");
    const issues = await checkSyntax(bad, "if true; then\necho unclosed\n");
    // bash always present on macOS/Linux dev machines; null only if missing.
    if (issues !== null) expect(issues.length).toBeGreaterThan(0);

    const good = join(dir, "good.sh");
    writeFileSync(good, "echo ok\n");
    const clean = await checkSyntax(good, "echo ok\n");
    if (clean !== null) expect(clean).toEqual([]);
  });

  test("python syntax check when python3 exists", async () => {
    if (!Bun.which("python3")) return; // environment without python — skip
    const dir = mkdtempSync(join(tmpdir(), "diag-py-"));
    const bad = join(dir, "bad.py");
    writeFileSync(bad, "def f(:\n  pass\n");
    const issues = await checkSyntax(bad, "def f(:\n  pass\n");
    expect(issues).not.toBeNull();
    expect(issues!.length).toBeGreaterThan(0);
  });

  test("unknown extensions yield null (no checker)", async () => {
    expect(await checkSyntax("/x/notes.md", "# whatever ((( ]")).toBeNull();
    expect(await checkSyntax("/x/data.csv", "a,b,c")).toBeNull();
  });
});

describe("withSyntaxCheck wrapper", () => {
  function fakeWriteHandler(dir: string): ToolHandler {
    return {
      schema: {
        name: "write_file",
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        permissionLevel: "confirm",
        category: "write",
      },
      validate: () => ({ valid: true }),
      execute: async (input: ToolCallInput) => {
        const p = join(dir, String(input.args.path));
        writeFileSync(p, String(input.args.content));
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: JSON.stringify({ path: p, hash: "h123", bytes_written: 1 }),
          durationMs: 1,
        };
      },
    };
  }

  const input = (dir: string, path: string, content: string): ToolCallInput => ({
    toolName: "write_file",
    callId: "c1",
    args: { path, content },
    sessionId: "s1",
    workspaceRoot: dir,
  });

  test("broken write gains a syntax_check warning; hash/path fields survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-wrap-"));
    const h = withSyntaxCheck(fakeWriteHandler(dir));
    const out = await h.execute(input(dir, "broken.ts", "const x = {\n"));
    expect(out.success).toBe(true); // the write itself still succeeded
    const parsed = JSON.parse(out.result);
    expect(parsed.syntax_check).toContain("SYNTAX ERRORS INTRODUCED");
    expect(parsed.hash).toBe("h123"); // freshness extraction unbroken
  });

  test("clean write result is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diag-wrap2-"));
    const h = withSyntaxCheck(fakeWriteHandler(dir));
    const out = await h.execute(input(dir, "ok.ts", "export const x = 1;\n"));
    expect(JSON.parse(out.result).syntax_check).toBeUndefined();
  });

  test("failed writes pass through without checking", async () => {
    const failing: ToolHandler = {
      ...fakeWriteHandler("/nowhere"),
      execute: async (i: ToolCallInput) => ({
        callId: i.callId,
        toolName: i.toolName,
        success: false,
        result: "",
        error: "boom",
        durationMs: 1,
      }),
    };
    const out = await withSyntaxCheck(failing).execute(input("/nowhere", "x.ts", ""));
    expect(out.success).toBe(false);
    expect(out.error).toBe("boom");
  });
});

describe("formatIssues", () => {
  test("caps at 5 issues and notes the overflow", () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({ line: i + 1, message: `e${i}` }));
    const s = formatIssues(issues);
    expect(s).toContain("(+3 more)");
    expect(s).toContain("line 1: e0");
    expect(s).not.toContain("e6");
  });
});
