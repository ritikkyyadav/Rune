/**
 * AgentLoop handling of gateway stream_reset (mid-stream retry):
 *  - Partial text/tool calls accumulated before the reset must be DISCARDED —
 *    the persisted assistant message contains only the re-streamed response,
 *    and half-formed tool calls never execute.
 *  - Context-overflow errors force a compaction and retry instead of dying.
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop, isContextOverflowError } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import type { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  const executed: string[] = [];
  return {
    executed,
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
    execute: async (input: { toolName: string; callId: string }) => {
      executed.push(input.callId);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    },
  } as any;
}

const textDelta = (text: string) => ({
  type: "content_delta",
  contentIndex: 0,
  delta: { type: "text_delta", text },
});

const stopEvent = (stopReason = "end_turn") => ({
  type: "message_stop",
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5 },
});

function loopWith(gateway: any, extra: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 8,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      thinking: false,
      ...extra,
    },
    gateway,
    makeRegistry(),
  );
}

describe("AgentLoop — stream_reset discards the partial message", () => {
  test("text before the reset never reaches the transcript; tool calls before the reset never run", async () => {
    const gateway = {
      inferStream: async function* () {
        // Partial junk that the retry supersedes:
        yield textDelta("HALF-ANSWER-");
        yield { type: "tool_use_start", toolCallId: "t-stale", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "t-stale", partialJson: '{"pa' };
        // Gateway decided to retry:
        yield { type: "stream_reset" };
        // Clean re-stream:
        yield textDelta("Final clean answer.");
        yield stopEvent();
      },
    } as any;

    const loop = loopWith(gateway);
    const events = await collect(loop.run("go", "s1", "/ws"));

    // The reset is surfaced to UIs plus an explanatory notice.
    expect(events.some((e) => e.type === "stream_reset")).toBe(true);
    expect(
      events.some((e) => e.type === "notice" && /interrupted mid-stream/i.test(e.message)),
    ).toBe(true);

    // The persisted assistant message holds ONLY the re-streamed text.
    const assistant = loop.getMessages().find((m: Message) => m.role === "assistant");
    expect(assistant).toBeDefined();
    const text = assistant!.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(text).toBe("Final clean answer.");
    expect(text).not.toContain("HALF-ANSWER");

    // The stale half-formed tool call was dropped, not executed.
    expect(events.some((e) => e.type === "tool_call_end")).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });
});

describe("AgentLoop — an attempt the loop sends again takes back what it showed", () => {
  // The gateway resets before its own retries. Once those are spent the loop
  // sends the request again itself, and found by the transport suite on 19
  // October, it sent no reset: the half answer stayed on the screen and in
  // the headless envelope, and the re-sent answer was appended to it.
  /** What a consumer is left holding: text, cleared on every reset. */
  const shown = (events: AgentTurnEvent[]) =>
    events.reduce(
      (acc, e) => (e.type === "text_delta" ? acc + e.text : e.type === "stream_reset" ? "" : acc),
      "",
    );

  test("a stream that fails after some text", async () => {
    let call = 0;
    const gateway = {
      inferStream: async function* () {
        call++;
        if (call === 1) {
          yield textDelta("HALF-ANSWER-");
          yield { type: "error", error: "upstream connect error" };
          return;
        }
        yield textDelta("Final clean answer.");
        yield stopEvent();
      },
    } as any;
    const events = await collect(loopWith(gateway).run("go", "s1", "/ws"));
    expect(call).toBe(2);
    expect(shown(events)).toBe("Final clean answer.");
  });

  test("a stream that throws after some text", async () => {
    let call = 0;
    const gateway = {
      inferStream: async function* () {
        call++;
        if (call === 1) {
          yield textDelta("HALF-ANSWER-");
          throw Object.assign(new Error("socket hang up"), { status: 502 });
        }
        yield textDelta("Final clean answer.");
        yield stopEvent();
      },
    } as any;
    const events = await collect(loopWith(gateway).run("go", "s1", "/ws"));
    expect(call).toBe(2);
    expect(shown(events)).toBe("Final clean answer.");
  });

  test("an attempt that showed nothing sends no reset", async () => {
    let call = 0;
    const gateway = {
      inferStream: async function* () {
        call++;
        if (call === 1) {
          yield { type: "error", error: "upstream connect error" };
          return;
        }
        yield textDelta("Final clean answer.");
        yield stopEvent();
      },
    } as any;
    const events = await collect(loopWith(gateway).run("go", "s1", "/ws"));
    expect(events.some((e) => e.type === "stream_reset")).toBe(false);
  });
});

describe("AgentLoop — context-overflow recovery", () => {
  test("isContextOverflowError matches real provider wordings", () => {
    expect(isContextOverflowError("prompt is too long: 250134 tokens > 200000 maximum")).toBe(true);
    expect(
      isContextOverflowError(
        "This model's maximum context length is 128000 tokens. However, you requested 131000 tokens",
      ),
    ).toBe(true);
    expect(isContextOverflowError("400 context_length_exceeded")).toBe(true);
    expect(isContextOverflowError("The input token count exceeds the maximum allowed")).toBe(true);
    expect(isContextOverflowError("rate limited, retry in 5s")).toBe(false);
    expect(isContextOverflowError("invalid api key")).toBe(false);
  });

  test("an over-limit rejection force-compacts and retries instead of dying", async () => {
    let call = 0;
    const gateway = {
      inferStream: async function* () {
        call++;
        if (call === 1) {
          yield { type: "error", error: "prompt is too long: 210000 tokens > 200000 maximum" };
          return;
        }
        yield textDelta("Recovered after compaction.");
        yield stopEvent();
      },
    } as any;

    let forceSeen: boolean | undefined;
    const contextEngine = {
      buildPrompt: (system: string, _tools: unknown[], messages: Message[]) => ({
        messages,
        system,
        tools: [],
        totalTokens: 1,
        evictedCount: 0,
      }),
      noteRealUsage: () => {},
      shouldCompact: () => false,
      compactWorkingSet: async (messages: Message[], _k: number, opts?: { force?: boolean }) => {
        forceSeen = opts?.force;
        return {
          messages: [
            { role: "user", content: [{ type: "text", text: "[summary]" }] } as Message,
            ...messages.slice(-1),
          ],
          compacted: true,
        };
      },
    } as unknown as ContextEngine;

    const loop = loopWith(gateway, { contextEngine });
    const events = await collect(loop.run("go", "s1", "/ws"));

    expect(forceSeen).toBe(true);
    expect(
      events.some((e) => e.type === "notice" && /context window exceeded/i.test(e.message)),
    ).toBe(true);
    // No unrecoverable error; the run completed after the retry.
    expect(events.some((e) => e.type === "error" && e.recoverable === false)).toBe(false);
    expect(events.at(-1)?.type).toBe("turn_complete");
    expect(call).toBe(2);
  });
});

/**
 * R2.4 of docs/program/rune-reliability-plan-20261014.md: an over-limit prompt
 * that nothing shrank is never re-sent unchanged. Before, it fell through to
 * the ordinary retry, was refused the same way until the error budget was
 * spent, and the run ended `provider_lost` — blaming a provider that answered.
 */
describe("AgentLoop — an over-limit prompt nothing shrank is not re-sent", () => {
  const OVER = "prompt is too long: 210000 tokens > 200000 maximum";

  function overflowing() {
    const gw = {
      calls: 0,
      inferStream: async function* () {
        gw.calls++;
        yield { type: "error", error: OVER };
      },
    } as any;
    return gw;
  }

  function engine(compacted: boolean) {
    return {
      buildPrompt: (system: string, _tools: unknown[], messages: Message[]) => ({
        messages,
        system,
        tools: [],
        totalTokens: 1,
        evictedCount: 0,
      }),
      noteRealUsage: () => {},
      shouldCompact: () => false,
      compactWorkingSet: async (messages: Message[]) => ({ messages, compacted }),
    } as unknown as ContextEngine;
  }

  function endsNamed(events: AgentTurnEvent[]) {
    const fatal = events.find((e) => e.type === "error" && e.recoverable === false) as
      Extract<AgentTurnEvent, { type: "error" }> | undefined;
    expect(fatal?.error).toContain("no longer fits this model's context window");
    expect(fatal?.error).toContain(OVER);
    const last = events.at(-1) as Extract<AgentTurnEvent, { type: "turn_complete" }>;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("max_tokens");
  }

  test("with nothing to compact, the run ends named after one refusal", async () => {
    const gw = overflowing();
    const events = await collect(
      loopWith(gw, { contextEngine: engine(false) }).run("go", "s1", "/ws"),
    );
    expect(gw.calls).toBe(1);
    endsNamed(events);
  });

  test("with no context engine at all, the same", async () => {
    const gw = overflowing();
    const events = await collect(loopWith(gw).run("go", "s1", "/ws"));
    expect(gw.calls).toBe(1);
    endsNamed(events);
  });

  test("when compaction has had its tries, the next refusal ends it", async () => {
    // Each compaction changes the prompt, so each re-send is a new request;
    // once the two tries are spent, the third refusal is not re-sent.
    const gw = overflowing();
    const events = await collect(
      loopWith(gw, { contextEngine: engine(true) }).run("go", "s1", "/ws"),
    );
    expect(gw.calls).toBe(3);
    endsNamed(events);
  });

  test("an ordinary failure still takes the ordinary retry", async () => {
    let calls = 0;
    const gw = {
      inferStream: async function* () {
        calls++;
        if (calls === 1) {
          yield { type: "error", error: "upstream connect error" };
          return;
        }
        yield textDelta("fine");
        yield stopEvent();
      },
    } as any;
    const events = await collect(loopWith(gw).run("go", "s1", "/ws"));
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error" && e.recoverable === false)).toBe(false);
  });
});
