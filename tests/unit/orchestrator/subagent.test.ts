import { describe, test, expect } from "bun:test";
import { LlmGateway } from "../../../packages/llm-gateway/src/gateway";
import type {
  InferenceRequest,
  InferenceResponse,
  LlmProvider,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";
import { ToolRegistry } from "../../../packages/tool-registry/src/registry";
import type { ToolHandler } from "../../../packages/tool-registry/src/types";
import {
  createSubagentTool,
  createReadOnlyPermissionCheck,
} from "../../../packages/orchestrator/src/subagent";

function makeTool(name: string, category: "read" | "write"): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      permissionLevel: category === "read" ? "auto" : "confirm",
      category,
    },
    validate: () => ({ valid: true }),
    execute: async (i) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: "ok",
      durationMs: 0,
    }),
  };
}

// Minimal fake provider that streams a single text answer (no tool calls).
class TextProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly text: string) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used in these tests");
  }
  async *inferStream(_req: InferenceRequest): AsyncGenerator<StreamEvent> {
    yield { type: "message_start", messageId: "m1" };
    yield { type: "content_start", contentIndex: 0 };
    yield { type: "content_delta", contentIndex: 0, delta: { type: "text_delta", text: this.text } };
    yield { type: "content_stop", contentIndex: 0 };
    yield {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
  async countTokens(): Promise<number> {
    return 1;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function gatewayWith(provider: LlmProvider): LlmGateway {
  const gw = new LlmGateway({
    providers: {},
    defaultProvider: provider.name,
    maxRetries: 0,
    retryBaseMs: 1,
  });
  gw.registerProvider(provider);
  return gw;
}

describe("createReadOnlyPermissionCheck", () => {
  const reg = new ToolRegistry();
  reg.register(makeTool("read_file", "read"));
  reg.register(makeTool("write_file", "write"));
  const gate = createReadOnlyPermissionCheck(reg);

  test("allows read-category tools", async () => {
    expect((await gate({ callId: "c", toolName: "read_file", args: {} })).allowed).toBe(true);
  });
  test("denies write-category tools", async () => {
    const d = await gate({ callId: "c", toolName: "write_file", args: {} });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/read-only|category/i);
  });
  test("denies unknown tools", async () => {
    expect((await gate({ callId: "c", toolName: "nope", args: {} })).allowed).toBe(false);
  });
});

describe("createSubagentTool", () => {
  const registry = new ToolRegistry();
  registry.register(makeTool("grep", "read"));

  const tool = () =>
    createSubagentTool({
      gateway: gatewayWith(new TextProvider("Found the config in app.ts")),
      registry,
      model: "test-model",
      provider: "anthropic",
    });

  test("exposes the task tool in the read category", () => {
    expect(tool().schema.name).toBe("task");
    expect(tool().schema.category).toBe("read");
  });

  test("validate rejects an empty prompt and accepts a real one", () => {
    expect(tool().validate({ prompt: "" }).valid).toBe(false);
    expect(tool().validate({ prompt: "find the config" }).valid).toBe(true);
  });

  test("returns the sub-agent's final summary", async () => {
    const out = await tool().execute({
      toolName: "task",
      callId: "c1",
      sessionId: "s1",
      workspaceRoot: "/tmp",
      args: { prompt: "where is the config?" },
    });
    expect(out.success).toBe(true);
    expect(out.result).toContain("Found the config in app.ts");
  });
});
