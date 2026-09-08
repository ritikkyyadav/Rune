/**
 * The task-state tail block says plainly that it is not a message to answer.
 *
 * Measured (session 01a067b8, turn 3): the block, re-sent as a trailing user
 * message on every request, was answered on every request by a weak model —
 * "Reading the state… 3/6 done, peer in the same tree, two write_file calls
 * held…" opened roughly 45 of that turn's 80 completions. It reads like a
 * message because it arrives in the user role, so it now says what it is.
 *
 * Sending LESS of it between changes was tried and rejected: a one-line stub
 * dropped the plan and `agent-loop-endurance` caught it, because across 105
 * turns of compaction this block is the only surviving copy of the mission.
 * The invariant those two tests hold together is the point — every request
 * carries the goal and the plan, whatever else is in the block.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  const requests: Array<{ messages: any[] }> = [];
  return {
    requests,
    inferStream: mock(async function* (req: any) {
      requests.push({ messages: req.messages });
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: t.args ?? {} });
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
        category: name === "write_file" ? "write" : name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: input.toolName === "todo_write" ? JSON.stringify({ items: input.args.items }) : "ok",
      durationMs: 1,
    })),
  } as any;
}

const GOAL = "audit every artifact in the vault and preserve the findings";

function makeLoop(gw: any) {
  const ts = new TaskStateStore();
  ts.beginTurn(GOAL);
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 30,
      systemPrompt: "s",
      taskState: ts,
    } as any,
    gw,
    makeRegistry(),
  );
}

const lastText = (req: { messages: any[] }): string => {
  const m = req.messages[req.messages.length - 1];
  const b = m?.content?.find((x: any) => x.type === "text");
  return b?.text ?? "";
};

const plan: Step = {
  tool: "todo_write",
  args: { items: [{ content: "inspect the vault manifest", status: "in_progress" }] },
};
// Distinct commands: three identical calls in a row trip the loop detector.
let n = 0;
const run = (): Step => ({
  tool: "bash",
  args: { command: ["ls", "pwd", "date", "uname"][n++ % 4] },
});

describe("the task-state tail block", () => {
  test("says plainly that it is harness state, not something to answer", async () => {
    const gw = makeGateway([plan, { text: "done" }]);
    await collect(makeLoop(gw).run(GOAL, "s1", "/tmp"));
    const block = lastText(gw.requests[1]);
    expect(block).toContain("[Task state — maintained by the harness");
    expect(block).toContain("not a message to answer");
    expect(block).toContain("never acknowledge, restate, or narrate it");
    // State is data: no imperative the model could echo as its opening line.
    expect(block).not.toMatch(/\bAct on\b|continue from|re-?submit|Just do the work/i);
  });

  test("every request after a plan carries the goal and the plan", async () => {
    const gw = makeGateway([plan, run(), run(), { text: "done" }]);
    await collect(makeLoop(gw).run(GOAL, "s1", "/tmp"));

    // Requests 1..n all follow the todo_write, so each must carry the spine.
    for (const req of gw.requests.slice(1)) {
      const block = lastText(req);
      expect(block).toContain(GOAL);
      expect(block).toContain("inspect the vault manifest");
      expect(block).toContain("not a message to answer");
    }
  });

  test("the block stays out of the stored transcript", async () => {
    const gw = makeGateway([plan, { text: "done" }]);
    const loop = makeLoop(gw);
    await collect(loop.run(GOAL, "s1", "/tmp"));
    const stored = loop
      .getMessages()
      .some((m: any) =>
        (m.content as any[]).some((b) => b.type === "text" && b.text?.includes("[Task state —")),
      );
    expect(stored).toBe(false);
  });
});
