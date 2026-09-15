/**
 * Phase 5 — the frontend loop, end to end through the real AgentLoop with a
 * scripted provider. Zero model calls.
 *
 * F2: a frontend run with no browser mounted says so on the FIRST turn, as a
 * notice to the person and as a note to the model, and the read-back's `leave`
 * carries the same sentence.
 */

import { describe, expect, test, mock } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../packages/orchestrator/src/task-state";
import { briefFromArgs } from "../../packages/orchestrator/src/brief";
import { NO_BROWSER_PREFLIGHT } from "../../packages/orchestrator/src/visual-verification";

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
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      if (t.tools && t.tools.length > 0) {
        for (let k = 0; k < t.tools.length; k++) {
          yield ev("tool_use_start", { toolCallId: `c${i}-${k}`, toolName: t.tools[k]!.name });
          yield ev("tool_use_stop", {
            toolCallId: `c${i}-${k}`,
            toolInput: t.tools[k]!.args ?? {},
          });
        }
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: t.text ?? "done" } });
        yield ev("message_stop", { stopReason: "end_turn" });
      }
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
  } as never;
}

/** A registry whose tool list either carries the browser MCP or does not. */
function makeRegistry(browser: boolean) {
  const names = ["write_file", "bash", "read_back", ...(browser ? ["mcp_browser_navigate"] : [])];
  return {
    toLlmTools: mock(() => []),
    list: mock(() => names.map((name) => ({ name }))),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: ["write_file"].includes(name) ? "write" : name === "bash" ? "execute" : "read",
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
  } as never;
}

function makeLoop(gateway: unknown, browser: boolean) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: "s",
      taskState: new TaskStateStore(),
    } as never,
    gateway as never,
    makeRegistry(browser) as never,
  );
}

describe("F2 — a run without a browser says so before it spends", () => {
  test("the limit is a first-turn notice and reaches the model before its first decision", async () => {
    const gw = makeGateway([{ text: "done" }]) as { inferStream: unknown };
    let firstRequest = "";
    const stream = gw.inferStream as (r: unknown) => AsyncGenerator<unknown>;
    gw.inferStream = async function* (request: unknown) {
      firstRequest ||= JSON.stringify(request);
      yield* stream(request);
    };
    const loop = makeLoop(gw, false);
    const events = await collect(loop.run("Build the settings screen", "noBrowser", "/tmp"));
    const notices = events.filter((e) => e.type === "notice") as Array<{ message: string }>;
    expect(notices.some((n) => n.message.includes(NO_BROWSER_PREFLIGHT))).toBe(true);
    // Before the first completion, not at the finish gate.
    expect(firstRequest).toContain(NO_BROWSER_PREFLIGHT);
    expect(firstRequest).toContain("`leave`");
  });

  test("a run WITH the browser mounted pays nothing for the pre-flight", async () => {
    const loop = makeLoop(makeGateway([{ text: "done" }]), true);
    const events = await collect(loop.run("Build the settings screen", "withBrowser", "/tmp"));
    const notices = events.filter((e) => e.type === "notice") as Array<{ message: string }>;
    expect(notices.some((n) => n.message.includes(NO_BROWSER_PREFLIGHT))).toBe(false);
    expect(JSON.stringify(loop.getMessages())).not.toContain(NO_BROWSER_PREFLIGHT);
  });

  test("a backend run with no browser pays nothing either", async () => {
    const loop = makeLoop(makeGateway([{ text: "done" }]), false);
    const events = await collect(loop.run("Fix the CSV parser's quote handling", "be", "/tmp"));
    expect(
      (events.filter((e) => e.type === "notice") as Array<{ message: string }>).some((n) =>
        n.message.includes(NO_BROWSER_PREFLIGHT),
      ),
    ).toBe(false);
  });

  test("the read-back's leave list carries the limit, once", () => {
    const brief = briefFromArgs(
      { reading: "r", leave: ["the API layer"], done_when: ["it renders"] },
      "build a screen",
      "2026-09-15T00:00:00.000Z",
      { preflight: [NO_BROWSER_PREFLIGHT] },
    );
    expect(brief.leave).toEqual(["the API layer", NO_BROWSER_PREFLIGHT]);

    // The model wrote it itself: not duplicated.
    const already = briefFromArgs(
      { reading: "r", leave: [`Screenshots — ${NO_BROWSER_PREFLIGHT}.`], done_when: ["x"] },
      "build a screen",
      "2026-09-15T00:00:00.000Z",
      { preflight: [NO_BROWSER_PREFLIGHT] },
    );
    expect(already.leave).toHaveLength(1);

    // No pre-flight: byte-identical to what every existing caller gets.
    expect(briefFromArgs({ reading: "r", leave: ["x"], done_when: ["y"] }, "q", "t").leave).toEqual(
      ["x"],
    );
  });
});
