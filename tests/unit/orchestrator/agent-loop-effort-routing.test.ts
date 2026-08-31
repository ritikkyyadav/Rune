/**
 * Effort routing: "conservative" runs ordinary turns one notch below the
 * thinkingEffort ceiling and LATCHES back to the ceiling for the rest of the
 * run on the first sign of difficulty. The asymmetry is the safety story:
 * turn 1 (planning), fix-shaped goals, and everything after a latch always get
 * the ceiling — diagnosis is never routed down.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop, stepDownEffort } from "../../../packages/orchestrator/src/agent-loop";
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

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

/** Scripted gateway that records each request's thinking effort. */
function makeGateway(turns: Step[]) {
  let i = 0;
  const efforts: string[] = [];
  return {
    efforts,
    inferStream: mock(async function* (req: any) {
      efforts.push(req.thinking?.effort ?? "(unset)");
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k].name });
          yield ev("tool_use_stop", { toolCallId: `c${i}-${k}`, toolInput: t.tools[k].args ?? {} });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [],
      model: "m",
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
        category: ["write_file", "edit_file"].includes(name)
          ? "write"
          : name === "bash"
            ? "execute"
            : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, opts: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "codex",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
      thinkingEffort: "max",
      effortRouting: "conservative",
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

describe("stepDownEffort", () => {
  test("only the deep end steps down, never below medium", () => {
    expect(stepDownEffort("max")).toBe("high");
    expect(stepDownEffort("xhigh")).toBe("high");
    expect(stepDownEffort("high")).toBe("medium");
    expect(stepDownEffort("medium")).toBe("medium");
    expect(stepDownEffort("low")).toBe("low");
  });
});

describe("effort routing in the loop", () => {
  test("turn 1 gets the ceiling, ordinary turns run one notch down", async () => {
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "a.ts" } }] },
      { tools: [{ name: "read_file", args: { path: "b.ts" } }] },
      { text: "done" },
    ]);
    await collect(makeLoop(gw).run("survey the module structure", "s1", "/tmp"));
    expect(gw.efforts[0]).toBe("max"); // planning turn
    expect(gw.efforts[1]).toBe("high");
    expect(gw.efforts[2]).toBe("high");
  });

  test("a verification failure latches the ceiling for the rest of the run", async () => {
    const verify = mock(async () => ({ ran: true, passed: false, report: "FAIL: 2 tests" }));
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "a.ts" } }] },
      { tools: [{ name: "write_file", args: { path: "a.ts" } }] },
      { text: "finished" }, // triggers verification → fails → loop continues
      { text: "fixed and finished" },
    ]);
    const loop = makeLoop(gw, { verifier: { verify }, maxVerifyAttempts: 1 });
    await collect(loop.run("tidy the module", "s1", "/tmp"));
    expect(gw.efforts[0]).toBe("max");
    expect(gw.efforts[1]).toBe("high");
    expect(gw.efforts[2]).toBe("high");
    // After the failed check, everything runs at the ceiling.
    expect(gw.efforts[3]).toBe("max");
  });

  test("a fix-shaped goal never routes down — diagnosis gets the ceiling", async () => {
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "a.ts" } }] },
      { tools: [{ name: "read_file", args: { path: "b.ts" } }] },
      { text: "done" },
    ]);
    await collect(makeLoop(gw).run("fix the crash in the date parser", "s1", "/tmp"));
    expect(gw.efforts.every((e: string) => e === "max")).toBe(true);
  });

  test("routing off runs the ceiling everywhere", async () => {
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "a.ts" } }] },
      { text: "done" },
    ]);
    await collect(makeLoop(gw, { effortRouting: "off" }).run("survey it", "s1", "/tmp"));
    expect(gw.efforts.every((e: string) => e === "max")).toBe(true);
  });

  test("unset routing (sub-agent default) also runs the ceiling everywhere", async () => {
    const gw = makeGateway([
      { tools: [{ name: "read_file", args: { path: "a.ts" } }] },
      { text: "done" },
    ]);
    await collect(makeLoop(gw, { effortRouting: undefined }).run("survey it", "s1", "/tmp"));
    expect(gw.efforts.every((e: string) => e === "max")).toBe(true);
  });
});
