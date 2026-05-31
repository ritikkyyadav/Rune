import {
  LlmGateway,
  AnthropicProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from "@alan/llm-gateway";
import type { Message, ProviderName } from "@alan/llm-gateway";
import { ToolRegistry, registerBuiltinTools } from "@alan/tool-registry";
import { SessionManager, hashArgs, hashResult } from "@alan/shared";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck, AgentTurnEvent } from "./agent-loop";
import { PermissionBroker } from "./permissions";
import type { PermissionScope } from "./permissions";
import { PlanRunner } from "./plan-runner";
import type { PlanRunnerEvent } from "./plan-runner";
import type { ModelRouting } from "./types";
import {
  eventsToMessages,
  messageToAssistantPayload,
  messageToToolResultPayloads,
} from "./session-replay";

// ─── Permission Prompt Handler ───

/** Data surfaced to the permission handler before a confirm/sandbox tool runs. */
export interface PermissionPrompt {
  toolName: string;
  /** Human-readable summary of the arguments passed to the tool. */
  argsSummary: string;
  /** Scope the broker suggests the user grant if they allow the call. */
  suggestedScope: PermissionScope;
  rawArgs: Record<string, unknown>;
}

/** Decision returned by the UI after showing a permission prompt. */
export type UserPermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_session" }
  | { kind: "deny" };

/**
 * Callback invoked whenever a tool requires user confirmation.
 * Pause the spinner, show the prompt, resolve with the user's choice.
 */
export type PermissionHandler = (
  prompt: PermissionPrompt,
) => Promise<UserPermissionDecision>;

// ─── Engine Config ───

/** Full configuration for an Engine instance. All fields have defaults. */
export interface EngineConfig {
  /** Model identifier forwarded to the LLM provider (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Which LLM provider to use by default. */
  provider: ProviderName;
  /** Absolute path to the project root the agent will operate on. */
  workspaceRoot: string;
  /** Path to the SQLite session database (defaults to ~/.alan/alan.db). */
  dbPath: string;
  /** Path or name of the alan-tools binary. */
  toolsBinaryPath: string;
  /** When true, all tool permission checks are bypassed. */
  yoloMode: boolean;
  /** Enable Planner-Executor two-tier mode. */
  plannerMode: boolean;
  /** Model routing for planner-executor split. */
  routing?: Partial<ModelRouting>;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  model: "deepseek/deepseek-v4-flash:free",
  provider: "openrouter",
  workspaceRoot: process.cwd(),
  dbPath: `${process.env.HOME}/.alan/alan.db`,
  toolsBinaryPath: "alan-tools",
  yoloMode: false,
  plannerMode: false,
};

// ─── System Prompt ───

const SYSTEM_PROMPT = `You are Alan, an expert software engineering assistant built by Savoir Studio.

You have access to tools for reading files, editing code, searching, and running commands.
Always read files before editing them. Use the file hash from read_file in edit_file to prevent stale edits.

When making code changes:
1. Read the relevant files first to understand context
2. Make targeted, minimal edits
3. Verify changes compile/pass tests when possible

Be concise and direct. Focus on solving the user's problem.`;

// ─── Engine ───

/**
 * Top-level Alan engine. Wires together the session store, LLM gateway,
 * tool registry, permission broker, and agent loop into a single interface.
 *
 * @example
 * ```ts
 * const engine = new Engine({ provider: "anthropic", workspaceRoot: "/my/project" });
 * const sessionId = engine.createSession();
 * for await (const event of engine.chat(sessionId, "Refactor the auth module")) {
 *   if (event.type === "text_delta") process.stdout.write(event.text);
 * }
 * engine.close();
 * ```
 */
export class Engine {
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private permissions: PermissionBroker;
  private config: EngineConfig;
  private permissionHandler?: PermissionHandler;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

    // Initialize LLM Gateway
    this.gateway = new LlmGateway({
      providers: {},
      defaultProvider: this.config.provider,
      maxRetries: 3,
      retryBaseMs: 1000,
    });

    // Register providers
    if (this.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY) {
      this.gateway.registerProvider(
        new AnthropicProvider(this.config.anthropicApiKey),
      );
    }
    if (this.config.openaiApiKey || process.env.OPENAI_API_KEY) {
      this.gateway.registerProvider(
        new OpenAIProvider(this.config.openaiApiKey),
      );
    }
    if (this.config.openrouterApiKey || process.env.OPENROUTER_API_KEY) {
      this.gateway.registerProvider(
        new OpenRouterProvider(this.config.openrouterApiKey),
      );
    }

    // Initialize Tool Registry with built-in tools
    this.registry = new ToolRegistry();
    registerBuiltinTools(this.registry, this.config.toolsBinaryPath);

    // Initialize Session Manager
    this.sessions = new SessionManager(this.config.dbPath);

    // Initialize Permission Broker
    this.permissions = new PermissionBroker(this.config.yoloMode);
  }

  /** Create a new session for the configured workspace. Returns the session ID. */
  createSession(model?: string): string {
    const session = this.sessions.createSession(
      this.config.workspaceRoot,
      model ?? this.config.model,
    );
    return session.id;
  }

  /**
   * Register the UI callback that is invoked when a tool requires confirmation.
   * Must be set before `chat()` is called if `yoloMode` is false.
   */
  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  private buildPermissionCheck(): PermissionCheck {
    return async ({ toolName, args }) => {
      const handler = this.registry.get(toolName);
      if (!handler) {
        return { allowed: false, reason: `Unknown tool: ${toolName}` };
      }

      const decision = this.permissions.check(handler.schema, args);

      if (decision.type === "allowed") {
        return { allowed: true };
      }
      if (decision.type === "denied") {
        return { allowed: false, reason: decision.reason };
      }

      if (!this.permissionHandler) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" requires confirmation but no handler is registered`,
        };
      }

      const userDecision = await this.permissionHandler({
        toolName: decision.tool,
        argsSummary: decision.argsSummary,
        suggestedScope: decision.suggestedScope,
        rawArgs: args,
      });

      if (userDecision.kind === "deny") {
        return { allowed: false, reason: "User denied" };
      }
      if (userDecision.kind === "allow_session") {
        this.permissions.grantTool(toolName, "session");
      }
      return { allowed: true };
    };
  }

  listSessions() {
    return this.sessions.listSessions();
  }

  /**
   * Chat with the agent. Uses the Planner-Executor architecture if plannerMode
   * is enabled; otherwise falls back to the flat ReAct loop.
   */
  async *chat(
    sessionId: string,
    userMessage: string,
  ): AsyncGenerator<PlanRunnerEvent> {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      yield { type: "error", error: "Session not found", recoverable: false };
      return;
    }

    // Load prior conversation history
    const priorEvents = this.sessions.getEvents(sessionId, 1);
    const priorMessages: Message[] = eventsToMessages(priorEvents);

    // Persist user message
    this.sessions.appendEvent(sessionId, {
      type: "user_msg",
      payload: { content: userMessage },
    });

    // Mark session as running for crash recovery
    this.sessions.appendEvent(sessionId, {
      type: "checkpoint",
      payload: { summary: "session_started" },
    });

    const permCheck = this.buildPermissionCheck();
    let turnCount = 0;

    // Choose agent mode
    let runner: { run: (...args: [string, string, string]) => AsyncGenerator<PlanRunnerEvent>; getMessages: () => Message[] };

    if (this.config.plannerMode) {
      const routing: ModelRouting = {
        planner: this.config.routing?.planner ?? session.model,
        executor: this.config.routing?.executor ?? session.model,
        plannerProvider: this.config.routing?.plannerProvider ?? this.config.provider,
        executorProvider: this.config.routing?.executorProvider ?? this.config.provider,
      };

      runner = new PlanRunner(
        {
          routing,
          maxTokens: 8192,
          maxTurnsPerStep: 20,
          maxStepRetries: 2,
          maxReplanAttempts: 2,
          systemPrompt: SYSTEM_PROMPT,
          priorMessages,
        },
        this.gateway,
        this.registry,
        permCheck,
      );
    } else {
      // Flat ReAct loop (original behavior)
      const loop = new AgentLoop(
        {
          model: session.model,
          provider: this.config.provider,
          systemPrompt: SYSTEM_PROMPT,
          priorMessages,
        },
        this.gateway,
        this.registry,
        permCheck,
      );
      runner = {
        run: (msg: string, sid: string, ws: string) => loop.run(msg, sid, ws) as AsyncGenerator<PlanRunnerEvent>,
        getMessages: () => loop.getMessages(),
      };
    }

    let runError: string | null = null;
    try {
      for await (const event of runner.run(
        userMessage,
        sessionId,
        this.config.workspaceRoot,
      )) {
        if (event.type === "error" && !event.recoverable) {
          runError = event.error;
        }

        // Track turns and auto-checkpoint every 10
        if (event.type === "turn_complete") {
          turnCount++;
          if (turnCount % 10 === 0) {
            this.sessions.appendEvent(sessionId, {
              type: "checkpoint",
              payload: { summary: `auto-checkpoint at turn ${turnCount}` },
            });
          }
        }

        // Audit tool calls
        if (event.type === "tool_call_end") {
          this.sessions.appendAuditEntry({
            sessionId,
            toolName: event.output.toolName,
            argsHash: hashArgs(event.args),
            resultHash: hashResult(
              event.output.success
                ? event.output.result
                : event.output.error ?? "",
            ),
            durationMs: event.output.durationMs,
            exitCode: event.output.success ? 0 : 1,
          });
        }

        // Persist plan events
        if (event.type === "plan_created") {
          this.sessions.appendEvent(sessionId, {
            type: "plan_created",
            payload: { plan: event.plan },
          });
        }
        if (event.type === "plan_updated") {
          this.sessions.appendEvent(sessionId, {
            type: "plan_updated",
            payload: { plan: event.plan },
          });
        }
        if (event.type === "step_completed") {
          this.sessions.appendEvent(sessionId, {
            type: "step_completed",
            payload: {
              planId: "",
              stepIndex: event.stepIndex,
              result: event.result,
            },
          });
        }

        yield event;
      }
    } finally {
      // Persist the conversation tail
      const allMessages = runner.getMessages();
      const startIndex = priorMessages.length + 1;
      for (let i = startIndex; i < allMessages.length; i++) {
        const m = allMessages[i];
        if (m.role === "assistant") {
          const payload = messageToAssistantPayload(m);
          if (payload.content.length > 0 || payload.toolUses.length > 0) {
            this.sessions.appendEvent(sessionId, {
              type: "assistant_msg",
              payload,
            });
          }
        } else if (m.role === "tool") {
          for (const r of messageToToolResultPayloads(m)) {
            this.sessions.appendEvent(sessionId, {
              type: "tool_result",
              payload: r,
            });
          }
        }
      }
      if (runError) {
        this.sessions.appendEvent(sessionId, {
          type: "system_note",
          payload: { content: `agent loop terminated: ${runError}` },
        });
      }

      // Mark session as cleanly ended for crash recovery
      this.sessions.appendEvent(sessionId, {
        type: "checkpoint",
        payload: { summary: "session_ended" },
      });
    }
  }

  getPermissions(): PermissionBroker {
    return this.permissions;
  }

  getCost() {
    return this.gateway.getTotalCost();
  }

  verifyAuditChain() {
    return this.sessions.verifyAuditChain();
  }

  close(): void {
    this.sessions.close();
  }
}
