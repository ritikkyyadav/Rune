/**
 * The loop detector watches results, not only arguments.
 *
 * Keyed on tool + arguments (+ writes since the last try), a poll whose
 * answer changed every time still read as a repeat, and a run that varied
 * its calls while the identical answer came back 29 times (evolab3, `team
 * status`) read as progress. Now a repeated call trips only when its result
 * was also the same the last two times; and the same substantive result
 * coming back four times, whatever the calls, earns one nudge — never a bail.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Script = Array<{ tool: string; args: Record<string, unknown> } | "text">;

function makeGateway(script: Script) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step === "text") {
        yield ev("content_delta", { delta: { type: "text_delta", text: "Done." } });
        yield ev("message_stop", { stopReason: "end_turn" });
        return;
      }
      yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: step.tool });
      yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: step.args });
      yield ev("message_stop", { stopReason: "tool_use" });
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

function makeRegistry(resultFor: (call: number, tool: string) => string) {
  let n = 0;
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "bash" ? "execute" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string; args: any }) => {
      n++;
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: resultFor(n, input.toolName),
        durationMs: 1,
      };
    }),
  } as any;
}

function makeLoop(gateway: any, registry: any, opts: Record<string, unknown> = {}) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      effortRouting: "off",
      ...opts,
    } as any,
    gateway,
    registry,
  );
}

const SAME = "the same forty-plus characters of output, every single time it runs";

describe("loop detector keyed on results", () => {
  test("an identical poll whose answer keeps changing is progress, not a loop", async () => {
    const poll = { tool: "bash", args: { command: "tail -n 5 build.log" } };
    const incidents: string[] = [];
    const loop = makeLoop(
      makeGateway([poll, poll, poll, poll, poll, "text"]),
      makeRegistry((n) => `${SAME}\nline ${n}: compiling module number ${n * 7}`),
      { onIncident: (i: any) => incidents.push(i.class) },
    );
    const events = await collect(loop.run("watch the build", "s1", "/tmp"));
    expect(incidents).not.toContain("loop.stuck_nudge");
    expect(incidents).not.toContain("loop.infinite_loop");
    expect(incidents).not.toContain("loop.result_loop");
    const last = events[events.length - 1] as any;
    expect(last.stopReason).toBe("end_turn");
    expect(last.totalTurns).toBe(6);
  });

  test("an identical call with the identical answer is still a rut — nudged, then bailed", async () => {
    const same = { tool: "bash", args: { command: "git status" } };
    const incidents: string[] = [];
    const loop = makeLoop(
      makeGateway([same, same, same, same, same, same, "text"]),
      makeRegistry(() => SAME),
      { onIncident: (i: any) => incidents.push(i.class) },
    );
    const events = await collect(loop.run("check the tree", "s1", "/tmp"));
    expect(incidents).toContain("loop.stuck_nudge");
    expect(incidents).toContain("loop.infinite_loop");
    expect(events.some((e) => e.type === "error" && (e as any).recoverable === false)).toBe(true);
  });

  test("the same answer to four different calls earns one nudge and never a bail", async () => {
    const script: Script = [
      { tool: "read_file", args: { path: "a.ts" } },
      { tool: "list_dir", args: { path: "src" } },
      { tool: "glob", args: { pattern: "**/*.ts" } },
      { tool: "read_file", args: { path: "b.ts" } },
      { tool: "read_file", args: { path: "c.ts" } },
      "text",
    ];
    const incidents: string[] = [];
    const notes: string[] = [];
    const loop = makeLoop(
      makeGateway(script),
      makeRegistry(() => SAME),
      {
        onIncident: (i: any) => incidents.push(i.class),
      },
    );
    const events = await collect(loop.run("look around", "s1", "/tmp"));
    for (const m of (loop as any).messages ?? []) {
      if (m.role === "user") for (const b of m.content) if (b.type === "text") notes.push(b.text);
    }
    expect(incidents.filter((c) => c === "loop.result_loop")).toHaveLength(1);
    expect(incidents).not.toContain("loop.infinite_loop");
    expect(incidents).toContain("loop.turn_refunded");
    expect(notes.some((t) => /identical|not changing/i.test(t))).toBe(true);
    const last = events[events.length - 1] as any;
    expect(last.stopReason).toBe("end_turn");
  });
});
