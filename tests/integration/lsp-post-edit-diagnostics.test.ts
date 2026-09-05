import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LspServerManager } from "../../packages/tool-registry/src/tools/lsp/manager";
import {
  withLspFeedback,
  setLspAutoFeedback,
  lspAutoFeedbackDefault,
} from "../../packages/tool-registry/src/tools/lsp/feedback";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
} from "../../packages/tool-registry/src/types";

// P10.1 against a REAL typescript-language-server. The unit suite proves the
// contract against a fake stdio server and must never need a toolchain; this
// proves the contract holds against the thing users actually run — that a
// genuine type error, one the syntax pass parses without complaint, comes back
// in the edit's own result inside the 2s budget.
//
// Skips cleanly when the server is not installed. That is not a soft gate: a
// machine without it exercises the documented fallback (the syntax pass), and
// this file has nothing to say about that path.

const HAS_SERVER = Bun.which("typescript-language-server") !== null;

const writeTool: ToolHandler = {
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
    writeFileSync(
      join(input.workspaceRoot, input.args.path as string),
      input.args.content as string,
    );
    return {
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: JSON.stringify({ path: input.args.path }),
      durationMs: 1,
    };
  },
};

describe.skipIf(!HAS_SERVER)(
  "post-edit diagnostics against a real typescript-language-server",
  () => {
    let workspace: string;
    let manager: LspServerManager;

    beforeAll(() => {
      workspace = mkdtempSync(join(tmpdir(), "rune-lsp-int-"));
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(
        join(workspace, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022" } }),
      );
      writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "fixture" }));
      manager = new LspServerManager();
    });

    afterAll(async () => {
      setLspAutoFeedback(false);
      await manager.stopAll();
    });

    test("this workspace defaults the feature ON", () => {
      // tsconfig.json + the server on PATH is exactly the documented default.
      expect(lspAutoFeedbackDefault(workspace)).toBe(true);
    });

    test("a real type error comes back in the edit's own result", async () => {
      setLspAutoFeedback(true);
      const wrapped = withLspFeedback(writeTool, manager);

      // First write warms the server (project load is not free), and the 2s
      // budget may legitimately expire on it — that is the documented cold path.
      await wrapped.execute({
        toolName: "write_file",
        callId: "warm",
        args: { path: "src/warm.ts", content: "export const warm = 1;\n" },
        sessionId: "s1",
        workspaceRoot: workspace,
      });

      // A genuine SEMANTIC error: the syntax pass parses this file happily.
      let block = "";
      for (let attempt = 0; attempt < 5 && !block; attempt++) {
        const out = await wrapped.execute({
          toolName: "write_file",
          callId: `c${attempt}`,
          args: {
            path: "src/broken.ts",
            content: `export const n: number = "definitely not a number";\nexport const m = n + ${attempt};\n`,
          },
          sessionId: "s1",
          workspaceRoot: workspace,
        });
        expect(out.success).toBe(true);
        block = (JSON.parse(out.result).diagnostics as string | undefined) ?? "";
      }

      expect(block).not.toBe("");
      expect(block).toContain("src/broken.ts:1:");
      expect(block).toContain("error");
      expect(block).toMatch(/not assignable to type/i);
    }, 60_000);

    test("a clean file gets no block, and the edit is not slowed past the budget", async () => {
      setLspAutoFeedback(true);
      const wrapped = withLspFeedback(writeTool, manager);

      const start = performance.now();
      const out = await wrapped.execute({
        toolName: "write_file",
        callId: "clean",
        args: { path: "src/clean.ts", content: "export const ok: number = 42;\n" },
        sessionId: "s1",
        workspaceRoot: workspace,
      });
      const elapsed = performance.now() - start;

      expect(out.success).toBe(true);
      expect(JSON.parse(out.result).diagnostics).toBeUndefined();
      // The hard promise of the feature: never more than the budget, plus slack.
      expect(elapsed).toBeLessThan(4000);
    }, 30_000);
  },
);
