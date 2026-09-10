/**
 * The result-keyed loop detector sees failures, and ends the run the second
 * time the same answer keeps coming back.
 *
 * Dogfood 2026-09-09: the model called a tool that does not exist five times
 * in a row, with varying arguments, eleven completions after the work was
 * committed. The refusal was identical every time and nothing was written —
 * and the detector read allowed, successful results only, so it saw nothing;
 * its one nudge (had it fired) would have been the end of its vigilance.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/**
 * Every completion pairs a fresh `tool` call with a productive read of a new
 * file — the dogfood shape: the bad call rode inside batches that also did
 * real work, so no turn was ever "fully refused" and no call was ever
 * repeated byte-for-byte. Only the answer to the bad call was identical.
 */
function varyingGateway(tool: string) {
  let i = 0;
  return {
    calls: () => i,
    inferStream: mock(async function* () {
      i++;
      yield ev("tool_use_start", { toolCallId: `c${i}`, toolName: tool });
      yield ev("tool_use_stop", { toolCallId: `c${i}`, toolInput: { query: `attempt ${i}` } });
      yield ev("tool_use_start", { toolCallId: `r${i}`, toolName: "read_file" });
      yield ev("tool_use_stop", { toolCallId: `r${i}`, toolInput: { path: `src/file-${i}.ts` } });
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

const REFUSAL =
  "Unknown tool: search. Related registered tools: grep, search_code, glob. Use their documented arguments.";

/** Reads always succeed with a fresh, substantive answer; `execute` decides the rest. */
function registry(execute: (input: { toolName: string; callId: string }) => unknown) {
  return {
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
    execute: mock(async (input: { toolName: string; callId: string }) =>
      input.toolName === "read_file"
        ? {
            callId: input.callId,
            toolName: input.toolName,
            success: true,
            result: `contents of a distinct file for call ${input.callId}, long enough to count as substantive`,
            durationMs: 1,
          }
        : execute(input),
    ),
  } as any;
}

function makeLoop(gateway: any, reg: any, permCheck?: any) {
  return new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 30,
      maxConsecutiveErrors: 3,
      systemPrompt: "s",
      effortRouting: "off",
    } as any,
    gateway,
    reg,
    permCheck,
  );
}

describe("result recurrence counts failures and escalates", () => {
  test("the same executed error four times earns the nudge; four more end the run resumably", async () => {
    const gw = varyingGateway("search");
    const reg = registry((input) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: false,
      error: REFUSAL,
      durationMs: 1,
    }));
    const loop = makeLoop(gw, reg);
    const events = await collect(loop.run("find the parser", "s1", "/tmp"));
    const nudge = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b: any) => b.type === "text" && b.text.includes("results were identical"),
          ),
      );
    expect(nudge).toBeDefined();
    expect(loop.originOf(nudge!)).toBe("nudge:result-loop");
    const error = events.find((e) => e.type === "error");
    expect(error?.type === "error" && error.error).toContain("came back 4 more times");
    // Two executed failures, then the repeated-failure breaker refuses the
    // rest without running them: four refusals to the nudge, four more to
    // the stop — ten completions, not thirty.
    expect(gw.calls()).toBe(10);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      false,
    );
  });

  test("a refusal the permission check returns counts the same as an executed error", async () => {
    const gw = varyingGateway("search");
    let executions = 0;
    const reg = registry((input) => {
      executions++;
      return { callId: input.callId, toolName: input.toolName, success: true, result: "never" };
    });
    const permCheck = async (args: { toolName: string }) =>
      args.toolName === "search" ? { allowed: false, reason: REFUSAL } : { allowed: true };
    const loop = makeLoop(gw, reg, permCheck);
    const events = await collect(loop.run("find the parser", "s1", "/tmp"));
    // The refused tool never ran; the reads beside it did.
    expect(executions).toBe(0);
    expect(events.some((e) => e.type === "error" && e.error.includes("came back"))).toBe(true);
    expect(gw.calls()).toBe(8);
  });

  test("a changing answer is progress and never trips it", async () => {
    let n = 0;
    const gw = {
      ...varyingGateway("probe"),
      inferStream: mock(async function* () {
        n++;
        if (n > 6) {
          yield ev("content_delta", { delta: { type: "text_delta", text: "Done." } });
          yield ev("message_stop", { stopReason: "end_turn" });
          return;
        }
        yield ev("tool_use_start", { toolCallId: `c${n}`, toolName: "probe" });
        yield ev("tool_use_stop", { toolCallId: `c${n}`, toolInput: { step: n } });
        yield ev("message_stop", { stopReason: "tool_use" });
      }),
    };
    const reg = registry((input) => ({
      callId: input.callId,
      toolName: input.toolName,
      success: false,
      error: `attempt failed with a different reason each time: ${Math.random()} ${input.callId}`,
      durationMs: 1,
    }));
    const events = await collect(makeLoop(gw, reg).run("probe it", "s1", "/tmp"));
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "turn_complete" && e.stopReason === "end_turn")).toBe(
      true,
    );
  });
});
