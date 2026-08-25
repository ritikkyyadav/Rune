/**
 * Phase-2 spine wiring: the loop feeds the TaskStateStore, re-injects it as an
 * ephemeral tail block, nudges plan discipline deterministically, counts
 * worker output as writes, hands off on ceilings, and folds harness notes in.
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

type Step = { tool?: string; args?: Record<string, unknown>; text?: string; result?: string };

/** Scripted gateway that also captures every request's messages. */
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

/** Registry where write/edit tools are writes, todo_write echoes its input. */
function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file", "edit_file", "multi_edit"].includes(name)
          ? "write"
          : name === "worker"
            ? "execute"
            : "read",
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

function makeLoop(gateway: any, taskState: TaskStateStore, opts: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: opts.maxTurns ?? 12,
      systemPrompt: "s",
      taskState,
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

const lastMessageText = (req: { messages: any[] }): string => {
  const m = req.messages[req.messages.length - 1];
  const b = m?.content?.find((x: any) => x.type === "text");
  return b?.text ?? "";
};

describe("task-state tail injection", () => {
  test("with todos recorded, every later request carries the ephemeral block — and the transcript does not", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "step one", status: "in_progress" }] },
      },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("do a multi step thing", "s1", "/tmp"));

    // Request 2 (after todo_write) ends with the injected block…
    expect(lastMessageText(gw.requests[1])).toContain("[Task state — maintained by the harness");
    expect(lastMessageText(gw.requests[1])).toContain("[>] step one");
    // …but the block is ephemeral: not in the stored transcript.
    const stored = loop.getMessages();
    const anyStoredBlock = stored.some((m) =>
      m.content.some((b: any) => b.type === "text" && b.text.includes("[Task state —")),
    );
    expect(anyStoredBlock).toBe(false);
  });

  test("no todos → no block, no cost", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([{ tool: "read_file", args: { path: "a.ts" } }, { text: "answer" }]);
    await collect(makeLoop(gw, ts).run("what is in a.ts?", "s1", "/tmp"));
    for (const r of gw.requests) {
      expect(lastMessageText(r)).not.toContain("[Task state");
    }
  });
});

describe("plan-discipline nudge", () => {
  test("second distinct file written with no plan → exactly one harness note on that result", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "write_file", args: { path: "a.ts" } },
      { tool: "write_file", args: { path: "b.ts" } },
      { tool: "write_file", args: { path: "c.ts" } },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("build the thing", "s1", "/tmp"));
    const transcript = loop.getMessages();
    const nudges = transcript.flatMap((m) =>
      m.content.filter(
        (b: any) =>
          (b.type === "tool_result" || b.type === "text") &&
          String(b.toolResultContent ?? b.text ?? "").includes(
            "editing files with no recorded plan",
          ),
      ),
    );
    expect(nudges).toHaveLength(1);
  });

  test("a single-file fix never trips the nudge", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([{ tool: "write_file", args: { path: "only.ts" } }, { text: "done" }]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("fix the typo", "s1", "/tmp"));
    const transcript = JSON.stringify(loop.getMessages());
    expect(transcript).not.toContain("no recorded plan");
  });

  test("a recorded plan suppresses the nudge entirely", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ content: "x", status: "in_progress" }] } },
      { tool: "write_file", args: { path: "a.ts" } },
      { tool: "write_file", args: { path: "b.ts" } },
      { tool: "write_file", args: { path: "c.ts" } },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("build", "s1", "/tmp"));
    expect(JSON.stringify(loop.getMessages())).not.toContain("no recorded plan");
  });
});

describe("worker output counts as writes", () => {
  test("a successful worker run triggers verification like a direct write", async () => {
    const ts = new TaskStateStore();
    const verify = mock(async () => ({ ran: true, passed: true, report: "ok" }));
    const gw = makeGateway([
      { tool: "worker", args: { files: ["src/x.ts", "src/y.ts"], prompt: "build" } },
      { text: "done" },
    ]);
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 8,
        systemPrompt: "s",
        taskState: ts,
        verifier: { verify } as any,
      } as any,
      gw,
      makeRegistry(),
    );
    const events = await collect(loop.run("big build", "s1", "/tmp"));
    expect(verify.mock.calls.length).toBe(1);
    expect(events.some((e) => e.type === "verification_completed")).toBe(true);
    // And the worker's files entered the spine ledger.
    expect(ts.snapshot().filesWritten).toEqual(["src/x.ts", "src/y.ts"]);
  });
});

describe("handoff", () => {
  test("hitting max turns with open todos emits a state-of-work handoff", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "todo_write", args: { items: [{ content: "never finishes", status: "pending" }] } },
      { tool: "read_file", args: { path: "a.ts" } }, // loops forever on varied reads
      { tool: "read_file", args: { path: "b.ts" } },
      { tool: "read_file", args: { path: "c.ts" } },
      { tool: "read_file", args: { path: "d.ts" } },
    ]);
    const loop = makeLoop(gw, ts, { maxTurns: 4 });
    const events = await collect(loop.run("endless task", "s1", "/tmp"));
    const handoff = events.find((e) => e.type === "handoff") as any;
    expect(handoff).toBeDefined();
    expect(handoff.reason).toBe("max_turns");
    expect(handoff.state).toContain("never finishes");
    expect(ts.snapshot().handoff?.reason).toBe("max_turns");
    // The handoff precedes the terminal turn_complete.
    const order = events.map((e) => e.type);
    expect(order.indexOf("handoff")).toBeLessThan(order.lastIndexOf("turn_complete"));
  });
});

describe("harness notes (struggle → live run)", () => {
  test("an injected note lands in the next request and announces replanning", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tool: "read_file", args: { path: "a.ts" } },
      { tool: "read_file", args: { path: "b.ts" } },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    const gen = loop.run("task", "s1", "/tmp");
    const events: AgentTurnEvent[] = [];
    let injected = false;
    for await (const e of gen) {
      events.push(e);
      if (!injected && e.type === "tool_call_end") {
        injected = true;
        loop.injectHarnessNote("Stop editing this file; reconsider the approach.", {
          replanReason: "repeated edits to the same file",
        });
      }
    }
    const replan = events.find((e) => e.type === "replanning") as any;
    expect(replan?.trigger).toBe("struggle");
    const transcript = JSON.stringify(loop.getMessages());
    expect(transcript).toContain("[Harness note] Stop editing this file");
  });
});
