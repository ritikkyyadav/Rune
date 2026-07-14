/**
 * LSP client + manager against the deterministic fake server fixture:
 * handshake, the four actions end-to-end through the real JSON-RPC transport,
 * timeout behavior (bounded, never a hang), missing-server teaching error,
 * mtime-keyed document freshness, and teardown that leaves no processes.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspServerManager } from "../../../packages/tool-registry/src/tools/lsp/manager";
import { createLspHandler } from "../../../packages/tool-registry/src/tools/lsp/tool";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";

const FIXTURE = join(import.meta.dir, "../../fixtures/lsp/fake-lsp-server.ts");

function fakeManager(opts: { slow?: boolean; requestTimeoutMs?: number } = {}): LspServerManager {
  return new LspServerManager({
    requestTimeoutMs: opts.requestTimeoutMs ?? 8000,
    serversOverride: [
      {
        extensions: [".fake"],
        spec: {
          id: "fake",
          command: ["bun", FIXTURE, ...(opts.slow ? ["--slow"] : [])],
          installHint: "cannot happen — bun is the test runtime",
          languageId: () => "fake",
        },
      },
    ],
  });
}

function workspaceWithFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "alan-lsp-"));
  const file = join(dir, "sample.fake");
  writeFileSync(file, "line one\nline two\nline three\n".repeat(5));
  return { dir, file };
}

function callInput(args: Record<string, unknown>, workspaceRoot: string): ToolCallInput {
  return { toolName: "lsp", callId: "c1", args, sessionId: "s1", workspaceRoot };
}

const managers: LspServerManager[] = [];
afterAll(async () => {
  for (const m of managers) await m.stopAll();
});

describe("LSP manager against the fake server", () => {
  test("definition round-trips through real JSON-RPC framing (1-based out)", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const locs = await manager.definition(file, { line: 3, column: 5 }, dir);
    expect(locs).toHaveLength(1);
    expect(locs[0].file).toBe(file);
    expect(locs[0].line).toBe(10); // fixture answers 0-based line 9
    expect(locs[0].column).toBe(3);
    expect(locs[0].preview).toContain("line");
  });

  test("references returns every location", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const locs = await manager.references(file, { line: 1, column: 1 }, dir);
    expect(locs.map((l) => l.line)).toEqual([2, 5]);
  });

  test("hover flattens markdown contents", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const text = await manager.hover(file, { line: 1, column: 1 }, dir);
    expect(text).toContain("function fake(): void");
  });

  test("diagnostics waits for the publish and converts to 1-based", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const { diagnostics, analyzed } = await manager.diagnostics(file, dir);
    expect(analyzed).toBe(true);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      line: 3,
      column: 5,
      message: "fake error from fixture",
    });
  });

  test("a server that never answers produces a bounded timeout, not a hang", async () => {
    const manager = fakeManager({ slow: true, requestTimeoutMs: 300 });
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const started = Date.now();
    await expect(manager.definition(file, { line: 1, column: 1 }, dir)).rejects.toThrow(
      /timed out/,
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("missing server binary → teaching error naming the install command", async () => {
    const manager = new LspServerManager({
      serversOverride: [
        {
          extensions: [".fake"],
          spec: {
            id: "fake",
            command: ["definitely-not-installed-lsp-server"],
            installHint: "npm install -g definitely-not-installed-lsp-server",
            languageId: () => "fake",
          },
        },
      ],
    });
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    await expect(manager.hover(file, { line: 1, column: 1 }, dir)).rejects.toThrow(
      /not installed.*npm install -g definitely-not-installed-lsp-server/s,
    );
  });

  test("unsupported extension → clear error listing what IS supported", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir } = workspaceWithFile();
    const weird = join(dir, "file.zig");
    writeFileSync(weird, "const x = 1;");
    await expect(manager.hover(weird, { line: 1, column: 1 }, dir)).rejects.toThrow(
      /No language server configured/,
    );
  });

  test("on-disk change reopens the document (mtime-keyed freshness)", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    await manager.diagnostics(file, dir);
    // Touch the file into the future — next call must didClose/didOpen and
    // the fixture publishes fresh diagnostics for the reopened doc.
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const { analyzed } = await manager.diagnostics(file, dir);
    expect(analyzed).toBe(true);
  });
});

describe("lsp tool handler", () => {
  test("validate rejects bad actions and missing positions", () => {
    const handler = createLspHandler(fakeManager());
    expect(handler.validate({ action: "rename", file: "x.fake" }).valid).toBe(false);
    expect(handler.validate({ action: "hover", file: "x.fake" }).valid).toBe(false);
    expect(handler.validate({ action: "diagnostics", file: "x.fake" }).valid).toBe(true);
    expect(handler.validate({ action: "hover", file: "x.fake", line: 1, column: 1 }).valid).toBe(
      true,
    );
  });

  test("resolves workspace-relative paths and formats file:line:column", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir, file } = workspaceWithFile();
    const handler = createLspHandler(manager);
    const out = await handler.execute(
      callInput({ action: "definition", file: "sample.fake", line: 3, column: 5 }, dir),
    );
    expect(out.success).toBe(true);
    expect(out.result).toContain(`${file}:10:3`);
  });

  test("tool errors are values (missing file), never throws", async () => {
    const manager = fakeManager();
    managers.push(manager);
    const { dir } = workspaceWithFile();
    const handler = createLspHandler(manager);
    const out = await handler.execute(
      callInput({ action: "hover", file: "nope.fake", line: 1, column: 1 }, dir),
    );
    expect(out.success).toBe(false);
    expect(out.error).toContain("File not found");
  });

  test("stopAll terminates the server process", async () => {
    const manager = fakeManager();
    const { dir, file } = workspaceWithFile();
    await manager.hover(file, { line: 1, column: 1 }, dir);
    await manager.stopAll();
    // A fresh request after stopAll lazily starts a NEW server — proving the
    // old one is gone and restart works.
    const text = await manager.hover(file, { line: 1, column: 1 }, dir);
    expect(text).toContain("function fake");
    await manager.stopAll();
  });
});
