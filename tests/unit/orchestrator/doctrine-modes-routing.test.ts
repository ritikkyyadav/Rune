/**
 * A mode asked for MID-RUN still has its routing.
 *
 * "# Built-in modes on request" routes three plain-language asks — "research
 * X", "compact the conversation", "show me a dashboard" — from the user's words
 * to three tools. P3B C2 made the section opening-only, on the grounds that the
 * reading "happens on the opening turn and nowhere else".
 *
 * A user's message is not confined to the opening turn. `AgentLoop.interject()`
 * folds mid-run steering into the SAME run at the next turn boundary, and
 * `turn` only resets per `run()` — so the ask lands on a turn > 1 request,
 * which is served the WORKING prompt. This is V-C's reproduction of that, red
 * at `dd37050`: the routing has to be on the request that carries the ask, and
 * `doctrineForRequest` has to name the section for the deferred-tools case
 * where it ships in neither phase.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import type { AgentTurnEvent } from "../../../packages/orchestrator/src/agent-loop";
import { TaskStateStore } from "../../../packages/orchestrator/src/task-state";
import {
  doctrineForRequest,
  renderDoctrine,
  type DoctrineContext,
} from "../../../packages/orchestrator/src/prompts";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeRegistry() {
  return {
    toLlmTools: mock(() => []),
    get: mock((name: string) => ({
      schema: {
        name,
        version: "0.1.0",
        description: "",
        inputSchema: { type: "object", properties: {} },
        category: name === "read_file" ? "read" : "execute",
        permissionLevel: "auto",
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

/** The default (jit) doctrine context the engine assembles — Lane C's own. */
const JIT: DoctrineContext = {
  canDelegate: false,
  greenfield: true,
  buildsInterfaces: false,
  hasModeTools: true,
};
const OPENING = renderDoctrine({ ...JIT, phase: "opening" });
const WORKING = renderDoctrine({ ...JIT, phase: "working" });
const MODES = "# Built-in modes on request";

/**
 * Turn 1 calls a tool (so the run reaches turn 2) and, while it is doing that,
 * the user types a mode request — exactly what `interject` exists for.
 */
function rigged(ask: string) {
  const systems: string[] = [];
  const bodies: string[] = [];
  let loop: AgentLoop | null = null;
  let i = 0;
  const gateway = {
    inferStream: mock(async function* (request: any) {
      systems.push(String(request?.system ?? ""));
      bodies.push(JSON.stringify(request?.messages ?? []));
      i++;
      if (i === 1) {
        yield ev("tool_use_start", { toolCallId: "c1", toolName: "read_file" });
        yield ev("tool_use_stop", { toolCallId: "c1", toolInput: { path: "a.ts" } });
        yield ev("message_stop", { stopReason: "tool_use" });
        // The user types while the run is in flight.
        loop!.interject(ask);
        return;
      }
      yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
      yield ev("message_stop", { stopReason: "end_turn" });
    }),
    infer: mock(async () => ({
      content: [],
      model: "m",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })),
    registerProvider: mock(() => {}),
    getProvider: mock(() => null),
    getTotalCost: mock(() => 0),
  } as any;
  loop = new AgentLoop(
    {
      model: "m",
      provider: "anthropic",
      maxTokens: 100,
      maxTurns: 6,
      systemPrompt: OPENING,
      workingSystemPrompt: WORKING,
      taskState: new TaskStateStore(),
      jitDoctrine: () => null,
    } as any,
    gateway,
    makeRegistry(),
  );
  return { loop, systems, bodies };
}

describe("the routing for a built-in mode reaches the request that asks for it", () => {
  for (const ask of [
    "compact the conversation",
    "research the auth flow and give me a cited report",
  ]) {
    test(`"${ask}" interjected mid-run is answered by a prompt that still carries the routing`, async () => {
      const rig = rigged(ask);
      await collect(rig.loop.run("refactor the parser", "s1", "/tmp"));

      // The ask really did land on a turn > 1 request.
      expect(rig.systems.length).toBeGreaterThan(1);
      expect(rig.bodies[1]).toContain(ask.slice(0, 20));

      // Turn 1 carries the routing, and so does the turn that carries the ask.
      expect(rig.systems[0]).toContain(MODES);
      expect({
        working_request_carrying_the_mode_ask_has_routing: rig.systems[1]!.includes(MODES),
        jit_would_deliver_it: doctrineForRequest(ask).length > 0,
      }).toEqual({
        working_request_carrying_the_mode_ask_has_routing: true,
        jit_would_deliver_it: true,
      });
    });
  }
});
