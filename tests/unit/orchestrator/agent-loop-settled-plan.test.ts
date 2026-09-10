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
      result: input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, taskState?: TaskStateStore) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      effortRouting: "off",
      ...(taskState ? { taskState } : {}),
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

  test("a plan with every step completed and evidenced stands the gate down", async () => {
    const ts = new TaskStateStore();
    ts.beginTurn("fix the parser");
    // Steps closed without the enforcement judge: no unproven mark, no open step.
    ts.setTodos(
      [
        { content: "repair parseCsv", status: "completed" },
        { content: "run the parser tests", status: "completed" },
      ],
      { enforce: false },
    );
    expect(ts.todoCounts()).toEqual({ done: 2, total: 2, unproven: 0, open: 0 });
    const gw = makeGateway(WRITE_THEN_FINISH);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("fix the parser", "s1", "/tmp"));
    expect(stopMessages(loop)).toHaveLength(0);
    expect(gw.calls()).toBe(2);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
    expect(
      (ts.snapshot().log ?? []).some((e) => e.kind === "gate" && /stood down/.test(e.text)),
    ).toBe(true);
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
});
