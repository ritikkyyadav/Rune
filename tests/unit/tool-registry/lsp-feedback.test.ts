import { describe, test, expect, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LspServerManager } from "../../../packages/tool-registry/src/tools/lsp/manager";
import {
  withLspFeedback,
  setLspAutoFeedback,
} from "../../../packages/tool-registry/src/tools/lsp/feedback";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
} from "../../../packages/tool-registry/src/types";

// P4: opt-in post-edit LSP feedback. The fake server publishes one ERROR
// diagnostic ("fake error from fixture") for every opened doc; --mute never
// publishes, which exercises the 1.5s budget path (edit must return promptly
// with no lsp field, not hang on the 10s readiness gate).

const FIXTURE = join(import.meta.dir, "../../fixtures/lsp/fake-lsp-server.ts");

function fakeManager(opts: { mute?: boolean } = {}): LspServerManager {
  const m = new LspServerManager({
    serversOverride: [
      {
        extensions: [".fake"],
        spec: {
          id: "fake",
          command: ["bun", FIXTURE, ...(opts.mute ? ["--mute"] : [])],
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

function editInput(workspace: string, path: string): ToolCallInput {
  return {
    toolName: "write_file",
    callId: "c1",
    args: { path, content: "const x: number = 'oops';\n" },
    sessionId: "s1",
    workspaceRoot: workspace,
  };
}

const managers: LspServerManager[] = [];
afterAll(async () => {
  for (const m of managers) await m.stopAll();
});
afterEach(() => setLspAutoFeedback(false));

describe("post-edit LSP feedback (P4)", () => {
  test("autoFeedback ON: server errors land in the same tool result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "alan-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager());

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(out.success).toBe(true);
    const result = JSON.parse(out.result);
    expect(result.lsp_check).toContain("fake error from fixture");
    expect(result.lsp_check).toContain("line 3");
    // The original result fields are untouched.
    expect(result.path).toBe("code.fake");
  });

  test("autoFeedback OFF (default): result is untouched, no server spawned", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "alan-lspfb-"));
    const manager = fakeManager();
    const wrapped = withLspFeedback(fakeWriteTool, manager);

    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).lsp_check).toBeUndefined();
  });

  test("budget: a server that never publishes cannot stall the edit past ~1.5s", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "alan-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager({ mute: true }));

    const start = performance.now();
    const out = await wrapped.execute(editInput(workspace, "code.fake"));
    const elapsed = performance.now() - start;

    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).lsp_check).toBeUndefined(); // analyzed=false → no claim
    expect(elapsed).toBeLessThan(4000); // 1.5s budget + spawn slack, NOT the 10s gate
  });

  test("unsupported extensions and failed writes pass through untouched", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "alan-lspfb-"));
    setLspAutoFeedback(true);
    const wrapped = withLspFeedback(fakeWriteTool, fakeManager());

    const txt = await wrapped.execute({
      ...editInput(workspace, "notes.txt"),
    });
    expect(JSON.parse(txt.result).lsp_check).toBeUndefined();

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
