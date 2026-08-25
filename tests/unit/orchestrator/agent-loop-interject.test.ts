/**
 * Mid-turn steering (interjections): messages the user sends WHILE a run is in
 * flight are folded into the conversation at the next turn boundary.
 *  - format/parse round-trip (the engine persists the RAW text from the wrapper)
 *  - interject during tool execution → user message lands after the tool
 *    results, before the next model call, with a folded-in notice
 *  - interject while the model is finishing → the run does NOT end; the loop
 *    continues and the model answers the new message
 *  - a queued interjection before the first model call is seen by the model
 */

import { describe, test, expect, mock } from "bun:test";
import {
  AgentLoop,
  INTERJECTION_MARKER,
  formatInterjection,
  parseInterjection,
} from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

/** Gateway that plays a scripted list of turns (tool_use or final text). */
function makeScriptedGateway(turns: Array<{ tool?: string; text?: string }>) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
    }),
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
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gateway: any) {
  return new AgentLoop(
    { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 10, systemPrompt: "s" },
    gateway,
    makeRegistry(),
  );
}

const textOf = (m: { content: Array<{ type: string; text?: string }> }): string => {
  const b = m.content.find((x) => x.type === "text");
  return b && "text" in b ? (b.text ?? "") : "";
};

describe("interjection format/parse", () => {
  test("round-trips the raw text", () => {
    const wrapped = formatInterjection(["use postgres instead", "and add tests"]);
    expect(wrapped.startsWith(INTERJECTION_MARKER)).toBe(true);
    expect(parseInterjection(wrapped)).toBe("use postgres instead\n\nand add tests");
  });

  test("returns null for ordinary and synthetic messages", () => {
    expect(parseInterjection("just a normal user turn")).toBeNull();
    expect(parseInterjection("[Earlier conversation summary]\nstuff")).toBeNull();
    expect(
      parseInterjection("Automated verification failed after your changes. Fix the problems"),
    ).toBeNull();
  });
});

describe("AgentLoop — mid-turn steering", () => {
  test("interject during a tool turn folds in before the next model call", async () => {
    const gateway = makeScriptedGateway([{ tool: "read_file" }, { text: "done" }]);
    const loop = makeLoop(gateway);
    const events: AgentTurnEvent[] = [];
    let interjected = false;
    for await (const e of loop.run("build the app", "s", "/ws")) {
      events.push(e);
      if (!interjected && e.type === "tool_call_end") {
        loop.interject("also add dark mode");
        interjected = true;
      }
    }

    // The interjection sits AFTER the tool results, BEFORE the final answer.
    const messages = loop.getMessages();
    const toolIdx = messages.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBeGreaterThan(0);
    const injected = messages[toolIdx + 1];
    expect(injected.role).toBe("user");
    expect(textOf(injected).startsWith(INTERJECTION_MARKER)).toBe(true);
    expect(parseInterjection(textOf(injected))).toBe("also add dark mode");

    // The user was told it landed, and the run completed normally.
    expect(events.some((e) => e.type === "notice" && /folded into/i.test(e.message))).toBe(true);
    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    >;
    expect(complete?.stopReason).toBe("end_turn");
  });

  test("interject while the model is finishing → the run continues instead of ending", async () => {
    const gateway = makeScriptedGateway([{ text: "half done" }, { text: "fully done" }]);
    const loop = makeLoop(gateway);
    const events: AgentTurnEvent[] = [];
    let interjected = false;
    for await (const e of loop.run("do the thing", "s", "/ws")) {
      events.push(e);
      if (!interjected && e.type === "text_delta") {
        loop.interject("wait — also cover the edge cases");
        interjected = true;
      }
    }

    // Two model rounds: the finish was refused, the interjection folded in,
    // and the model answered again.
    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    >;
    expect(complete?.totalTurns).toBe(2);

    const messages = loop.getMessages();
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    // Order: assistant("half done") → user(interjection) → assistant("fully done").
    const interIdx = messages.findIndex(
      (m) => m.role === "user" && textOf(m).startsWith(INTERJECTION_MARKER),
    );
    const firstAssistant = messages.findIndex((m) => m.role === "assistant");
    expect(interIdx).toBeGreaterThan(firstAssistant);
    expect(messages[interIdx + 1]?.role).toBe("assistant");
    expect(loop.hasPendingInterjections()).toBe(false);
  });

  test("an interjection queued before the first model call is folded in", async () => {
    const gateway = makeScriptedGateway([{ text: "done" }]);
    const loop = makeLoop(gateway);
    loop.interject("one more constraint: no external deps");
    const events: AgentTurnEvent[] = [];
    for await (const e of loop.run("start", "s", "/ws")) events.push(e);

    const messages = loop.getMessages();
    expect(messages[0].role).toBe("user");
    expect(textOf(messages[0])).toBe("start");
    expect(messages[1].role).toBe("user");
    expect(parseInterjection(textOf(messages[1]))).toBe("one more constraint: no external deps");
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });

  test("blank interjections are ignored", () => {
    const loop = makeLoop(makeScriptedGateway([{ text: "x" }]));
    loop.interject("   ");
    expect(loop.hasPendingInterjections()).toBe(false);
  });

  test("abort before the next boundary leaves the interjection recoverable", async () => {
    // Interject AND abort while the first tool turn is finishing: the loop
    // returns "aborted" before the next drain point, so the message was never
    // folded in. takeUndrainedInterjections must hand it back (the engine
    // persists it as a user turn) — steering must never be silently lost.
    const gateway = makeScriptedGateway([{ tool: "read_file" }, { text: "done" }]);
    const loop = makeLoop(gateway);
    const controller = new AbortController();
    const events: AgentTurnEvent[] = [];
    for await (const e of loop.run("go", "s", "/ws", controller.signal)) {
      events.push(e);
      if (e.type === "tool_call_end") {
        loop.interject("actually, stop and use sqlite");
        controller.abort();
      }
    }

    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    >;
    expect(complete?.stopReason).toBe("aborted");
    // Never folded into the transcript…
    expect(
      loop
        .getMessages()
        .some((m) => m.role === "user" && textOf(m).startsWith(INTERJECTION_MARKER)),
    ).toBe(false);
    // …but recoverable exactly once.
    expect(loop.takeUndrainedInterjections()).toEqual(["actually, stop and use sqlite"]);
    expect(loop.takeUndrainedInterjections()).toEqual([]);
  });
});
