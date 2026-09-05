import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createGlobHandler, globToRegExp } from "../../../packages/tool-registry/src/tools/glob";

describe("globToRegExp", () => {
  test("* does not cross path separators", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("x/a.ts")).toBe(false);
  });
  test("** matches across directories", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("x/y/a.ts")).toBe(true);
    expect(re.test("a.js")).toBe(false);
  });
  test("nested pattern with prefix", () => {
    const re = globToRegExp("src/**/*.test.ts");
    expect(re.test("src/a.test.ts")).toBe(true);
    expect(re.test("src/x/y/a.test.ts")).toBe(true);
    expect(re.test("lib/a.test.ts")).toBe(false);
  });
  test("? matches exactly one char", () => {
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("abc.ts")).toBe(false);
  });
});

const handler = createGlobHandler();
function inputFor(ws: string, args: Record<string, unknown>) {
  return { toolName: "glob", callId: "c1", sessionId: "s1", workspaceRoot: ws, args };
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "rune-glob-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("createGlobHandler", () => {
  test("has correct schema metadata", () => {
    expect(handler.schema.name).toBe("glob");
    expect(handler.schema.permissionLevel).toBe("auto");
    expect(handler.schema.category).toBe("read");
  });

  test("rejects missing pattern", () => {
    expect(handler.validate({}).valid).toBe(false);
  });

  test("finds files recursively and skips ignored dirs", async () => {
    await mkdir(join(ws, "src"), { recursive: true });
    await mkdir(join(ws, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(ws, "src", "a.ts"), "");
    await writeFile(join(ws, "src", "b.ts"), "");
    await writeFile(join(ws, "src", "c.js"), "");
    await writeFile(join(ws, "node_modules", "pkg", "d.ts"), "");

    const out = await handler.execute(inputFor(ws, { pattern: "**/*.ts" }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("src/a.ts");
    expect(out.result).toContain("src/b.ts");
    expect(out.result).not.toContain("c.js");
    expect(out.result).not.toContain("node_modules");
  });

  test("matches files at the root with a non-recursive pattern", async () => {
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "top.ts"), "");
    await writeFile(join(ws, "sub", "deep.ts"), "");
    const out = await handler.execute(inputFor(ws, { pattern: "*.ts" }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("top.ts");
    expect(out.result).not.toContain("sub/deep.ts");
  });

  test("returns a friendly message when nothing matches", async () => {
    const out = await handler.execute(inputFor(ws, { pattern: "**/*.rs" }));
    expect(out.success).toBe(true);
    expect(out.result).toMatch(/No files matched/);
  });

  test("respects the result limit", async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(ws, `f${i}.txt`), "");
    const out = await handler.execute(inputFor(ws, { pattern: "*.txt", limit: 2 }));
    expect(out.success).toBe(true);
    expect(out.result).toMatch(/showing 2/);
  });
});
