/**
 * The harness does not spend the model's turn budget on itself. A batch the
 * loop skipped after a stuck nudge is a completion the harness discarded;
 * the ceiling moves up by one so the run keeps the productive turns it was
 * promised. Measured before this: nine runs ended at the 80-turn ceiling
 * with the gates having eaten a share of it, and the second wind never fired.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Turns 1–3 issue the identical read (the third is skipped by the stuck
 * detector and refunded), turn 4 reads something else, turn 5 answers.
 * With a ceiling of 4 the answer only fits because turn 3 was refunded.
 */
function makeGateway() {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      i++;
      if (i <= 3) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: { path: "same.ts" } });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else if (i === 4) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: { path: "other.ts" } });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "Done." } });
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
        category: "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "the same forty-plus characters of file content every single time",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any, registry: any, opts: Record<string, unknown>) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 4,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      effortRouting: "off",
      ...opts,
    } as any,
    gateway,
    registry,
  );
}

describe("turn refunds in the loop", () => {
  test("a skipped batch is refunded, and the run finishes inside the refunded ceiling", async () => {
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(), makeRegistry(), {
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("read the thing", "s1", "/tmp"));
    expect(incidents).toContain("loop.stuck_nudge");
    expect(incidents).toContain("loop.turn_refunded");
    expect(incidents).not.toContain("loop.max_turns");
    const last = events[events.length - 1] as any;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("end_turn");
    expect(last.totalTurns).toBe(5);
  });

  test("without the refund the same run dies at the ceiling — the control", async () => {
    // A ceiling of 4 with no refund possible (cap 0 because base 0 rounds
    // to 0) is not constructible through config, so the control is the
    // arithmetic: the refunded run above needed turn 5 to finish.
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(), makeRegistry(), {
      maxTurns: 3,
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("read the thing", "s1", "/tmp"));
    // base 3 → cap 1: the skipped turn 3 is refunded (ceiling 4), turn 4
    // reads, and the ceiling ends the run before the answer at turn 5.
    expect(incidents).toContain("loop.turn_refunded");
    expect(incidents).toContain("loop.max_turns");
    const last = events[events.length - 1] as any;
    expect(last.stopReason).toBe("max_turns");
    expect(last.totalTurns).toBe(4);
  });
});

describe("refunds and the sub-agent clock", () => {
  test("a clocked sub-agent gets no refunds — its ceiling is a deadline it was told to watch", async () => {
    // Found by the scout budget test: a refund moved "turn 6 of 8" to
    // "turn 6 of 9" and the wrap-up escalation the scout relies on never fired.
    const incidents: string[] = [];
    const loop = makeLoop(makeGateway(), makeRegistry(), {
      turnBudgetNotice: true,
      onIncident: (i: any) => incidents.push(i.class),
    });
    const events = await collect(loop.run("read the thing", "s1", "/tmp"));
    expect(incidents).toContain("loop.stuck_nudge");
    expect(incidents).not.toContain("loop.turn_refunded");
    const last = events[events.length - 1] as any;
    expect(last.stopReason).toBe("max_turns");
    expect(last.totalTurns).toBe(4);
  });
});
