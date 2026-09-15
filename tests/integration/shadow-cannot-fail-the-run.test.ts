/**
 * V6 finding 9, promoted: a shadow lane that can fail a run is not a shadow lane.
 *
 * THE CLAIM
 *
 *   docs/program/m2-shadow-controller.md, "The one rule":
 *     "**Shadow means pure.** … It runs beside the guard, the guard acts as it
 *      always did, and the only output is a bounded ledger row…"
 *   packages/orchestrator/src/shadow-arbiter.ts, `observe`'s own doc:
 *     "Never throws. A shadow lane that can fail a run is not a shadow lane."
 *
 * WHAT USED TO HAPPEN
 *
 * Containment lived INSIDE one implementation, not at the 26 call sites.
 * `this.config.shadow?.observe(g, i, a, shadowState())` let two things out:
 * an observer that is not the arbiter (an embedder's, a test's) threw straight
 * into the loop; and the SNAPSHOT, evaluated as the argument, sat outside every
 * `try`, so a run with the controller ON died at `agent-loop.ts:1559` where the
 * identical run with it OFF finished. Those accessors are read only because
 * shadow is on, which is precisely the behaviour difference M2 promises the
 * shadow lane cannot introduce.
 *
 * WHAT HAPPENS NOW
 *
 * `AgentLoop.watch` takes the state as a THUNK and calls both it and `observe`
 * inside one `try`. The early `if (!shadow) return` keeps `?.`'s short-circuit:
 * with the controller off nothing is built and nothing is called — the third
 * test here is that control, and it passed before the fix too.
 *
 * No network, no credential, no model call: a scripted gateway and registry.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop } from "../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../packages/orchestrator/src/task-state";
import { ShadowArbiter, type ShadowObserver } from "../../packages/orchestrator/src/shadow-arbiter";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** One write, then a wrap-up. No network, no credential, no model call. */
function gateway() {
  let step = 0;
  return {
    inferStream: mock(async function* () {
      step++;
      if (step === 1) {
        yield ev("tool_use_start", { toolCallId: "w1", toolName: "write_file" });
        yield ev("tool_use_stop", {
          toolCallId: "w1",
          toolInput: { path: "index.html", content: "<main>hi</main>" },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
        return;
      }
      yield ev("content_delta", { delta: { type: "text_delta", text: "built it" } });
      yield ev("message_stop", { stopReason: "end_turn" });
    }),
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as unknown as never;
}

function registry() {
  return {
    toLlmTools: mock(() => [{ name: "write_file", description: "", inputSchema: {} }]),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "write",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (i: { toolName: string; callId: string }) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: JSON.stringify({ path: "x", hash: "h" }),
      durationMs: 1,
    })),
  } as unknown as never;
}

function loopWith(extra: Record<string, unknown>): AgentLoop {
  const ts = new TaskStateStore();
  ts.beginTurn("write the page");
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      taskState: ts,
      ...extra,
    } as never,
    gateway(),
    registry(),
  );
}

/** The accessor the Engine wires as `spentUsd`, standing in for a cost ledger
 *  that cannot answer (a closed database, a rehydration failure). It is read
 *  ONLY from `snapshot()`, i.e. only because the shadow lane is on. */
const brokenSpend = () => {
  throw new Error("cost ledger unavailable");
};

describe("a shadow observation cannot kill the run it only watches", () => {
  test("an observer whose observe() throws does not escape into the loop", async () => {
    const shadow: ShadowObserver = {
      observe() {
        throw new Error("observer down");
      },
      unshadowed() {},
      finish() {},
    };
    const events = await collect(loopWith({ shadow }).run("go", "s1", "/tmp"));
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });

  test("with shadow ON, a throwing snapshot accessor does not kill the run", async () => {
    const shadow = new ShadowArbiter({ runId: "r#1", emit: () => {} });
    const events = await collect(
      loopWith({ shadow, spentUsd: brokenSpend }).run("go", "s1", "/tmp"),
    );
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });

  test("the control: with shadow OFF the same broken accessor is never read", async () => {
    // GREEN — kept as the control that makes the two above a BEHAVIOUR
    // difference rather than a pre-existing fragility.
    const events = await collect(loopWith({ spentUsd: brokenSpend }).run("go", "s1", "/tmp"));
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });
});
