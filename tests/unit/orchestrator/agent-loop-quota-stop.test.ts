/**
 * What the RUN does when the gateway reports a quota cap.
 *
 * The gateway refuses to substitute a weaker model (see gateway quota-stop
 * tests); this is the other half — the loop must end cleanly rather than burn
 * its consecutive-error budget or sit in the all-providers-rate-limited wait,
 * and it must write the resume handoff first. Stopping is only an improvement
 * on degrading if the work survives the stop.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { BudgetExceededError } from "../../../packages/llm-gateway/src/cost-tracker";

const QUOTA_ERROR =
  "Quota exceeded on codex/gpt-5.6-sol — The usage limit has been reached. " +
  "Stopped here instead of handing your task to a weaker model. " +
  "Your work is saved: resume this session in ~15m, switch now with /model, " +
  'or set [fallback] onQuotaExceeded = "degrade" to allow automatic downgrade.';

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (i: { toolName: string; callId: string }) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: JSON.stringify({ items: [{ content: "step one", status: "in_progress" }] }),
      durationMs: 1,
    }),
  } as any;
}

/** Turn 1 records a todo; every turn after that hits the quota wall. */
function gatewayCappedAfterPlanning() {
  const gw = {
    calls: 0,
    inferStream: async function* () {
      gw.calls++;
      if (gw.calls === 1) {
        yield { type: "tool_use_start", toolCallId: "t1", toolName: "todo_write" };
        yield {
          type: "tool_use_stop",
          toolCallId: "t1",
          toolInput: { items: [{ content: "step one", status: "in_progress" }] },
        };
        yield { type: "message_stop", stopReason: "tool_use" };
        return;
      }
      yield { type: "error", error: QUOTA_ERROR, retryable: false };
    },
  } as any;
  return gw;
}

async function drain(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function run(gateway: any, taskState: TaskStateStore) {
  const loop = new AgentLoop(
    {
      model: "gpt-5.6-sol",
      provider: "codex",
      maxTokens: 100,
      maxTurns: 12,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      taskState,
    } as any,
    gateway,
    makeRegistry(),
  );
  return drain(loop.run("do the extensive thing", "s1", "/ws"));
}

describe("a quota cap ends the run", () => {
  test("it stops on the FIRST capped turn, not after the error budget", async () => {
    // maxConsecutiveErrors is 3; a terminal error must not be retried at all.
    const gw = gatewayCappedAfterPlanning();
    await run(gw, new TaskStateStore());
    expect(gw.calls).toBe(2); // planning turn + the capped turn, nothing more
  });

  test("the error reaches the surface unrecoverable", async () => {
    const events = await run(gatewayCappedAfterPlanning(), new TaskStateStore());
    const err = events.find((e) => e.type === "error") as Extract<
      AgentTurnEvent,
      { type: "error" }
    >;
    expect(err.recoverable).toBe(false);
    expect(err.error).toContain("Quota exceeded");
  });

  test("the work is handed off before the run ends", async () => {
    // The whole point: stopping beats degrading only if the task survives.
    const events = await run(gatewayCappedAfterPlanning(), new TaskStateStore());
    const handoff = events.find((e) => e.type === "handoff") as Extract<
      AgentTurnEvent,
      { type: "handoff" }
    >;
    expect(handoff).toBeDefined();
    expect(handoff.state).toContain("step one");
  });

  test("the handoff comes BEFORE the error, so nothing races the exit", async () => {
    const events = await run(gatewayCappedAfterPlanning(), new TaskStateStore());
    const iHandoff = events.findIndex((e) => e.type === "handoff");
    const iError = events.findIndex((e) => e.type === "error");
    expect(iHandoff).toBeGreaterThanOrEqual(0);
    expect(iHandoff).toBeLessThan(iError);
  });

  test("and the terminal event comes AFTER it, naming the provider (Phase 5B)", async () => {
    // This exit emitted nothing terminal at all, so the envelope carried an
    // `error` with no `stopReason` key — `JSON.stringify` drops undefined —
    // and the lifecycle row was invented afterwards. A non-retryable provider
    // failure that does NOT carry the cap's structural code (this gateway
    // sends only the sentence) is `provider_lost`; the run says so itself.
    const events = await run(gatewayCappedAfterPlanning(), new TaskStateStore());
    const terminal = events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
    expect(terminal.type).toBe("turn_complete");
    expect(terminal.stopReason).toBe("provider_lost");
    expect(events.findIndex((e) => e.type === "error")).toBeLessThan(events.length - 1);
  });

  test("the open todo is preserved for the resume", async () => {
    const ts = new TaskStateStore();
    await run(gatewayCappedAfterPlanning(), ts);
    expect(ts.hasOpenTodos()).toBe(true);
  });

  test("the run does not sit waiting on the cap", async () => {
    // A 15-minute window must never be read as a waitable throttle. If it were,
    // this test would hang rather than fail — so bound it explicitly.
    const started = Date.now();
    await run(gatewayCappedAfterPlanning(), new TaskStateStore());
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

/**
 * What the real gateway sends for a plan or usage cap: the sentence, and the
 * kind (`usage_cap`) and the reset (`resetAt`) as fields. The loop dropped
 * both until 2026-10-14 and ended the run `provider_lost` — 39 of 44 such
 * endings in one install's record were a Codex limit with a known reset.
 */
describe("a usage cap the gateway names ends the run `quota_wall`, with its reset", () => {
  const RESET_AT = Date.parse("2026-10-14T17:14:00Z");
  function gatewayWithStructuralCap() {
    const gw = gatewayCappedAfterPlanning();
    const planning = gw.inferStream;
    gw.inferStream = async function* (...args: unknown[]) {
      if (gw.calls === 0) {
        yield* planning(...args);
        return;
      }
      gw.calls++;
      yield {
        type: "error",
        error: QUOTA_ERROR,
        retryable: false,
        code: "usage_cap",
        resetAt: RESET_AT,
      };
    };
    return gw;
  }

  test("the terminal event says quota_wall and carries the provider's reset", async () => {
    const events = await run(gatewayWithStructuralCap(), new TaskStateStore());
    const terminal = events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
    expect(terminal.type).toBe("turn_complete");
    expect(terminal.stopReason).toBe("quota_wall");
    expect(terminal.resumeAt).toBe(RESET_AT);
  });

  test("the handoff is written as a quota wall, before the error", async () => {
    const ts = new TaskStateStore();
    const events = await run(gatewayWithStructuralCap(), ts);
    const iHandoff = events.findIndex((e) => e.type === "handoff");
    const handoff = events[iHandoff] as Extract<AgentTurnEvent, { type: "handoff" }>;
    expect(handoff.reason).toBe("quota_wall");
    expect(iHandoff).toBeLessThan(events.findIndex((e) => e.type === "error"));
    expect(ts.hasOpenTodos()).toBe(true);
  });

  test("it still stops on the first capped turn and never waits on the cap", async () => {
    const gw = gatewayWithStructuralCap();
    const started = Date.now();
    await run(gw, new TaskStateStore());
    expect(gw.calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a non-retryable failure that is not a cap still ends provider_lost", async () => {
    const gw = gatewayCappedAfterPlanning();
    const planning = gw.inferStream;
    gw.inferStream = async function* (...args: unknown[]) {
      if (gw.calls === 0) {
        yield* planning(...args);
        return;
      }
      gw.calls++;
      yield { type: "error", error: "No credits on openrouter.", retryable: false };
    };
    const events = await run(gw, new TaskStateStore());
    const terminal = events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
    expect(terminal.stopReason).toBe("provider_lost");
    expect(terminal.resumeAt).toBeUndefined();
  });
});

/**
 * The budget-admission exit (E7 in the guard inventory).
 *
 * The gateway refuses the request BEFORE it is sent — a spend cap, or a model
 * with no price. It had no test anywhere and no terminal event, so it reached
 * the record as `provider_lost`: a run refused on cost was indistinguishable
 * from a dead network. It is a budget stop and now says so.
 */
describe("a budget refusal ends the run before the request", () => {
  const refusingGateway = () => ({
    inferStream: async function* (): AsyncGenerator<never> {
      throw new BudgetExceededError("session", 1, 2.5);
      yield undefined as never;
    },
    infer: async () => {
      throw new BudgetExceededError("session", 1, 2.5);
    },
    registerProvider: () => {},
    getProvider: () => null,
    getTotalCost: () => 0,
  });

  test("the error is unrecoverable and the terminal event follows it, as `budget`", async () => {
    const events = await run(refusingGateway(), new TaskStateStore());
    const iError = events.findIndex((e) => e.type === "error");
    expect(iError).toBeGreaterThanOrEqual(0);
    expect((events[iError] as Extract<AgentTurnEvent, { type: "error" }>).recoverable).toBe(false);
    expect((events[iError] as Extract<AgentTurnEvent, { type: "error" }>).error).toContain(
      "Budget exceeded",
    );
    const terminal = events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
    expect(terminal.type).toBe("turn_complete");
    expect(terminal.stopReason).toBe("budget");
    expect(iError).toBeLessThan(events.length - 1);
  });

  test("it does not burn the consecutive-error budget re-asking", async () => {
    // An admission failure needs a changed budget, not another identical try.
    let calls = 0;
    const gw = {
      ...refusingGateway(),
      inferStream: async function* (): AsyncGenerator<never> {
        calls++;
        throw new BudgetExceededError("session", 1, 2.5);
        yield undefined as never;
      },
    };
    await run(gw, new TaskStateStore());
    expect(calls).toBe(1);
  });
});
