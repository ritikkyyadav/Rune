import type {
  ContentBlock,
  InferenceRequest,
  LlmProvider,
  Message,
  ProviderName,
  StreamEvent,
  ToolDefinition,
} from "@alan/llm-gateway";
import { LlmGateway } from "@alan/llm-gateway";
import type { ToolCallInput, ToolCallOutput } from "@alan/tool-registry";
import { ToolRegistry } from "@alan/tool-registry";
import type { ContextEngine } from "./context-engine";

// ─── Agent Turn Events (yielded to caller) ───

export type AgentTurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; callId: string; toolName: string }
  | { type: "tool_call_args_delta"; callId: string; partialJson: string }
  | {
      type: "tool_call_end";
      callId: string;
      args: Record<string, unknown>;
      output: ToolCallOutput;
    }
  | { type: "turn_complete"; stopReason: string; totalTurns: number }
  | { type: "error"; error: string; recoverable: boolean }
  | { type: "context_warning"; message: string };

// ─── Permission Gate ───
// The agent loop invokes this before executing every tool call.
// Returns whether the tool may proceed. The engine wires this to the
// PermissionBroker and (for confirm-level tools) a CLI/UI prompt.

export interface PermissionCheckArgs {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export type PermissionCheck = (args: PermissionCheckArgs) => Promise<PermissionCheckResult>;

// ─── Agent Configuration ───

export interface AgentLoopConfig {
  model: string;
  provider: ProviderName;
  maxTokens: number;
  maxTurns: number;
  maxConsecutiveErrors: number;
  systemPrompt: string;
  temperature?: number;
  priorMessages?: Message[];
  contextEngine?: ContextEngine;
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  model: "claude-sonnet-4-20250514",
  provider: "anthropic",
  maxTokens: 8192,
  maxTurns: 50,
  maxConsecutiveErrors: 3,
  systemPrompt: "You are Alan, an expert software engineering assistant.",
};

// ─── Agent State ───

export type AgentState = "idle" | "thinking" | "tool_calling" | "observing" | "done" | "error";

// ─── Agent Loop ───

export class AgentLoop {
  private config: AgentLoopConfig;
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private messages: Message[] = [];
  private state: AgentState = "idle";
  private permissionCheck?: PermissionCheck;

  constructor(
    config: Partial<AgentLoopConfig>,
    gateway: LlmGateway,
    registry: ToolRegistry,
    permissionCheck?: PermissionCheck,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gateway = gateway;
    this.registry = registry;
    this.permissionCheck = permissionCheck;
    if (this.config.priorMessages && this.config.priorMessages.length > 0) {
      this.messages = [...this.config.priorMessages];
    }
  }

  getState(): AgentState {
    return this.state;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  async *run(
    userMessage: string,
    sessionId: string,
    workspaceRoot: string,
  ): AsyncGenerator<AgentTurnEvent> {
    this.state = "thinking";

    // Add user message
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userMessage }],
    });

    let turn = 0;
    let consecutiveErrors = 0;
    const recentToolSignatures: string[] = [];

    while (turn < this.config.maxTurns) {
      turn++;

      // Build inference request
      const tools = this.registry.toLlmTools();

      // Before building the request, apply context engine if available
      let requestMessages = this.messages;
      let requestSystemPrompt = this.config.systemPrompt;

      if (this.config.contextEngine) {
        const built = this.config.contextEngine.buildPrompt(
          this.config.systemPrompt || "",
          tools.length > 0 ? tools : [],
          this.messages,
        );
        requestMessages = built.messages;
        requestSystemPrompt = built.system;

        // Warn if context is getting full (items were evicted to fit budget)
        if (built.evictedCount > 0) {
          yield {
            type: "context_warning",
            message: `Context budget exceeded: ${built.evictedCount} items evicted, ${built.totalTokens} tokens used`,
          };
        }
      }

      const request: InferenceRequest = {
        messages: requestMessages,
        system: requestSystemPrompt,
        tools: tools.length > 0 ? tools : undefined,
        model: this.config.model,
        provider: this.config.provider,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        stream: true,
      };

      // Stream inference
      const contentBlocks: ContentBlock[] = [];
      let stopReason = "end_turn";
      const pendingToolCalls: Array<{
        callId: string;
        toolName: string;
        argsJson: string;
      }> = [];

      try {
        for await (const event of this.gateway.inferStream(request)) {
          const result = this.processStreamEvent(event, contentBlocks, pendingToolCalls);
          if (result.event) yield result.event;
          if (result.stopReason) stopReason = result.stopReason;
          if (result.error) {
            consecutiveErrors++;
            yield { type: "error", error: result.error, recoverable: true };
            if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
              this.state = "error";
              yield {
                type: "error",
                error: `Too many consecutive errors (${consecutiveErrors})`,
                recoverable: false,
              };
              return;
            }
            break;
          }
        }
      } catch (err) {
        consecutiveErrors++;
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: msg, recoverable: true };
        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          this.state = "error";
          yield {
            type: "error",
            error: `Too many consecutive errors (${consecutiveErrors})`,
            recoverable: false,
          };
          return;
        }
        continue;
      }

      // Record assistant message
      this.messages.push({ role: "assistant", content: contentBlocks });

      // If no tool use, we're done
      if (stopReason !== "tool_use" || pendingToolCalls.length === 0) {
        // Try summarization before finishing
        if (this.config.contextEngine) {
          await this.config.contextEngine.maybeSummarize(this.messages);
        }
        this.state = "done";
        yield { type: "turn_complete", stopReason, totalTurns: turn };
        return;
      }

      // Infinite loop detection
      const signature = pendingToolCalls.map((tc) => `${tc.toolName}:${tc.argsJson}`).join("|");
      recentToolSignatures.push(signature);
      if (recentToolSignatures.length > 10) recentToolSignatures.shift();

      const duplicateCount = recentToolSignatures.filter((s) => s === signature).length;
      if (duplicateCount >= 3) {
        this.state = "error";
        yield {
          type: "error",
          error: "Infinite loop detected: same tool calls repeated 3 times",
          recoverable: false,
        };
        return;
      }

      // Execute tool calls
      this.state = "tool_calling";
      const toolResults: ContentBlock[] = [];

      for (const tc of pendingToolCalls) {
        const parsedArgs = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        const input: ToolCallInput = {
          toolName: tc.toolName,
          callId: tc.callId,
          args: parsedArgs,
          sessionId,
          workspaceRoot,
        };

        let output: ToolCallOutput;

        // Permission gate — blocks confirm/sandbox tools until approved.
        if (this.permissionCheck) {
          const decision = await this.permissionCheck({
            callId: tc.callId,
            toolName: tc.toolName,
            args: parsedArgs,
          });
          if (!decision.allowed) {
            output = {
              callId: tc.callId,
              toolName: tc.toolName,
              success: false,
              result: "",
              error: decision.reason ?? "Permission denied",
              durationMs: 0,
            };
            yield {
              type: "tool_call_end",
              callId: tc.callId,
              args: parsedArgs,
              output,
            };
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.callId,
              toolResultContent: `Permission denied: ${output.error}`,
              isError: true,
            });
            consecutiveErrors++;
            continue;
          }
        }

        output = await this.registry.execute(input);
        yield {
          type: "tool_call_end",
          callId: tc.callId,
          args: parsedArgs,
          output,
        };

        toolResults.push({
          type: "tool_result",
          toolCallId: tc.callId,
          toolResultContent: output.success ? output.result : `Error: ${output.error}`,
          isError: !output.success,
        });

        consecutiveErrors = output.success ? 0 : consecutiveErrors + 1;
      }

      // Add tool results as user message
      this.messages.push({ role: "tool", content: toolResults });

      // After processing the assistant response, try summarization
      if (this.config.contextEngine) {
        await this.config.contextEngine.maybeSummarize(this.messages);
      }

      this.state = "observing";
    }

    // Max turns reached
    this.state = "done";
    yield {
      type: "turn_complete",
      stopReason: "max_turns",
      totalTurns: turn,
    };
  }

  private processStreamEvent(
    event: StreamEvent,
    contentBlocks: ContentBlock[],
    pendingToolCalls: Array<{ callId: string; toolName: string; argsJson: string }>,
  ): { event?: AgentTurnEvent; stopReason?: string; error?: string } {
    switch (event.type) {
      case "content_delta":
        if (event.delta.type === "text_delta") {
          // Ensure we have a text block
          if (
            contentBlocks.length === 0 ||
            contentBlocks[contentBlocks.length - 1].type !== "text"
          ) {
            contentBlocks.push({ type: "text", text: "" });
          }
          const last = contentBlocks[contentBlocks.length - 1];
          if (last.type === "text") {
            last.text += event.delta.text;
          }
          return { event: { type: "text_delta", text: event.delta.text } };
        }
        return {};

      case "tool_use_start":
        contentBlocks.push({
          type: "tool_use",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          toolInput: {},
        });
        pendingToolCalls.push({
          callId: event.toolCallId,
          toolName: event.toolName,
          argsJson: "",
        });
        return {
          event: {
            type: "tool_call_start",
            callId: event.toolCallId,
            toolName: event.toolName,
          },
        };

      case "tool_use_delta": {
        const tc = pendingToolCalls.find((t) => t.callId === event.toolCallId);
        if (tc) tc.argsJson += event.partialJson;
        return {
          event: {
            type: "tool_call_args_delta",
            callId: event.toolCallId,
            partialJson: event.partialJson,
          },
        };
      }

      case "tool_use_stop": {
        const block = contentBlocks.find(
          (b) => b.type === "tool_use" && b.toolCallId === event.toolCallId,
        );
        if (block && block.type === "tool_use") {
          block.toolInput = event.toolInput;
        }
        const pending = pendingToolCalls.find((t) => t.callId === event.toolCallId);
        if (pending) {
          pending.argsJson = JSON.stringify(event.toolInput);
        }
        return {};
      }

      case "message_stop":
        return { stopReason: event.stopReason };

      case "error":
        return { error: event.error };

      default:
        return {};
    }
  }
}
