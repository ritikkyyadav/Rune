import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LspServerManager } from "../../../packages/tool-registry/src/tools/lsp/manager";
import {
  withLspFeedback,
  setLspAutoFeedback,
  formatDiagnosticsBlock,
  lspAutoFeedbackDefault,
  MAX_DIAGNOSTIC_LINES,
} from "../../../packages/tool-registry/src/tools/lsp/feedback";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
} from "../../../packages/tool-registry/src/types";

// P10.1: post-edit semantic diagnostics in the edit's OWN tool result.
//
// Everything here drives the fake stdio language server in tests/fixtures/lsp
// — no test depends on typescript-language-server being installed. Its cases:
// default (one error), --mute (never publishes), --case=typecheck (derives
// diagnostics from the document text), --case=mixed (warnings first on the
// wire), --case=many (25 errors + 5 warnings), --case=noisy (a hint and an
// information that must never reach the block).

const FIXTURE = join(import.meta.dir, "../../fixtures/lsp/fake-lsp-server.ts");

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

/** A stand-in write tool: writes the file and returns the usual JSON shape. */
const fakeWriteTool: ToolHandler = {
  schema: {
    name: "write_file",
    version: "0",
    description: "test write",
    inputSchema: { type: "object", properties: {} },
    permissionLevel: "confirm",
    category: "write",
  },
  validate: () => ({ valid: true }),
  execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
    const abs = join(input.workspaceRoot, input.args.path as string);
    writeFileSync(abs, input.args.content as string);
    return {
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: JSON.stringify({ path: input.args.path, bytes: String(input.args.content).length }),
      durationMs: 1,
    };
  },
};

function editInput(
  workspace: string,
  path: string,
  content = "const x: number = 'oops';\n",
): ToolCallInput {
  return {
    toolName: "write_file",
    callId: "c1",
    args: { path, content },
    sessionId: "s1",
    workspaceRoot: workspace,
  };
}

const managers: LspServerManager[] = [];
afterAll(async () => {
  for (const m of managers) await m.stopAll();
});
afterEach(() => setLspAutoFeedback(false));

describe("post-edit LSP diagnostics (P10.1)", () => {
  test("ON: the server's verdict lands in the same tool result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager());

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(out.success).toBe(true);
    const result = JSON.parse(out.result);
    // `file:line:col severity message`, workspace-relative.
    expect(result.diagnostics).toBe("code.fake:3:5 error fake error from fixture");
    // The original result fields are untouched.
    expect(result.path).toBe("code.fake");
  });

  test("OFF: result is untouched and no server is spawned", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    const manager = fakeManager();
    const wrapped = withLspFeedback(fakeWriteTool, manager);

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).diagnostics).toBeUndefined();
  });

  test("readiness gate: a server that never publishes claims nothing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--mute"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(out.success).toBe(true);
    // analyzed=false — silence is NOT a clean bill of health, so no block at
    // all rather than an empty one that would read as "the file is fine".
    expect(JSON.parse(out.result).diagnostics).toBeUndefined();
  });

  test("the 2s cap holds: a silent server cannot stall the edit to the 10s gate", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--mute"]));

    const start = performance.now();
    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    const elapsed = performance.now() - start;

    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).diagnostics).toBeUndefined();
    // 2s budget + spawn slack, and nowhere near the manager's 10s gate.
    expect(elapsed).toBeLessThan(5000);
    expect(elapsed).toBeGreaterThan(1000);
  });

  test("a publish that beats the budget is still reported", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--publish-delay=400"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(JSON.parse(out.result).diagnostics).toContain("fake error from fixture");
  });

  test("errors come before warnings, whatever order the server published in", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--case=mixed"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    const lines = (JSON.parse(out.result).diagnostics as string).split("\n");
    expect(lines).toEqual([
      "code.fake:21:5 error error twenty",
      "code.fake:41:5 error error forty",
      "code.fake:11:5 warning warning ten",
      "code.fake:51:5 warning warning fifty",
    ]);
  });

  test("truncation: 20 lines plus a +N more tail, errors surviving first", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--case=many"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    const lines = (JSON.parse(out.result).diagnostics as string).split("\n");
    // 25 errors + 5 warnings = 30 diagnostics, bounded to 20 + the tail.
    expect(lines).toHaveLength(MAX_DIAGNOSTIC_LINES + 1);
    expect(lines[lines.length - 1]).toBe("+10 more");
    // Every surviving line is an error: warnings are the first thing cut.
    expect(lines.slice(0, MAX_DIAGNOSTIC_LINES).every((l) => l.includes(" error "))).toBe(true);
  });

  test("hints and information never reach the block", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--case=noisy"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(JSON.parse(out.result).diagnostics).toBe("code.fake:3:5 error the only real error");
  });

  test("a clean file gets no block at all", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--case=typecheck"]));

    const out = await wrapped.execute(editInput(workspace, "code.fake", "const x: number = 1;\n"));
    expect(JSON.parse(out.result).diagnostics).toBeUndefined();
  });

  test("the content-derived case reports the semantic error the syntax pass cannot see", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager(["--case=typecheck"]));

    const out = await wrapped.execute(
      editInput(workspace, "code.fake", "const _unused = 1;\nconst n: number = 'two';\n"),
    );
    const lines = (JSON.parse(out.result).diagnostics as string).split("\n");
    expect(lines[0]).toContain("Type 'string' is not assignable to type 'number'.");
    expect(lines[1]).toContain("'_unused' is declared but its value is never read.");
  });

  test("the server's block supersedes the syntax pass for that file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const withSyntax: ToolHandler = {
      ...fakeWriteTool,
      execute: async (input) => {
        const out = await fakeWriteTool.execute(input);
        const r = JSON.parse(out.result) as Record<string, unknown>;
        r.syntax_check = "SYNTAX ERRORS INTRODUCED: line 1: something";
        return { ...out, result: JSON.stringify(r) };
      },
    };
    const out = await withLspFeedback(withSyntax, fakeManager()).execute(
      editInput(workspace, "code.fake"),
    );
    const result = JSON.parse(out.result);
    expect(result.diagnostics).toContain("fake error from fixture");
    expect(result.syntax_check).toBeUndefined();
  });

  test("no server for the extension, and failed writes, pass through untouched", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "gear-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager());

    const txt = await wrapped.execute(editInput(workspace, "notes.txt"));
    expect(JSON.parse(txt.result).diagnostics).toBeUndefined();

    const failing: ToolHandler = {
      ...fakeWriteTool,
      execute: async (input) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error: "disk full",
        durationMs: 1,
      }),
    };
    const failed = await withLspFeedback(failing, fakeManager()).execute(
      editInput(workspace, "code.fake"),
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("disk full");
  });
});

describe("diagnostics block rendering", () => {
  const d = (severity: string, line: number, column: number, message: string) => ({
    severity,
    line,
    column,
    message,
  });

  test("multi-file blocks order by severity, then file, then position", () => {
    const block = formatDiagnosticsBlock(
      [
        { file: "/w/b.ts", diagnostics: [d("warning", 1, 1, "w-b"), d("error", 9, 2, "e-b")] },
        { file: "/w/a.ts", diagnostics: [d("error", 3, 1, "e-a2"), d("error", 1, 4, "e-a1")] },
      ],
      "/w",
    );
    expect(block.split("\n")).toEqual([
      "a.ts:1:4 error e-a1",
      "a.ts:3:1 error e-a2",
      "b.ts:9:2 error e-b",
      "b.ts:1:1 warning w-b",
    ]);
  });

  test("a file outside the workspace keeps its absolute path", () => {
    const block = formatDiagnosticsBlock(
      [{ file: "/elsewhere/x.ts", diagnostics: [d("error", 1, 1, "e")] }],
      "/w",
    );
    expect(block).toBe("/elsewhere/x.ts:1:1 error e");
  });

  test("multi-line server messages collapse to one line, and duplicates are dropped", () => {
    const block = formatDiagnosticsBlock(
      [
        {
          file: "/w/a.ts",
          diagnostics: [
            d("error", 1, 1, "line one\n  line two"),
            d("error", 1, 1, "line one line two"),
          ],
        },
      ],
      "/w",
    );
    expect(block).toBe("a.ts:1:1 error line one line two");
  });

  test("nothing reportable renders as an empty string, never a header", () => {
    expect(formatDiagnosticsBlock([{ file: "/w/a.ts", diagnostics: [] }], "/w")).toBe("");
    expect(
      formatDiagnosticsBlock([{ file: "/w/a.ts", diagnostics: [d("hint", 1, 1, "h")] }], "/w"),
    ).toBe("");
  });
});

describe("default-on detection", () => {
  test("a workspace with no project markers never defaults on", () => {
    const empty = mkdtempSync(join(tmpdir(), "gear-lspdef-"));
    expect(lspAutoFeedbackDefault(empty)).toBe(false);
  });

  test("a TypeScript workspace defaults on exactly when its server is installed", () => {
    const ws = mkdtempSync(join(tmpdir(), "gear-lspdef-"));
    writeFileSync(join(ws, "tsconfig.json"), "{}");
    // The default is a function of the machine, so the assertion has to be
    // too — asserting `true` here would fail on a box without the server.
    expect(lspAutoFeedbackDefault(ws)).toBe(Bun.which("typescript-language-server") !== null);
  });

  test("a Rust workspace never defaults on (rust-analyzer indexes past the budget)", () => {
    const ws = mkdtempSync(join(tmpdir(), "gear-lspdef-"));
    writeFileSync(join(ws, "Cargo.toml"), "[package]\nname='x'\n");
    expect(lspAutoFeedbackDefault(ws)).toBe(false);
  });
});
