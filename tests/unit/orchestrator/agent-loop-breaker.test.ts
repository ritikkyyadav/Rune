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
        yield ev("tool_use_stop", { toolCallId: `read-${turn}`, toolInput: { path: `f${turn}.ts` } });
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
