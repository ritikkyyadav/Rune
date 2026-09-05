/**
 * A call that arrived with no arguments at all is answered by the loop
 * before the permission gate: nothing runs, nothing is reviewed, no held
 * step is created. Observed 2026-09-03: a 24 KB stylesheet cut at the output
 * cap became `write_file {}`, went through two reasoned safety reviews, was
 * deferred as a held step and re-narrated for forty messages. The audit's
 * record said this path was pinned by a test; it was not, until now.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  AgentLoop,
  argumentsNeverArrived,
  malformedCallMessage,
  type AgentTurnEvent,
} from "../../../packages/orchestrator/src/agent-loop";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect(gen: AsyncGenerator<AgentTurnEvent>): Promise<AgentTurnEvent[]> {
  const out: AgentTurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function makeGateway() {
  let i = 0;
  return {
    inferStream: mock(async function* () {
      i++;
      if (i === 1) {
        yield ev("tool_use_start", { toolCallId: "c1", toolName: "write_file" });
        yield ev("tool_use_stop", { toolCallId: "c1", toolInput: {} });
        yield ev("message_stop", { stopReason: "tool_use" });
      } else {
        yield ev("content_delta", { delta: { type: "text_delta", text: "Re-issued." } });
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

describe("argumentsNeverArrived", () => {
  const schema = { inputSchema: { type: "object", required: ["path", "content"] } };
  test("fires only for a call with no arguments at all", () => {
    expect(argumentsNeverArrived(schema, {})).toEqual(["path", "content"]);
    expect(argumentsNeverArrived(schema, { path: "a" })).toEqual([]); // the model's own mistake
    expect(argumentsNeverArrived(schema, { content: "" })).toEqual([]); // "" is a value
    expect(argumentsNeverArrived({ inputSchema: { type: "object" } }, {})).toEqual([]);
    expect(argumentsNeverArrived(undefined, {})).toEqual([]);
  });

  test("the message names the cause and the way out, and says it is not a refusal", () => {
    const m = malformedCallMessage("write_file", ["path", "content"]);
    expect(m).toContain("`write_file` arrived with no arguments at all");
    expect(m).toContain("NOT a permission or safety refusal");
    expect(m).toContain("output-token limit");
    expect(m).toContain("write the first section with `write_file`");
  });
});

describe("the loop answers an empty call itself", () => {
  test("nothing runs, nothing is reviewed, the model is told, and the run goes on", async () => {
    const incidents: string[] = [];
    const permissionChecks: string[] = [];
    const execute = mock(async () => ({
      callId: "c1",
      toolName: "write_file",
      success: true,
      result: "",
      durationMs: 1,
    }));
    const registry = {
      toLlmTools: mock(() => []),
      get: mock((name: string) => ({
        schema: {
          name,
          version: "0.1.0",
          description: "",
          inputSchema: { type: "object", required: ["path", "content"], properties: {} },
          category: "write",
          permissionLevel: "confirm",
        },
      })),
      execute,
    } as any;
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 6,
        maxConsecutiveErrors: 3,
        systemPrompt: "s",
        effortRouting: "off",
        onIncident: (i: any) => incidents.push(i.class),
      } as any,
      makeGateway(),
      registry,
      async ({ toolName }: { toolName: string }) => {
        permissionChecks.push(toolName);
        return { allowed: true };
      },
    );
    const events = await collect(loop.run("write the stylesheet", "s1", "/tmp"));
    expect(incidents).toContain("tool.malformed_call");
    expect(execute).not.toHaveBeenCalled();
    expect(permissionChecks).toEqual([]); // never reached the gate
    const told = ((loop as any).messages as any[])
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .map((b) => String(b.toolResultContent ?? ""));
    expect(told.some((t) => t.includes("Malformed call: `write_file`"))).toBe(true);
    const last = events[events.length - 1] as any;
    expect(last.stopReason).toBe("end_turn");
  });
});
