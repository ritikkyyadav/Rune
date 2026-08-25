/**
 * Empty-completion guard: a stream that closes with no text and no tool calls
 * must never end the run as a silent no-op. Live failure 2026-07-07: Gemini
 * fallback returned stopReason tool_use with ZERO tool calls; the turn ended
 * with nothing rendered and nothing explained.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: () => undefined,
    execute: async () => {
      throw new Error("no tools should run in these tests");
    },
  } as any;
}

const textDelta = (text: string) => ({
  type: "content_delta",
  contentIndex: 0,
  delta: { type: "text_delta", text },
});

const stopEvent = (stopReason: string) => ({
  type: "message_stop",
  stopReason,
  usage: { inputTokens: 10, outputTokens: 0 },
});

function loopWith(gateway: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 8,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      thinking: false,
    },
    gateway,
    makeRegistry(),
  );
}

describe("AgentLoop — empty completions never end a run silently", () => {
  test("stopReason tool_use with zero tool calls: retries twice, then fails LOUDLY", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        yield stopEvent("tool_use"); // claims a tool call, delivers none
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("build me a dashboard", "s1", "/tmp"));

    expect(calls).toBe(3); // initial + 2 retries
    const notices = events.filter(
      (e) => e.type === "notice" && /empty response/i.test((e as any).message),
    );
    expect(notices.length).toBe(2);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect((errors[0] as any).error).toContain("empty response 3 times");
    // The transcript must not be poisoned with empty assistant messages.
    const empties = loop
      .getMessages()
      .filter((m) => m.role === "assistant" && m.content.length === 0);
    expect(empties.length).toBe(0);
  });

  test("recovers when a retry produces real output", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield stopEvent("tool_use"); // defective first attempt
        } else {
          yield textDelta("Here is the answer.");
          yield stopEvent("end_turn");
        }
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("hello", "s1", "/tmp"));

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "text_delta" && (e as any).text.includes("answer"))).toBe(
      true,
    );
    const complete = events.filter((e) => e.type === "turn_complete");
    expect(complete.length).toBe(1);
    expect((complete[0] as any).stopReason).toBe("end_turn");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("first-step end_turn with literal nothing is treated as a defect, not an answer", async () => {
    let calls = 0;
    const gateway = {
      inferStream: async function* () {
        calls++;
        yield stopEvent("end_turn"); // no content at all, first step of the run
      },
    };
    const loop = loopWith(gateway);
    const events = await collect(loop.run("say hi", "s1", "/tmp"));

    expect(calls).toBe(3);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("incidents are reported for empty completions", async () => {
    const classes: string[] = [];
    const gateway = {
      inferStream: async function* () {
        yield stopEvent("tool_use");
      },
    };
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "google",
        maxTokens: 100,
        maxTurns: 8,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        thinking: false,
        onIncident: (i: any) => classes.push(i.class),
      } as any,
      gateway as any,
      makeRegistry(),
    );
    await collect(loop.run("x", "s1", "/tmp"));
    expect(classes.filter((c) => c === "provider.empty_completion").length).toBe(3);
  });
});
