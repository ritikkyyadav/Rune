/**
 * The two finish gates added after the evolab4 post-mortem, both refuse-once:
 *
 *  - fix-verified: a fix-shaped task with a read-back brief may not finish with
 *    zero criteria at `verified` — reaching the rung IS authoring the check.
 *  - product-sight: a run that wrote visual files may not finish without ever
 *    looking at the result (browser tool ran, or an image reached the model).
 *
 * Both are bounded exactly like the execution/delegation gates: one refusal,
 * then the model proceeds — a gate must never become a kill chain.
 */

import { describe, test, expect, mock } from "bun:test";
import {
  AgentLoop,
  FIX_SHAPED_MAX_CHARS,
  isFixShaped,
} from "../../../packages/orchestrator/src/agent-loop";
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

/** Scripted gateway: each step is either one text reply or N tool calls. */
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
      result: "ok",
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
      maxTurns: 12,
      systemPrompt: "s",
      taskState,
      ...opts,
    } as any,
    gateway,
    makeRegistry(),
  );
}

const transcriptText = (loop: AgentLoop): string => JSON.stringify(loop.getMessages());

describe("fix-verified gate", () => {
  test("a fix-shaped task with an unverified brief is refused once, then may finish", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/date.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "all done" },
      { text: "done, criterion honestly short of verified" },
    ]);
    const loop = makeLoop(gw, ts, {
      ledgerStatus: () => ({ total: 2, verified: 0 }),
    });
    const events = await collect(loop.run("fix the date parsing bug", "s1", "/tmp"));
    expect(transcriptText(loop)).toContain("none of your done_when criteria reached");
    expect(
      events.some(
        (e) => e.type === "notice" && String((e as any).message).includes("verified check"),
      ),
    ).toBe(true);
    // Refused exactly once — the second finish attempt goes through.
    const refusals =
      transcriptText(loop).split("none of your done_when criteria reached").length - 1;
    expect(refusals).toBe(1);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  test("a verified criterion satisfies the gate — no refusal", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/date.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, {
      ledgerStatus: () => ({ total: 2, verified: 1 }),
    });
    await collect(loop.run("fix the date parsing bug", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("done_when criteria reached");
  });

  test("a non-fix goal never trips the gate, brief or not", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/feature.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, {
      ledgerStatus: () => ({ total: 2, verified: 0 }),
    });
    await collect(loop.run("add a settings page to the dashboard", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("done_when criteria reached");
  });

  test("no brief (ledgerStatus null) → gate silently inapplicable", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/date.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts, { ledgerStatus: () => null });
    await collect(loop.run("fix the date parsing bug", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("done_when criteria reached");
  });
});

describe("product-sight gate", () => {
  test("visual files written and never looked at → refused once, then may finish", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "web/index.html" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "shipped" },
      { text: "reviewed and shipped" },
    ]);
    const loop = makeLoop(gw, ts);
    const events = await collect(loop.run("build the landing page", "s1", "/tmp"));
    expect(transcriptText(loop)).toContain("never looked at it");
    const refusals = transcriptText(loop).split("never looked at it").length - 1;
    expect(refusals).toBe(1);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });

  test("a browser tool call counts as looking — no refusal", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "web/index.html" } }] },
      { tools: [{ name: "bash", args: { command: "bun run serve --check" } }] },
      { tools: [{ name: "mcp_browser_browser_snapshot", args: {} }] },
      { text: "reviewed, shipped" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("build the landing page", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("never looked at it");
  });

  test("non-visual work never trips the gate", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "src/core.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = makeLoop(gw, ts);
    await collect(loop.run("refactor the core module", "s1", "/tmp"));
    expect(transcriptText(loop)).not.toContain("never looked at it");
  });
});

describe("fix-shaped means short", () => {
  test("a long brief that mentions fixing defects is a build, not a fix — no gate", async () => {
    const ts = new TaskStateStore();
    const gw = makeGateway([
      { tools: [{ name: "write_file", args: { path: "a.ts" } }] },
      { tools: [{ name: "bash", args: { command: "bun test" } }] },
      { text: "done" },
    ]);
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 12,
        systemPrompt: "s",
        taskState: ts,
        ledgerStatus: () => ({ total: 2, verified: 0 }),
      } as any,
      gw,
      makeRegistry(),
    );
    const brief =
      "Build the laboratory end to end.\n" +
      "Fix scientific correctness defects before new features.\n".repeat(30);
    await collect(loop.run(brief, "s1", "/tmp"));
    expect(JSON.stringify(gw.requests)).not.toContain("this task is a FIX");
  });

  test("isFixShaped: short and fix-worded, nothing else", () => {
    expect(isFixShaped("fix the date parsing bug")).toBe(true);
    expect(isFixShaped("the login page is broken on mobile")).toBe(true);
    expect(isFixShaped("add a login page")).toBe(false);
    expect(isFixShaped("")).toBe(false);
    expect(isFixShaped("x".repeat(FIX_SHAPED_MAX_CHARS) + " fix it")).toBe(false);
  });
});
