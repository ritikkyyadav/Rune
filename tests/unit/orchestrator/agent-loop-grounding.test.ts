/**
 * Regression test for the live Gemini failure:
 *   "Built-in tools ({google_search}) and Function Calling cannot be combined
 *    in the same request."
 *
 * The agent always carries function tools, so for providers whose native
 * grounding is mutually exclusive with function calling (Gemini), the loop must
 * NOT enable native grounding — it must keep the universal web_search function
 * tool instead. For providers where grounding coexists with tools (Anthropic),
 * it should still ground natively and drop the redundant web_search tool.
 */

import { describe, test, expect, mock } from "bun:test";
import { AgentLoop } from "../../../packages/orchestrator/src/agent-loop";
import { ContextEngine } from "../../../packages/orchestrator/src/context-engine";
import type { ProviderName, InferenceRequest } from "../../../packages/llm-gateway";

function ev(type: string, extra: Record<string, unknown> = {}) {
  return { type, ...extra };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Gateway that captures the request of the FIRST turn, then ends cleanly. */
function makeCapturingGateway(captured: { req?: InferenceRequest }) {
  return {
    inferStream: mock(async function* (request: InferenceRequest) {
      captured.req ??= request;
      yield ev("content_delta", { delta: { type: "text_delta", text: "done" } });
      yield ev("message_stop", { stopReason: "end_turn" });
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

/** Registry advertising web_search plus a normal function tool. */
function makeRegistry() {
  const tool = (name: string) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  });
  return {
    toLlmTools: mock(() => [tool("web_search"), tool("read_file")]),
    get: mock(() => undefined),
    execute: mock(async () => ({ success: true, result: "ok" })),
  } as any;
}

async function requestFor(provider: ProviderName): Promise<InferenceRequest> {
  const captured: { req?: InferenceRequest } = {};
  const loop = new AgentLoop(
    { model: "m", provider, maxTokens: 100, maxTurns: 1, systemPrompt: "s", nativeGrounding: true },
    makeCapturingGateway(captured),
    makeRegistry(),
  );
  await collect(loop.run("search the web for me", "sess", "/ws"));
  if (!captured.req) throw new Error("no request captured");
  return captured.req;
}

describe("AgentLoop — native grounding vs. function tools", () => {
  test("Gemini keeps web_search tool and does NOT enable grounding (avoids the API conflict)", async () => {
    const req = await requestFor("google");
    // Grounding is OFF — so no googleSearch is sent alongside functionDeclarations.
    expect(req.enableWebSearch).toBeFalsy();
    // The universal web_search function tool stays available to the model.
    const names = (req.tools ?? []).map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("read_file");
  });

  test("Anthropic grounds natively and drops the redundant web_search tool", async () => {
    const req = await requestFor("anthropic");
    expect(req.enableWebSearch).toBe(true);
    const names = (req.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("web_search"); // replaced by server-side grounding
    expect(names).toContain("read_file"); // other tools coexist with grounding
  });

  test("request-specific repository context reaches the model through ContextEngine", async () => {
    const captured: { req?: InferenceRequest } = {};
    const gateway = makeCapturingGateway(captured);
    const contextEngine = new ContextEngine({ budget: { maxTokens: 10_000 } }, gateway);
    const loop = new AgentLoop(
      {
        model: "m",
        provider: "anthropic",
        maxTokens: 100,
        maxTurns: 1,
        systemPrompt: "s",
        contextEngine,
        retrievedChunks: [
          { content: "# Repository map\n- src/auth.ts:4 — function validateToken", relevance: 0.96 },
        ],
      },
      gateway,
      makeRegistry(),
    );
    await collect(loop.run("fix auth", "sess", "/ws"));
    expect(JSON.stringify(captured.req?.messages)).toContain("validateToken");
  });
});
