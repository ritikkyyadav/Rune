/**
 * Wave 2 integration-wiring unit tests.
 *
 * Covers:
 *  1. todo_updated event is emitted after a successful todo_write tool call.
 *  2. todo_updated is NOT emitted when todo_write fails.
 *  3. todo_updated is NOT emitted for other successful tools.
 *  4. AgentLoop stops cleanly on abort (pre-turn check).
 *  5. AgentLoop stops cleanly on abort (between tool calls).
 *  6. compactWorkingSet is called (not maybeSummarize) after each turn.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStreamEvent(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

/** Collect all events from an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const e of gen) results.push(e);
  return results;
}

/** Minimal fake gateway that returns a single text turn then ends. */
function makeGateway(overrides: Record<string, unknown> = {}) {
  const events = [
    makeStreamEvent("content_delta", { delta: { type: "text_delta", text: "Hello" } }),
    makeStreamEvent("message_stop", { stopReason: "end_turn" }),
    ...((overrides.extraEvents as unknown[]) ?? []),
  ];

  return {
    inferStream: mock(async function* () {
      for (const e of events) yield e;
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "summary" }],
      model: "test",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 5 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

/** Minimal fake registry. */
function makeRegistry(toolResult: {
  success: boolean;
  result?: string;
  error?: string;
  toolName?: string;
}) {
  return {
    toLlmTools: mock(() => []),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: toolResult.toolName ?? input.toolName,
      success: toolResult.success,
      result: toolResult.result ?? "",
      error: toolResult.error,
      durationMs: 1,
    })),
    get: mock(() => null),
  } as any;
}

/** Context engine stub that tracks compactWorkingSet calls. */
function makeContextEngine(compact = false, shouldCompactVal = true) {
  const compactMock = mock(async (messages: unknown[]) => ({
    messages,
    compacted: compact,
  }));
  const maybeSummarizeMock = mock(async () => false);

  return {
    compactWorkingSet: compactMock,
    maybeSummarize: maybeSummarizeMock,
    buildPrompt: mock((sys: string, _tools: unknown[], messages: unknown[]) => ({
      system: sys,
      messages,
      evictedCount: 0,
      totalTokens: 100,
    })),
    getContextUsage: mock(() => ({ used: 100, limit: 1000, percent: 10 })),
    shouldCompact: mock(() => shouldCompactVal),
  } as any;
}

// ─── Gateway that yields a tool_use turn then an end_turn ────────────────────

function makeToolUseGateway(toolName: string, toolInput: Record<string, unknown> = {}) {
  let call = 0;
  return {
    inferStream: mock(async function* () {
      call++;
      if (call === 1) {
        // First turn: model calls a tool
        yield makeStreamEvent("tool_use_start", {
          toolCallId: "tc-1",
          toolName,
        });
        yield makeStreamEvent("tool_use_delta", {
          toolCallId: "tc-1",
          partialJson: "",
        });
        yield makeStreamEvent("tool_use_stop", {
          toolCallId: "tc-1",
          toolInput,
        });
        yield makeStreamEvent("message_stop", { stopReason: "tool_use" });
      } else {
        // Second turn: model produces text and ends
        yield makeStreamEvent("content_delta", {
          delta: { type: "text_delta", text: "Done" },
        });
        yield makeStreamEvent("message_stop", { stopReason: "end_turn" });
      }
    }),
    infer: mock(async () => ({
      content: [{ type: "text", text: "summary" }],
      model: "test",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 5 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Wave 2 wiring — todo_updated", () => {
  test("emits todo_updated after successful todo_write", async () => {
    const items = [
      { content: "Task A", status: "pending" as const },
      { content: "Task B", status: "completed" as const },
    ];
    const gateway = makeToolUseGateway("todo_write", {});
    const registry = makeRegistry({
      success: true,
      toolName: "todo_write",
      result: JSON.stringify({ items }),
    });
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    const events = await collect(loop.run("do stuff", "sess-1", "/ws"));
    const todoEvents = events.filter((e): e is Extract<AgentTurnEvent, { type: "todo_updated" }> =>
      e.type === "todo_updated"
    );

    expect(todoEvents).toHaveLength(1);
    expect(todoEvents[0].items).toEqual(items);
  });

  test("does NOT emit todo_updated when todo_write fails", async () => {
    const gateway = makeToolUseGateway("todo_write", {});
    const registry = makeRegistry({
      success: false,
      toolName: "todo_write",
      error: "disk full",
    });
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    const events = await collect(loop.run("do stuff", "sess-1", "/ws"));
    const todoEvents = events.filter((e) => e.type === "todo_updated");
    expect(todoEvents).toHaveLength(0);
  });

  test("does NOT emit todo_updated for other successful tools", async () => {
    const gateway = makeToolUseGateway("read_file", {});
    const registry = makeRegistry({
      success: true,
      toolName: "read_file",
      result: "file contents",
    });
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    const events = await collect(loop.run("read a file", "sess-1", "/ws"));
    const todoEvents = events.filter((e) => e.type === "todo_updated");
    expect(todoEvents).toHaveLength(0);
  });
});

describe("Wave 2 wiring — abort (C2)", () => {
  test("stops cleanly when signal is aborted before first turn", async () => {
    const gateway = makeGateway();
    const registry = makeRegistry({ success: true, result: "" });
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 10, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    const controller = new AbortController();
    controller.abort(); // abort immediately

    const events = await collect(loop.run("hello", "sess-1", "/ws", controller.signal));

    // Should see a turn_complete with stopReason "aborted"
    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    > | undefined;
    expect(complete).toBeDefined();
    expect(complete?.stopReason).toBe("aborted");

    // No errors should be yielded
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
  });

  test("stops cleanly when signal is aborted between tool calls", async () => {
    const controller = new AbortController();

    const gateway = makeToolUseGateway("bash", {});
    const registry = {
      toLlmTools: mock(() => []),
      execute: mock(async (input: { toolName: string; callId: string }) => {
        // Abort mid-execution (simulates abort while tool runs)
        controller.abort();
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: "ok",
          durationMs: 1,
        };
      }),
      get: mock(() => null),
    } as any;
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    const events = await collect(loop.run("run bash", "sess-1", "/ws", controller.signal));

    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    > | undefined;
    expect(complete).toBeDefined();
    expect(complete?.stopReason).toBe("aborted");
  });
});

describe("Wave 2 wiring — compactWorkingSet (C1)", () => {
  test("calls compactWorkingSet (not maybeSummarize) after each turn", async () => {
    const gateway = makeGateway();
    const registry = makeRegistry({ success: true, result: "" });
    const ctx = makeContextEngine();

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    await collect(loop.run("hello", "sess-1", "/ws"));

    expect((ctx.compactWorkingSet as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0);
    expect((ctx.maybeSummarize as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("does NOT call compactWorkingSet when usage is below the high-water mark", async () => {
    const gateway = makeGateway();
    const registry = makeRegistry({ success: true, result: "" });
    const ctx = makeContextEngine(false, false); // shouldCompact() → false

    const loop = new AgentLoop(
      { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 5, systemPrompt: "s", contextEngine: ctx },
      gateway,
      registry,
    );

    await collect(loop.run("hello", "sess-1", "/ws"));

    expect((ctx.compactWorkingSet as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });
});
