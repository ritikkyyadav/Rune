/**
 * Halt handling and the barren-turn breaker.
 *
 * The behavior these pin against, observed in one EvoLab build (session
 * 01a04c74, 2026-08-29): a background safety supervisor flagged `npm audit`
 * after it ran and latched a run-wide halt. Every later tool call — including
 * `todo_write`, which has no blast radius at all — came back with the same
 * denial sentence. The denial told the agent "no further tool calls will run
 * this turn"; nothing enforced that, so the loop kept serving turns and the
 * agent kept calling tools. Three separate runs died that way, ~10 wasted
 * turns each, at ~197k re-sent context per turn, until a generic
 * call-signature loop detector finally noticed.
 *
 * The contract now:
 *  - a halt buys exactly ONE more turn, offered no tools, for a final report;
 *  - that turn ends the run (stopReason "halted") — no verifier, no evidence
 *    gate, no interjection fold-in, all of which push toward tool use;
 *  - the report turn is owed even when the turn budget just ran out;
 *  - independently, three turns in which EVERY call was refused before running
 *    stop the run, because nothing executed and retrying cannot help;
 *  - a refusal a PERSON made never counts toward that, and neither does a turn
 *    that actually ran something.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

type Step = { tool?: string; args?: Record<string, unknown>; text?: string };

/** Records the tools advertised on every request, so "offered none" is testable. */
type Recorder = { toolsPerRequest: Array<number | undefined>; requests: number };

function makeGateway(turns: Step[], rec: Recorder) {
  let i = 0;
  return {
    inferStream: mock(async function* (request: { tools?: unknown[] }) {
      rec.requests++;
      rec.toolsPerRequest.push(request?.tools === undefined ? undefined : request.tools.length);
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", {
          toolCallId: `c${i}`,
          toolInput: t.args ?? { path: `f${i}.txt` },
        });
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

function makeRegistry(executed: string[]) {
  return {
    // One advertised tool, so "tools were withheld" is distinguishable from
    // "there were never any tools".
    toLlmTools: mock(() => [{ name: "bash", description: "", inputSchema: {} }]),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : "read",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => {
      executed.push(input.toolName);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        result: "ok",
        durationMs: 1,
      };
    }),
  } as any;
}

function makeLoop(
  gateway: any,
  permissionCheck?: any,
  opts: Record<string, unknown> = {},
  executed: string[] = [],
) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      ...opts,
    } as any,
    gateway,
    makeRegistry(executed),
    permissionCheck,
  );
}

const HALT_REASON = "The safety supervisor flagged the preceding bash action after it ran.";

/** Denies everything and reports a latched halt, exactly as the engine does. */
const haltingCheck = () =>
  mock(async () => ({
    allowed: false,
    halt: { reason: HALT_REASON },
    reason: `Auto mode halted this run: ${HALT_REASON} No further tool calls will run this turn.`,
  }));

// ─── The halt buys one report turn, then ends the run ───

describe("a halted run reports once and stops", () => {
  test("one tool-free turn, then turn_complete with stopReason 'halted'", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    // The model would keep calling tools forever if the loop let it — every
    // scripted turn after the first is another tool call.
    const gateway = makeGateway(
      [{ tool: "bash" }, { tool: "bash" }, { tool: "bash" }, { tool: "bash" }],
      rec,
    );
    const loop = makeLoop(gateway, haltingCheck());

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(complete.stopReason).toBe("halted");
    // Turn 1 proposed the call and was halted; turn 2 is the report. Nothing more.
    expect(rec.requests).toBe(2);
    expect(complete.totalTurns).toBe(2);
  });

  test("the report turn is offered no tools at all", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway([{ tool: "bash" }, { text: "here is what happened" }], rec),
      haltingCheck(),
    );

    await collect(loop.run("build it", "s1", "/tmp"));

    // First request advertised the toolbelt; the report request had none.
    expect(rec.toolsPerRequest[0]).toBe(1);
    expect(rec.toolsPerRequest[1]).toBeUndefined();
  });

  test("provider-side web search is off on the report turn too", async () => {
    // Taking the toolbelt away is pointless if native grounding leaves the
    // model a network reach it never had to ask for.
    const seen: Array<boolean | undefined> = [];
    const gateway = {
      inferStream: mock(async function* (request: { enableWebSearch?: boolean }) {
        seen.push(request?.enableWebSearch);
        if (seen.length === 1) {
          yield ev("tool_use_start", { toolCallId: "c1", toolName: "bash" });
          yield ev("tool_use_stop", { toolCallId: "c1", toolInput: {} });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "report" } });
          yield ev("message_stop", { stopReason: "end_turn" });
        }
      }),
      infer: mock(async () => ({ content: [], model: "t", stopReason: "end_turn", usage: {} })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getTotalCost: mock(() => 0),
    } as any;
    const loop = makeLoop(gateway, haltingCheck(), {
      nativeGrounding: true,
      provider: "google",
    });

    await collect(loop.run("build it", "s1", "/tmp"));
    expect(seen[1]).toBeUndefined();
  });

  test("the agent is told it is halted, in its own transcript", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(makeGateway([{ tool: "bash" }, { text: "report" }], rec), haltingCheck());

    await collect(loop.run("build it", "s1", "/tmp"));

    const text = loop
      .takePendingPersist()
      .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
      .map((b: any) => (b?.type === "text" ? b.text : ""))
      .join("\n");
    expect(text).toContain("HALTED");
    expect(text).toContain(HALT_REASON);
    // It must ask for a report, not for a workaround.
    expect(text).toContain("did NOT finish");
  });

  test("no tool ever executes after the halt", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const executed: string[] = [];
    const loop = makeLoop(
      makeGateway([{ tool: "bash" }, { tool: "bash" }, { text: "report" }], rec),
      haltingCheck(),
      {},
      executed,
    );

    await collect(loop.run("build it", "s1", "/tmp"));
    expect(executed).toEqual([]);
  });

  test("the report turn is granted even when the turn budget is spent", async () => {
    // maxTurns: 1 — the halt lands on the last turn the budget allows. A run
    // that halts at its ceiling still owes the user an account of itself.
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway([{ tool: "bash" }, { text: "report" }], rec),
      haltingCheck(),
      {
        maxTurns: 1,
      },
    );

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(complete.stopReason).toBe("halted");
    expect(rec.requests).toBe(2);
  });

  test("the verifier never runs on a halted turn", async () => {
    // The verifier and the evidence gate both exist to push the agent back
    // toward tool use. On a halted run that is the one thing not to do.
    const verify = mock(async () => ({ ran: true, passed: false, report: "tests failed" }));
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway([{ tool: "write_file" }, { text: "report" }], rec),
      haltingCheck(),
      { verifier: { verify } },
    );

    await collect(loop.run("build it", "s1", "/tmp"));
    expect(verify).not.toHaveBeenCalled();
  });

  test("an ordinary denial does not end the run", async () => {
    // Control: the same shape WITHOUT `halt` is a per-call refusal, and the
    // agent goes on working. The halt channel is what makes the difference.
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const deny = mock(async () => ({ allowed: false, userDecision: true, reason: "not that one" }));
    const loop = makeLoop(makeGateway([{ tool: "bash" }, { text: "fine, done" }], rec), deny);

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const complete = events.find((e) => e.type === "turn_complete") as any;
    expect(complete.stopReason).toBe("end_turn");
  });
});

// ─── The barren-turn breaker ───

describe("barren-turn breaker", () => {
  /** Refuses deterministically — a policy rule, not a person. */
  const ruleDeny = () =>
    mock(async () => ({ allowed: false, reason: "Denied by configured rule: bash(*)" }));

  test("three fully-refused turns stop the run", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway([{ tool: "bash" }, { tool: "bash" }, { tool: "bash" }, { tool: "bash" }], rec),
      ruleDeny(),
    );

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const fatal = events.find((e) => e.type === "error" && (e as any).recoverable === false) as any;

    expect(fatal).toBeDefined();
    expect(fatal.error).toContain("refused before it ran");
    expect(fatal.error).toContain("Denied by configured rule");
    // Three turns, not thirty.
    expect(rec.requests).toBe(3);
  });

  test("the second barren turn gets one nudge to change approach", async () => {
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway([{ tool: "bash" }, { tool: "bash" }, { tool: "bash" }], rec),
      ruleDeny(),
    );

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const notices = events.filter((e) => e.type === "notice").map((e: any) => e.message);
    expect(notices.some((m) => m.includes("change approach or stop"))).toBe(true);
  });

  test("a turn that actually executes resets the streak", async () => {
    // deny, deny, ALLOW (executes), deny, deny — never three in a row, so the
    // run finishes normally. This is the verify-loop shape the older
    // call-signature detector kept killing.
    let call = 0;
    const check = mock(async () => {
      call++;
      return call === 3
        ? { allowed: true }
        : { allowed: false, reason: "Denied by configured rule: bash(*)" };
    });
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const loop = makeLoop(
      makeGateway(
        [
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { text: "done" },
        ],
        rec,
      ),
      check,
    );

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const fatal = events.filter((e) => e.type === "error" && (e as any).recoverable === false);
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(fatal).toEqual([]);
    expect(complete.stopReason).toBe("end_turn");
  });

  test("refusals a person made never count", async () => {
    // Five human "no"s in a row, then the agent gives up gracefully. A person
    // declining a call is a conversation, and the next answer may be yes.
    const rec: Recorder = { toolsPerRequest: [], requests: 0 };
    const deny = mock(async () => ({ allowed: false, userDecision: true, reason: "User denied" }));
    const loop = makeLoop(
      makeGateway(
        [
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { tool: "bash" },
          { text: "understood" },
        ],
        rec,
      ),
      deny,
    );

    const events = await collect(loop.run("build it", "s1", "/tmp"));
    const fatal = events.filter((e) => e.type === "error" && (e as any).recoverable === false);
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(fatal).toEqual([]);
    expect(complete.stopReason).toBe("end_turn");
  });
});
