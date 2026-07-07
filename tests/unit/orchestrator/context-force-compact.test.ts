/**
 * Context-overflow compaction contract:
 *  - force: true compacts even below the turn threshold (the provider REJECTED
 *    the prompt — shrinking is mandatory, not optional).
 *  - In-loop compaction now uses the comprehensive (resume-grade) summary —
 *    the 500-token bullet summary amnesia'd goals/files/decisions mid-task.
 */

import { describe, test, expect } from "bun:test";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { Message } from "../../../packages/llm-gateway/src/types";

function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

/** Gateway stub whose infer() records the request and returns a summary. */
function summarizerGateway() {
  const calls: Array<{ maxTokens: number; system?: string }> = [];
  return {
    calls,
    getRegisteredProviderNames: () => [],
    infer: async (req: { maxTokens: number; system?: string }) => {
      calls.push({ maxTokens: req.maxTokens, system: req.system });
      return {
        id: "r1",
        content: [{ type: "text", text: "SUMMARY: goals, files touched, next step." }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "m",
      };
    },
  } as any;
}

function engineWith(gateway: any): ContextEngine {
  return new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);
}

const conversation = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));

describe("ContextEngine.compactWorkingSet", () => {
  test("below threshold without force: unchanged", async () => {
    const gw = summarizerGateway();
    const r = await engineWith(gw).compactWorkingSet(conversation(6));
    expect(r.compacted).toBe(false);
    expect(gw.calls.length).toBe(0);
  });

  test("below threshold WITH force: compacts anyway (overflow recovery)", async () => {
    const gw = summarizerGateway();
    const messages = conversation(6);
    const r = await engineWith(gw).compactWorkingSet(messages, 2, { force: true });
    expect(r.compacted).toBe(true);
    expect(r.messages.length).toBeLessThan(messages.length);
    const first = r.messages[0].content[0];
    expect(first.type === "text" && first.text).toContain("SUMMARY");
  });

  test("in-loop compaction requests the comprehensive resume-grade summary", async () => {
    const gw = summarizerGateway();
    const r = await engineWith(gw).compactWorkingSet(conversation(14));
    expect(r.compacted).toBe(true);
    expect(gw.calls.length).toBe(1);
    // Comprehensive: 2000-token budget + the "resume from summary alone" system.
    expect(gw.calls[0].maxTokens).toBe(2000);
    expect(gw.calls[0].system).toMatch(/resume|continue/i);
  });
});
