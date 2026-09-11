/**
 * What excuses a write from re-arming the finish gates (P3B A3 + I6).
 *
 * A plan that closed on a green check waives the execution-evidence and
 * fix-verified gates (`agent-loop.ts`, `planSettled`). A write after that
 * closure re-arms them, because a check that ran before the edit has not
 * measured the edit — UNLESS the write changed nothing, in which case there is
 * nothing the check could have missed and the run should not pay a refused
 * finish for it.
 *
 * "Changed nothing" is one verdict — `usefulEdit`, stamped on the call from
 * the tool's OWN result — and it has to mean the file's content, not the
 * tool's diff. `unifiedDiff` returns "" exactly when the two TEXTS it was
 * handed were equal, and for three of `apply_patch`'s four outcomes those are
 * not the two texts that describe the change (V-A, 2026-09-11):
 *
 *   move    `unifiedDiff(prior, content, moveTo)`  — the PATH moved, not the text
 *   delete  `unifiedDiff(prior, "", path)`         — "" for an empty file
 *   add     `unifiedDiff(prior ?? "", content)`    — "" for an empty new file
 *
 * plus `multi_edit` on a file that is not valid UTF-8, where the decoded texts
 * match and the bytes do not.
 *
 * Every tool result below that can be measured IS measured: the real
 * `apply_patch` / `multi_edit` handler runs in a temp workspace inside the
 * test and the loop is driven with the exact JSON it emitted, so the fixtures
 * cannot drift from the tools. `write_file` and `edit_file` run in the Rust
 * binary; their shapes are quoted from crates/rune-tools.
 *
 * Zero model calls: a scripted gateway, as in agent-loop-settled-plan.test.ts.
 */

import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { createApplyPatchHandler } from "../../../packages/tool-registry/src/tools/apply-patch";
import { createMultiEditHandler } from "../../../packages/tool-registry/src/tools/multi-edit";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    calls: () => i,
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: t.args ?? {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "s" }],
      model: "t",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

const WRITE_TOOLS = ["write_file", "edit_file", "multi_edit", "apply_patch"];

/**
 * The registry the loop sees. Every tool returns `args.toolResult` verbatim
 * when the script supplies one — so each case drives the loop with the exact
 * JSON the real tool emitted, or with the binary's documented shape.
 */
function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: WRITE_TOOLS.includes(name) ? "write" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : input.toolName === "bash"
            ? JSON.stringify({
                exit_code: String(input.args.command ?? "").includes("failing") ? 1 : 0,
                stdout: "",
                stderr: "",
              })
            : typeof input.args?.toolResult === "string"
              ? input.args.toolResult
              : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, taskState: TaskStateStore) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      effortRouting: "off",
      taskState,
      ledgerStatus: () => ({ total: 1, verified: 0 }),
    } as any,
    gateway,
    makeRegistry(),
  );
}

const stopOrigins = (loop: AgentLoop) =>
  loop
    .getMessages()
    .filter(
      (m) =>
        m.role === "user" &&
        m.content.some((b: any) => b.type === "text" && b.text.startsWith("Stop —")),
    )
    .map((m) => loop.originOf(m));

const item = { content: "repair parseCsv", kind: "change" as const };

/** The file the step's own work writes, and the hash the binary reports for it. */
const STEP_FILE = "src/parser.ts";
const STEP_HASH = "ce762e37a2f5a17e1b0e2b9b2f3b9e1d5c4b3a29187766554433221100aabbcc";
const FIRST_WRITE = JSON.stringify({
  path: STEP_FILE,
  hash: STEP_HASH,
  bytes_written: 9,
  created: true,
});

/** Open the step, write, run a green check, close it — then `after`, then finish. */
const settledThen = (after: Step[]): Step[] => [
  { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
  { tool: "write_file", args: { path: STEP_FILE, content: "export {}", toolResult: FIRST_WRITE } },
  { tool: "bash", args: { command: "bun test" } },
  { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
  ...after,
  { text: "The parser was checked." },
];

/** The call id of the one write in `after` — one call per scripted completion. */
const AFTER_CALL = "c5";

/** Did the run's own log record the waiver surviving a write? */
const excusedInLog = (ts: TaskStateStore) =>
  (ts.snapshot().log ?? []).some(
    (e: any) => e.kind === "gate" && /changed no file — the waiver stands/.test(e.text),
  );

/** Drive `settledThen([write])` and report what the run did about it. */
async function afterSettle(write: Step) {
  const ts = new TaskStateStore();
  const loop = makeLoop(makeGateway(settledThen([write])), ts);
  await collect(loop.run("fix the parser", "s1", "/tmp"));
  return {
    excused: excusedInLog(ts),
    origins: stopOrigins(loop),
    usefulEdit: loop.usefulEditOf(AFTER_CALL),
  };
}

/** The two gates a write after a green check must re-arm. */
const REARMED = ["gate:execution-evidence", "gate:fix-verified"];

const patch = async (root: string, text: string) =>
  (await createApplyPatchHandler().execute({
    callId: "c",
    toolName: "apply_patch",
    args: { patch: text },
    workspaceRoot: root,
    sessionId: "s",
  } as any)) as any;

const multiEdit = async (root: string, path: string, edits: unknown[]) =>
  (await createMultiEditHandler().execute({
    callId: "c",
    toolName: "multi_edit",
    args: { path, edits },
    workspaceRoot: root,
    sessionId: "s",
  } as any)) as any;

describe("A3 — an empty diff is not an unchanged tree", () => {
  test("a rename whose content did not move still re-arms the gates", async () => {
    const ws = mkdtempSync(join(tmpdir(), "excuse-move-"));
    writeFileSync(join(ws, "a.ts"), "export const x = 1;\nexport const y = 2;\n");
    const out = await patch(
      ws,
      "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n" +
        "-export const y = 2;\n+export const y = 2;\n*** End Patch\n",
    );
    expect(out.success).toBe(true);
    // Ground truth: the module moved and every importer of `a.ts` is broken,
    // while the tool's own diff is empty — it diffs the CONTENT, and the
    // content is what did not move.
    expect(existsSync(join(ws, "a.ts"))).toBe(false);
    expect(existsSync(join(ws, "b.ts"))).toBe(true);
    expect(JSON.parse(out.result).files[0].diff).toBe("");

    const r = await afterSettle({
      tool: "apply_patch",
      args: { patch: "…", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(true);
    expect(r.excused).toBe(false);
    expect(r.origins).toEqual(REARMED);
  });

  test("deleting an empty file still re-arms the gates", async () => {
    const ws = mkdtempSync(join(tmpdir(), "excuse-del-"));
    writeFileSync(join(ws, "empty.ts"), ""); // .gitkeep, __init__.py, an empty barrel
    const out = await patch(ws, "*** Begin Patch\n*** Delete File: empty.ts\n*** End Patch\n");
    expect(out.success).toBe(true);
    expect(existsSync(join(ws, "empty.ts"))).toBe(false);
    // `unifiedDiff(prior, "")` with prior === "" is "" — a deletion nothing sees.
    expect(JSON.parse(out.result).files[0].diff).toBe("");

    const r = await afterSettle({
      tool: "apply_patch",
      args: { patch: "…", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(true);
    expect(r.excused).toBe(false);
    expect(r.origins).toEqual(REARMED);
  });

  test("adding an empty file still re-arms the gates", async () => {
    const ws = mkdtempSync(join(tmpdir(), "excuse-add-"));
    const out = await patch(ws, "*** Begin Patch\n*** Add File: src/new.ts\n*** End Patch\n");
    expect(out.success).toBe(true);
    expect(existsSync(join(ws, "src/new.ts"))).toBe(true);
    expect(JSON.parse(out.result).files[0].action).toBe("added");
    expect(JSON.parse(out.result).files[0].diff).toBe("");

    const r = await afterSettle({
      tool: "apply_patch",
      args: { patch: "…", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(true);
    expect(r.excused).toBe(false);
    expect(r.origins).toEqual(REARMED);
  });

  test("a multi_edit that rewrote the BYTES of a non-UTF-8 file re-arms the gates", async () => {
    // `multi_edit` decides what to write by comparing bytes, so an edit that
    // reproduces the decoded text of a valid-UTF-8 file writes nothing at all
    // (below). On a file that is NOT valid UTF-8 the decode is lossy: the text
    // it would write back is the text it matched, and the bytes are not the
    // bytes on disk. That write is a change, the diff of the two decoded texts
    // is empty, and the result says so in the only place that can — its hashes.
    const ws = mkdtempSync(join(tmpdir(), "excuse-me-bin-"));
    const p = join(ws, "fixture.bin");
    writeFileSync(p, Buffer.from("const b = 2;\n\xff\xfe\n", "binary"));
    const before = readFileSync(p);
    const out = await multiEdit(ws, "fixture.bin", [
      { old_text: "const b = 2;", new_text: "const b = 2;" },
    ]);
    expect(out.success).toBe(true);
    const record = JSON.parse(out.result);
    expect(record.diff).toBe("");
    expect(readFileSync(p).equals(before)).toBe(false); // the bytes moved
    expect(record.unchanged).toBe(false);
    expect(record.hash).not.toBe(record.prior_hash);

    const r = await afterSettle({
      tool: "multi_edit",
      args: { path: "fixture.bin", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(true);
    expect(r.excused).toBe(false);
    expect(r.origins).toEqual(REARMED);
  });

  test("a mixed patch — one empty hunk, one real — re-arms the gates", async () => {
    const ws = mkdtempSync(join(tmpdir(), "excuse-mixed-"));
    writeFileSync(join(ws, "a.ts"), "const a = 1;\n");
    writeFileSync(join(ws, "b.ts"), "const b = 2;\n");
    const out = await patch(
      ws,
      "*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = 1;\n+const a = 1;\n" +
        "*** Update File: b.ts\n@@\n-const b = 2;\n+const b = 3;\n*** End Patch\n",
    );
    expect(out.success).toBe(true);
    const files = JSON.parse(out.result).files;
    expect(files[0].diff).toBe("");
    expect(files[1].diff).not.toBe("");

    const r = await afterSettle({
      tool: "apply_patch",
      args: { patch: "…", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(true);
    expect(r.origins).toEqual(REARMED);
  });

  test("a no-op edit of a UTF-8 file writes nothing and keeps the waiver", async () => {
    // The case A3 exists for, and the one the finish-path rig counts as 7→6
    // completions: an edit that reproduced what was already there. The tool
    // now skips the write entirely, so the empty diff is true rather than
    // merely reported, and the run is not charged a refused finish for it.
    const ws = mkdtempSync(join(tmpdir(), "excuse-me-noop-"));
    const p = join(ws, "parser.ts");
    writeFileSync(p, "export const parse = () => null;\n");
    const before = readFileSync(p);
    const out = await multiEdit(ws, "parser.ts", [
      { old_text: "export const parse", new_text: "export const parse" },
    ]);
    expect(out.success).toBe(true);
    const record = JSON.parse(out.result);
    expect(record.diff).toBe("");
    expect(record.unchanged).toBe(true);
    expect(record.hash).toBe(record.prior_hash);
    expect(readFileSync(p).equals(before)).toBe(true); // nothing was written

    const r = await afterSettle({
      tool: "multi_edit",
      args: { path: "parser.ts", toolResult: out.result },
    });
    expect(r.usefulEdit).toBe(false);
    expect(r.excused).toBe(true);
    expect(r.origins).toEqual([]);
  });
});

// ─── The matrix: every write tool, changed and unchanged ───
//
// A3 used to reach `multi_edit` and `apply_patch` only. `edit_file` starts
// EVERY diff with `--- a/… / +++ b/…` (edit_file.rs:288) so `diff.trim() === ""`
// was unreachable, and `write_file` emits no diff at all (write_file.rs:99) —
// both were read as real changes, and both are where the doctrine steers most
// writes. The content hash each result already carries closes the gap.
describe("the excuse reaches all four write tools", () => {
  const OTHER_HASH = "aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899";

  /** `write_file`, crates/rune-tools/src/write_file.rs:99. */
  const writeFileResult = (hash: string, created: boolean) =>
    JSON.stringify({ path: STEP_FILE, hash, bytes_written: 9, created });

  /** `edit_file`, crates/rune-tools/src/edit_file.rs:288 — header, then hunks. */
  const editFileResult = (hash: string, hunks: string) =>
    JSON.stringify({
      path: STEP_FILE,
      hash,
      diff: `--- a/${STEP_FILE}\n+++ b/${STEP_FILE}\n${hunks}`,
      replacements: 1,
      strategy: "exact",
    });

  const cases: Array<{
    tool: string;
    what: "changed" | "unchanged";
    step: () => Promise<Step> | Step;
  }> = [
    {
      tool: "write_file",
      what: "unchanged",
      // The same bytes written again: `created: false`, and the hash the run
      // already saw at that path from the write that made it.
      step: () => ({
        tool: "write_file",
        args: { path: STEP_FILE, toolResult: writeFileResult(STEP_HASH, false) },
      }),
    },
    {
      tool: "write_file",
      what: "changed",
      step: () => ({
        tool: "write_file",
        args: { path: STEP_FILE, toolResult: writeFileResult(OTHER_HASH, false) },
      }),
    },
    {
      tool: "edit_file",
      what: "unchanged",
      step: () => ({
        tool: "edit_file",
        args: { path: STEP_FILE, toolResult: editFileResult(STEP_HASH, "") },
      }),
    },
    {
      tool: "edit_file",
      what: "changed",
      step: () => ({
        tool: "edit_file",
        args: {
          path: STEP_FILE,
          toolResult: editFileResult(OTHER_HASH, "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n"),
        },
      }),
    },
    {
      tool: "multi_edit",
      what: "unchanged",
      step: async () => {
        const ws = mkdtempSync(join(tmpdir(), "matrix-me-same-"));
        writeFileSync(join(ws, "f.ts"), "const a = 1;\n");
        const out = await multiEdit(ws, "f.ts", [
          { old_text: "const a = 1;", new_text: "const a = 1;" },
        ]);
        return { tool: "multi_edit", args: { path: "f.ts", toolResult: out.result } };
      },
    },
    {
      tool: "multi_edit",
      what: "changed",
      step: async () => {
        const ws = mkdtempSync(join(tmpdir(), "matrix-me-diff-"));
        writeFileSync(join(ws, "f.ts"), "const a = 1;\n");
        const out = await multiEdit(ws, "f.ts", [
          { old_text: "const a = 1;", new_text: "const a = 2;" },
        ]);
        return { tool: "multi_edit", args: { path: "f.ts", toolResult: out.result } };
      },
    },
    {
      tool: "apply_patch",
      what: "unchanged",
      step: async () => {
        const ws = mkdtempSync(join(tmpdir(), "matrix-ap-same-"));
        writeFileSync(join(ws, "f.ts"), "const a = 1;\n");
        const out = await patch(
          ws,
          "*** Begin Patch\n*** Update File: f.ts\n@@\n-const a = 1;\n+const a = 1;\n*** End Patch\n",
        );
        return { tool: "apply_patch", args: { patch: "…", toolResult: out.result } };
      },
    },
    {
      tool: "apply_patch",
      what: "changed",
      step: async () => {
        const ws = mkdtempSync(join(tmpdir(), "matrix-ap-diff-"));
        writeFileSync(join(ws, "f.ts"), "const a = 1;\n");
        const out = await patch(
          ws,
          "*** Begin Patch\n*** Update File: f.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch\n",
        );
        return { tool: "apply_patch", args: { patch: "…", toolResult: out.result } };
      },
    },
  ];

  for (const c of cases) {
    test(`${c.tool}, content ${c.what}: ${
      c.what === "unchanged" ? "excused, no gate" : "re-arms both gates"
    }`, async () => {
      const r = await afterSettle(await c.step());
      if (c.what === "unchanged") {
        expect(r.usefulEdit).toBe(false);
        expect(r.excused).toBe(true);
        expect(r.origins).toEqual([]);
      } else {
        expect(r.usefulEdit).toBe(true);
        expect(r.excused).toBe(false);
        expect(r.origins).toEqual(REARMED);
      }
    });
  }
});
