/**
 * Second wind: the turn ceiling extends itself when the plan is open AND
 * moving — a step completed with evidence since the window began — and
 * nothing struggled in the window. evolab7 hit 80 turns with four of five
 * steps done and handed off; a person had to type "continue". The ceiling is
 * a guard against runaway loops, not a measure of the task; a plan that is
 * not moving, a struggle in the window, or winds = 0 keep the hard ceiling.
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

/** N tool turns of two calls each (no serial-crawl nudge), then one text reply. */
function makeGateway(toolTurns: number) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      i++;
      if (i <= toolTurns) {
        yield ev("tool_use_start", { toolCallId: `a${i}`, toolName: "advance" });
        yield ev("tool_use_stop", { toolCallId: `a${i}`, toolInput: { step: i } });
        yield ev("tool_use_start", { toolCallId: `b${i}`, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: `b${i}`, toolInput: { path: `f${i}.ts` } });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "All steps done." } });
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

const STEPS = ["one", "two", "three", "four", "five"];

/** `advance` completes the next planned step when the plan is moving. */
function makeRegistry(ts: TaskStateStore, moving: boolean) {
  let done = 0;
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      if (input.toolName === "advance" && moving) {
        done = Math.min(done + 1, STEPS.length);
        ts.setTodos(
          STEPS.map((content, i) => ({
            content,
            status: i < done ? "completed" : i === done ? "in_progress" : "pending",
          })),
          { enforce: false },
        );
      }
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    }),
  } as any;
}

function plannedState(): TaskStateStore {
  const ts = new TaskStateStore();
  ts.beginTurn("build the whole laboratory");
  ts.setTodos(
    STEPS.map((content, i) => ({ content, status: i === 0 ? "in_progress" : "pending" })),
    { enforce: false },
  );
  return ts;
}

function makeLoop(gateway: any, ts: TaskStateStore, registry: any, opts: Record<string, unknown>) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 4,
      systemPrompt: "s",
      taskState: ts,
      ...opts,
    } as any,
    gateway,
    registry,
  );
}

describe("second wind at the turn ceiling", () => {
  test("a moving plan earns the ceiling again and the run finishes clean", async () => {
    const ts = plannedState();
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(5), ts, makeRegistry(ts, true), {
      maxSecondWinds: 2,
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("build the whole laboratory", "s1", "/tmp"));
    expect(incidents).toContain("loop.second_wind");
    expect(incidents).not.toContain("loop.max_turns");
    expect(events.find((e) => e.type === "handoff")).toBeUndefined();
    expect(
      events.some((e) => e.type === "notice" && /extended the budget/.test((e as any).message)),
    ).toBe(true);
    const last = events.at(-1) as any;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).not.toBe("max_turns");
    expect(last.totalTurns).toBe(6);
    expect(ts.hasOpenTodos()).toBe(false);
    // The model was told, at the boundary, that the extension is for finishing.
    const transcript = JSON.stringify(loop.getMessages());
    expect(transcript).toContain("wind 1 of 2");
  });

  test("winds = 0 keeps the hard ceiling", async () => {
    const ts = plannedState();
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(5), ts, makeRegistry(ts, true), {
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("build the whole laboratory", "s1", "/tmp"));
    expect(incidents).toContain("loop.max_turns");
    expect(incidents).not.toContain("loop.second_wind");
    expect((events.find((e) => e.type === "handoff") as any)?.reason).toBe("max_turns");
  });

  test("a plan that is not moving gets no wind", async () => {
    const ts = plannedState();
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(5), ts, makeRegistry(ts, false), {
      maxSecondWinds: 2,
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("build the whole laboratory", "s1", "/tmp"));
    expect(incidents).not.toContain("loop.second_wind");
    expect((events.find((e) => e.type === "handoff") as any)?.reason).toBe("max_turns");
  });

  test("a struggle in the window blocks the wind", async () => {
    const ts = plannedState();
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(5), ts, makeRegistry(ts, true), {
      maxSecondWinds: 2,
      onIncident: (i: any) => incidents.push(i.class),
    });
    loop.injectHarnessNote("you have rewritten this file five times", {
      replanReason: "edit churn",
    });
    const events = await collect(loop.run("build the whole laboratory", "s1", "/tmp"));
    expect(events.some((e) => e.type === "replanning")).toBe(true);
    expect(incidents).not.toContain("loop.second_wind");
    expect((events.find((e) => e.type === "handoff") as any)?.reason).toBe("max_turns");
  });
});
