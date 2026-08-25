/**
 * Harness-side file freshness: the harness tracks last-known content hashes so
 * the model doesn't have to plumb SHA-256 strings through edit calls.
 *  - edit without prior read → rejected with a read-before-edit error
 *  - edit after read → recorded hash injected as expected_hash
 *  - successful edits update the recorded hash (no re-read needed between edits)
 *  - explicit expected_hash from the model is passed through untouched
 */

import { describe, test, expect, mock } from "bun:test";
import { FileFreshness, withFreshness } from "../../../packages/tool-registry/src/tools/freshness";
import type { ToolCallInput, ToolHandler } from "../../../packages/tool-registry/src/types";

function makeInput(toolName: string, args: Record<string, unknown>): ToolCallInput {
  return { toolName, callId: "c1", args, sessionId: "s1", workspaceRoot: "/ws" };
}

function fakeHandler(
  name: string,
  result: Record<string, unknown>,
  onExecute?: (input: ToolCallInput) => void,
): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: "",
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async (input) => {
      onExecute?.(input);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: JSON.stringify(result),
        durationMs: 1,
      };
    },
  };
}

describe("FileFreshness", () => {
  test("normalizes relative and absolute paths to the same key", () => {
    const f = new FileFreshness();
    f.note("/ws", "src/a.ts", "h1");
    expect(f.get("/ws", "/ws/src/a.ts")).toBe("h1");
    expect(f.get("/ws", "src/a.ts")).toBe("h1");
  });
});

describe("withFreshness", () => {
  test("edit without prior read is rejected", async () => {
    const f = new FileFreshness();
    const edit = withFreshness(fakeHandler("edit_file", {}), f, { requiresFreshRead: true });
    const out = await edit.execute(
      makeInput("edit_file", { path: "a.ts", old_text: "x", new_text: "y" }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toContain("read");
  });

  test("read records the hash; subsequent edit gets it injected", async () => {
    const f = new FileFreshness();
    const read = withFreshness(fakeHandler("read_file", { path: "a.ts", hash: "h-read" }), f);
    await read.execute(makeInput("read_file", { path: "a.ts" }));

    let seenArgs: Record<string, unknown> | undefined;
    const edit = withFreshness(
      fakeHandler("edit_file", { path: "a.ts", hash: "h-after-edit" }, (i) => {
        seenArgs = i.args;
      }),
      f,
      { requiresFreshRead: true },
    );
    const out = await edit.execute(
      makeInput("edit_file", { path: "a.ts", old_text: "x", new_text: "y" }),
    );
    expect(out.success).toBe(true);
    expect(seenArgs?.expected_hash).toBe("h-read");
    // The post-edit hash was recorded — a second edit needs no re-read.
    expect(f.get("/ws", "a.ts")).toBe("h-after-edit");
  });

  test("explicit expected_hash from the model passes through untouched", async () => {
    const f = new FileFreshness();
    f.note("/ws", "a.ts", "h-recorded");
    let seenArgs: Record<string, unknown> | undefined;
    const edit = withFreshness(
      fakeHandler("edit_file", { path: "a.ts", hash: "h2" }, (i) => {
        seenArgs = i.args;
      }),
      f,
      { requiresFreshRead: true },
    );
    await edit.execute(
      makeInput("edit_file", {
        path: "a.ts",
        old_text: "x",
        new_text: "y",
        expected_hash: "h-explicit",
      }),
    );
    expect(seenArgs?.expected_hash).toBe("h-explicit");
  });

  test("write_file records the new hash so an edit can follow without a read", async () => {
    const f = new FileFreshness();
    const write = withFreshness(fakeHandler("write_file", { path: "new.ts", hash: "h-w" }), f);
    await write.execute(makeInput("write_file", { path: "new.ts", content: "x" }));

    let seenArgs: Record<string, unknown> | undefined;
    const edit = withFreshness(
      fakeHandler("edit_file", { path: "new.ts", hash: "h-e" }, (i) => {
        seenArgs = i.args;
      }),
      f,
      { requiresFreshRead: true },
    );
    const out = await edit.execute(
      makeInput("edit_file", { path: "new.ts", old_text: "x", new_text: "y" }),
    );
    expect(out.success).toBe(true);
    expect(seenArgs?.expected_hash).toBe("h-w");
  });
});
