/**
 * Deterministic long-horizon regression for the real AgentLoop + ContextEngine.
 *
 * Short, happy-path evals never exercised the failure mode observed in the
 * field: a tool-heavy run survives for hours, compacts several times, and must
 * still remember its original goal while keeping every tool protocol pair
 * valid. This test drives 105 sequential tool turns (plus the final answer),
 * crosses the real-usage high-water mark four times, and verifies the
 * engine-owned task spine survives every compaction.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AgentLoop, type AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import { tokenCounter } from "../../../packages/orchestrator/src/tokenizer";

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const textInRequest = (request: any): string => JSON.stringify(request.messages ?? []);

describe("AgentLoop — 100+ turn endurance", () => {
  beforeEach(() => tokenCounter.resetCalibrations());
  afterEach(() => tokenCounter.resetCalibrations());

  test("105 tool turns survive repeated compaction without losing the task spine", async () => {
    const requests: any[] = [];
    let requestNumber = 0;

    const gateway = {
      inferStream: mock(async function* (request: any) {
        requests.push(request);
        requestNumber++;

        if (requestNumber <= 105) {
          const callId = `endurance-${requestNumber}`;
          yield {
            type: "tool_use_start",
            toolCallId: callId,
            toolName: "inspect_artifact",
          };
          yield {
            type: "tool_use_stop",
            toolCallId: callId,
            toolInput: { ordinal: requestNumber },
          };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            // Four authoritative high-water crossings. Ordinary turns report
            // a realistic below-threshold working set so compaction is driven
            // by provider usage, not a test-only hook.
            usage: {
              inputTokens: requestNumber % 25 === 0 ? 80_000 : 30_000,
              outputTokens: 20,
            },
          };
          return;
        }

        yield {
          type: "content_delta",
          delta: { type: "text_delta", text: "All 105 artifacts inspected." },
        };
        yield {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 30_000, outputTokens: 12 },
        };
      }),
      // This workload should remain on tier 1: old bulky results can be
      // discarded without asking another model to paraphrase the run.
      infer: mock(async () => ({
        content: [{ type: "text", text: "unexpected summary" }],
        model: "endurance-model",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
      registerProvider: mock(() => {}),
      getProvider: mock(() => null),
      getRegisteredProviderNames: () => [],
      getTotalCost: mock(() => 0),
    } as any;

    const registry = {
      toLlmTools: mock(() => [
        {
          name: "inspect_artifact",
          description: "Read one synthetic artifact.",
          inputSchema: { type: "object", properties: { ordinal: { type: "number" } } },
        },
      ]),
      get: mock(() => ({
        schema: {
          name: "inspect_artifact",
          version: "1.0.0",
          description: "Read one synthetic artifact.",
          inputSchema: { type: "object", properties: {} },
          category: "read",
          permissionLevel: "auto",
        },
      })),
      execute: mock(async (input: any) => ({
        callId: input.callId,
        toolName: input.toolName,
        success: true,
        // Large enough to reproduce tool-heavy context pressure, small enough
        // to stay below the per-result safety cap.
        result: `artifact ${input.args.ordinal}\n${"x".repeat(12_000)}`,
        durationMs: 1,
      })),
    } as any;

    const taskState = new TaskStateStore();
    taskState.beginTurn("Audit all 105 artifacts without losing the original objective.");
    taskState.setTodos([
      { content: "Inspect all 105 artifacts and preserve the findings", status: "in_progress" },
    ]);

    const contextEngine = new ContextEngine({ summarizeTurnsThreshold: 10 }, gateway);
    const loop = new AgentLoop(
      {
        model: "endurance-model",
        provider: "anthropic",
        maxTokens: 1_000,
        maxTurns: 110,
        maxConsecutiveErrors: 3,
        systemPrompt: "Inspect each artifact in sequence.",
        verifyExecution: false,
        contextEngine,
        taskState,
      } as any,
      gateway,
      registry,
    );

    const events = await collect(loop.run("continue", "endurance-session", "/workspace"));
    const compactions = events.filter(
      (event): event is Extract<AgentTurnEvent, { type: "compaction" }> =>
        event.type === "compaction",
    );
    const toolEnds = events.filter((event) => event.type === "tool_call_end");

    expect(requests).toHaveLength(106);
    expect(toolEnds).toHaveLength(105);
    expect(compactions.length).toBeGreaterThanOrEqual(4);
    expect(compactions.every((event) => event.summarizedCount === 0)).toBe(true);
    expect(compactions.every((event) => event.afterTokens < event.beforeTokens)).toBe(true);
    expect(gateway.infer).not.toHaveBeenCalled();

    // The task block is external to transcript compaction and rebuilt as the
    // request suffix. It must be present before and after every compaction.
    for (const request of requests) {
      const text = textInRequest(request);
      expect(text).toContain("Audit all 105 artifacts");
      expect(text).toContain("Inspect all 105 artifacts and preserve the findings");
    }

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "turn_complete",
      stopReason: "end_turn",
      totalTurns: 106,
    });

    // The full internal transcript remains protocol-valid even though old
    // result bodies were replaced by explicit eviction markers.
    const useIds = new Set(
      loop
        .getMessages()
        .flatMap((message) =>
          message.content
            .filter((block) => block.type === "tool_use")
            .map((block) => block.toolCallId),
        ),
    );
    const resultIds = new Set(
      loop
        .getMessages()
        .flatMap((message) =>
          message.content
            .filter((block) => block.type === "tool_result")
            .map((block) => block.toolCallId),
        ),
    );
    expect(resultIds).toEqual(useIds);
  }, 30_000);
});
