/**
 * A scout that investigated but never wrote its summary must not lose the work.
 *
 * `task` used to return `success: false, result: ""` whenever the sub-agent's
 * final text was empty — throwing away every file it read and every search it
 * ran, and reporting a cause it had never captured. In this install's audit log
 * that was 33 of 68 `task` calls (48%), against 0 of 43 for `worker`.
 *
 * The asymmetry was never the model — both fall through to the same session
 * model on providers absent from the tier table. It was one line of policy:
 * `worker` falls back to its changed-file list when it writes no prose, so its
 * work survives. A read-only scout has no file changes to fall back on, but it
 * does have the ground it covered — which is what the parent needs to finish
 * the job itself or re-dispatch with a real budget.
 */

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
import { createSubagentTool } from "../../../packages/orchestrator/src/subagent";

function readTool(name: string): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
    },
    validate: () => ({ valid: true }),
    execute: async (i) => ({
      callId: i.callId,
      toolName: i.toolName,
      success: true,
      result: "file contents",
      durationMs: 0,
    }),
  };
}

/**
 * Reads a DIFFERENT file every turn and never writes text — a scout making
 * real progress that simply never stops to summarize. The paths must vary:
 * repeating one identical call trips the loop detector instead, which is a
 * different (and correctly handled) failure.
 */
class ToolOnlyProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  calls = 0;
  constructor(private readonly prefix = "src/app") {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(_req: InferenceRequest): AsyncGenerator<StreamEvent> {
    this.calls++;
    const id = `call_${this.calls}`;
    yield { type: "message_start", messageId: `m${this.calls}` };
    yield { type: "tool_use_start", toolCallId: id, toolName: "read_file" };
    yield {
      type: "tool_use_stop",
      toolCallId: id,
      toolInput: { path: `${this.prefix}/file${this.calls}.ts` },
    };
    yield {
      type: "message_stop",
      stopReason: "tool_use",
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

/** Ends immediately with neither text nor tool calls. */
class SilentProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(_req: InferenceRequest): AsyncGenerator<StreamEvent> {
    yield { type: "message_start", messageId: "m1" };
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

function subagent(provider: LlmProvider) {
  const registry = new ToolRegistry();
  registry.register(readTool("read_file"));
  return createSubagentTool({
    gateway: gatewayWith(provider),
    registry,
    model: "test-model",
    provider: "anthropic",
  });
}

const run = (tool: ToolHandler, args: Record<string, unknown>) =>
  tool.execute({
    toolName: "task",
    callId: "c1",
    sessionId: "s1",
    workspaceRoot: "/tmp",
    args,
  });

describe("a scout that ran out of turns keeps its findings", () => {
  test("it succeeds with a partial report instead of returning nothing", async () => {
    // effort "quick" = 8 turns; the provider never writes text, so the loop
    // burns the budget on tool calls — the exact 48% failure shape.
    const out = await run(subagent(new ToolOnlyProvider()), {
      prompt: "where is the config?",
      effort: "quick",
    });

    expect(out.success).toBe(true);
    expect(out.result).not.toBe("");
  });

  test("the report names the cause — out of turns, not 'no summary'", async () => {
    const out = await run(subagent(new ToolOnlyProvider()), {
      prompt: "where is the config?",
      effort: "quick",
    });

    expect(out.result).toContain("ran out of turns");
    expect(out.result).toContain("8"); // the budget it hit
  });

  test("it carries the ground the scout covered", async () => {
    const out = await run(subagent(new ToolOnlyProvider("src/auth")), {
      prompt: "where is auth configured?",
      effort: "quick",
    });

    expect(out.result).toContain("read_file");
    expect(out.result).toContain("src/auth/file1.ts");
    // Several distinct files, not one repeated — the trail is the real path.
    expect(out.result).toContain("src/auth/file2.ts");
  });

  test("it is labelled INCOMPLETE so the parent cannot read it as an answer", async () => {
    const out = await run(subagent(new ToolOnlyProvider()), {
      prompt: "where is the config?",
      effort: "quick",
    });

    expect(out.result).toContain("INCOMPLETE");
    expect(out.result).toContain("Treat nothing here as an answer");
  });

  test("it tells the parent how to recover", async () => {
    const out = await run(subagent(new ToolOnlyProvider()), {
      prompt: "where is the config?",
      effort: "quick",
    });
    expect(out.result).toContain("thorough");
  });

  test("at the top budget it stops suggesting a bigger budget", async () => {
    const out = await run(subagent(new ToolOnlyProvider()), {
      prompt: "survey everything",
      effort: "thorough",
    });
    expect(out.result).toContain("NARROWER");
  });
});

describe("the one case that still fails", () => {
  test("no text AND no tool calls is a genuine failure", async () => {
    // Mirrors worker's `!trimmed && changed.size === 0`: nothing written and
    // nothing done means there is no result to salvage.
    const out = await run(subagent(new SilentProvider()), { prompt: "find X" });

    expect(out.success).toBe(false);
    expect(out.error).toContain("did nothing and wrote nothing");
  });

  test("even then it carries the real cause instead of a bare phrase", async () => {
    // A provider that streams nothing trips the loop's empty-completion
    // retries first, so THAT is the honest cause to report — not the bare
    // "Sub-agent produced no summary" the old code emitted for everything.
    const out = await run(subagent(new SilentProvider()), { prompt: "find X" });
    expect(out.error).toContain("empty response");
    expect(out.error).not.toBe("Sub-agent produced no summary");
  });
});
