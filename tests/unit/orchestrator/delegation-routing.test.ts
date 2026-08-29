// ─── Per-call routing on the delegation tools ───
//
// `tier` routes one call's model weight through the engine's resolve()
// closure; `effort` picks its turn/token budget; and a worker's ownership is
// leased repo-wide through the team hook — refused up front in "block" mode,
// annotated in "warn" mode, and always released when the run ends.

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
import { createWorkerTool } from "../../../packages/orchestrator/src/worker";

class TextProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly text: string) {}
  async infer(): Promise<InferenceResponse> {
    throw new Error("not used");
  }
  async *inferStream(_req: InferenceRequest): AsyncGenerator<StreamEvent> {
    yield { type: "message_start", messageId: "m1" };
    yield { type: "content_start", contentIndex: 0 };
    yield {
      type: "content_delta",
      contentIndex: 0,
      delta: { type: "text_delta", text: this.text },
    };
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

function readTool(name: string): ToolHandler {
  return {
    schema: {
      name,
      version: "0.1.0",
      description: name,
      inputSchema: { type: "object", properties: {} },
      permissionLevel: "auto",
      category: "read",
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

const call = (args: Record<string, unknown>) => ({
  toolName: "x",
  callId: "c1",
  sessionId: "s1",
  workspaceRoot: "/tmp",
  args,
});

describe("task tool — tier & effort", () => {
  const registry = new ToolRegistry();
  registry.register(readTool("grep"));

  test("validate rejects bad tier/effort values", () => {
    const tool = createSubagentTool({
      gateway: gatewayWith(new TextProvider("x")),
      registry,
      model: "m",
      provider: "anthropic",
    });
    expect(tool.validate({ prompt: "p", tier: "mega" }).valid).toBe(false);
    expect(tool.validate({ prompt: "p", effort: "extreme" }).valid).toBe(false);
    expect(tool.validate({ prompt: "p", tier: "heavy", effort: "thorough" }).valid).toBe(true);
  });

  test("the per-call tier reaches resolve(); default stays undefined", async () => {
    const seen: Array<string | undefined> = [];
    const tool = createSubagentTool({
      gateway: gatewayWith(new TextProvider("unused")),
      registry,
      model: "m",
      provider: "anthropic",
      resolve: (tier) => {
        seen.push(tier);
        return {
          gateway: gatewayWith(new TextProvider("routed answer")),
          model: "m2",
          provider: "anthropic",
        };
      },
    });
    let out = await tool.execute(call({ prompt: "q1", tier: "heavy" }));
    expect(out.success).toBe(true);
    out = await tool.execute(call({ prompt: "q2" }));
    expect(out.success).toBe(true);
    expect(seen).toEqual(["heavy", undefined]);
  });
});

describe("worker tool — tier, effort & team lease", () => {
  const deps = (over: Partial<Parameters<typeof createWorkerTool>[0]> = {}) =>
    createWorkerTool({
      binaryPath: "/nonexistent/gear-tools",
      resolve: () => ({
        gateway: gatewayWith(new TextProvider("Report: built the module.")),
        model: "m",
        provider: "anthropic",
      }),
      ...over,
    });

  test("validate rejects bad tier/effort values", () => {
    const tool = deps();
    expect(tool.validate({ prompt: "p", files: ["a.ts"], tier: "huge" }).valid).toBe(false);
    expect(tool.validate({ prompt: "p", files: ["a.ts"], effort: "max" }).valid).toBe(false);
    expect(
      tool.validate({ prompt: "p", files: ["a.ts"], tier: "light", effort: "quick" }).valid,
    ).toBe(true);
  });

  test("per-call tier reaches resolve()", async () => {
    const seen: Array<string | undefined> = [];
    const tool = deps({
      resolve: (tier) => {
        seen.push(tier);
        return {
          gateway: gatewayWith(new TextProvider("done")),
          model: "m",
          provider: "anthropic",
        };
      },
    });
    const out = await tool.execute(call({ prompt: "build it", files: ["a.ts"], tier: "heavy" }));
    expect(out.success).toBe(true);
    expect(seen).toEqual(["heavy"]);
  });

  test("a blocked team lease refuses the worker before any model call", async () => {
    let resolved = false;
    const released: string[] = [];
    const tool = deps({
      resolve: () => {
        resolved = true;
        throw new Error("must not be called");
      },
      team: {
        claim: () => ({
          ok: false,
          error: "Team ownership conflict: src/a.ts is leased by g-peer1.",
        }),
        release: (label) => released.push(label),
      },
    });
    const out = await tool.execute(call({ prompt: "build", files: ["src/a.ts"] }));
    expect(out.success).toBe(false);
    expect(out.error).toContain("g-peer1");
    expect(resolved).toBe(false);
    // Nothing was leased, so nothing to release.
    expect(released).toEqual([]);
  });

  test("a warn-mode lease note lands in the report; lease is released after", async () => {
    const released: string[] = [];
    const tool = deps({
      team: {
        claim: () => ({ ok: true, note: "[TEAM] Heads-up: src/a.ts is leased by g-peer1." }),
        release: (label) => released.push(label),
      },
    });
    const out = await tool.execute(call({ prompt: "build", files: ["src/a.ts"] }));
    expect(out.success).toBe(true);
    expect(out.result).toContain("[TEAM] Heads-up");
    expect(out.result).toContain("Report: built the module.");
    expect(released).toHaveLength(1);
  });

  test("a clean team lease is released when the worker finishes", async () => {
    const released: string[] = [];
    const tool = deps({
      team: {
        claim: () => ({ ok: true }),
        release: (label) => released.push(label),
      },
    });
    const out = await tool.execute(call({ prompt: "build", files: ["src/a.ts"] }));
    expect(out.success).toBe(true);
    expect(released).toHaveLength(1);
  });
});
