/**
 * Run economics: the two deterministic pacing mechanisms added after the
 * evolab4 post-mortem (101 requests at ~1.7 tool calls each, quota death at
 * hour four with verification still "none"):
 *
 *  - batching nudge: four consecutive single-read turns earn ONE note that
 *    independent reads execute in parallel when batched.
 *  - wrap-up reserve: past ~85% of the turn budget with todos still open, the
 *    remaining turns are directed at closing and verifying, once.
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

type Step = { tools?: Array<{ name: string; args?: Record<string, unknown> }>; text?: string };

function makeGateway(turns: Step[]) {
  let i = 0;
  const requests: Array<{ messages: any[] }> = [];
  return {
    requests,
    inferStream: mock(async function* (req: any) {
      requests.push({ messages: req.messages });
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k].name });
          yield ev("tool_use_stop", { toolCallId: `c${i}-${k}`, toolInput: t.tools[k].args ?? {} });
        }
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
        category: ["write_file", "edit_file", "multi_edit"].includes(name)
          ? "write"
          : name === "bash"
            ? "execute"
            : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      // Distinct files read distinctly: the results-side progress breaker
      // counts a turn whose every result was already seen as stale, and a
      // stub answering "ok" to every path would read as a stalled run.
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : `ok: ${String(input.args?.path ?? input.args?.command ?? "")}`,
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

const transcriptText = (loop: AgentLoop): string => JSON.stringify(loop.getMessages());
const read = (path: string): Step => ({ tools: [{ name: "read_file", args: { path } }] });

describe("batching nudge", () => {
  test("four consecutive single-read turns → exactly one note, on the fourth result", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      read("a.ts"),
      read("b.ts"),
      read("c.ts"),
      read("d.ts"),
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("map the subsystem", "s1", "/tmp"));
    const t = transcriptText(loop);
    expect(t).toContain("execute in PARALLEL");
    expect(t.split("execute in PARALLEL").length - 1).toBe(1);
  });

  test("batched reads never trip it", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      {
        tools: [
          { name: "read_file", args: { path: "a.ts" } },
          { name: "read_file", args: { path: "b.ts" } },
        ],
      },
      {
        tools: [
          { name: "read_file", args: { path: "c.ts" } },
          { name: "read_file", args: { path: "d.ts" } },
        ],
      },
      {
        tools: [
          { name: "read_file", args: { path: "e.ts" } },
          { name: "read_file", args: { path: "f.ts" } },
        ],
      },
      {
        tools: [
          { name: "read_file", args: { path: "g.ts" } },
          { name: "read_file", args: { path: "h.ts" } },
        ],
      },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("map the subsystem", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("execute in PARALLEL");
  });

  test("a write in the streak resets it", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      read("a.ts"),
      read("b.ts"),
      { tools: [{ name: "write_file", args: { path: "x.ts" } }] },
      read("c.ts"),
      read("d.ts"),
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("small fix task", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("execute in PARALLEL");
  });
});

describe("wrap-up reserve", () => {
  test("past 85% of the budget with open todos → one close-out directive", async () => {
    const ts = new TaskStateStore();
    const steps: Step[] = [
      {
        tools: [
          {
            name: "todo_write",
            args: { items: [{ content: "never done", status: "in_progress" }] },
          },
        ],
      },
    ];
    for (let k = 0; k < 17; k++) steps.push(read(`file-${k}.ts`));
    steps.push({ text: "final answer" });
    const gw = makeGateway(steps);
    const loop = makeLoop(gw, ts, { maxTurns: 20 });
    const events = await collect(loop.run("a long build", "s1", "/tmp"));
    const t = transcriptText(loop);
    expect(t).toContain("Budget reserve");
    expect(t.split("Budget reserve").length - 1).toBe(1);
    expect(
      events.some((e) => e.type === "notice" && String((e as any).message).includes("close out")),
    ).toBe(true);
  });

  test("no open todos → no reserve directive", async () => {
    const ts = new TaskStateStore();
    const steps: Step[] = [];
    for (let k = 0; k < 18; k++) steps.push(read(`file-${k}.ts`));
    steps.push({ text: "answer" });
    const gw = makeGateway(steps);
    const loop = makeLoop(gw, ts, { maxTurns: 20 });
    await collect(loop.run("a long investigation", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("Budget reserve");
  });

  test("one SURVIVED rate/quota 429 arms the reserve immediately, at any turn count", async () => {
    // evolab6 pinned this: quota killed the run at turn 64 of 80, so a reserve
    // keyed on turns alone protected nothing. The first survived wall sighting
    // is the only advance warning a subscription quota gives.
    const ts = new TaskStateStore();
    let call = 0;
    const gw = {
      inferStream: mock(async function* () {
        call++;
        if (call === 1) {
          yield ev("tool_use_start", { toolCallId: "t1", toolName: "todo_write" });
          yield ev("tool_use_stop", {
            toolCallId: "t1",
            toolInput: { items: [{ content: "big open step", status: "in_progress" }] },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
          return;
        }
        if (call === 2) {
          yield ev("error", {
            error: "All providers rate limited — retry in 1s",
            retryable: false,
          });
          return;
        }
        yield ev("content_delta", { delta: { type: "text_delta", text: "closing out" } });
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
    const loop = makeLoop(gw, ts, { maxTurns: 40, maxRateWaits: 2 });
    const events = await collect(loop.run("a long build", "s1", "/tmp"));
    const t = transcriptText(loop);
    expect(t).toContain("Budget reserve");
    expect(t).toContain("rate/quota wall");
    expect(
      events.some(
        (e) => e.type === "notice" && String((e as any).message).includes("rate limited"),
      ),
    ).toBe(true);
    // rateLimitWaitSecs floors the wait at 5s, so this test sleeps a real
    // five seconds — exactly bun's default timeout. Give it room.
  }, 20_000);

  test("small budgets (sub-agent scale) never get the reserve", async () => {
    const ts = new TaskStateStore();
    const steps: Step[] = [
      {
        tools: [
          { name: "todo_write", args: { items: [{ content: "open", status: "in_progress" }] } },
        ],
      },
    ];
    for (let k = 0; k < 12; k++) steps.push(read(`f-${k}.ts`));
    const gw = makeGateway(steps);
    const loop = makeLoop(gw, ts, { maxTurns: 12 });
    await collect(loop.run("bounded task", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("Budget reserve");
  });
});
