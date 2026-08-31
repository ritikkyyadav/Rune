/**
 * Reliability tests for the two "don't fall apart" mechanisms:
 *  1. Repeated-failure circuit breaker — the SAME failing call (tool + args) is
 *     executed at most twice per run; further repeats are refused without
 *     running, with a firm change-strategy error the model can read.
 *  2. rateLimitWaitSecs — parses the retry window out of an all-providers
 *     rate-limit message so the loop can wait it out and resume (bounded).
 */

import { describe, test, expect, mock } from "bun:test";
import {
  AgentLoop,
  rateLimitWaitSecs,
  abortableSleep,
} from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Gateway that keeps re-issuing the SAME doomed call (identical args) plus one
 * unique read per turn (so the batch signature varies and the whole-batch loop
 * detector stays quiet — this exercises the per-call breaker specifically).
 */
function makeRepeatingFailureGateway(turns: number) {
  let turn = 0;
  return {
    inferStream: mock(async function* () {
      turn++;
      if (turn <= turns) {
        yield ev("tool_use_start", { toolCallId: `doomed-${turn}`, toolName: "web_fetch" });
        yield ev("tool_use_stop", {
          toolCallId: `doomed-${turn}`,
          toolInput: { url: "https://blocked.example/lib.js" },
        });
        yield ev("tool_use_start", { toolCallId: `read-${turn}`, toolName: "read_file" });
        yield ev("tool_use_stop", {
          toolCallId: `read-${turn}`,
          toolInput: { path: `f${turn}.ts` },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
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
  const executed: string[] = [];
  const registry = {
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
    execute: mock(async (input: { toolName: string; callId: string }) => {
      executed.push(input.toolName);
      const fails = input.toolName === "web_fetch";
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: !fails,
        result: fails ? "" : "ok",
        error: fails ? "Egress blocked: https://blocked.example/lib.js" : undefined,
        durationMs: 1,
      };
    }),
  } as any;
  return { registry, executed };
}

describe("repeated-failure circuit breaker", () => {
  test("the same failing call executes at most twice; repeats are refused unrun", async () => {
    const { registry, executed } = makeRegistry();
    const loop = new AgentLoop(
      { maxTurns: 10, maxConsecutiveErrors: 50 },
      makeRepeatingFailureGateway(4),
      registry,
    );
    const events = (await collect(loop.run("go", "s", "/w"))) as AgentTurnEvent[];

    // Executed twice for real; turns 3 & 4 are refused without running.
    expect(executed.filter((n) => n === "web_fetch").length).toBe(2);

    const ends = events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> => e.type === "tool_call_end",
    );
    const refusals = ends.filter((e) => (e.output.error ?? "").includes("Refused without running"));
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    // The refusal tells the model what to do instead.
    expect(refusals[0]!.output.error).toContain("Change strategy");
  });
});

/**
 * Gateway that keeps ASKING with different wording every turn — the shape of
 * the 2026-08-31 incident: nine differently-phrased ask_user calls, one
 * identical validation rejection, and no other call in between. The per-call
 * breaker never fires (args differ); the same-shape streak must.
 */
// Genuinely different WORDS each time, the way a model rewords -- the
// aggressive per-call signature folds digits, so varying only a number would
// (correctly) trip the exact-call breaker instead of the shape streak.
const REWORDINGS = [
  "What kind of reaudit do you want today?",
  "Which scope should this audit take?",
  "How deep should the reaudit go?",
  "What flavor of audit fits tonight?",
  "Where should the audit focus first?",
  "Should this be delta or full coverage?",
  "Pick the audit lane you want.",
  "Choose how thorough we go.",
];

function makeRewordingFailureGateway(turns: number) {
  let turn = 0;
  return {
    inferStream: mock(async function* () {
      turn++;
      if (turn <= turns) {
        yield ev("tool_use_start", { toolCallId: `ask-${turn}`, toolName: "ask_user" });
        yield ev("tool_use_stop", {
          toolCallId: `ask-${turn}`,
          toolInput: { questions: [{ question: REWORDINGS[(turn - 1) % REWORDINGS.length] }] },
        });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
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

function makeAlwaysFailingRegistry(error: string) {
  const executed: string[] = [];
  const registry = {
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
    execute: mock(async (input: { toolName: string; callId: string }) => {
      executed.push(input.toolName);
      return {
        callId: input.callId,
        toolName: input.toolName,
        success: false,
        result: "",
        error,
        durationMs: 1,
      };
    }),
  } as any;
  return { registry, executed };
}

describe("same-shape failure streak", () => {
  test("reworded calls dying on one error get a note at 3 and refuse at 5", async () => {
    const { registry, executed } = makeAlwaysFailingRegistry(
      "Validation failed: each question needs text and 2-6 non-empty options",
    );
    const loop = new AgentLoop(
      { maxTurns: 12, maxConsecutiveErrors: 50 },
      makeRewordingFailureGateway(8),
      registry,
    );
    const events = (await collect(loop.run("go", "s", "/w"))) as AgentTurnEvent[];

    // Five real executions at most: the streak refuses the shape from there,
    // however inventively the model rewords it.
    expect(executed.filter((n) => n === "ask_user").length).toBeLessThanOrEqual(5);

    const ends = events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> => e.type === "tool_call_end",
    );
    const refusals = ends.filter((e) =>
      (e.output.error ?? "").includes("Refused without running"),
    );
    expect(refusals.length).toBeGreaterThanOrEqual(1);
    // The ask_user refusal names the conversational way out.
    expect(refusals.some((e) => (e.output.error ?? "").includes("END YOUR TURN"))).toBe(true);

    // The corrective note landed in the transcript after the third failure.
    const transcript = JSON.stringify(loop.getMessages());
    expect(transcript).toContain("[Harness note] Your last 3 ask_user calls");
    expect(transcript).toContain("write the question as plain prose");
  });

  test("a successful call between failures resets the streak", async () => {
    // fail, fail, SUCCEED, fail, fail... — never three consecutive, never
    // refused. The reset is what keeps this breaker off legitimate runs that
    // are making contact with the world between misses.
    let turn = 0;
    const gw = {
      inferStream: mock(async function* () {
        turn++;
        if (turn <= 6) {
          const tool = turn === 3 ? "read_file" : "ask_user";
          yield ev("tool_use_start", { toolCallId: `c-${turn}`, toolName: tool });
          yield ev("tool_use_stop", {
            toolCallId: `c-${turn}`,
            toolInput:
              tool === "read_file"
                ? { path: "a.ts" }
                : { questions: [{ question: REWORDINGS[(turn - 1) % REWORDINGS.length] }] },
          });
          yield ev("message_stop", { stopReason: "tool_use" });
        } else {
          yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
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
    const executed: string[] = [];
    const registry = {
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
      execute: mock(async (input: { toolName: string; callId: string }) => {
        executed.push(input.toolName);
        const ok = input.toolName === "read_file";
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: ok,
          result: ok ? "ok" : "",
          error: ok ? undefined : "Validation failed: same shape",
          durationMs: 1,
        };
      }),
    } as any;
    const loop = new AgentLoop({ maxTurns: 10, maxConsecutiveErrors: 50 }, gw, registry);
    const events = (await collect(loop.run("go", "s", "/w"))) as AgentTurnEvent[];
    // Every ask_user ran for real — nothing was refused.
    expect(executed.filter((n) => n === "ask_user").length).toBe(5);
    const ends = events.filter(
      (e): e is Extract<AgentTurnEvent, { type: "tool_call_end" }> => e.type === "tool_call_end",
    );
    expect(ends.some((e) => (e.output.error ?? "").includes("Refused without running"))).toBe(
      false,
    );
  });
});

describe("rateLimitWaitSecs", () => {
  test("parses the retry window (with slack)", () => {
    expect(
      rateLimitWaitSecs(
        "All providers rate limited (ollama-turbo, openrouter, google). Retry in ~53s, or switch models with /model.",
      ),
    ).toBe(55);
  });

  test("floors tiny windows and caps long ones", () => {
    expect(rateLimitWaitSecs("rate limited. Retry in ~1s")).toBe(5);
    expect(rateLimitWaitSecs("rate limited. Retry in ~600s")).toBe(90);
  });

  test("null for non-rate-limit or windowless messages", () => {
    expect(rateLimitWaitSecs("Invalid API key for provider anthropic")).toBeNull();
    expect(rateLimitWaitSecs("All providers rate limited. Wait a moment.")).toBeNull();
  });
});

describe("abortableSleep", () => {
  test("wakes early when the signal aborts", async () => {
    const ac = new AbortController();
    const start = Date.now();
    const p = abortableSleep(5_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});
