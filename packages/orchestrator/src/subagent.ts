import type { LlmGateway, ProviderName } from "@alan/llm-gateway";
import type {
  ToolCallInput,
  ToolCallOutput,
  ToolHandler,
  ToolRegistry,
  ToolSchema,
} from "@alan/tool-registry";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck } from "./agent-loop";

/**
 * Dependencies the orchestrator must supply when constructing the `task` tool.
 *
 * IMPORTANT — `registry` must be a READ-ONLY tool set that does NOT contain the
 * `task` tool itself. The caller (engine) guarantees this. If the task tool were
 * present in the sub-agent's registry, a sub-agent could spawn further
 * sub-agents, leading to unbounded recursive nesting. The permission gate below
 * additionally denies any tool whose category is not "read", so even a registry
 * that accidentally includes write/execute/network tools cannot be used by a
 * sub-agent — but the caller should still pass a curated read-only registry.
 */
export interface SubagentDeps {
  gateway: LlmGateway;
  registry: ToolRegistry;
  model: string;
  provider: ProviderName;
  maxTokens?: number;
  maxTurns?: number;
  systemPrompt?: string;
  /**
   * Optional live resolver, called at EXECUTE time instead of using the
   * construction-time snapshot above. Lets the engine (a) route sub-agents to
   * the cheap "light" model tier, and (b) hand over the CURRENT gateway — the
   * engine rebuilds its gateway on every key edit/provider toggle, and a
   * snapshot taken at startup would go stale.
   */
  resolve?: () => { gateway: LlmGateway; model: string; provider: ProviderName };
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_SYSTEM_PROMPT =
  "You are a focused sub-agent performing a read-only investigation (exploration, " +
  "search, and analysis). You have access only to read-only tools. Gather what you " +
  "need, then produce a single concise final summary of your findings for the agent " +
  "that delegated this task. Do not attempt to modify files or run commands.";

export const TASK_TOOL_SCHEMA: ToolSchema = {
  name: "task",
  version: "0.1.0",
  description:
    "Delegate a focused, read-only sub-task (exploration/search/analysis) to a " +
    "sub-agent. Returns the sub-agent's final summary. To fan out, issue SEVERAL " +
    "task calls in ONE response — independent investigations run concurrently " +
    "and all summaries come back together. One self-contained question per call.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The task for the sub-agent to perform. Should be a self-contained, " +
          "read-only investigation (e.g. 'find where X is configured').",
      },
      context: {
        type: "string",
        description:
          "Optional additional context to prepend to the prompt (e.g. relevant " +
          "file paths or constraints).",
      },
    },
    required: ["prompt"],
  },
  permissionLevel: "auto",
  category: "read",
};

/**
 * Build a PermissionCheck that allows ONLY tools whose registry schema category
 * is "read" and denies everything else. A sub-agent can therefore never write,
 * execute, or hit the network — regardless of what the registry exposes.
 *
 * Exported for direct unit testing of the permission gate.
 */
export function createReadOnlyPermissionCheck(registry: ToolRegistry): PermissionCheck {
  return async ({ toolName }) => {
    const handler = registry.get(toolName);
    if (!handler) {
      return { allowed: false, reason: `Unknown tool: ${toolName}` };
    }
    if (handler.schema.category !== "read") {
      return {
        allowed: false,
        reason: `Sub-agent may only use read-only tools; "${toolName}" is category "${handler.schema.category}"`,
      };
    }
    return { allowed: true };
  };
}

/**
 * Create the `task` tool handler. The handler spins up a nested {@link AgentLoop}
 * restricted to read-only tools, runs the delegated prompt to completion, and
 * returns the sub-agent's accumulated final text.
 *
 * The returned handler never throws out of `execute`: any failure is reported as
 * `success: false` with a descriptive error.
 */
export function createSubagentTool(deps: SubagentDeps): ToolHandler {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const systemPrompt = deps.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return {
    schema: TASK_TOOL_SCHEMA,

    validate: (args) => {
      if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
        return { valid: false, error: "prompt is required and must be a non-empty string" };
      }
      if (args.context !== undefined && typeof args.context !== "string") {
        return { valid: false, error: "context must be a string when provided" };
      }
      return { valid: true };
    },

    execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
      const start = performance.now();
      const { prompt, context } = input.args as { prompt: string; context?: string };

      try {
        const permissionCheck = createReadOnlyPermissionCheck(deps.registry);

        // Live resolution (tier routing + current gateway) when available.
        const live = deps.resolve?.() ?? {
          gateway: deps.gateway,
          model: deps.model,
          provider: deps.provider,
        };

        const loop = new AgentLoop(
          {
            model: live.model,
            provider: live.provider,
            maxTokens,
            maxTurns,
            systemPrompt,
          },
          live.gateway,
          deps.registry,
          permissionCheck,
        );

        const fullPrompt = context && context.trim().length > 0
          ? `${context}\n\n${prompt}`
          : prompt;

        let finalText = "";
        let toolCallCount = 0;
        let loopError: string | undefined;

        for await (const event of loop.run(fullPrompt, input.sessionId, input.workspaceRoot)) {
          switch (event.type) {
            case "text_delta":
              finalText += event.text;
              break;
            case "tool_call_end":
              toolCallCount++;
              break;
            case "error":
              // Keep the last error; only fatal (non-recoverable) errors end the run.
              loopError = event.error;
              break;
            case "turn_complete":
              // Sub-agent finished (end_turn, max_turns, aborted, …). Stop consuming.
              break;
            default:
              break;
          }
          if (event.type === "turn_complete") break;
        }

        const trimmed = finalText.trim();

        if (trimmed.length === 0) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: loopError
              ? `Sub-agent produced no summary (last error: ${loopError})`
              : "Sub-agent produced no summary",
            durationMs: Math.round(performance.now() - start),
          };
        }

        const suffix = `\n\n(sub-agent made ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"})`;

        return {
          callId: input.callId,
          toolName: input.toolName,
          success: true,
          result: trimmed + suffix,
          durationMs: Math.round(performance.now() - start),
        };
      } catch (err) {
        // Never throw out of execute — surface as a failed tool result instead.
        return {
          callId: input.callId,
          toolName: input.toolName,
          success: false,
          result: "",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Math.round(performance.now() - start),
        };
      }
    },
  };
}
