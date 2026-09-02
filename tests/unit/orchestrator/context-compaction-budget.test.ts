/**
 * Compaction is bounded.
 *
 * `compactWorkingSet` used to await the summarizer with no clock and no abort:
 * a candidate walk plus live-model recovery could stall a turn for minutes
 * with nothing the user could do. Now it carries the run's abort signal and a
 * wall-clock budget, and past either it takes the deterministic tier instead.
 */

import { describe, expect, mock, test } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

/** A summarizer that answers only when its request is aborted. */
function hangingGateway() {
  const infer = mock(
    (req: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        const fail = () => reject(new Error("aborted by caller"));
        if (req.signal?.aborted) fail();
        else req.signal?.addEventListener("abort", fail, { once: true });
      }),
  );
  return {
    infer,
    inferStream: mock(async function* () {}),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getRegisteredProviderNames: () => [],
    getTotalCost: mock(() => 0),
  } as any;
}

function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `question ${i} ${"x".repeat(200)}` }],
    });
    out.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${i} ${"y".repeat(200)}` }],
    });
  }
  return out;
}

const engine = (gw: any) =>
  new ContextEngine(
    { summarizeTurnsThreshold: 4, summarizerModel: "m", summarizerProvider: "anthropic" },
    gw,
  );

describe("compaction budget", () => {
  test("a hanging summarizer is cut off at the wall-clock budget, not left to stall the turn", async () => {
    const gw = hangingGateway();
    const started = Date.now();
    const r = await engine(gw).compactWorkingSet(conversation(8), 2, { budgetMs: 1_000 });
    const elapsed = Date.now() - started;
    expect(r.compacted).toBe(false);
    expect(r.failed).toBe(true);
    expect(r.failureReason).toContain("budget");
    expect(elapsed).toBeLessThan(4_000);
    // The request itself carried an abort signal, and it fired.
    const req = gw.infer.mock.calls[0]?.[0];
    expect(req?.signal?.aborted).toBe(true);
  });

  test("the run's own abort ends compaction immediately", async () => {
    const gw = hangingGateway();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const started = Date.now();
    const r = await engine(gw).compactWorkingSet(conversation(8), 2, {
      signal: ac.signal,
      budgetMs: 30_000,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.compacted).toBe(false);
    expect(r.failureReason).toContain("aborted");
  });

  test("past the budget, old tool-result bodies are evicted instead of giving up", async () => {
    const gw = hangingGateway();
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: "user", content: [{ type: "text", text: `read file ${i}` }] });
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            toolCallId: `t${i}`,
            toolName: "read_file",
            toolInput: { path: `f${i}` },
          },
        ] as any,
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: `t${i}`,
            toolResultContent: "z".repeat(4_000),
          },
        ] as any,
      });
    }
    messages.push({ role: "user", content: [{ type: "text", text: "and now?" }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: "working" }] });
    const r = await engine(gw).compactWorkingSet(messages, 2, { budgetMs: 1_000 });
    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("tool_results");
    expect(r.afterTokens!).toBeLessThan(r.beforeTokens!);
  });
});
