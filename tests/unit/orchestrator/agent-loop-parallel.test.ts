/**
 * Phase 1b/Bug-2 unit tests for AgentLoop:
 *  1. Independent read-only (auto) tool calls in one turn run CONCURRENTLY.
 *  2. Write/serial tool calls run SEQUENTIALLY (never overlap).
 *  3. tool_call_end events + results preserve original call order.
 *  4. A mid-turn stream error RETRIES the turn instead of silently completing.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Gateway: turn 1 emits N tool_use calls, turn 2 ends with text. */
function makeMultiToolGateway(calls: Array<{ id: string; name: string }>) {
  let turn = 0;
  return {
    inferStream: mock(async function* () {
      turn++;
      if (turn === 1) {
        for (const c of calls) {
          yield ev("tool_use_start", { toolCallId: c.id, toolName: c.name });
          yield ev("tool_use_stop", { toolCallId: c.id, toolInput: {} });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "summary" }],
      model: "test",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

/** Registry whose tools share one category/permissionLevel, with a concurrency probe. */
function makeProbeRegistry(category: "read" | "write", permissionLevel: "auto" | "confirm") {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const registry = {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category,
        permissionLevel,
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      order.push(input.callId);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 15,
      };
    }),
    _probe: () => ({ maxActive, order }),
  } as any;
  return registry;
}

describe("AgentLoop — parallel tool execution (Phase 1b)", () => {
  test("independent read-only auto tools run concurrently", async () => {
    const gateway = makeMultiToolGateway([
      { id: "a", name: "read_file" },
      { id: "b", name: "grep" },
      { id: "c", name: "list_dir" },
    ]);
    const registry = makeProbeRegistry("read", "auto");

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s" },
      gateway,
      registry,
    );
    const events = await collect(loop.run("go", "sess", "/ws"));

    const { maxActive, order } = registry._probe();
    expect(maxActive).toBe(3); // all three ran at once
    expect(order.length).toBe(3);

    // tool_call_end events appear in the ORIGINAL order a,b,c
    const endIds = events
      .filter(
        (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> => e.type === "tool_call_end",
      )
      .map((e) => e.callId);
    expect(endIds).toEqual(["a", "b", "c"]);
  });

  test("write (serial) tools never overlap", async () => {
    const gateway = makeMultiToolGateway([
      { id: "x", name: "write_file" },
      { id: "y", name: "write_file" },
    ]);
    const registry = makeProbeRegistry("write", "confirm");

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s" },
      gateway,
      registry,
    );
    await collect(loop.run("go", "sess", "/ws"));

    const { maxActive } = registry._probe();
    expect(maxActive).toBe(1); // strictly sequential
  });
});

describe("AgentLoop — stream-error retry (Bug 2)", () => {
  test("retries the turn on a mid-stream error instead of completing", async () => {
    let turn = 0;
    const gateway = {
      inferStream: mock(async function* () {
        turn++;
        if (turn === 1) {
          // Simulate a provider throttle/5xx surfaced as a stream error event.
          yield ev("error", { error: "rate limited" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "recovered" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
      infer: mock(async () => ({
        content: [{ type: "text", text: "s" }],
        model: "test",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const registry = makeProbeRegistry("read", "auto");

    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 5,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
      },
      gateway,
      registry,
    );
    const events = await collect(loop.run("go", "sess", "/ws"));

    // It retried: inferStream called twice.
    expect((gateway.inferStream as ReturnType<typeof mock>).mock.calls.length).toBe(2);

    // A recoverable error was surfaced (not swallowed).
    const errs = events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "error" }> => e.type === "error",
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].recoverable).toBe(true);

    // And the turn ultimately completed cleanly, not as a silent end_turn-with-nothing.
    const complete = events.find(
      (e): e is Extract<AgentTurnEvent, { type: "turn_complete" }> => e.type === "turn_complete",
    );
    expect(complete?.stopReason).toBe("end_turn");
  });
});

describe("AgentLoop — bounded fan-out concurrency (Phase 3)", () => {
  test("respects the maxParallelTools cap while still running every call", async () => {
    const gateway = makeMultiToolGateway([
      { id: "a", name: "read_file" },
      { id: "b", name: "read_file" },
      { id: "c", name: "read_file" },
      { id: "d", name: "read_file" },
      { id: "e", name: "read_file" },
    ]);
    const registry = makeProbeRegistry("read", "auto");
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 5,
        systemPrompt: "s",
        maxParallelTools: 2,
      },
      gateway,
      registry,
    );
    await collect(loop.run("go", "sess", "/ws"));

    const { maxActive, order } = registry._probe();
    expect(maxActive).toBe(2); // never exceeds the cap
    expect(order.length).toBe(5); // but all five still ran
  });
});

describe("AgentLoop — stuck-detection nudge (Phase 3)", () => {
  test("nudges once before bailing when the same call repeats", async () => {
    // Gateway that ALWAYS repeats the same single tool call.
    let providerTurn = 0;
    const gateway = {
      inferStream: mock(async function* () {
        const callId = `same-${++providerTurn}`;
        yield ev("tool_use_start", { toolCallId: callId, toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: callId, toolInput: { path: "x" } });
        yield ev("message_stop", { stopReason: "tool_use" });
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
    const registry = makeProbeRegistry("read", "auto");
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 30,
        maxStuckNudges: 1,
        systemPrompt: "s",
      },
      gateway,
      registry,
    );
    const events = await collect(loop.run("go", "sess", "/ws"));

    // A nudge notice was emitted before bailing.
    const nudge = events.find((e) => e.type === "notice" && /nudg/i.test((e as any).message));
    expect(nudge).toBeDefined();

    // And it ultimately bailed with a non-recoverable loop error.
    const fatal = events.find((e) => e.type === "error" && (e as any).recoverable === false);
    expect(fatal).toBeDefined();
    expect((fatal as any).error).toMatch(/loop/i);

    // Resume-safety invariant: even the FINAL repeated function call gets a
    // synthetic output. Before this fix the persisted transcript ended on a
    // bare tool_use, and Codex rejected every resume with
    // "No tool output found for function call".
    const queued = loop.takePendingPersist();
    const calls = queued.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((b) => b.type === "tool_use") : [],
    );
    const outputs = queued.flatMap((m) =>
      m.role === "tool" ? m.content.filter((b) => b.type === "tool_result") : [],
    );
    expect(outputs).toHaveLength(calls.length);
    expect(outputs.at(-1)).toMatchObject({
      type: "tool_result",
      toolCallId: calls.at(-1)?.type === "tool_use" ? calls.at(-1)?.toolCallId : "",
      isError: true,
    });
  });
});
