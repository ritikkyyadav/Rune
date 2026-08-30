/**
 * The loop detector must not kill a verify cycle.
 *
 * The defect, open since 2026-08-26 and observed in the evolab2 build (session
 * 01a03a3b, seq 314): the detector keyed on `batchSignature(pendingToolCalls)`
 * — the ARGUMENTS alone, never the result and never whether anything changed.
 * That made the healthiest pattern in the loop indistinguishable from its
 * worst. Build, read the failure, fix it, re-run the same
 * `tsc --noEmit && vitest run`: three honest iterations of that look exactly
 * like three attempts at the same wall, and the run was killed immediately
 * after a SUCCESSFUL TypeScript fix.
 *
 * The distinction the detector now makes is simply: was anything written
 * between the tries? A command repeated after an edit is a verify cycle. The
 * same command with no edit between it is a rut.
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

const CHECK = "npx tsc --noEmit && npx vitest run";

/**
 * `cycles` iterations of edit → run-the-same-check, then a final answer. Every
 * check call is byte-identical, which is exactly what a real verify loop looks
 * like.
 */
function verifyCycleGateway(cycles: number, withEdits: boolean) {
  let step = 0;
  return {
    inferStream: mock(async function* () {
      const i = Math.floor(step / (withEdits ? 2 : 1));
      const isEditStep = withEdits && step % 2 === 0;
      step++;
      if (i >= cycles) {
        yield ev("content_delta", { delta: { type: "text_delta", text: "green." } });
        yield ev("message_stop", { stopReason: "end_turn" });
        return;
      }
      if (isEditStep) {
        yield ev("tool_use_start", { toolCallId: `e${step}`, toolName: "edit_file" });
        yield ev("tool_use_stop", {
          toolCallId: `e${step}`,
          toolInput: { path: "src/a.ts", old_text: `v${i}`, new_text: `v${i + 1}` },
        });
      } else {
        yield ev("tool_use_start", { toolCallId: `c${step}`, toolName: "bash" });
        yield ev("tool_use_stop", { toolCallId: `c${step}`, toolInput: { command: CHECK } });
      }
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

function registry() {
  return {
    toLlmTools: mock(() => [{ name: "bash", description: "", inputSchema: {} }]),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "edit_file" ? "write" : "execute",
        permissionLevel: "auto",
      },
    })),
    execute: mock(async (input: { toolName: string; callId: string }) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: true,
      // The check keeps failing — the agent is mid-fix, which is the point.
      result: input.toolName === "bash" ? "1 error in src/a.ts" : "edited",
      durationMs: 1,
    })),
  } as any;
}

const makeLoop = (gw: any) =>
  new AgentLoop(
    { model: "m", provider: "anthropic", maxTokens: 100, maxTurns: 20, systemPrompt: "s" } as any,
    gw,
    registry(),
  );

describe("loop detection distinguishes a verify cycle from a rut", () => {
  test("five edit → same-check iterations run to completion", async () => {
    const events = await collect(makeLoop(verifyCycleGateway(5, true)).run("fix it", "s1", "/tmp"));

    const fatal = events.filter((e) => e.type === "error" && (e as any).recoverable === false);
    const complete = events.find((e) => e.type === "turn_complete") as any;

    expect(fatal).toEqual([]);
    expect(complete.stopReason).toBe("end_turn");
    // Nothing was skipped: the identical check ran every single time.
    const skipped = events.filter(
      (e) => e.type === "notice" && String((e as any).message).includes("repeating tool call"),
    );
    expect(skipped).toEqual([]);
  });

  test("the same check with NO edit between still trips the detector", async () => {
    // The control. Without this the fix would just be "never detect anything".
    const events = await collect(
      makeLoop(verifyCycleGateway(8, false)).run("fix it", "s1", "/tmp"),
    );

    const nudged = events.some(
      (e) => e.type === "notice" && String((e as any).message).includes("repeating tool call"),
    );
    const fatal = events.some((e) => e.type === "error" && (e as any).recoverable === false);

    expect(nudged || fatal).toBe(true);
  });
});
