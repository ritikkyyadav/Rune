/**
 * The plan is a ledger — the loop side.
 *
 * task-state.test.ts proves the store's rules in isolation. These tests prove
 * the LOOP applies them at the tool chokepoint: a completion with nothing
 * behind it comes back to the model as a refused todo_write; a step that
 * wrote files no check covered gets the project's compile check run at the
 * step; finishing with steps open is refused once and then handed off; and a
 * run whose results stop changing is nudged, then stopped.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { VerifyResult } from "../../../packages/orchestrator/src/verifier";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

/** Scripted gateway that also captures every request's messages. */
function makeGateway(turns: Step[]) {
  let i = 0;
  const requests: Array<{ messages: any[] }> = [];
  return {
    requests,
    inferStream: mock(async function* (req: any) {
      requests.push({ messages: req.messages });
      const t = turns[Math.min(i, turns.length - 1)];
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

/** Registry where write tools are writes, bash fails on `bun test`, grep never matches. */
function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file", "edit_file", "multi_edit"].includes(name)
          ? "write"
          : name === "bash"
            ? "execute"
            : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      if (input.toolName === "bash" && /bun test/.test(String(input.args.command))) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          error: "2 tests failed\nerror: expect(received).toBe(expected)",
          durationMs: 1,
        };
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result:
          input.toolName === "todo_write"
            ? JSON.stringify({ items: input.args.items })
            : input.toolName === "grep"
              ? "no matches"
              : "ok",
        durationMs: 1,
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
      maxTurns: opts.maxTurns ?? 20,
      systemPrompt: "s",
      taskState,
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

/** The tool_result text the model saw for a given tool call id. */
function toolResultFor(loop: AgentLoop, callId: string): { text: string; isError: boolean } | null {
  for (const m of loop.getMessages()) {
    if (m.role !== "tool") continue;
    for (const b of m.content as any[]) {
      if (b.type === "tool_result" && b.toolCallId === callId) {
        return { text: String(b.toolResultContent), isError: b.isError === true };
      }
    }
  }
  return null;
}

const todo = (items: Array<{ content: string; status: string }>): Step => ({
  tool: "todo_write",
  args: { items },
});

describe("step completion needs evidence", () => {
  test("a completion with nothing behind it is accepted as unproven, in one line of fact", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([{ content: "run the test suite", status: "in_progress" }]),
      todo([{ content: "run the test suite", status: "completed" }]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("run the tests", "s1", "/tmp"));

    const closed = toolResultFor(loop, "c2")!;
    expect(closed.isError).toBe(false);
    expect(closed.text).toContain("Step 1 closed unproven: nothing ran while it was open.");
    // A fact the model reads once — never an instruction it can narrate back.
    expect(closed.text).not.toMatch(/re-?submit|re-?run|Plan NOT updated/i);

    const updates = events.filter((e) => e.type === "todo_updated") as any[];
    // One for the plan, one for the close: the ledger never argues.
    expect(updates).toHaveLength(2);
    expect(updates[1].items[0].unproven).toBe("no_evidence");
  });

  test("refuse mode sends the list back once, in one line; the retry is accepted as unproven", async () => {
    const ts = new TaskStateStore();
    ts.setEvidenceGate("refuse");
    const gw = makeGateway([
      todo([{ content: "run the test suite", status: "in_progress" }]),
      todo([{ content: "run the test suite", status: "completed" }]),
      todo([{ content: "run the test suite", status: "completed" }]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("run the tests", "s1", "/tmp"));

    const refused = toolResultFor(loop, "c2")!;
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(
      'Error: Plan not updated: step 1 "run the test suite" is not closed: nothing ran while it was open.',
    );
    const accepted = toolResultFor(loop, "c3")!;
    expect(accepted.isError).toBe(false);

    const updates = events.filter((e) => e.type === "todo_updated") as any[];
    // One for the plan, one for the accepted retry — never one for the refusal.
    expect(updates).toHaveLength(2);
    expect(updates[1].items[0].unproven).toBe("no_evidence");
  });

  test("a write while the step was open makes the completion clean, with a receipt", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([{ content: "write the handler", status: "in_progress" }]),
      { tool: "write_file", args: { path: "src/h.ts", content: "x" } },
      { tool: "bash", args: { command: "node src/h.js" } },
      todo([{ content: "write the handler", status: "completed" }]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("add the handler", "s1", "/tmp"));
    const updates = events.filter((e) => e.type === "todo_updated") as any[];
    const item = updates[updates.length - 1].items[0];
    expect(item.status).toBe("completed");
    expect(item.unproven).toBeUndefined();
    expect(item.evidence.writes).toBe(1);
    expect(item.evidence.runs).toBe(1);
  });

  test("a failing test run recorded during the step closes it as unproven", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([{ content: "make the suite green", status: "in_progress" }]),
      { tool: "bash", args: { command: "bun test" } }, // fails in the registry
      todo([{ content: "make the suite green", status: "completed" }]),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("fix the tests", "s1", "/tmp"));
    const closed = toolResultFor(loop, "c3")!;
    expect(closed.isError).toBe(false);
    expect(closed.text).toContain("closed unproven: its last check failed");
    expect(closed.text).toContain("bun test");
    expect(ts.snapshot().todos[0].status).toBe("completed");
    expect(ts.snapshot().todos[0].unproven).toBe("check_failed");
  });
});

describe("the step check", () => {
  test("a step that wrote files nobody checked gets the compile check; a failure closes it unproven, a fix clears it", async () => {
    const ts = new TaskStateStore();
    const results: VerifyResult[] = [
      {
        ran: true,
        passed: false,
        report: "$ bunx tsc --noEmit  (exit 2)\nsrc/h.ts(1,1): error TS2322",
      },
      { ran: true, passed: true, report: "$ bunx tsc --noEmit  (ok)" },
    ];
    const stepCheck = mock(async () => results.shift() ?? results[0]);
    const gw = makeGateway([
      todo([{ content: "write the handler", status: "in_progress" }]),
      { tool: "write_file", args: { path: "src/h.ts", content: "x" } },
      todo([{ content: "write the handler", status: "completed" }]), // check fails → unproven
      { tool: "edit_file", args: { path: "src/h.ts", old: "x", new: "y" } }, // the fix
      todo([{ content: "write the handler", status: "completed" }]), // check passes → cleared
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, { stepCheck });
    const events = await collect(loop.run("add the handler", "s1", "/tmp"));

    expect(stepCheck).toHaveBeenCalledTimes(2);
    const checks = events.filter((e) => e.type === "step_check") as any[];
    expect(checks.map((c) => c.passed)).toEqual([false, true]);
    expect(checks[0].step).toBe("write the handler");

    const unproven = toolResultFor(loop, "c3")!;
    expect(unproven.isError).toBe(false);
    expect(unproven.text).toContain("closed unproven");
    expect(unproven.text).toContain("tsc");
    const accepted = toolResultFor(loop, "c5")!;
    expect(accepted.isError).toBe(false);
    expect(accepted.text).not.toContain("unproven");
    const item = ts.snapshot().todos[0];
    expect(item.status).toBe("completed");
    expect(item.unproven).toBeUndefined();
    expect(item.evidence?.lastCheck?.passed).toBe(true);
  });

  test("no check runs when the model already ran one during the step", async () => {
    const ts = new TaskStateStore();
    const stepCheck = mock(async () => ({ ran: true, passed: true, report: "$ tsc  (ok)" }));
    const gw = makeGateway([
      todo([{ content: "write the handler", status: "in_progress" }]),
      { tool: "write_file", args: { path: "src/h.ts", content: "x" } },
      { tool: "bash", args: { command: "bunx tsc --noEmit" } }, // the model's own check
      todo([{ content: "write the handler", status: "completed" }]),
      { text: "done" },
    ]);
    await collect(makeLoop(gw, ts, { stepCheck }).run("add the handler", "s1", "/tmp"));
    expect(stepCheck).not.toHaveBeenCalled();
    expect(ts.snapshot().todos[0].evidence?.checksPassed).toBe(1);
  });
});

describe("the open-steps gate", () => {
  test("finishing with steps open is refused once; the second finish hands off instead of forgetting", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([
        { content: "read the config", status: "in_progress" },
        { content: "port the loader", status: "pending" },
      ]),
      { tool: "read_file", args: { path: "config.ts" } },
      { text: "I looked at the config; the loader can wait." },
      { text: "Stopping here." },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("port the config loader", "s1", "/tmp"));

    const notices = events.filter((e) => e.type === "notice").map((e: any) => e.message);
    expect(notices.some((m) => /2 planned steps still open/.test(m))).toBe(true);
    // The refusal is a user-role message the model reads on its next request.
    const refusal = gw.requests[3].messages.at(-2)?.content?.[0]?.text ?? "";
    expect(refusal).toContain("2 of 2 planned steps still open");

    const handoff = events.find((e) => e.type === "handoff") as any;
    expect(handoff?.reason).toBe("open_steps");
    expect(ts.snapshot().handoff?.reason).toBe("open_steps");
    const done = events.find((e) => e.type === "turn_complete") as any;
    expect(done.stopReason).toBe("end_turn");
    expect(ts.renderMissionFile()).toContain("gate: ended with 2 of 2 steps open");
  });

  test("a plan rewritten to cut the open steps finishes clean", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      todo([
        { content: "read the config", status: "in_progress" },
        { content: "port the loader", status: "pending" },
      ]),
      { tool: "read_file", args: { path: "config.ts" } },
      { text: "Done with what matters." },
      todo([{ content: "read the config", status: "completed" }]), // cuts the loader, with evidence
      { text: "Finished." },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("port the config loader", "s1", "/tmp"));
    expect(events.find((e) => e.type === "handoff")).toBeUndefined();
    expect(ts.snapshot().handoff).toBeUndefined();
    expect(toolResultFor(loop, "c4")!.text).toContain("dropped 1 unfinished step");
  });
});

describe("the progress breaker", () => {
  test("six turns of already-seen results earn one nudge; twelve stop the run with a handoff", async () => {
    const ts = new TaskStateStore();
    // Different arguments every turn, identical result every turn: invisible
    // to the request-side detector, exactly what this breaker is for.
    const turns: Step[] = Array.from({ length: 14 }, (_, i) => ({
      tool: "grep",
      args: { pattern: `needle-${i}` },
    }));
    const gw = makeGateway(turns);
    const loop = makeLoop(gw, ts, { maxTurns: 40 });
    ts.setTodos([{ content: "find the needle", status: "in_progress" }]);
    const events = await collect(loop.run("find where the needle is defined", "s1", "/tmp"));

    const notices = events.filter((e) => e.type === "notice").map((e: any) => e.message);
    expect(notices.filter((m) => /nothing new/.test(m))).toHaveLength(1);
    const error = events.find((e) => e.type === "error") as any;
    expect(error?.error).toContain("produced nothing new");
    const handoff = events.find((e) => e.type === "handoff") as any;
    expect(handoff?.reason).toBe("stalled");
    // 1 novel turn + 12 stale turns, then the stop: no fourteenth request.
    expect(gw.requests).toHaveLength(13);
  });

  test("a write resets the stale count", async () => {
    const ts = new TaskStateStore();
    const turns: Step[] = [];
    for (let i = 0; i < 5; i++) turns.push({ tool: "grep", args: { pattern: `n${i}` } });
    turns.push({ tool: "write_file", args: { path: "a.ts", content: "x" } });
    for (let i = 5; i < 10; i++) turns.push({ tool: "grep", args: { pattern: `n${i}` } });
    turns.push({ tool: "bash", args: { command: "node a.js" } });
    turns.push({ text: "done" });
    const gw = makeGateway(turns);
    const events = await collect(makeLoop(gw, ts, { maxTurns: 40 }).run("g", "s1", "/tmp"));
    const notices = events.filter((e) => e.type === "notice").map((e: any) => e.message);
    expect(notices.some((m) => /nothing new/.test(m))).toBe(false);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });
});

describe("the boundary follows the plan, in the loop", () => {
  test("a follow-up after a finished task rolls the goal only when a fresh plan is written", async () => {
    const ts = new TaskStateStore();
    const first = makeGateway([
      todo([{ content: "write the parser", status: "in_progress" }]),
      { tool: "write_file", args: { path: "p.ts", content: "x" } },
      { tool: "bash", args: { command: "node p.js" } },
      todo([{ content: "write the parser", status: "completed" }]),
      { text: "parser done" },
    ]);
    await collect(makeLoop(first, ts).run("build me a parser", "s1", "/tmp"));
    expect(ts.snapshot().goal).toBe("build me a parser");

    // A casual follow-up: answered in prose, no plan → the goal stands.
    const second = makeGateway([{ text: "Here is how it works." }]);
    await collect(
      makeLoop(second, ts).run("well i cant see how it works could you show me", "s1", "/tmp"),
    );
    expect(ts.snapshot().goal).toBe("build me a parser");
    expect(ts.snapshot().todos).toHaveLength(1);

    // A real new mission: the first fresh plan rolls the goal and keeps lineage.
    const third = makeGateway([
      todo([{ content: "write the lexer", status: "in_progress" }]),
      { tool: "write_file", args: { path: "l.ts", content: "x" } },
      { tool: "bash", args: { command: "node l.js" } },
      todo([{ content: "write the lexer", status: "completed" }]),
      { text: "lexer done" },
    ]);
    await collect(makeLoop(third, ts).run("now build me a lexer for it", "s1", "/tmp"));
    expect(ts.snapshot().goal).toBe("now build me a lexer for it");
    expect(ts.snapshot().priorGoals).toEqual(["build me a parser"]);
  });
});
