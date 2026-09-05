/**
 * The art-direction question is asked at PLAN time, before the first screen
 * exists.
 *
 * The failure this pins (session 01a067b8): the first-write tripwire fired
 * only after index.html had been written — 4.8k output tokens, 30 s — and the
 * model then threw that page away and rewrote it to the direction the user
 * chose. Asking on the plan costs the same question and saves the page. The
 * note also stops pointing at a `skill` tool that is not registered in every
 * session ("Unknown tool: skill" cost the run a completion); it carries six
 * directions of its own.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop, planLooksVisual } from "../../../packages/orchestrator/src/agent-loop";
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
  return {
    inferStream: mock(async function* () {
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
    infer: mock(async () => ({ content: [], model: "m", stopReason: "end_turn", usage: {} })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
}

function makeRegistry(withAskUser = true) {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => {
      if (name === "ask_user" && !withAskUser) return undefined;
      return {
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", properties: {} },
          category: name === "write_file" ? "write" : "execute",
          permissionLevel: "auto",
        },
      };
    }),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result:
        input.toolName === "todo_write"
          ? JSON.stringify({ items: input.args.items })
          : JSON.stringify({ path: input.args.path ?? "x", hash: "h" }),
      durationMs: 1,
    })),
  } as any;
}

function makeLoop(gw: any, withAskUser = true) {
  const ts = new TaskStateStore();
  ts.beginTurn("prototype me a website for a sweet shop");
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      taskState: ts,
    } as any,
    gw,
    makeRegistry(withAskUser),
  );
}

function toolResultFor(loop: AgentLoop, callId: string): string {
  for (const m of loop.getMessages()) {
    if (m.role !== "tool") continue;
    for (const b of m.content as any[]) {
      if (b.type === "tool_result" && b.toolCallId === callId) return String(b.toolResultContent);
    }
  }
  return "";
}

const visualPlan: Step = {
  tool: "todo_write",
  args: {
    items: [{ content: "Scaffold index.html + styles.css for the shop", status: "in_progress" }],
  },
};
const write: Step = {
  tool: "write_file",
  args: { path: "shop/index.html", content: "<h1>hi</h1>" },
};

describe("planLooksVisual", () => {
  test("a creation verb within reach of a screen", () => {
    expect(planLooksVisual([{ content: "Build the landing page" }])).toBe(true);
    expect(planLooksVisual([{ content: "Write styles.css" }])).toBe(true);
    expect(planLooksVisual([{ content: "Scaffold index.html + styles.css for the shop" }])).toBe(
      true,
    );
    expect(planLooksVisual([{ content: "Design the checkout screen" }])).toBe(true);
  });
  test("no screen, or a screen that is not being created", () => {
    expect(planLooksVisual([{ content: "Parse the CSV" }, { content: "Add a CLI flag" }])).toBe(
      false,
    );
    // The noun alone used to fire on all four of these.
    expect(planLooksVisual([{ content: "Fix the settings screen flicker" }])).toBe(false);
    expect(planLooksVisual([{ content: "Expose the endpoint used by the UI" }])).toBe(false);
    expect(planLooksVisual([{ content: "Remove dead css from the build" }])).toBe(false);
    expect(planLooksVisual([{ content: "Migrate the dashboard query to Postgres" }])).toBe(false);
  });
});

describe("art direction at plan time", () => {
  test("a plan that names a screen gets the question on the plan, before any write", async () => {
    const gw = makeGateway([visualPlan, write, { text: "built" }]);
    const loop = makeLoop(gw);
    await collect(loop.run("prototype me a website", "s1", "/tmp"));

    const onPlan = toolResultFor(loop, "c1");
    expect(onPlan).toContain("its art direction is");
    expect(onPlan).toContain("Ask BEFORE the first screen is written");
    expect(onPlan).toContain("TWO OR THREE concrete");
    expect(onPlan).toContain("ask_user");
    // Self-sufficient: the six house directions travel with the note, and the
    // skill is named only as an option.
    expect(onPlan).toContain("If a `skill` tool is registered");
    expect(onPlan).toContain("Swiss");
    expect(onPlan).toContain("Bazaar");
    // Asked once: the first screen written afterwards is left alone.
    expect(toolResultFor(loop, "c2")).not.toContain("its art direction is");
  });

  test("a plan with no screen in it is none of its business", async () => {
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: { items: [{ content: "Parse the CSV", status: "in_progress" }] },
      },
      { text: "done" },
    ]);
    const loop = makeLoop(gw);
    await collect(loop.run("parse the csv", "s1", "/tmp"));
    expect(toolResultFor(loop, "c1")).not.toContain("its art direction is");
  });

  test("a fix-shaped request never gets the question, even when the plan builds a screen", async () => {
    const gw = makeGateway([
      {
        tool: "todo_write",
        args: {
          items: [
            {
              content: "Build the settings screen again without the flicker",
              status: "in_progress",
            },
          ],
        },
      },
      { text: "done" },
    ]);
    const loop = makeLoop(gw);
    await collect(loop.run("fix the broken settings screen", "s1", "/tmp"));
    expect(toolResultFor(loop, "c1")).not.toContain("its art direction is");
  });

  test("with no ask_user it stays quiet", async () => {
    const gw = makeGateway([visualPlan, { text: "done" }]);
    const loop = makeLoop(gw, false);
    await collect(loop.run("prototype me a website", "s1", "/tmp"));
    expect(toolResultFor(loop, "c1")).not.toContain("its art direction is");
  });
});
