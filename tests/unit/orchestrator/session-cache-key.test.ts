/**
 * P2 — a session's requests carry the session's prompt-cache key.
 *
 * The provider adapter accepts a caller's key (`codex-quota.test.ts`, "the
 * prompt cache key"); no caller passed one. Held here: what the key is, and
 * that the loop hands it to the gateway on every request it makes. That the
 * ENGINE gives a session the same key across runs, a rebuilt gateway and a new
 * process is `tests/integration/prompt-cache-key.test.ts`.
 *
 * What this cannot say is how much a warm cache saves. That is a live
 * measurement, with the same model, effort and inputs on both sides.
 */

import { describe, expect, test } from "bun:test";

import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import { sessionCacheKey } from "../../../packages/orchestrator/src/session-cache-key";

describe("the key", () => {
  const A = "0199a3f2-7c1e-7b3a-9d2e-5f6a7b8c9d0e";
  const B = "0199a3f2-7c1e-7b3a-9d2e-5f6a7b8c9d0f";

  test("is the same every time it is asked for one session", () => {
    expect(sessionCacheKey(A)).toBe(sessionCacheKey(A));
    // Pinned: a key that changed between two builds would cool every cache once.
    expect(sessionCacheKey(A)).toBe("rune-f0b178cc6784e69c5cdd76d01d50308e");
  });

  test("is never two sessions' at once, however close their ids", () => {
    expect(sessionCacheKey(A)).not.toBe(sessionCacheKey(B));
  });

  test("is printable and short enough to ride in a header", () => {
    expect(sessionCacheKey(A)).toMatch(/^rune-[0-9a-f]{32}$/);
  });

  test("is not the session id, and does not carry it", () => {
    const key = sessionCacheKey(A);
    expect(key).not.toContain(A);
    // A UUIDv7 begins with when it was made. None of that is in the key.
    expect(key).not.toContain("0199a3f2");
  });
});

describe("the loop", () => {
  /** A gateway that answers at once and remembers what each request was sent WITH. */
  function makeGateway(seen: Array<Record<string, unknown>>) {
    let turn = 0;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inferStream: async function* (_request: any, opts?: Record<string, unknown>) {
        seen.push({ ...(opts ?? {}) });
        turn++;
        if (turn === 1) {
          yield { type: "tool_use_start", toolCallId: "c1", toolName: "read_file" };
          yield { type: "tool_use_stop", toolCallId: "c1", toolInput: { path: "a.ts" } };
          yield { type: "message_stop", stopReason: "tool_use" };
        } else {
          yield { type: "content_delta", delta: { type: "text_delta", text: "done" } };
          yield { type: "message_stop", stopReason: "end_turn" };
        }
      },
      infer: async () => ({
        content: [{ type: "text", text: "s" }],
        model: "m",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      registerProvider: () => {},
      getProvider: () => null,
      getTotalCost: () => 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  const registry = {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  async function requestsOf(config: Record<string, unknown>) {
    const seen: Array<Record<string, unknown>> = [];
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 6,
        systemPrompt: "s",
        ...config,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      makeGateway(seen),
      registry,
    );
    for await (const _event of loop.run("do it", "s1", "/tmp")) {
      // drained
    }
    return seen;
  }

  test("hands the key it was given to the gateway on every request of the run", async () => {
    const seen = await requestsOf({ cacheKey: "rune-abc" });
    expect(seen).toHaveLength(2);
    expect(seen.map((opts) => opts.cacheKey)).toEqual(["rune-abc", "rune-abc"]);
  });

  test("given none, sends none: the provider falls back to its own, as it always did", async () => {
    const seen = await requestsOf({});
    expect(seen).toHaveLength(2);
    for (const opts of seen) expect("cacheKey" in opts).toBe(false);
  });
});
