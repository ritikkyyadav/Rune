/**
 * The provider stopped answering after the retry budget. evolab7: a stalled
 * Codex stream and four connection failures ended a run whose every check was
 * green on disk as a plain "error". Now a complete plan ends finished, a plan
 * with steps open hands off as `provider_lost`, and a run with no plan keeps
 * the plain error — the record says the network failed, not the model.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeDeadGateway() {
  return {
    inferStream: mock(async function* () {
      throw new Error("Unable to connect. Is the computer able to access the url?");
    }),
    infer: mock(async () => {
      throw new Error("Unable to connect.");
    }),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock(() => undefined),
    execute: mock(async () => ({ success: true, result: "ok", durationMs: 1 })),
  } as any;
}

function makeLoop(ts: TaskStateStore | undefined) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      maxConsecutiveErrors: 2,
      systemPrompt: "s",
      taskState: ts,
    } as any,
    makeDeadGateway(),
    makeRegistry(),
  );
}

describe("provider lost", () => {
  test("steps open → hands off as provider_lost, then the fatal error", async () => {
    const ts = new TaskStateStore();
    ts.beginTurn("build it");
    ts.setTodos(
      [
        { content: "done step", status: "completed" },
        { content: "open step", status: "in_progress" },
      ],
      { enforce: false },
    );
    const events = await collect(makeLoop(ts).run("build it", "s1", "/tmp"));
    const handoff = events.find((e) => e.type === "handoff") as any;
    expect(handoff?.reason).toBe("provider_lost");
    expect(handoff?.state).toContain("open step");
    expect(ts.snapshot().handoff?.reason).toBe("provider_lost");
    const fatal = events.find((e) => e.type === "error" && !(e as any).recoverable) as any;
    expect(fatal?.error).toMatch(/Too many consecutive errors \(2\)/);
  });

  test("every step done → the run ends finished, with a notice", async () => {
    const ts = new TaskStateStore();
    ts.beginTurn("build it");
    ts.setTodos([{ content: "the only step", status: "completed" }], { enforce: false });
    const events = await collect(makeLoop(ts).run("build it", "s1", "/tmp"));
    expect(events.find((e) => e.type === "handoff")).toBeUndefined();
    expect(events.some((e) => e.type === "error" && !(e as any).recoverable)).toBe(false);
    expect(
      events.some(
        (e) => e.type === "notice" && /ending the run as finished/.test((e as any).message),
      ),
    ).toBe(true);
    const last = events.at(-1) as any;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("end_turn");
  });

  test("no plan at all → the plain error, as before", async () => {
    const events = await collect(makeLoop(undefined).run("hello", "s1", "/tmp"));
    expect(events.find((e) => e.type === "handoff")).toBeUndefined();
    const fatal = events.find((e) => e.type === "error" && !(e as any).recoverable) as any;
    expect(fatal?.error).toMatch(/Too many consecutive errors/);
  });
});
