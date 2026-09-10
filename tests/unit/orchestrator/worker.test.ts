/**
 * `worker` — write-capable parallel sub-agents with disjoint file ownership.
 * Ownership is enforced mechanically (write tools wrapped), concurrent claims
 * conflict-checked, and the worker's world contains no shell/network/recursion.
 */

import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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

// Resolve the compiled rune-tools binary the same way the CLI does
// (bin/rune-cli.ts's findToolsBinary): release build, then debug build,
// relative to this file — not a hardcoded developer-machine path, which
// would only ever resolve on the one laptop it was written on. Tests that
// actually shell out to it skip cleanly (test.skipIf) when it hasn't been
// built — e.g. CI's ts-lint job runs `bun test` without a `cargo build` step.
const RUST_RELEASE = join(import.meta.dir, "../../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../../target/debug/rune-tools");
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

describe("worker isolation contract", () => {
  function gitRepo(): string {
    const root = ws();
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "T"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "README.md"), "# base\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    return root;
  }
  function scriptedGateway() {
    let call = 0;
    return {
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
            delta: { type: "text_delta", text: "Created widget.ts." },
          };
          yield {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
      },
    };
  }

  test.skipIf(!HAS_RUST_BIN)(
    "a checkout that cannot be created falls back to the shared tree and says so",
    async () => {
      const root = gitRepo();
      writeFileSync(join(root, ".rune"), "not a directory");
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({
          gateway: scriptedGateway() as any,
          model: "m",
          provider: "google" as any,
        }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Create widget.ts", files: ["widget.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);
      expect(out.success).toBe(true);
      expect(out.result).toContain("ISOLATION UNAVAILABLE");
      expect(out.structured?.integration).toBe("shared");
      expect(String(out.structured?.isolationNote)).toContain("shared tree");
      expect(readFileSync(join(root, "widget.ts"), "utf8")).toContain("42");
    },
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a snapshot that would be partial fails the dispatch with the remedy, never a stale worker",
    async () => {
      const root = gitRepo();
      symlinkSync("/etc/hosts", join(root, "escape"));
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({
          gateway: scriptedGateway() as any,
          model: "m",
          provider: "google" as any,
        }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Create widget.ts", files: ["widget.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);
      expect(out.success).toBe(false);
      expect(out.error).toContain("leaves the project");
      expect(existsSync(join(root, "widget.ts"))).toBe(false);
    },
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a worker with its own checkout reports what provisioning cost",
    async () => {
      const root = gitRepo();
      const tool = createWorkerTool({
        binaryPath: RUST_BIN,
        resolve: () => ({
          gateway: scriptedGateway() as any,
          model: "m",
          provider: "google" as any,
        }),
      });
      const out = await tool.execute({
        toolName: "worker",
        callId: "c1",
        args: { prompt: "Create widget.ts", files: ["widget.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);
      expect(out.success).toBe(true);
      expect(out.result).toContain("[ISOLATION] own checkout");
      expect(out.structured?.provisioning).toMatchObject({ untrackedFiles: 0 });
    },
  );
});

/**
 * G24 — a conflicted merge keeps `success: true` and stops being invisible.
 *
 * The work is retained on the worker's branch, not lost, so failing the tool
 * call would tell the model to throw a real build away. But the conflict was
 * only ever the prose block `[MERGE CONFLICTS — …]` inside the result text,
 * which no machine consumer reads: the headless envelope and the TUI both saw
 * an unqualified success.
 */
describe("G24 — a conflicted worker merge is a typed field, not only prose", () => {
  function gitRepo(): string {
    const root = ws();
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "T"],
    ])
      spawnSync("git", args, { cwd: root });
    writeFileSync(join(root, "README.md"), "# base\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    return root;
  }

  test.skipIf(!HAS_RUST_BIN)(
    "conflicts and integration reach `structured`, and the child summary carries both",
    async () => {
      const root = gitRepo();
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
            yield { type: "message_stop", stopReason: "tool_use", usage: {} };
          } else {
            // The lead edits the same file while the worker is running. This is
            // the concurrent-lead-edit shape worker-worktree.test.ts pins at the
            // merge layer; here it has to survive all the way to the caller.
            writeFileSync(join(root, "widget.ts"), "export const widget = () => 1;\n");
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: "Created widget.ts." },
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
        args: { prompt: "Create widget.ts", files: ["widget.ts"] },
        sessionId: "0198cccc-5555-7000-8000-eeeeeeeeeeee",
        workspaceRoot: root,
      } as ToolCallInput);

      // The work is retained, so the call is not a failure.
      expect(out.success).toBe(true);
      expect(out.result).toContain("MERGE CONFLICTS");
      // ... and now a consumer can count it without reading prose.
      expect(out.structured?.integration).toBe("retained");
      expect(out.structured?.conflicts).toEqual(["widget.ts"]);
      // The branch is named for the worker, whose id is keyed to a digest of
      // the WHOLE session id rather than its first 8 characters (two sessions a
      // second apart shared those, and therefore shared a counter).
      expect(out.structured?.branch).toMatch(/^rune\/worker-w[0-9a-f]{12}-\d+$/);
      // The §4 `children[]` shape.
      expect(out.structured?.child).toMatchObject({
        status: "end_turn",
        integration: "retained",
        conflicts: ["widget.ts"],
      });
      // The lead's own edit is still the lead's.
      expect(readFileSync(join(root, "widget.ts"), "utf8")).toContain("() => 1");
    },
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a clean merge reports no conflicts rather than no field",
    async () => {
      const root = gitRepo();
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
            yield { type: "message_stop", stopReason: "tool_use", usage: {} };
          } else {
            yield {
              type: "content_delta",
              contentIndex: 0,
              delta: { type: "text_delta", text: "Created widget.ts." },
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
        args: { prompt: "Create widget.ts", files: ["widget.ts"] },
        sessionId: "0198dddd-6666-7000-8000-ffffffffffff",
        workspaceRoot: root,
      } as ToolCallInput);

      expect(out.success).toBe(true);
      expect(out.structured?.integration).toBe("merged");
      expect(out.structured?.conflicts).toEqual([]);
      expect(out.structured?.child).toMatchObject({ integration: "merged", conflicts: [] });
      expect(out.result).not.toContain("MERGE CONFLICTS");
    },
  );
});

/**
 * "No summary" never erases useful work — the worker half.
 *
 * The scout stopped failing on this in P6B.3. `worker` still did: it passed
 * `trail: []` and bailed on `!trimmed && changed.size === 0`, so a worker that
 * read a dozen files and ran out of turns before writing its report came back
 * as a bare failure with every receipt discarded.
 */
describe("a worker that wrote no report still returns its work and its cause", () => {
  /**
   * A "model" that never stops calling a tool and never writes a report.
   *
   * `glob` on purpose: it is TypeScript-native (no rune-tools binary) and its
   * calls SUCCEED against real seeded files, so the run marches its whole turn
   * budget instead of tripping the repeated-failure breaker first — the same
   * reason worker-report-provenance.test.ts uses it for the turn clock.
   */
  function toolOnlyGateway() {
    let turn = 0;
    return {
      inferStream: async function* () {
        turn++;
        yield { type: "tool_use_start", toolCallId: `t${turn}`, toolName: "glob" };
        yield {
          type: "tool_use_stop",
          toolCallId: `t${turn}`,
          toolInput: { pattern: `src/f${turn}.ts` },
        };
        yield { type: "message_stop", stopReason: "tool_use", usage: {} };
      },
    };
  }

  test("a tool-heavy worker that hits max_turns keeps its receipts and names the cause", async () => {
    const root = ws();
    mkdirSync(join(root, "src"), { recursive: true });
    for (let i = 1; i <= 14; i++) writeFileSync(join(root, "src", `f${i}.ts`), "export {};\n");
    const tool = createWorkerTool({
      binaryPath: "/nonexistent/rune-tools",
      resolve: () => ({ gateway: toolOnlyGateway() as any, model: "m", provider: "google" as any }),
    });
    const out = await tool.execute({
      toolName: "worker",
      callId: "c1",
      args: { prompt: "Build widget.ts", files: ["widget.ts"], effort: "quick" },
      sessionId: "s",
      workspaceRoot: root,
    } as ToolCallInput);

    // It used to be `success: false, "Worker produced no changes and no report"`.
    expect(out.success).toBe(true);
    expect(out.result).toContain("INCOMPLETE");
    expect(out.result).toContain("ran out of turns");
    expect(out.result).toContain("Stopped: max_turns");
    // The ground it covered, which is the parent's shortest path to finishing.
    expect(out.result).toContain("glob");
    expect(out.result).toContain("src/f1.ts");
    expect(out.result).toContain("src/f2.ts");
    expect(out.structured?.stopReason).toBe("max_turns");
    expect((out.structured?.filesExamined as string[]).length).toBeGreaterThan(1);
    expect(out.structured?.confidence).toBe("low");
    expect(out.structured?.child).toMatchObject({ status: "max_turns" });
  });

  test.skipIf(!HAS_RUST_BIN)(
    "a worker that edited files then returned an empty final surfaces the edits, not a failure",
    async () => {
      const root = ws();
      let call = 0;
      const gateway = {
        inferStream: async function* () {
          call++;
          if (call <= 2) {
            yield { type: "tool_use_start", toolCallId: `t${call}`, toolName: "write_file" };
            yield {
              type: "tool_use_stop",
              toolCallId: `t${call}`,
              toolInput: {
                path: `part${call}.ts`,
                content: `export const part${call} = ${call};\n`,
              },
            };
            yield { type: "message_stop", stopReason: "tool_use", usage: {} };
          } else {
            // Two real edits, then nothing said about them.
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
        args: { prompt: "Build both parts", files: ["part1.ts", "part2.ts"] },
        sessionId: "s",
        workspaceRoot: root,
      } as ToolCallInput);

      expect(out.success).toBe(true);
      // Harness-measured, never the model's claim — it made none.
      expect((out.structured?.filesChanged as string[]).sort()).toEqual(["part1.ts", "part2.ts"]);
      expect(out.structured?.confidence).toBe("low");
      expect(String((out.structured?.unresolved as string[])[0])).toContain("wrote no summary");
      expect(out.result).toContain("INCOMPLETE");
      expect(out.result).toContain("WORKER MANIFEST");
      expect(out.structured?.child).toMatchObject({ status: "end_turn" });
      expect(readFileSync(join(root, "part2.ts"), "utf8")).toContain("part2 = 2");
    },
  );

  test("nothing written, nothing changed AND nothing done is still the one genuine failure", async () => {
    const root = ws();
    const silent = {
      inferStream: async function* () {
        yield { type: "message_stop", stopReason: "end_turn", usage: {} };
      },
    };
    const tool = createWorkerTool({
      binaryPath: "/nonexistent/rune-tools",
      resolve: () => ({ gateway: silent as any, model: "m", provider: "google" as any }),
    });
    const out = await tool.execute({
      toolName: "worker",
      callId: "c1",
      args: { prompt: "Build it", files: ["widget.ts"] },
      sessionId: "s",
      workspaceRoot: root,
    } as ToolCallInput);
    expect(out.success).toBe(false);
    expect(out.error).toContain("Worker produced");
  });
});
