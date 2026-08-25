/**
 * Provider-error handling in the flat AgentLoop.
 *  - A terminal (retryable:false) gateway error — e.g. all providers rate-limited
 *    — must fail fast: one error, no re-running the doomed chain.
 *  - A transient error (no flag) must still retry the turn up to
 *    maxConsecutiveErrors before the fatal "Too many consecutive errors".
 */

import { describe, test, expect } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  return {
    toLlmTools: () => [],
    get: (name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: "read",
        permissionLevel: "auto",
      },
    }),
    execute: async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    }),
  } as any;
}

/** Gateway whose every inferStream call yields a single error event. Counts calls. */
function makeErrorGateway(error: { type: "error"; error: string; retryable?: boolean }) {
  const gateway = {
    calls: 0,
    inferStream: async function* () {
      gateway.calls++;
      yield error;
    },
  } as any;
  return gateway;
}

function loopWith(gateway: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "google",
      maxTokens: 100,
      maxTurns: 12,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
    },
    gateway,
    makeRegistry(),
  );
}

const errs = (events: AgentTurnEvent[]) =>
  events.filter((e): e is Extract<AgentTurnEvent, { type: "error" }> => e.type === "error");

describe("AgentLoop — provider error handling", () => {
  test("a retryable:false error fails fast — one error, no re-hammer", async () => {
    const gateway = makeErrorGateway({
      type: "error",
      error:
        "All providers rate limited (google, openrouter). Wait a moment, or switch models with /model.",
      retryable: false,
    });

    const events = await collect(loopWith(gateway).run("go", "s", "/ws"));

    expect(gateway.calls).toBe(1); // did NOT re-run the doomed fallback chain
    const errors = errs(events);
    expect(errors.length).toBe(1);
    expect(errors[0].recoverable).toBe(false);
    expect(errors[0].error.toLowerCase()).toContain("rate limited");
    // The old, confusing terminal message must NOT appear.
    expect(errors.some((e) => /too many consecutive/i.test(e.error))).toBe(false);
  });

  test("a transient error (no flag) retries the turn up to maxConsecutiveErrors", async () => {
    const gateway = makeErrorGateway({ type: "error", error: "503 upstream connect error" });

    const events = await collect(loopWith(gateway).run("go", "s", "/ws"));

    expect(gateway.calls).toBe(3); // retried until the consecutive-error cap
    expect(errs(events).some((e) => /too many consecutive/i.test(e.error))).toBe(true);
  });
});
