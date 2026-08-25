import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createMultiEditHandler } from "../../../packages/tool-registry/src/tools/multi-edit";

const handler = createMultiEditHandler();
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

function inputFor(ws: string, args: Record<string, unknown>) {
  return { toolName: "multi_edit", callId: "c1", sessionId: "s1", workspaceRoot: ws, args };
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "gear-medit-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("createMultiEditHandler", () => {
  test("has correct schema metadata", () => {
    expect(handler.schema.name).toBe("multi_edit");
    expect(handler.schema.permissionLevel).toBe("confirm");
    expect(handler.schema.category).toBe("write");
  });

  // ── validate ──
  test("rejects missing path", () => {
    expect(handler.validate({ edits: [{ old_text: "a", new_text: "b" }] }).valid).toBe(false);
  });
  test("rejects empty edits array", () => {
    expect(handler.validate({ path: "x", edits: [] }).valid).toBe(false);
  });
  test("rejects edit with empty old_text", () => {
    const r = handler.validate({ path: "x", edits: [{ old_text: "", new_text: "b" }] });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/old_text/);
  });
  test("accepts a well-formed edit", () => {
    expect(handler.validate({ path: "x", edits: [{ old_text: "a", new_text: "b" }] }).valid).toBe(
      true,
    );
  });

  // ── execute: exact ──
  test("applies a single exact edit and returns the new hash", async () => {
    const content = "export const greeting = 'hello';\n";
    await writeFile(join(ws, "f.ts"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.ts",
        expected_hash: sha(content),
        edits: [{ old_text: "'hello'", new_text: "'world'" }],
      }),
    );
    expect(out.success).toBe(true);
    const after = await readFile(join(ws, "f.ts"), "utf8");
    expect(after).toBe("export const greeting = 'world';\n");
    const parsed = JSON.parse(out.result);
    expect(parsed.hash).toBe(sha(after));
    expect(parsed.edits[0].strategy).toBe("exact");
  });

  test("applies multiple sequential edits atomically", async () => {
    const content = "let a = 1;\nlet b = 2;\n";
    await writeFile(join(ws, "f.ts"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.ts",
        edits: [
          { old_text: "a = 1", new_text: "a = 10" },
          { old_text: "b = 2", new_text: "b = 20" },
        ],
      }),
    );
    expect(out.success).toBe(true);
    expect(await readFile(join(ws, "f.ts"), "utf8")).toBe("let a = 10;\nlet b = 20;\n");
  });

  test("replace_all replaces every occurrence", async () => {
    await writeFile(join(ws, "f.txt"), "x x x\n");
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.txt",
        edits: [{ old_text: "x", new_text: "y", replace_all: true }],
      }),
    );
    expect(out.success).toBe(true);
    expect(await readFile(join(ws, "f.txt"), "utf8")).toBe("y y y\n");
  });

  test("ambiguous match without replace_all fails and leaves the file unchanged", async () => {
    const content = "x x x\n";
    await writeFile(join(ws, "f.txt"), content);
    const out = await handler.execute(
      inputFor(ws, { path: "f.txt", edits: [{ old_text: "x", new_text: "y" }] }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/matches 3 times/);
    expect(await readFile(join(ws, "f.txt"), "utf8")).toBe(content);
  });

  // ── execute: safety ──
  test("hash mismatch fails and leaves the file unchanged", async () => {
    const content = "original\n";
    await writeFile(join(ws, "f.txt"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.txt",
        expected_hash: "deadbeef",
        edits: [{ old_text: "original", new_text: "changed" }],
      }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Hash mismatch/);
    expect(await readFile(join(ws, "f.txt"), "utf8")).toBe(content);
  });

  test("if a later edit fails, no earlier edit is written (atomicity)", async () => {
    const content = "let a = 1;\nlet b = 2;\n";
    await writeFile(join(ws, "f.ts"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.ts",
        edits: [
          { old_text: "a = 1", new_text: "a = 10" }, // would succeed
          { old_text: "does-not-exist", new_text: "x" }, // fails
        ],
      }),
    );
    expect(out.success).toBe(false);
    expect(await readFile(join(ws, "f.ts"), "utf8")).toBe(content);
  });

  test("not-found edit fails and leaves the file unchanged", async () => {
    const content = "hello\n";
    await writeFile(join(ws, "f.txt"), content);
    const out = await handler.execute(
      inputFor(ws, { path: "f.txt", edits: [{ old_text: "nonexistent", new_text: "x" }] }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found/);
    expect(await readFile(join(ws, "f.txt"), "utf8")).toBe(content);
  });

  test("missing file fails gracefully", async () => {
    const out = await handler.execute(
      inputFor(ws, { path: "nope.txt", edits: [{ old_text: "a", new_text: "b" }] }),
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Cannot read file/);
  });

  // ── execute: fuzzy fallbacks ──
  test("falls back to whitespace-insensitive match (trailing spaces in file)", async () => {
    const content = "function f() {   \n  return 1;\n}\n";
    await writeFile(join(ws, "f.ts"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.ts",
        edits: [
          {
            old_text: "function f() {\n  return 1;\n}",
            new_text: "function f() {\n  return 2;\n}",
          },
        ],
      }),
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).edits[0].strategy).toBe("whitespace");
    expect(await readFile(join(ws, "f.ts"), "utf8")).toContain("return 2;");
  });

  test("falls back to indentation-insensitive match (different indent width)", async () => {
    const content = "class A {\n    method() {\n        return 1;\n    }\n}\n";
    await writeFile(join(ws, "f.ts"), content);
    const out = await handler.execute(
      inputFor(ws, {
        path: "f.ts",
        edits: [
          {
            old_text: "method() {\n  return 1;\n}",
            new_text: "method() {\n  return 2;\n}",
          },
        ],
      }),
    );
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result).edits[0].strategy).toBe("indentation");
    expect(await readFile(join(ws, "f.ts"), "utf8")).toContain("return 2;");
  });
});
