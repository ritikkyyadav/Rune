/**
 * The settled-plan waiver, and the spine's record of what a step TOUCHED.
 *
 * Written by an independent verifier. The registry here mirrors PRODUCTION
 * tool categories (`apply_patch` is `category: "write"`, see
 * packages/tool-registry/src/tools/apply-patch.ts:262), which the older
 * fixtures do not — theirs list only write_file/edit_file/multi_edit, and
 * that gap is exactly how two of the defects below survived: a step whose
 * writes came from a patch recorded no touched file at all, and a check that
 * executed zero tests counted as a whole-project verdict.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

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

/** Production categories: apply_patch and multi_edit are writes. */
const WRITE = new Set(["write_file", "edit_file", "multi_edit", "apply_patch"]);

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: WRITE.has(name) ? "write" : name === "worker" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      const failing = String(input.args?.command ?? "").includes("failing");
      const base = { callId: input.callId, toolName: input.toolName, durationMs: 1 };
      if (input.toolName === "worker") {
        return {
          ...base,
          success: true,
          result: "worker done",
          // A worker's writes land in a worktree the lead never sees a call for.
          structured: { integration: "merged", filesChanged: ["src/worker-made.ts"] },
        };
      }
      return {
        ...base,
        success: true,
        result:
          input.toolName === "todo_write"
            ? JSON.stringify({ items: input.args.items })
            : input.toolName === "bash"
              ? JSON.stringify({
                  exit_code: failing ? 1 : 0,
                  stdout: "",
                  stderr: failing ? "1 fail" : "",
                })
              : input.toolName === "apply_patch"
                ? // apply_patch reports its files in the RESULT; it has no
                  // `path` argument at all (APPLY_PATCH_SCHEMA takes `patch`).
                  JSON.stringify({ files: [{ path: "src/csv.ts", action: "updated" }] })
                : "ok",
      };
    }),
  } as any;
}

function makeLoop(gateway: any, taskState: TaskStateStore, opts: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      effortRouting: "off",
      taskState,
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

const stopMessages = (loop: AgentLoop) =>
  loop
    .getMessages()
    .filter(
      (m) =>
        m.role === "user" &&
        m.content.some((b: any) => b.type === "text" && b.text.startsWith("Stop —")),
    );

const stoodDown = (ts: TaskStateStore) =>
  (ts.snapshot().log ?? []).some((e: any) => e.kind === "gate" && /stood down/.test(e.text));

const ITEM = { content: "repair parseCsv", kind: "change" as const };

/** Settle a one-step plan with a real write and a real check, then do `after`. */
function settledThen(after: Step[]): Step[] {
  return [
    { tool: "todo_write", args: { items: [{ ...ITEM, status: "in_progress" }] } },
    { tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } },
    { tool: "bash", args: { command: "bun test" } },
    { tool: "todo_write", args: { items: [{ ...ITEM, status: "completed" }] } },
    ...after,
    { text: "The parser was checked." },
  ];
}

describe("a settled plan cannot waive evidence for a LATER write", () => {
  test.each([
    ["multi_edit", { tool: "multi_edit", args: { path: "src/csv.ts", edits: [] } } as Step],
    ["apply_patch", { tool: "apply_patch", args: { patch: "*** Begin Patch" } } as Step],
    ["worker", { tool: "worker", args: { files: ["src/worker-made.ts"], prompt: "p" } } as Step],
  ])("a %s after closure re-arms the finish gates", async (_name, write) => {
    const ts = new TaskStateStore();
    const gw = makeGateway(settledThen([write]));
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(ts.todoCounts()).toMatchObject({ open: 0, unproven: 0 });
    // The waiver must NOT stand: the write happened after the plan settled.
    expect(stoodDown(ts)).toBe(false);
    expect(stopMessages(loop).length).toBeGreaterThanOrEqual(1);
  });

  test("no later write: the waiver legitimately stands", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway(settledThen([]));
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(stopMessages(loop)).toHaveLength(0);
  });

  test("a plan whose only step is REPORT-shaped no longer waives the gate", async () => {
    // Was PINNED, NOT ENDORSED, and is now settled. `TaskStateStore.setTodos`
    // closes a step whose wording matches `REPORT_STEP_RE` with
    // `closedBy: "report"` and NO `unproven` mark when it carries zero tool
    // evidence — right for the step, because no tool can attest "told the
    // user". `todoCounts().unproven` therefore stayed 0, the plan settled, and
    // the settled-plan waiver stood the execution-evidence gate down for a run
    // that wrote a file and executed nothing at all.
    //
    // Phase 3B (Lane A, the finish path) settles it on the director's ruling:
    // a report-shaped closure cannot grant the waiver when a write happened
    // after the last step that closed on real evidence. That is the backlog
    // item `docs/program/backlog.md` recorded against
    // `packages/orchestrator/src/task-state.ts` — "a `closedBy: "report"` step
    // … can still latch the settled-plan waiver even though the run wrote
    // files" — and this test is where it is now closed.
    //
    // The line is narrow: the handoff step itself was never the problem. A
    // report step closing beside an evidenced one, or with nothing written
    // since, still settles the plan — `agent-loop-report-step.test.ts`
    // ("closing the handoff step is not refused") holds that case.
    const item = { content: "Report back to the user", kind: "verify" as const };
    const ts = new TaskStateStore();
    const gw = makeGateway([
      // The write lands BEFORE the plan, so the step itself carries no
      // evidence at all — which is exactly the shape the report clause was
      // written for, and exactly the shape that must not waive a gate.
      { tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } },
      { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      { text: "Done — the parser is fixed." },
    ]);
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    // The step still closes on the report, and still carries no unproven mark:
    // what changed is what the PLAN may borrow from that closure, not what the
    // step is worth.
    expect(ts.todos[0]!.closedBy).toBe("report");
    expect(ts.todoCounts()).toMatchObject({ open: 0, unproven: 0 });
    expect(ts.checks).toHaveLength(0); // nothing was ever executed
    expect(stoodDown(ts)).toBe(false);
    expect(stopMessages(loop).map((m) => loop.originOf(m))).toEqual([
      "gate:execution-evidence",
      "gate:fix-verified",
    ]);
    // The run says why, in its own log, rather than leaving a silent waiver.
    expect(
      (ts.snapshot().log ?? []).some(
        (e: any) => e.kind === "gate" && /report step with 1 write/.test(e.text),
      ),
    ).toBe(true);
  });

  test("a check whose failure is MASKED by the shell leaves the waiver standing", async () => {
    // `bun test; false` exits 1. The loop has that exit code in hand
    // (bashCheckVerdict reads it) but never looks, because
    // isVerificationCommand() reads only the LAST `;`-separated list — here
    // `false` — so the command is not classified as a check at all and the
    // `if (!verdict.passed) settledPlanAtWriteCount = null` withdrawal is
    // never reached. Documented as a demotion; this pins what it costs.
    const ts = new TaskStateStore();
    const gw = makeGateway(
      settledThen([{ tool: "bash", args: { command: "bun test failing-suite; false" } }]),
    );
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    // Nothing on the check ledger: the red run is invisible to the spine.
    expect(ts.checks).toHaveLength(1); // only the earlier `bun test`
    expect(ts.checks[0]!.passed).toBe(true);
    expect(stopMessages(loop)).toHaveLength(0);
  });
});

describe("what the spine records a step as having TOUCHED", () => {
  /** Open a step, write via `write`, run `command`, close the step. */
  async function run(write: Step, command: string): Promise<TaskStateStore> {
    const ts = new TaskStateStore();
    const item = { content: "prove parseCsv round-trips", kind: "verify" as const };
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
      write,
      { tool: "bash", args: { command } },
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      { text: "Done." },
    ]);
    await collect(makeLoop(gw, ts).run("fix parseCsv", "s1", "/tmp"));
    return ts;
  }

  test("write_file: an unrelated check is set aside, as A2 claims", async () => {
    const ts = await run(
      { tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } },
      "bun test tests/unit/other.test.ts",
    );
    // `touchedFiles` drains on each accepted plan, so read the cumulative list.
    expect(ts.writtenFiles).toEqual(["src/csv.ts"]);
    expect(ts.todos[0]!.evidence?.lastCheck).toBeUndefined();
    expect(ts.todos[0]!.unproven).toBe("no_evidence");
  });

  test("a check that runs NOTHING cannot close a step it never exercised", async () => {
    // `bun test --test-name-pattern <no match>` exits 0 having executed zero
    // tests. It used to answer TRUE to `isVerificationCommand` AND to
    // `projectLevelCheck`, so relatedness returned reason:"project" — related
    // to every step by construction — and the step closed with
    // `lastCheck.passed === true`. A test-name selector is no longer a
    // whole-project verdict, and a run whose output shows no test ran is an
    // execution receipt. Same for `cargo test -- --skip everything` and
    // `pytest -k <no match>`.
    const ts = await run(
      { tool: "write_file", args: { path: "src/csv.ts", content: "export {}" } },
      "bun test --test-name-pattern zzzznope",
    );
    expect(ts.todos[0]!.evidence?.lastCheck?.passed).toBeUndefined();
    expect(ts.todos[0]!.unproven).toBe("no_evidence");
  });

  test("apply_patch records what it touched, so an unrelated check cannot close the step", async () => {
    // The spine used to record writes as `p.isWrite && args.path`, and
    // `apply_patch` has no `path` argument at all (APPLY_PATCH_SCHEMA takes
    // `patch` and reports its files in the RESULT — the exact reason
    // lifecycle.ts's `filesChangedFrom` exists). Nothing was recorded,
    // `touchedFiles` was empty, relatedness returned reason:"unscoped", and
    // the whole rule stood down for any step whose writes came from a patch.
    const ts = await run(
      { tool: "apply_patch", args: { patch: "*** Begin Patch\n*** End Patch" } },
      "bun test tests/unit/other.test.ts",
    );
    expect({
      writtenFiles: ts.writtenFiles,
      lastCheck: ts.todos[0]!.evidence?.lastCheck?.passed,
      unproven: ts.todos[0]!.unproven,
    }).toEqual({ writtenFiles: ["src/csv.ts"], lastCheck: undefined, unproven: "no_evidence" });
  });
});
