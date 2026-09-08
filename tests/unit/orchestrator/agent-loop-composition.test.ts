/**
 * What one request is made of, measured at the only place that knows.
 *
 * The founder's measurement was "~34k fresh input tokens per completion" — a
 * total with no parts, so nothing could be traded away. The agent loop is the
 * only place that can split it: on the wire the plan-ledger block is an
 * ordinary user message, indistinguishable from the work, and only the loop
 * knows where the cacheable prefix ends and the ephemeral tail begins. That
 * line is `stableMessageCount`, and it is the same line the cache breakpoint
 * uses.
 *
 * The load-bearing test here is the last one: the JIT doctrine's effect must
 * be VISIBLE in this row, or "jit is the default" is a claim with no meter.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import type { InferenceRequest } from "../../../packages/llm-gateway/src/index";
import { utf8Bytes } from "../../../packages/llm-gateway/src/index";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Records every request the loop sends, then replies with one text turn. */
function makeGateway(seen: InferenceRequest[]) {
  return {
    inferStream: mock(async function* (request: InferenceRequest) {
      seen.push(request);
      yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
      yield ev("message_stop", { stopReason: "end_turn" });
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

const TOOL = {
  name: "read_file",
  description: "Read a file from the workspace",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

function makeRegistry(tools: unknown[] = []) {
  return {
    toLlmTools: mock(() => tools),
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
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: unknown, over: Record<string, unknown> = {}, tools: unknown[] = []) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 4,
      systemPrompt: "SYSTEM DOCTRINE",
      taskState: new TaskStateStore(),
      ...over,
    } as any,
    gateway as never,
    makeRegistry(tools),
  );
}

describe("per-request composition", () => {
  test("every request carries a role and a composition", async () => {
    const seen: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(seen)).run("hello", "chat", "/tmp"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.role).toBe("primary");
    expect(seen[0]!.composition).toBeDefined();
  });

  test("a delegated loop says so, and is still not governance", async () => {
    const seen: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(seen), { callRole: "subagent" }).run("go", "chat", "/tmp"));
    expect(seen[0]!.role).toBe("subagent");
  });

  test("the doctrine's bytes are the system prompt's bytes", async () => {
    const seen: InferenceRequest[] = [];
    const systemPrompt = "# Doctrine\n" + "x".repeat(5_000);
    await collect(makeLoop(makeGateway(seen), { systemPrompt }).run("hello", "chat", "/tmp"));
    expect(seen[0]!.composition!.doctrine).toBe(utf8Bytes(seen[0]!.system!));
    expect(seen[0]!.composition!.doctrine).toBeGreaterThan(5_000);
  });

  test("the tool surface is counted, and costs nothing when no tools are offered", async () => {
    const without: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(without)).run("hello", "chat", "/tmp"));
    expect(without[0]!.composition!.toolSchemas).toBe(0);

    const withTools: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(withTools), {}, [TOOL]).run("hello", "chat", "/tmp"));
    expect(withTools[0]!.composition!.toolSchemas).toBe(utf8Bytes(JSON.stringify([TOOL])));
  });

  test("the parts always sum to the total", async () => {
    const seen: InferenceRequest[] = [];
    const taskState = new TaskStateStore();
    taskState.beginTurn("build the parser");
    taskState.setTodos(
      [
        { content: "read the grammar", status: "completed" },
        { content: "write the parser", status: "in_progress" },
      ],
      { enforce: false },
    );
    await collect(
      makeLoop(makeGateway(seen), { taskState }, [TOOL]).run("build it", "build", "/tmp"),
    );
    const c = seen[0]!.composition!;
    expect(c.total).toBe(c.doctrine + c.planLedger + c.taskState + c.toolSchemas + c.conversation);
    expect(c.conversation).toBeGreaterThan(0);
  });

  test("the plan ledger is attributed to itself, not to the conversation", async () => {
    // It rides as an ephemeral final user message, so a naive measurement
    // would file the entire spine under "conversation" and the readout would
    // say the ledger costs nothing.
    const taskState = new TaskStateStore();
    taskState.beginTurn("build the parser");
    taskState.setTodos(
      [
        { content: "read the grammar", status: "completed" },
        { content: "write the parser", status: "in_progress" },
        { content: "verify", status: "pending" },
      ],
      { enforce: false },
    );
    const withPlan: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(withPlan), { taskState }).run("go on", "build", "/tmp"));

    const withoutPlan: InferenceRequest[] = [];
    await collect(makeLoop(makeGateway(withoutPlan)).run("go on", "chat", "/tmp"));

    expect(withPlan[0]!.composition!.planLedger).toBeGreaterThan(0);
    expect(withoutPlan[0]!.composition!.planLedger).toBe(0);
    // …and the ledger's bytes did NOT land in the conversation bucket.
    expect(withPlan[0]!.composition!.conversation).toBe(withoutPlan[0]!.composition!.conversation);
  });

  test("the turn-budget notice is task state, not conversation", async () => {
    const seen: InferenceRequest[] = [];
    await collect(
      makeLoop(makeGateway(seen), { turnBudgetNotice: true }).run("hello", "chat", "/tmp"),
    );
    expect(seen[0]!.composition!.taskState).toBeGreaterThan(0);
  });

  test("the JIT doctrine's effect is visible in the doctrine bytes", async () => {
    // This is the meter that makes "jit is the default" a measurable claim
    // rather than a comment: `full` delivery puts the situational sections in
    // the per-request system prompt, and the row has to show it.
    const jitLike: InferenceRequest[] = [];
    await collect(
      makeLoop(makeGateway(jitLike), { systemPrompt: "CORE" }).run("hi", "chat", "/tmp"),
    );

    const fullLike: InferenceRequest[] = [];
    await collect(
      makeLoop(makeGateway(fullLike), {
        systemPrompt: "CORE\n\n# Delegation\n" + "d".repeat(2_000),
      }).run("hi", "chat", "/tmp"),
    );

    expect(fullLike[0]!.composition!.doctrine - jitLike[0]!.composition!.doctrine).toBeGreaterThan(
      2_000,
    );
    // Nothing else moved: the difference is entirely the prompt.
    expect(fullLike[0]!.composition!.conversation).toBe(jitLike[0]!.composition!.conversation);
  });
});
