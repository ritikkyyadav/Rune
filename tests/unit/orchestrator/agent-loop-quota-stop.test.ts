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
