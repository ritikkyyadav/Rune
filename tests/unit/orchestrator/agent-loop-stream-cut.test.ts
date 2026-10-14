/**
 * A response cut after it finished tool calls keeps them (R2 of
 * docs/program/rune-reliability-plan-20261014.md). The gateway ends such a
 * stream with `message_cut` when the loop asks it to; the loop runs every
 * call the response finished, drops the one it did not, and continues from
 * there. Until now the whole response was re-streamed from zero — a long
 * think or a long file paid for twice, and sometimes a third time.
 */

import { describe, expect, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function text(index: number, t: string) {
  return [
    { type: "content_start", contentIndex: index },
    { type: "content_delta", contentIndex: index, delta: { type: "text_delta", text: t } },
    { type: "content_stop", contentIndex: index },
  ];
}

function call(id: string, input: Record<string, unknown>) {
  return [
    { type: "tool_use_start", toolCallId: id, toolName: "read_file" },
    { type: "tool_use_delta", toolCallId: id, partialJson: JSON.stringify(input) },
    { type: "tool_use_stop", toolCallId: id, toolInput: input },
  ];
}

const CUT = { type: "message_cut", reason: "stream stalled — no data for 120s", completedCalls: 0 };

/** First call: `first`. Every call after: a plain answer. */
function gateway(first: unknown[]) {
  const gw = {
    calls: 0,
    requests: [] as any[],
    opts: [] as any[],
    inferStream: async function* (req: unknown, opts: unknown) {
      gw.calls++;
      gw.requests.push(JSON.parse(JSON.stringify(req)));
      gw.opts.push(opts);
      if (gw.calls === 1) {
        yield* first as any[];
        return;
      }
      yield* text(0, "Both files read.");
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } as any;
  return gw;
}

function registry() {
  const executed: string[] = [];
  const reg = {
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
    execute: async (i: { toolName: string; callId: string }) => {
      executed.push(i.callId);
      return {
        callId: i.callId,
        toolName: i.toolName,
        success: true,
        result: "file contents",
        durationMs: 1,
      };
    },
  } as any;
  return reg;
}

async function run(first: unknown[]) {
  const gw = gateway(first);
  const reg = registry();
  const loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 10,
      maxConsecutiveErrors: 1,
      systemPrompt: "s",
      suspendClock: false,
    } as any,
    gw,
    reg,
  );
  const events = await collect(loop.run("read a.ts and b.ts", "s1", "/tmp"));
  return { gw, reg, events };
}

const notices = (events: AgentTurnEvent[]) =>
  events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message);

describe("a response cut after finished tool calls", () => {
  test("runs the finished call, drops the unfinished one, and continues", async () => {
    const { gw, reg, events } = await run([
      ...text(0, "Reading both files."),
      ...call("call-kept", { path: "a.ts" }),
      { type: "tool_use_start", toolCallId: "call-cut", toolName: "read_file" },
      { type: "tool_use_delta", toolCallId: "call-cut", partialJson: '{"pa' },
      { ...CUT, completedCalls: 1 },
    ]);

    expect(reg.executed).toEqual(["call-kept"]);
    expect(notices(events)).toContain(
      "The response was cut after 1 finished tool call — running it and continuing.",
    );
    // One cut response and one answer: nothing re-sent from zero.
    expect(gw.calls).toBe(2);
    const last = events.at(-1) as any;
    expect(last.type).toBe("turn_complete");
    expect(last.stopReason).toBe("end_turn");
  });

  test("the next request carries the kept call and its result, and never the cut one", async () => {
    const { gw } = await run([
      ...text(0, "Reading both files."),
      ...call("call-kept", { path: "a.ts" }),
      { type: "tool_use_start", toolCallId: "call-cut", toolName: "read_file" },
      { ...CUT, completedCalls: 1 },
    ]);
    const second = JSON.stringify(gw.requests[1].messages);
    expect(second).toContain("call-kept");
    expect(second).toContain("file contents");
    expect(second).toContain("Reading both files.");
    expect(second).not.toContain("call-cut");
  });

  test("text after the last finished call is dropped with the cut", async () => {
    const { gw, reg, events } = await run([
      ...call("first", { path: "a.ts" }),
      ...text(1, "and the second one"),
      ...call("second", { path: "b.ts" }),
      ...text(3, "a trailing half sent"),
      { ...CUT, completedCalls: 2 },
    ]);
    expect(reg.executed).toEqual(["first", "second"]);
    expect(notices(events)).toContain(
      "The response was cut after 2 finished tool calls — running them and continuing.",
    );
    const second = JSON.stringify(gw.requests[1].messages);
    expect(second).toContain("and the second one");
    expect(second).not.toContain("a trailing half sent");
  });

  test("the loop asks the gateway to keep finished calls", async () => {
    const { gw } = await run([
      ...call("call-kept", { path: "a.ts" }),
      { ...CUT, completedCalls: 1 },
    ]);
    expect(gw.opts[0]?.keepCompletedOnCut).toBe(true);
  });
});
