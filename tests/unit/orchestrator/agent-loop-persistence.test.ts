/**
 * Phase-1 regression tests: incremental persistence + error-counter hygiene.
 *
 * Pre-fix behavior these pin against:
 *  - Session persistence was one positional sweep at run end
 *    (`startIndex = priorMessages.length + 1` into the loop's LIVE array).
 *    After any auto-compaction shrank that array, the entire run's
 *    assistant/tool history silently vanished from the session log. The loop
 *    now queues every appended message for the engine to drain incrementally.
 *  - `consecutiveErrors` was shared by provider errors, tool failures, AND
 *    permission denials — and never reset on success — so three denied
 *    prompts plus one transient provider blip killed an otherwise-fine run.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; text?: string; error?: string };

/** Gateway that plays a scripted list of turns (tool_use, final text, or a recoverable error). */
function makeScriptedGateway(turns: Step[]) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.error) {
        yield ev("error", { error: t.error });
      } else if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: { path: `f${i}.txt` } });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
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
        category: name === "write_file" ? "write" : "read",
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

function makeLoop(gateway: any, opts: Record<string, unknown> = {}, permissionCheck?: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
    permissionCheck,
  );
}

describe("incremental persistence queue", () => {
  test("every appended message is queued, in order", async () => {
    const loop = makeLoop(makeScriptedGateway([{ tool: "read_file" }, { text: "all done" }]));
    await collect(loop.run("do the thing", "s1", "/tmp"));
    const queued = loop.takePendingPersist();
    const roles = queued.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    // Draining twice yields nothing new.
    expect(loop.takePendingPersist()).toEqual([]);
  });

  test("the queue survives a mid-run compaction that rewrites the transcript", async () => {
    // Context engine double: compacts once after the tool turn, replacing the
    // whole array with [summary, tail] — the exact operation that used to
    // erase the run from the session log.
    let compactions = 0;
    const contextEngine = {
      buildPrompt: (system: string, tools: unknown[], messages: unknown[]) => ({
        messages,
        system,
        tools,
        totalTokens: 10,
        evictedCount: 0,
      }),
      shouldCompact: () => compactions === 0,
      compactWorkingSet: async (messages: any[]) => {
        compactions++;
        return {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "[Earlier conversation summary]\nx" }],
            },
            ...messages.slice(-2),
          ],
          compacted: true,
          beforeTokens: 100,
          afterTokens: 20,
          summarizedCount: 3,
        };
      },
      noteRealUsage: () => {},
      getContextUsage: () => ({ used: 10, limit: 100, percent: 10 }),
    } as any;

    const loop = makeLoop(makeScriptedGateway([{ tool: "read_file" }, { text: "done" }]), {
      contextEngine,
    });
    await collect(loop.run("long task", "s1", "/tmp"));
    expect(compactions).toBe(1);

    const queued = loop.takePendingPersist();
    // The assistant tool-use message from BEFORE the compaction is still in
    // the persistence queue even though the live array was rewritten.
    const assistantWithTool = queued.filter(
      (m) => m.role === "assistant" && m.content.some((b: any) => b.type === "tool_use"),
    );
    expect(assistantWithTool.length).toBe(1);
    const roles = queued.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  test("draining mid-run is incremental — no message is lost or duplicated", async () => {
    const loop = makeLoop(makeScriptedGateway([{ tool: "read_file" }, { text: "done" }]));
    const gen = loop.run("task", "s1", "/tmp");
    const seen: any[] = [];
    const drained: any[] = [];
    for await (const e of gen) {
      seen.push(e);
      drained.push(...loop.takePendingPersist());
    }
    drained.push(...loop.takePendingPersist());
    expect(drained.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

describe("consecutiveErrors hygiene", () => {
  test("provider errors interleaved with successful turns never kill the run", async () => {
    // error, ok, error, ok, error, done — three total errors, but each
    // successful stream resets the breaker. Pre-fix (no reset), the third
    // error hit maxConsecutiveErrors=3 and the run died mid-task.
    const loop = makeLoop(
      makeScriptedGateway([
        { error: "transient 500" },
        { tool: "read_file" },
        { error: "transient 500" },
        { tool: "read_file" },
        { error: "transient 500" },
        { text: "done" },
      ]),
      { maxConsecutiveErrors: 3 },
    );
    const events = await collect(loop.run("task", "s1", "/tmp"));
    const fatal = events.filter((e) => e.type === "error" && (e as any).recoverable === false);
    expect(fatal).toEqual([]);
    const complete = events.find((e) => e.type === "turn_complete") as any;
    expect(complete?.stopReason).toBe("end_turn");
  });

  test("permission denials do not charge the provider-error breaker", async () => {
    // Three denials, then one recoverable provider error, then done.
    // Pre-fix: denials pre-charged the counter to 3, the blip made 4 ≥ 3 →
    // "Too many consecutive errors" killed the run.
    const deny = mock(async () => ({ allowed: false, reason: "user said no" }));
    const loop = makeLoop(
      makeScriptedGateway([
        { tool: "write_file" },
        { tool: "write_file" },
        { tool: "write_file" },
        { error: "transient 500" },
        { text: "understood, stopping" },
      ]),
      { maxConsecutiveErrors: 3 },
      deny,
    );
    const events = await collect(loop.run("task", "s1", "/tmp"));
    const fatal = events.filter((e) => e.type === "error" && (e as any).recoverable === false);
    expect(fatal).toEqual([]);
    const complete = events.find((e) => e.type === "turn_complete") as any;
    expect(complete?.stopReason).toBe("end_turn");
  });
});
