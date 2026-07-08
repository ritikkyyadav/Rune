/**
 * `research` — the /research pipeline as a model-invocable tool.
 *  - schema: confirm + network (research fans out real web requests)
 *  - validate: query required, depth restricted to the three presets
 *  - execute: plans with the live gateway, records the research_plan audit
 *    event, and surfaces a failed run as a failed tool result (never a throw)
 */

import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type { InferenceResponse, LlmProvider, StreamEvent } from "../../../packages/llm-gateway/src/types";
import {
  createResearchTool,
  RESEARCH_TOOL_SCHEMA,
} from "../../../packages/orchestrator/src/research-tool";

/** Fake provider that streams a fixed text body (the planner JSON). */
class JsonProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly body: string) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(): AsyncGenerator<StreamEvent> {
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: this.body } };
    yield { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async countTokens(): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function gatewayWith(body: string): LlmGateway {
  const gw = new LlmGateway({ providers: {}, defaultProvider: "anthropic", maxRetries: 0, retryBaseMs: 1 });
  gw.registerProvider(new JsonProvider(body));
  return gw;
}

function toolWith(body: string, recorded: Array<{ type: string; payload: Record<string, unknown> }>) {
  return createResearchTool({
    binaryPath: "alan-tools",
    workspaceRoot: "/tmp/nonexistent-ws",
    resolve: () => ({ gateway: gatewayWith(body), model: "test-model", provider: "anthropic" }),
    defaults: () => ({ save: false }),
    record: (_sessionId, type, payload) => recorded.push({ type, payload }),
  });
}

const input = (args: Record<string, unknown>) => ({
  toolName: "research",
  callId: "c1",
  args,
  sessionId: "s1",
  workspaceRoot: "/tmp/nonexistent-ws",
});

describe("research tool schema + validation", () => {
  test("network-category, confirm-gated", () => {
    expect(RESEARCH_TOOL_SCHEMA.name).toBe("research");
    expect(RESEARCH_TOOL_SCHEMA.category).toBe("network");
    expect(RESEARCH_TOOL_SCHEMA.permissionLevel).toBe("confirm");
  });

  test("query is required and non-empty", () => {
    const tool = toolWith("{}", []);
    expect(tool.validate!({}).valid).toBe(false);
    expect(tool.validate!({ query: "  " }).valid).toBe(false);
    expect(tool.validate!({ query: "compare X and Y" }).valid).toBe(true);
  });

  test("depth must be a known preset", () => {
    const tool = toolWith("{}", []);
    expect(tool.validate!({ query: "q", depth: "extreme" }).valid).toBe(false);
    for (const d of ["quick", "standard", "deep"]) {
      expect(tool.validate!({ query: "q", depth: d }).valid).toBe(true);
    }
  });
});

describe("research tool execution", () => {
  test("plans, records the audit event, and reports a sourceless run as failure", async () => {
    // Planner JSON parses into a 1-question plan; the investigator round then
    // finds no sources (the fake provider never emits tool calls), so the run
    // ends with the no-sources error — which must surface as a FAILED tool
    // result carrying that reason, not a throw or a fake report.
    const body = JSON.stringify({
      subQuestions: [{ question: "q1", rationale: "r1", sourceScope: "web" }],
    });
    const recorded: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tool = toolWith(body, recorded);

    const out = await tool.execute(input({ query: "compare X and Y", depth: "quick" }));

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no sources/i);
    // The plan was persisted for audit before execution started.
    expect(recorded.map((r) => r.type)).toContain("research_plan");
    expect(recorded.map((r) => r.type)).not.toContain("research_report");
  });

  test("an already-aborted signal fails fast with 'aborted'", async () => {
    const body = JSON.stringify({
      subQuestions: [{ question: "q1", rationale: "r1", sourceScope: "web" }],
    });
    const tool = toolWith(body, []);
    const controller = new AbortController();
    controller.abort();
    const out = await tool.execute({ ...input({ query: "q" }), signal: controller.signal });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/abort/i);
  });
});
