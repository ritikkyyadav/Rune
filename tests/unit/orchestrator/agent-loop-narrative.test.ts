/**
 * The refutation inference (P11.1): the harness settles a hypothesis from the
 * verdict of the step that was testing it.
 *
 * The model may report a verdict, and the record keeps its reason either way.
 * But a hypothesis whose status came only from the model's confidence is worth
 * what "verified" was worth before the parent-commit rule — an assertion that
 * argues back. So the loop reads the plan boundary instead:
 *
 *   the closing step's check FAILED   -> refuted, with the check's own summary
 *   the step closed on evidence       -> confirmed, with the step as evidence
 *
 * Scoped to the plan boundary on purpose. A failing test in the middle of a
 * build is a fix in progress, not a refuted theory.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string; fail?: boolean };

function makeGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
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

/**
 * `bash` fails for any command containing FAIL, so a check can genuinely fail,
 * and `note_hypothesis` writes through to the spine exactly as the real tool
 * does — the hypothesis is raised DURING the run, which is the ordering the
 * inference depends on.
 */
function makeRegistry(ts: TaskStateStore) {
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
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      if (input.toolName === "note_hypothesis") {
        const h = ts.noteHypothesis(String(input.args?.text ?? ""));
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: `Recorded as ${h.id}`,
          durationMs: 1,
        };
      }
      const command = String(input.args?.command ?? "");
      const failing = command.includes("FAIL");
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: !failing,
        result:
          input.toolName === "todo_write"
            ? JSON.stringify({ items: input.args.items })
            : failing
              ? ""
              : "ok",
        ...(failing ? { error: "1 failing\npool at 20% — not exhausted" } : {}),
        durationMs: 1,
      };
    }),
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
      taskState,
    } as any,
    gateway,
    makeRegistry(taskState),
  );
}

describe("a step whose check failed refutes the hypothesis it was testing", () => {
  test("with the check's own summary as the reason", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "test the pool", status: "in_progress" }] },
      },
      // The probe fails: the pool is fine, so the theory is wrong.
      { tool: "bash", args: { command: "bun test pool.test.ts FAIL" } },
      { tool: "todo_write", args: { items: [{ content: "test the pool", status: "completed" }] } },
      { text: "the pool is not the problem" },
    ]);
    ts.beginTurn("why is the api slow?");
    const h = ts.noteHypothesis("connection pool exhaustion");
    expect(h.status).toBe("testing");

    const events = await collect(makeLoop(gw, ts).run("why is the api slow?", "s1", "/tmp"));

    const updates = events.filter((e) => e.type === "hypothesis_updated");
    expect(updates).toHaveLength(1);
    const update = updates[0] as Extract<AgentTurnEvent, { type: "hypothesis_updated" }>;
    expect(update.id).toBe("h1");
    expect(update.status).toBe("refuted");
    expect(update.source).toBe("harness");
    expect(update.reason).toContain("pool at 20%");
    // …and the model was never asked to agree.
    expect(ts.hypotheses[0].status).toBe("refuted");
    expect(ts.hypotheses[0].reason).toContain("pool at 20%");
  });
});

describe("a step that closes AFTER a failing check still refutes", () => {
  test("ruling a theory out is writing the finding up and moving on", async () => {
    // The other half of the same rule. The ledger accepts this completion —
    // the run did something after the failure, so it is not an empty claim —
    // and the check that failed is still the verdict on the theory.
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "rule out the cache", status: "in_progress" }] },
      },
      { tool: "note_hypothesis", args: { text: "cache eviction on deploy" } },
      { tool: "bash", args: { command: "bun test cache.test.ts FAIL" } },
      { tool: "write_file", args: { path: "findings/cache.md" } },
      {
        tool: "todo_write",
        args: { items: [{ content: "rule out the cache", status: "completed" }] },
      },
      { text: "not the cache" },
    ]);

    const events = await collect(makeLoop(gw, ts).run("why is the api slow?", "s1", "/tmp"));

    const update = events.find((e) => e.type === "hypothesis_updated") as
      Extract<AgentTurnEvent, { type: "hypothesis_updated" }> | undefined;
    expect(update?.status).toBe("refuted");
    expect(update?.source).toBe("harness");
    expect(update?.reason).toContain("pool at 20%");
    // The step itself closed clean: ruling a theory out is real work.
    expect(ts.snapshot().todos[0].unproven).toBeUndefined();
    expect(ts.progress()).toBe(1);
  });
});

describe("a step that closes on evidence confirms it", () => {
  test("with the step itself as the evidence", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "check the query", status: "in_progress" }] },
      },
      { tool: "bash", args: { command: "bun test orders.test.ts" } },
      {
        tool: "todo_write",
        args: { items: [{ content: "check the query", status: "completed" }] },
      },
      { text: "found it" },
    ]);
    ts.beginTurn("why is the api slow?");
    ts.noteHypothesis("query regression in orders.ts");

    const events = await collect(makeLoop(gw, ts).run("why is the api slow?", "s1", "/tmp"));

    const update = events.find((e) => e.type === "hypothesis_updated") as
      Extract<AgentTurnEvent, { type: "hypothesis_updated" }> | undefined;
    expect(update?.status).toBe("confirmed");
    expect(update?.source).toBe("harness");
    expect(ts.hypotheses[0].evidence.map((e) => e.kind)).toContain("step");
    expect(ts.hypotheses[0].evidence.map((e) => e.ref)).toContain("check the query");
  });
});

describe("what the inference does NOT do", () => {
  test("a failing command mid-step is a fix in progress, not a refutation", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "wire the parser", status: "in_progress" }] },
      },
      { tool: "note_hypothesis", args: { text: "the tokenizer drops newlines" } },
      { tool: "bash", args: { command: "bun test FAIL" } },
      // The model fixes it and the check passes; the step never closed red.
      { tool: "write_file", args: { path: "parser.ts" } },
      { tool: "bash", args: { command: "bun test parser.test.ts" } },
      { text: "fixed" },
    ]);

    const events = await collect(makeLoop(gw, ts).run("build the parser", "s1", "/tmp"));

    expect(events.filter((e) => e.type === "hypothesis_updated")).toHaveLength(0);
    expect(ts.hypotheses[0].status).toBe("testing");
  });

  test("with no hypothesis open, a failed step settles nothing", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ content: "test it", status: "in_progress" }] } },
      { tool: "bash", args: { command: "bun test FAIL" } },
      { tool: "todo_write", args: { items: [{ content: "test it", status: "completed" }] } },
      { text: "done" },
    ]);
    ts.beginTurn("build the thing");

    const events = await collect(makeLoop(gw, ts).run("build the thing", "s1", "/tmp"));
    expect(events.filter((e) => e.type === "hypothesis_updated")).toHaveLength(0);
  });

  test("an already-settled hypothesis is not re-settled by the next step", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ content: "step two", status: "in_progress" }] } },
      { tool: "bash", args: { command: "bun test FAIL" } },
      { tool: "todo_write", args: { items: [{ content: "step two", status: "completed" }] } },
      { text: "done" },
    ]);
    ts.beginTurn("why is it slow?");
    ts.noteHypothesis("cache eviction");
    ts.updateHypothesis("h1", "refuted", { reason: "TTL unchanged" });

    const events = await collect(makeLoop(gw, ts).run("why is it slow?", "s1", "/tmp"));
    expect(events.filter((e) => e.type === "hypothesis_updated")).toHaveLength(0);
    expect(ts.hypotheses[0].reason).toBe("TTL unchanged");
  });
});
