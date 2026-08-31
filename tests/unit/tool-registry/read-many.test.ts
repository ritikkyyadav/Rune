/**
 * read_many — the batched form of read_file. One model round-trip for up to 12
 * files, composed over the real (freshness-wrapped) read_file handler so every
 * file read through it records its hash like a plain read.
 */

import { describe, test, expect } from "bun:test";
import {
  createReadManyHandler,
  READ_MANY_SCHEMA,
} from "../../../packages/tool-registry/src/tools/read-many";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
} from "../../../packages/tool-registry/src/types";

function fakeReadFile(files: Record<string, string | { image: true } | { fail: string }>): {
  handler: ToolHandler;
  calls: string[];
} {
  const calls: string[] = [];
  const handler: ToolHandler = {
    schema: { ...READ_MANY_SCHEMA, name: "read_file" },
    validate: () => ({ valid: true }),
    async execute(input: ToolCallInput): Promise<ToolCallOutput> {
      const path = String(input.args.path);
      calls.push(path);
      const f = files[path];
      const base = { callId: input.callId, toolName: "read_file", durationMs: 1 };
      if (f === undefined || (typeof f === "object" && "fail" in f)) {
        return {
          ...base,
          success: false,
          result: "",
          error: typeof f === "object" && "fail" in f ? f.fail : "No such file",
        };
      }
      if (typeof f === "object" && "image" in f) {
        return {
          ...base,
          success: true,
          result: JSON.stringify({ path, content: "(image)", hash: "h" }),
          attachments: [
            { kind: "image", mediaType: "image/png", data: "AAAA", label: path } as any,
          ],
        };
      }
      return {
        ...base,
        success: true,
        result: JSON.stringify({ path, content: f, hash: `hash-${path}`, truncated: false }),
      };
    },
  };
  return { handler, calls };
}

const input = (paths: unknown): ToolCallInput => ({
  toolName: "read_many",
  callId: "c1",
  args: { paths },
  sessionId: "s",
  workspaceRoot: "/tmp",
});

describe("read_many", () => {
  test("reads several files in one call, each under its own header", async () => {
    const { handler: rf, calls } = fakeReadFile({
      "a.ts": "const a = 1;",
      "b.ts": "const b = 2;",
      "c.ts": "const c = 3;",
    });
    const out = await createReadManyHandler(rf).execute(input(["a.ts", "b.ts", "c.ts"]));
    expect(out.success).toBe(true);
    expect(calls).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(out.result).toContain("=== a.ts ===\nconst a = 1;");
    expect(out.result).toContain("=== b.ts ===\nconst b = 2;");
    expect(out.result).toContain("=== c.ts ===\nconst c = 3;");
  });

  test("a failed file degrades to an inline error; the batch still succeeds", async () => {
    const { handler: rf } = fakeReadFile({ "a.ts": "ok", "missing.ts": { fail: "No such file" } });
    const out = await createReadManyHandler(rf).execute(input(["a.ts", "missing.ts"]));
    expect(out.success).toBe(true);
    expect(out.result).toContain("=== a.ts ===\nok");
    expect(out.result).toContain("=== missing.ts ===\n(error: No such file)");
  });

  test("all files failing fails the call", async () => {
    const { handler: rf } = fakeReadFile({});
    const out = await createReadManyHandler(rf).execute(input(["x.ts", "y.ts"]));
    expect(out.success).toBe(false);
    expect(out.error).toContain("no path could be read");
  });

  test("images are skipped with a pointer to read_file — pixels ride single reads only", async () => {
    const { handler: rf } = fakeReadFile({ "shot.png": { image: true }, "a.ts": "code" });
    const out = await createReadManyHandler(rf).execute(input(["shot.png", "a.ts"]));
    expect(out.result).toContain("=== shot.png ===\n(image/binary");
    expect(out.result).toContain("=== a.ts ===\ncode");
    expect(out.attachments ?? []).toHaveLength(0);
  });

  test("caps at 12 paths and says how many were dropped", async () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 15; i++) {
      files[`f${i}.ts`] = `f${i}`;
      paths.push(`f${i}.ts`);
    }
    const { handler: rf, calls } = fakeReadFile(files);
    const out = await createReadManyHandler(rf).execute(input(paths));
    expect(calls).toHaveLength(12);
    expect(out.result).toContain("+3 more paths dropped");
  });

  test("a giant file is truncated per-file so it cannot starve the batch", async () => {
    const { handler: rf } = fakeReadFile({ "big.ts": "x".repeat(50_000), "small.ts": "tiny" });
    const out = await createReadManyHandler(rf).execute(input(["big.ts", "small.ts"]));
    expect(out.result).toContain("more chars — read_file for the rest");
    expect(out.result).toContain("=== small.ts ===\ntiny");
  });

  test("validate rejects an empty or non-array paths", () => {
    const { handler: rf } = fakeReadFile({});
    const h = createReadManyHandler(rf);
    expect(h.validate({ paths: [] }).valid).toBe(false);
    expect(h.validate({ paths: "a.ts" as any }).valid).toBe(false);
    expect(h.validate({ paths: ["a.ts"] }).valid).toBe(true);
  });
});
