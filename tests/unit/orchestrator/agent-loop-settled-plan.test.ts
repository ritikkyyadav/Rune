/**
 * Finish gates, revisited: a settled plan stands the evidence gates down, and every gate
 * that re-prompts the model leaves a named origin behind.
 *
 * Dogfood 2026-09-09: a run committed the brief's last step, wrote its
 * closing message, and was then re-prompted for eleven more completions with
 * no event in the session log saying why. Two things fix that: a plan whose
 * every step is completed with evidence satisfies the execution-evidence and
 * fix-verified gates, and any gate that does fire tags the message it
 * appends so the engine can persist it.
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

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file", "edit_file", "multi_edit"].includes(name) ? "write" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      // The shell reports that it LAUNCHED; the child exit code lives in its
      // result JSON, and that is what decides a check. A command naming
      // "failing" comes back red, so a failed check can be scripted here.
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : input.toolName === "bash"
            ? JSON.stringify({
                exit_code: String(input.args.command ?? "").includes("failing") ? 1 : 0,
                stdout: "",
                stderr: String(input.args.command ?? "").includes("failing") ? "1 fail" : "",
              })
            : // The write tools compute a unified diff from both texts and put
              // it in their result. `emptyDiff` scripts the one that reproduced
              // what was already on disk.
              input.args?.emptyDiff
              ? JSON.stringify({ path: input.args.path, diff: "" })
              : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, taskState?: TaskStateStore, opts: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      effortRouting: "off",
      ...(taskState ? { taskState } : {}),
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

/** A write and then a closing message, with nothing ever executed. */
const WRITE_THEN_FINISH: Step[] = [
  { tool: "write_file", args: { path: "src/parser.ts", content: "export {}" } },
  { text: "Done — the parser is fixed." },
];

/** Did the run's own log say the plan stood the evidence gates down? */
const stoodDown = (ts: TaskStateStore) =>
  (ts.snapshot().log ?? []).some((e: any) => e.kind === "gate" && /stood down/.test(e.text));

const stopMessages = (loop: AgentLoop) =>
  loop
    .getMessages()
    .filter(
      (m) =>
        m.role === "user" &&
        m.content.some((b: any) => b.type === "text" && b.text.startsWith("Stop —")),
    );

describe("finish gates", () => {
  test("with no plan, the execution-evidence gate refuses the finish once and tags its message", async () => {
    const gw = makeGateway(WRITE_THEN_FINISH);
    const loop = makeLoop(gw);
    const events = await collect(loop.run("fix the parser", "s1", "/tmp"));
    const stops = stopMessages(loop);
    expect(stops).toHaveLength(1);
    expect(loop.originOf(stops[0]!)).toBe("gate:execution-evidence");
    expect(
      events.some((e) => e.type === "notice" && e.message.startsWith("Execution-evidence gate:")),
    ).toBe(true);
    // write, refused finish, second finish → three completions
    expect(gw.calls()).toBe(3);
  });

  test("a completed plan cannot waive verification of a later edit", async () => {
    const ts = new TaskStateStore();
    ts.beginTurn("fix the parser");
    ts.setTodos([{ content: "repair parseCsv", kind: "change", status: "in_progress" }]);
    ts.noteEffect("write");
    ts.noteEffect("check_pass", { command: "bun test" });
    ts.setTodos([{ content: "repair parseCsv", kind: "change", status: "completed" }]);
    expect(ts.todoCounts()).toEqual({ done: 1, total: 1, unproven: 0, open: 0 });
    const gw = makeGateway(WRITE_THEN_FINISH);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(stopMessages(loop)).toHaveLength(1);
    expect(gw.calls()).toBe(3);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
    expect(loop.originOf(stopMessages(loop)[0]!)).toBe("gate:execution-evidence");
  });

  test("a plan with an unproven step does not stand the gate down", async () => {
    const ts = new TaskStateStore();
    ts.beginTurn("fix the parser");
    ts.setTodos([{ content: "repair parseCsv", status: "in_progress" }]);
    // Closing the step with nothing behind it leaves it completed but unproven.
    ts.setTodos([{ content: "repair parseCsv", status: "completed" }]);
    expect(ts.todoCounts().unproven).toBe(1);
    const gw = makeGateway(WRITE_THEN_FINISH);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(stopMessages(loop).length).toBeGreaterThanOrEqual(1);
  });

  test.each([false, true])(
    "a newly settled plan covers only the writes before closure: later write %s",
    async (laterWrite) => {
      const ts = new TaskStateStore();
      const item = { content: "repair parseCsv", kind: "change" };
      const steps: Step[] = [
        { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
        WRITE_THEN_FINISH[0]!,
        { tool: "bash", args: { command: "node browser-test.mjs" } },
        { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
        ...(laterWrite
          ? [
              WRITE_THEN_FINISH[0]!,
              // Repeating the old completed list does not re-check the new edit.
              { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
            ]
          : []),
        { text: "The parser was checked." },
      ];
      const gw = makeGateway(steps);
      const loop = makeLoop(gw, ts);
      await collect(loop.run("fix the parser", "s1", "/tmp"));
      expect(ts.todoCounts().unproven).toBe(0); // the closed row itself is historical
      expect(stopMessages(loop)).toHaveLength(laterWrite ? 1 : 0);
      expect(gw.calls()).toBe(steps.length + (laterWrite ? 1 : 0));
    },
  );

  test("a genuinely settled plan avoids an extra fix-verified prompt", async () => {
    const ts = new TaskStateStore();
    const item = { content: "repair parseCsv", kind: "change" };
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
      WRITE_THEN_FINISH[0]!,
      { tool: "bash", args: { command: "node browser-test.mjs" } },
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      { text: "The parser was checked." },
    ]);
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(ts.todoCounts()).toEqual({ done: 1, total: 1, unproven: 0, open: 0 });
    expect(stopMessages(loop)).toHaveLength(0);
    expect(gw.calls()).toBe(5);
  });

  test("the open-steps gate tags its message too", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ content: "step one", status: "in_progress" }] } },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("do a multi step thing", "s1", "/tmp"));
    const stops = stopMessages(loop);
    expect(stops.map((m) => loop.originOf(m))).toContain("gate:open-steps");
  });

  test("a resumed completed plan is not renewed by re-emitting it", async () => {
    // The plan was settled in an EARLIER turn. Re-sending the same completed
    // list transitions nothing, so it closes no step and grants no waiver —
    // and the edit that follows is still unverified work.
    const ts = new TaskStateStore();
    ts.beginTurn("fix the parser");
    const item = { content: "repair parseCsv", kind: "change" as const };
    ts.setTodos([{ ...item, status: "in_progress" }]);
    ts.noteEffect("write");
    ts.noteEffect("check_pass", { command: "bun test" });
    ts.setTodos([{ ...item, status: "completed" }]);
    expect(ts.todoCounts()).toEqual({ done: 1, total: 1, unproven: 0, open: 0 });
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      WRITE_THEN_FINISH[0]!,
      { text: "Done — the parser is fixed." },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(stoodDown(ts)).toBe(false);
    expect(stopMessages(loop).map((m) => loop.originOf(m))).toEqual(["gate:execution-evidence"]);
  });

  test("a check that FAILS after the plan settled re-arms the gates", async () => {
    // Closure is a snapshot of what was true then. A red check afterwards is
    // new evidence about the same code, and a stale waiver would let the run
    // finish a fix-shaped task with nothing verified and a failing check on
    // the record.
    const item = { content: "repair parseCsv", kind: "change" as const };
    const ts = new TaskStateStore();
    const steps: Step[] = [
      { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
      WRITE_THEN_FINISH[0]!,
      { tool: "bash", args: { command: "node browser-test.mjs" } },
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      { tool: "bash", args: { command: "node failing-test.mjs" } },
      { text: "The parser was checked." },
    ];
    const gw = makeGateway(steps);
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(ts.checks.map((c) => c.passed)).toEqual([true, false]);
    expect(stoodDown(ts)).toBe(false);
    expect(stopMessages(loop).map((m) => loop.originOf(m))).toEqual(["gate:fix-verified"]);
  });

  // ── Phase 3B, A3: the waiver is measured against what the write DID ──
  //
  // `settledPlanAtWriteCount === writeCount` counted every call of a write tool
  // alike, so a call that hit no file — a patch whose targets were already
  // applied, a `multi_edit` with nothing to do — re-armed all five gates after
  // a green check and cost the run a refused finish for an edit that never
  // happened. What excuses a write is evidence, never a guess: Lane 0's
  // `usefulEdit`, the unified write predicate's own verdict, says the call
  // changed no file. A call that DID change one re-arms the gates as before,
  // whatever check passed earlier — a check that ran before the edit has not
  // measured the edit.
  describe("A3 — a write that changed nothing", () => {
    const item = { content: "repair parseCsv", kind: "change" as const };
    /** Open the step, write, run `check`, close it — then `after`, then finish. */
    const settledThen = (check: string, after: Step[]): Step[] => [
      { tool: "todo_write", args: { items: [{ ...item, status: "in_progress" }] } },
      WRITE_THEN_FINISH[0]!,
      { tool: "bash", args: { command: check } },
      { tool: "todo_write", args: { items: [{ ...item, status: "completed" }] } },
      ...after,
      { text: "The parser was checked." },
    ];

    test("a green check, a write that hit no file, a finish — zero gate re-prompts", async () => {
      // RED at 730fd97: `multi_edit` with no path and a result naming none
      // changed nothing, and the run was refused its finish anyway. This is
      // the design's A3 case, stated as the acceptance check asks for it.
      const ts = new TaskStateStore();
      const steps = settledThen("bun test", [{ tool: "multi_edit", args: { edits: [] } }]);
      const gw = makeGateway(steps);
      const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
      await collect(loop.run("fix the parser", "s1", "/tmp"));
      expect(stopMessages(loop)).toHaveLength(0);
      expect(stoodDown(ts)).toBe(true);
      // No re-prompt means no extra completion: exactly the script, no more.
      expect(gw.calls()).toBe(steps.length);
    });

    test("an edit whose own diff is empty is excused too", async () => {
      // The reachable shape: `multi_edit` names its path (so the write
      // predicate sees a file) but computes the unified diff from both texts
      // and emits an EMPTY one — an edit that reproduced what was already
      // there. The tool's own result is the evidence; nothing is inferred.
      const ts = new TaskStateStore();
      const steps = settledThen("bun test", [
        { tool: "multi_edit", args: { path: "src/parser.ts", edits: [], emptyDiff: true } },
      ]);
      const gw = makeGateway(steps);
      const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
      await collect(loop.run("fix the parser", "s1", "/tmp"));
      expect(stopMessages(loop)).toHaveLength(0);
      expect(gw.calls()).toBe(steps.length);
    });

    test("a write that DID change a file re-arms the gates, as before", async () => {
      // The control. `bun test` passed over the whole project a moment ago and
      // that changes nothing here: it ran before this edit, so it has not
      // measured it. Two refused finishes, two extra completions.
      const ts = new TaskStateStore();
      const steps = settledThen("bun test", [WRITE_THEN_FINISH[0]!]);
      const gw = makeGateway(steps);
      const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
      await collect(loop.run("fix the parser", "s1", "/tmp"));
      expect(stopMessages(loop).map((m) => loop.originOf(m))).toEqual([
        "gate:execution-evidence",
        "gate:fix-verified",
      ]);
      expect(stoodDown(ts)).toBe(false);
      expect(gw.calls()).toBe(steps.length + 2);
    });

    test("a check going red after the excused write withdraws the waiver anyway", async () => {
      // The excuse is about the WRITE, never about the check. A red check after
      // it is new evidence and takes the waiver down, exactly as it always did.
      const ts = new TaskStateStore();
      const steps = settledThen("bun test", [
        { tool: "multi_edit", args: { edits: [] } },
        { tool: "bash", args: { command: "node failing-test.mjs" } },
      ]);
      const gw = makeGateway(steps);
      const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
      await collect(loop.run("fix the parser", "s1", "/tmp"));
      expect(stoodDown(ts)).toBe(false);
      expect(stopMessages(loop).map((m) => loop.originOf(m))).toEqual(["gate:fix-verified"]);
    });
  });

  test("one open step is enough to keep the gates armed", async () => {
    const ts = new TaskStateStore();
    const one = { content: "repair parseCsv", kind: "change" as const };
    const two = { content: "run the parser tests", kind: "verify" as const };
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: {
          items: [
            { ...one, status: "in_progress" },
            { ...two, status: "pending" },
          ],
        },
      },
      WRITE_THEN_FINISH[0]!,
      { tool: "bash", args: { command: "node browser-test.mjs" } },
      {
        tool: "todo_write",
        args: {
          items: [
            { ...one, status: "completed" },
            { ...two, status: "in_progress" },
          ],
        },
      },
      { text: "The parser was checked." },
    ]);
    const loop = makeLoop(gw, ts, { ledgerStatus: () => ({ total: 1, verified: 0 }) });
    await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(ts.todoCounts()).toMatchObject({ open: 1, unproven: 0 });
    expect(stoodDown(ts)).toBe(false);
    expect(stopMessages(loop).map((m) => loop.originOf(m))).toContain("gate:open-steps");
  });
});
