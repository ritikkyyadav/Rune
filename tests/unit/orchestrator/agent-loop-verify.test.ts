/**
 * Phase 2 — verification loop wired into the flat AgentLoop.
 *  - passes  → completes normally, verify ran once
 *  - fails   → re-prompts the agent with the report, then completes on the next pass
 *  - no edits → verify not called (pure read/Q&A)
 *  - ran:false (no checks detected) → completes, no re-prompt
 *  - bounded by maxVerifyAttempts
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Gateway that plays a scripted list of turns (tool_use or final text). */
function makeScriptedGateway(turns: Array<{ tool?: string; text?: string }>) {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.tool) {
        yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: t.tool });
        yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: {} });
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

/** Registry: write_file is category "write", everything else "read". Always succeeds. */
function makeCatRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "write_file" ? "write" : "read",
        permissionLevel: name === "write_file" ? "confirm" : "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      result: "ok",
      durationMs: 1,
    })),
  } as any;
}

function makeVerifier(results: Array<{ passed: boolean; ran: boolean }>) {
  let i = 0;
  return {
    verify: mock(async () => {
      const r = results[Math.min(i, results.length - 1)];
      i++;
      return { passed: r.passed, ran: r.ran, report: r.passed ? "ok" : "FAIL: tests broken" };
    }),
  };
}

function loopWith(gateway: any, verifier: any, maxVerifyAttempts?: number) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 12,
      systemPrompt: "s",
      verifier,
      ...(maxVerifyAttempts != null ? { maxVerifyAttempts } : {}),
    },
    gateway,
    makeCatRegistry(),
  );
}

describe("AgentLoop — verification loop (Phase 2)", () => {
  test("passing verification → completes, verify ran once", async () => {
    const gateway = makeScriptedGateway([{ tool: "write_file" }, { text: "done" }]);
    const verifier = makeVerifier([{ passed: true, ran: true }]);
    const events = await collect(loopWith(gateway, verifier).run("go", "s", "/ws"));

    expect((verifier.verify as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    >;
    expect(complete?.stopReason).toBe("end_turn");
  });

  test("failing verification re-prompts the agent, then completes on the fix", async () => {
    const gateway = makeScriptedGateway([
      { tool: "write_file" },
      { text: "I think it's done" },
      { tool: "write_file" },
      { text: "fixed it" },
    ]);
    const verifier = makeVerifier([
      { passed: false, ran: true },
      { passed: true, ran: true },
    ]);
    const loop = loopWith(gateway, verifier);
    const events = await collect(loop.run("go", "s", "/ws"));

    // Verified twice (fail, then pass).
    expect((verifier.verify as ReturnType<typeof mock>).mock.calls.length).toBe(2);

    // The failure report was fed back as a user message.
    const hasFailureMsg = loop
      .getMessages()
      .some(
        (m) =>
          m.role === "user" &&
          m.content.some((b) => b.type === "text" && b.text.includes("FAIL: tests broken")),
      );
    expect(hasFailureMsg).toBe(true);

    // And it ultimately completed.
    const complete = events.find((e) => e.type === "turn_complete") as Extract<
      AgentTurnEvent,
      { type: "turn_complete" }
    >;
    expect(complete?.stopReason).toBe("end_turn");
  });

  test("no edits → verifier is never called", async () => {
    const gateway = makeScriptedGateway([{ tool: "read_file" }, { text: "the answer" }]);
    const verifier = makeVerifier([{ passed: true, ran: true }]);
    await collect(loopWith(gateway, verifier).run("go", "s", "/ws"));
    expect((verifier.verify as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  });

  test("ran:false (no checks detected) → completes without a re-prompt", async () => {
    const gateway = makeScriptedGateway([{ tool: "write_file" }, { text: "done" }]);
    const verifier = makeVerifier([{ passed: true, ran: false }]);
    const events = await collect(loopWith(gateway, verifier).run("go", "s", "/ws"));
    expect((verifier.verify as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });

  test("bounded: verify attempts, then ONE replan round, then give up", async () => {
    // Always fails. New contract: after maxVerifyAttempts (1) fix rounds the
    // loop demands a genuinely different approach ONCE (`replanning` event,
    // verify budget reset), so total verify runs are bounded at
    // maxVerifyAttempts × (maxReplanNudges + 1) = 2 — and the run still ends.
    const gateway = makeScriptedGateway([
      { tool: "write_file" },
      { text: "a" },
      { tool: "write_file" },
      { text: "b" },
      { tool: "write_file" },
      { text: "c" },
    ]);
    const verifier = makeVerifier([{ passed: false, ran: true }]);
    const events = await collect(loopWith(gateway, verifier, 1).run("go", "s", "/ws"));

    expect((verifier.verify as ReturnType<typeof mock>).mock.calls.length).toBe(2);
    const replans = events.filter((e) => e.type === "replanning");
    expect(replans).toHaveLength(1);
    expect((replans[0] as { trigger?: string }).trigger).toBe("verification");
    expect(events.some((e) => e.type === "turn_complete")).toBe(true);
  });
});
