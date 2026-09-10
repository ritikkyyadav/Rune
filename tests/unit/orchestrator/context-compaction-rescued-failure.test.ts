/**
 * A rescued compaction keeps its failure — on the REAL ContextEngine.
 * Written by an independent verifier.
 *
 * The lane's own S-2 test (tests/integration/engine-lifecycle-projection.test.ts
 * :554) STUBS `ContextEngine.compactWorkingSet` and asserts what the Engine
 * does with the object it returns. That leaves the half S-2 is actually about
 * untested: does a real summarizer failure plus a real eviction PRODUCE that
 * object? This drives the real ContextEngine with a summarizer that 500s.
 */

import { describe, expect, mock, test } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import { registerContextLimit } from "../../../packages/orchestrator/src/tokenizer";
import type { Message } from "../../../packages/llm-gateway/src/types";

const MODEL = "v2-s2-model";
registerContextLimit(MODEL, 60_000);

/** A gateway whose summarizer answers 500, every time and on every candidate. */
function brokenGateway() {
  return {
    infer: mock(async () => {
      throw new Error("500 Internal Server Error from the summarizer");
    }),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getRegisteredProviderNames: () => [],
    getTotalCost: mock(() => 0),
  };
}

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const toolUse = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", toolCallId: id, toolName: "bash", toolInput: { command: "ls" } }],
});
const toolResult = (id: string, body: string): Message => ({
  role: "tool",
  content: [{ type: "tool_result", toolCallId: id, toolResultContent: body }],
});

function toolHeavy(pairs: number, bodyChars: number): Message[] {
  const out: Message[] = [userMsg("Build the thing.")];
  for (let i = 0; i < pairs; i++)
    out.push(toolUse(`c${i}`), toolResult(`c${i}`, "x".repeat(bodyChars)));
  out.push(userMsg("Keep going."));
  return out;
}

function proseOnly(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i++) {
    out.push(userMsg(`ask ${i} ${"word ".repeat(400)}`));
    out.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${i} ${"word ".repeat(400)}` }],
    });
  }
  return out;
}

describe("a rescued compaction on the real ContextEngine", () => {
  test("a 500-ing summarizer rescued by eviction reports the reason and is NOT failed", async () => {
    const gateway = brokenGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 2 }, gateway as never);
    engine.noteRealUsage({ inputTokens: 150_000 }, MODEL);
    const messages = toolHeavy(30, 4_000);

    const r = await engine.compactWorkingSet(messages, 6, { force: true });

    expect(gateway.infer).toHaveBeenCalled(); // the summarizer really was tried
    expect(r.compacted).toBe(true);
    expect(r.tier).toBe("tool_results");
    expect(r.summarizedCount).toBe(0);
    // The whole S-2 contract: the reason travels, `failed` does not — a
    // `failed` compaction is persisted as `compaction_failed`, which does not
    // replace the replayed transcript, and for a real eviction that would
    // resurrect everything it just dropped.
    expect(r.failed).toBeUndefined();
    expect(typeof r.failureReason).toBe("string");
    expect(r.failureReason!.length).toBeGreaterThan(0);
    expect(r.afterTokens!).toBeLessThan(r.beforeTokens!);
  });

  test("with nothing to evict, the same failure is `failed: true` and carries its reason", async () => {
    const gateway = brokenGateway();
    const engine = new ContextEngine({ summarizeTurnsThreshold: 2 }, gateway as never);
    engine.noteRealUsage({ inputTokens: 150_000 }, MODEL);

    const r = await engine.compactWorkingSet(proseOnly(20), 6, { force: true });

    expect(gateway.infer).toHaveBeenCalled();
    expect(r.compacted).toBe(false);
    expect(r.failed).toBe(true);
    expect(typeof r.failureReason).toBe("string");
    expect(r.failureReason!.length).toBeGreaterThan(0);
  });
});
