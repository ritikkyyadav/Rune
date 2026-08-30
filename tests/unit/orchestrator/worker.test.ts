/**
 * `worker` — write-capable parallel sub-agents with disjoint file ownership.
 * Ownership is enforced mechanically (write tools wrapped), concurrent claims
 * conflict-checked, and the worker's world contains no shell/network/recursion.
 */

import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ownership,
  OwnershipClaims,
  WORKER_TOOL_SCHEMA,
  buildWorkerRegistry,
  createWorkerPermissionCheck,
  createWorkerTool,
  workerSystemPrompt,
} from "../../../packages/orchestrator/src/worker";
import type { ToolCallInput } from "../../../packages/tool-registry/src/types";

// Resolve the compiled gear-tools binary the same way the CLI does
// (bin/gear-cli.ts's findToolsBinary): release build, then debug build,
// relative to this file — not a hardcoded developer-machine path, which
// would only ever resolve on the one laptop it was written on. Tests that
// actually shell out to it skip cleanly (test.skipIf) when it hasn't been
// built — e.g. CI's ts-lint job runs `bun test` without a `cargo build` step.
const RUST_RELEASE = join(import.meta.dir, "../../../target/release/gear-tools");
const RUST_DEBUG = join(import.meta.dir, "../../../target/debug/gear-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

function ws(): string {
  return mkdtempSync(join(tmpdir(), "worker-ws-"));
}

describe("Ownership — path semantics", () => {
  test("exact files and directory subtrees; outside-workspace rejected", () => {
    const root = ws();
    mkdirSync(join(root, "src"));
    const o = new Ownership(root, ["src/auth.ts", "lib/"]);
    expect(o.owns(root, "src/auth.ts")).toBe(true);
    expect(o.owns(root, join(root, "src/auth.ts"))).toBe(true);
    expect(o.owns(root, "lib/new-file.ts")).toBe(true); // new file under owned dir
    expect(o.owns(root, "lib/deep/nested.ts")).toBe(true);
    expect(o.owns(root, "src/other.ts")).toBe(false);
    expect(o.owns(root, "package.json")).toBe(false);
    expect(() => new Ownership(root, ["../escape.ts"])).toThrow(/inside the workspace/);
    expect(() => new Ownership(root, ["/etc/hosts"])).toThrow(/inside the workspace/);
  });
});

describe("OwnershipClaims — concurrent disjointness", () => {
  test("overlapping claims are refused; release frees them", () => {
    const root = ws();
    const claims = new OwnershipClaims();
    const a = new Ownership(root, ["src/a.ts", "shared/"]);
    expect(claims.claim("w1", a)).toBeNull();

    // exact overlap
    expect(claims.claim("w2", new Ownership(root, ["src/a.ts"]))).not.toBeNull();
    // file under a claimed dir
    expect(claims.claim("w3", new Ownership(root, ["shared/util.ts"]))).not.toBeNull();
    // dir over a claimed file
    expect(claims.claim("w4", new Ownership(root, ["src/"]))).not.toBeNull();
    // disjoint is fine
    expect(claims.claim("w5", new Ownership(root, ["docs/readme.md"]))).toBeNull();

    claims.release("w1");
    expect(claims.claim("w6", new Ownership(root, ["src/a.ts"]))).toBeNull();
  });
});

describe("worker registry — restricted world", () => {
  test("reads + guarded writes only; no bash/web/task/dashboard", () => {
    const root = ws();
    const registry = buildWorkerRegistry(RUST_BIN, new Ownership(root, ["mine.ts"]));
    const names = registry.list().map((s) => s.name);
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    for (const banned of [
      "bash",
      "bash_output",
      "kill_shell",
      "web_fetch",
      "web_search",
      "task",
      "worker",
      "interactive_dashboard",
      "n8n_trigger",
    ]) {
      expect(names).not.toContain(banned);
    }
  });

  test.skipIf(!HAS_RUST_BIN)(
    "write inside ownership lands; outside is refused with guidance",
    async () => {
      const root = ws();
      const registry = buildWorkerRegistry(RUST_BIN, new Ownership(root, ["mine.ts"]));
      const write = (path: string): Promise<any> =>
        registry.execute({
          toolName: "write_file",
          callId: "c",
          args: { path, content: "export const x = 1;\n" },
          sessionId: "s",
          workspaceRoot: root,
        } as ToolCallInput);

      const ok = await write("mine.ts");
      expect(ok.success).toBe(true);
      expect(existsSync(join(root, "mine.ts"))).toBe(true);

      const denied = await write("theirs.ts");
      expect(denied.success).toBe(false);
      expect(denied.error).toContain("Ownership violation");
      expect(denied.error).toContain("read-only reference");
      expect(existsSync(join(root, "theirs.ts"))).toBe(false);
    },
  );

  test("permission check allows read/write categories only", async () => {
    const root = ws();
    const registry = buildWorkerRegistry(RUST_BIN, new Ownership(root, ["mine.ts"]));
    const check = createWorkerPermissionCheck(registry);
    expect((await check({ toolName: "read_file", args: {} } as any)).allowed).toBe(true);
    expect((await check({ toolName: "write_file", args: {} } as any)).allowed).toBe(true);
    expect((await check({ toolName: "bash", args: {} } as any)).allowed).toBe(false);
  });
});

describe("worker tool — schema + end-to-end run", () => {
  test("schema: confirm-level execute, explicitly parallel-safe, teaches disjointness", () => {
    expect(WORKER_TOOL_SCHEMA.permissionLevel).toBe("confirm");
    expect(WORKER_TOOL_SCHEMA.category).toBe("execute");
    expect(WORKER_TOOL_SCHEMA.parallelSafe).toBe(true);
    expect(WORKER_TOOL_SCHEMA.description).toContain("DISJOINT");
  });

  test("workers carry the interface-craft doctrine — big-build frontends are not exempt", () => {
    // The doctrine steers large builds to workers; without this block, every
    // large build's UI was written by the one agent that never saw
    // "Building interfaces" — the observed generated-looking-frontend cause.
    const prompt = workerSystemPrompt("app/ui.html");
    expect(prompt).toContain("a senior product designer built this");
    expect(prompt).toContain("ONE art direction");
    expect(prompt).toContain("Banned slop");
    expect(prompt).toContain("never emoji");
  });

  test("validation: prompt + files required, bounded", () => {
    const tool = createWorkerTool({ binaryPath: RUST_BIN, resolve: () => ({}) as any });
    expect(tool.validate({ prompt: "x" }).valid).toBe(false);
    expect(tool.validate({ prompt: "x", files: [] }).valid).toBe(false);
    expect(tool.validate({ prompt: "", files: ["a.ts"] }).valid).toBe(false);
    expect(tool.validate({ prompt: "x", files: ["a.ts"] }).valid).toBe(true);
  });

  test.skipIf(!HAS_RUST_BIN)(
    "a scripted worker writes its owned file and reports; changes surface in the result",
    async () => {
      const root = ws();
      // Fake gateway: the "model" writes its owned file, then reports.
      let call = 0;
      const gateway = {
        inferStream: async function* () {
          call++;
          if (call === 1) {
            yield { type: "tool_use_start", toolCallId: "t1", toolName: "write_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: "t1",
              toolInput: { path: "widget.ts", content: "export const widget = () => 42;\n" },
            };
            yield {
              type: "message_stop",
              stopReason: "tool_use",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          } else {
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: "Created widget.ts exporting widget()." },
            };
            yield {
              type: "message_stop",
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          }
        },
      };
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({ gateway: gateway as any, model: "m", provider: "google" as any }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Create widget.ts exporting widget()", files: ["widget.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);

      expect(out.success).toBe(true);
      expect(out.result).toContain("Created widget.ts");
      // The report now ends in something the worker did not write: what is
      // actually on disk, measured after the run.
      expect(out.result).toContain("WORKER MANIFEST");
      expect(out.result).toContain("widget.ts");
      expect(out.result).toContain("1 file");
      expect(out.result).toContain("NOT VERIFIED");
      expect(readFileSync(join(root, "widget.ts"), "utf8")).toContain("widget = () => 42");
    },
  );

  // The defect this exists for: in one EvoLab build three workers wrote an
  // entire backend, an entire frontend, and all the docs, and the orchestrator
  // accepted their prose after opening seven files out of fifty-four. A file
  // NAME cannot tell you whether a module is a module or a stub. A line count
  // can, and the worker cannot inflate it.
  test.skipIf(!HAS_RUST_BIN)(
    "the manifest measures the file, so a stub cannot hide behind a confident report",
    async () => {
      const root = ws();
      let call = 0;
      const gateway = {
        inferStream: async function* () {
          call++;
          if (call === 1) {
            yield { type: "tool_use_start", toolCallId: "t1", toolName: "write_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: "t1",
              toolInput: { path: "api.ts", content: "// TODO\nexport {};\n" },
            };
            yield { type: "message_stop", stopReason: "tool_use", usage: {} };
          } else {
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: {
                type: "text_delta",
                text: "Implemented the complete REST API with full validation and error handling.",
              },
            };
            yield { type: "message_stop", stopReason: "end_turn", usage: {} };
          }
        },
      };
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({ gateway: gateway as any, model: "m", provider: "google" as any }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Build the API", files: ["api.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);

      // The prose claims a complete API ...
      expect(out.result).toContain("complete REST API");
      // ... and the measurement, right underneath, says three lines.
      expect(out.result).toMatch(/\s3 lines\s/);
      expect(out.result).toContain("NOT VERIFIED");
    },
  );

  // The MISSING row is defensive and cannot be staged through the real tool
  // (only a write that SUCCEEDED enters the changed set), so what is pinned
  // here is the other half: a file that really landed is never mislabelled.
  test.skipIf(!HAS_RUST_BIN)(
    "a file that really was written is reported plainly, with no MISSING row",
    async () => {
      const root = ws();
      let call = 0;
      const gateway = {
        inferStream: async function* () {
          call++;
          if (call === 1) {
            // A write the guard will refuse: the path is not owned, so nothing
            // lands on disk while the worker still reports success.
            yield { type: "tool_use_start", toolCallId: "t1", toolName: "write_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: "t1",
              toolInput: { path: "owned.ts", content: "export const a = 1;\n" },
            };
            yield { type: "message_stop", stopReason: "tool_use", usage: {} };
          } else {
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: "Done." },
            };
            yield { type: "message_stop", stopReason: "end_turn", usage: {} };
          }
        },
      };
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({ gateway: gateway as any, model: "m", provider: "google" as any }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Write it", files: ["owned.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);

      // Sanity: this one really was written, so the happy path still reads normally.
      expect(out.result).toContain("owned.ts");
      expect(out.result).not.toContain("MISSING");
      expect(existsSync(join(root, "owned.ts"))).toBe(true);
    },
  );

  test("two CONCURRENT workers with overlapping ownership: second refused instantly", async () => {
    const root = ws();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Worker 1's model stalls until we release it, keeping the claim active.
    const slowGateway = {
      inferStream: async function* () {
        await gate;
        yield {
          type: "content_delta",
          contentIndex: 0,
          delta: { type: "text_delta", text: "done" },
        };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const tool = createWorkerTool({
      binaryPath: RUST_BIN,
      resolve: () => ({ gateway: slowGateway as any, model: "m", provider: "google" as any }),
    });
    const input = (id: string, files: string[]): ToolCallInput =>
      ({
        toolName: "worker",
        callId: id,
        args: { prompt: "p", files },
        sessionId: "s",
        workspaceRoot: root,
      }) as ToolCallInput;

    const first = tool.execute(input("c1", ["src/"]));
    await new Promise((r) => setTimeout(r, 30)); // let worker 1 claim
    const second = await tool.execute(input("c2", ["src/overlap.ts"]));
    expect(second.success).toBe(false);
    expect(second.error).toContain("Ownership conflict");

    release();
    const firstOut = await first;
    expect(firstOut.success).toBe(true);

    // After release, the same files are claimable again.
    const third = tool.execute(input("c3", ["src/overlap.ts"]));
    release();
    expect((await third).success).toBe(true);
  });
});
