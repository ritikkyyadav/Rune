import {
  LlmGateway,
  AnthropicProvider,
  OpenAIProvider,
  OpenRouterProvider,
  GoogleProvider,
  OllamaProvider,
  CostTracker,
} from "@alan/llm-gateway";
import type { Message, ProviderName } from "@alan/llm-gateway";
import { ToolRegistry, registerBuiltinTools, ToolRateLimiter } from "@alan/tool-registry";
import {
  SessionManager,
  hashArgs,
  hashResult,
  SqliteCheckpointStore,
  DEFAULT_CHECKPOINT_POLICY,
  createAutoVerifier,
} from "@alan/shared";
import type { CheckpointStore, CheckpointPolicy, RunState } from "@alan/shared";
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
  resumeFromCheckpoint,
} from "./session-replay";
import { ContextEngine } from "./context-engine";
import type { ContextBudget } from "./context-engine";
import { createToolExecutionGuard } from "./security";
import { MemoryManager } from "./memory/manager";
import { EpisodicMemory } from "./memory/episodic";
import { WorkingMemory } from "./memory/working";
import { HookRunner } from "./hooks";
import { createSubagentTool } from "./subagent";
import { CommandVerifier } from "./verifier";
import type { Verifier } from "./verifier";

// ─── Permission Prompt Handler ───

export interface PermissionPrompt {
  toolName: string;
  argsSummary: string;
  suggestedScope: PermissionScope;
  rawArgs: Record<string, unknown>;
}

export type UserPermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_session" }
  | { kind: "deny" };

export type PermissionHandler = (prompt: PermissionPrompt) => Promise<UserPermissionDecision>;

// ─── Engine Config ───

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface EngineConfig {
  model: string;
  provider: ProviderName;
  workspaceRoot: string;
  dbPath: string;
  toolsBinaryPath: string;
  yoloMode: boolean;
  /**
   * Auto-approve in-workspace writes/edits and bash without prompting. Out-of-workspace
   * writes and network tools still prompt. Default false.
   */
  trustWorkspace?: boolean;
  /** Enable Planner-Executor two-tier mode. */
  plannerMode: boolean;
  /** Model routing for planner-executor split. */
  routing?: Partial<ModelRouting>;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  googleApiKey?: string;
  /** Base URL for a local Ollama server (default http://localhost:11434). */
  ollamaBaseUrl?: string;
  contextBudget?: Partial<ContextBudget>;
  enableSecurity?: boolean;
  enableRateLimiting?: boolean;
  enableCheckpoints?: boolean;
  enableHooks?: boolean;
  /** Run project checks (typecheck/test/cargo) after edits so the agent self-corrects. Default on. */
  enableVerification?: boolean;
  /** Explicit verification commands; when set, project auto-detection is skipped. */
  verifyCommand?: string[];
  checkpointPolicy?: Partial<CheckpointPolicy>;
  egressAllowlist?: string[];
  redactOutputs?: boolean;
  userId?: string;
}

const EFFORT_SETTINGS: Record<EffortLevel, { maxTokens: number; maxTurns: number; label: string }> =
  {
    low: { maxTokens: 2048, maxTurns: 10, label: "Quick responses, minimal reasoning" },
    medium: { maxTokens: 8192, maxTurns: 50, label: "Balanced depth and speed (default)" },
    high: { maxTokens: 16384, maxTurns: 80, label: "Thorough analysis, deeper reasoning" },
    max: { maxTokens: 32768, maxTurns: 120, label: "Maximum capability, deepest reasoning" },
  };

// Cheaper "executor" model per provider for planner-executor routing: the
// planner keeps the session's (stronger) model; individual steps run on the
// fast model. Falls back to the session model when no fast variant is known.
const FAST_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  openrouter: "qwen/qwen3-coder:free",
  ollama: "llama3",
};

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  // Default to a known-good, free model. The previous default
  // (openrouter/deepseek-v4-flash:free) is an invalid model id that errors
  // instantly on OpenRouter, so out-of-the-box runs hit a dead model.
  model: "gemini-2.5-flash",
  provider: "google",
  workspaceRoot: process.cwd(),
  dbPath: `${process.env.HOME}/.alan/alan.db`,
  toolsBinaryPath: "alan-tools",
  yoloMode: false,
  trustWorkspace: false,
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

export class Engine {
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private permissions: PermissionBroker;
  private config: EngineConfig;
  private permissionHandler?: PermissionHandler;
  private effort: EffortLevel = "medium";
  private contextEngine: ContextEngine;
  private costTracker: CostTracker;
  private rateLimiter: ToolRateLimiter | null = null;
  private securityGuard: ReturnType<typeof createToolExecutionGuard> | null = null;
  private checkpointStore: CheckpointStore | null = null;
  private checkpointPolicy: CheckpointPolicy;
  private memoryManager: MemoryManager | null = null;
  private autoVerifier: ReturnType<typeof createAutoVerifier> | null = null;
  private currentAbort: AbortController | null = null;
  private hookRunner: HookRunner | null = null;
  private hooksLoaded = false;
  private verifier: Verifier | null = null;

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
      this.gateway.registerProvider(new AnthropicProvider(this.config.anthropicApiKey));
    }
    if (this.config.openaiApiKey || process.env.OPENAI_API_KEY) {
      this.gateway.registerProvider(new OpenAIProvider(this.config.openaiApiKey));
    }
    if (this.config.openrouterApiKey || process.env.OPENROUTER_API_KEY) {
      this.gateway.registerProvider(new OpenRouterProvider(this.config.openrouterApiKey));
    }
    if (this.config.googleApiKey || process.env.GOOGLE_API_KEY) {
      this.gateway.registerProvider(new GoogleProvider(this.config.googleApiKey));
    }
    // Local-first: register Ollama only when explicitly selected, so cloud
    // sessions never accidentally fall back to a local server.
    if (
      this.config.provider === "ollama" ||
      this.config.ollamaBaseUrl ||
      process.env.OLLAMA_HOST
    ) {
      this.gateway.registerProvider(new OllamaProvider(this.config.ollamaBaseUrl));
    }

    // Initialize Tool Registry with built-in tools
    this.registry = new ToolRegistry();
    registerBuiltinTools(this.registry, this.config.toolsBinaryPath);

    // Register the `task` sub-agent tool. It runs nested investigations against
    // a SEPARATE read-only registry (built-ins only, without `task` itself) so a
    // sub-agent can never write/execute and can never recurse into more agents.
    const subRegistry = new ToolRegistry();
    registerBuiltinTools(subRegistry, this.config.toolsBinaryPath);
    this.registry.register(
      createSubagentTool({
        gateway: this.gateway,
        registry: subRegistry,
        model: this.config.model,
        provider: this.config.provider,
      }),
    );

    // Initialize Session Manager
    this.sessions = new SessionManager(this.config.dbPath);

    // Initialize Permission Broker
    this.permissions = new PermissionBroker(this.config.yoloMode, {
      workspaceRoot: this.config.workspaceRoot,
      trustWorkspace: this.config.trustWorkspace,
    });

    // Initialize Context Engine — always on, manages token budgets
    this.contextEngine = new ContextEngine(
      { budget: this.config.contextBudget },
      this.gateway,
    );

    // Verifier — runs project checks after edits so the agent self-corrects.
    // On by default; detection is best-effort and a no-op when nothing matches.
    if (this.config.enableVerification !== false) {
      this.verifier = new CommandVerifier({
        workspaceRoot: this.config.workspaceRoot,
        commands: this.config.verifyCommand,
      });
    }

    // Initialize Cost Tracker
    this.costTracker = new CostTracker();

    // Checkpoint policy
    this.checkpointPolicy = {
      ...DEFAULT_CHECKPOINT_POLICY,
      ...this.config.checkpointPolicy,
    };

    // Security guard — on by default
    if (this.config.enableSecurity !== false) {
      this.securityGuard = createToolExecutionGuard({
        egressAllowlist: this.config.egressAllowlist,
        redactOutputs: this.config.redactOutputs ?? true,
        scanInputs: true,
      });
    }

    // Rate limiter — on by default
    if (this.config.enableRateLimiting !== false) {
      this.rateLimiter = new ToolRateLimiter();
    }

    // Checkpoint store — on by default
    if (this.config.enableCheckpoints !== false) {
      try {
        const { Database } = require("bun:sqlite");
        const db = new Database(this.config.dbPath);
        this.checkpointStore = new SqliteCheckpointStore(db);
      } catch {
        // SQLite unavailable, checkpoints disabled
      }
    }

    // Auto audit verifier
    this.autoVerifier = createAutoVerifier(this.sessions);

    // Memory manager
    try {
      const { Database } = require("bun:sqlite");
      const db = new Database(this.config.dbPath);
      const episodic = new EpisodicMemory(db);
      const working = new WorkingMemory();
      this.memoryManager = new MemoryManager(episodic, working);
    } catch {
      // Memory subsystem unavailable
    }
  }

  createSession(model?: string): string {
    const session = this.sessions.createSession(
      this.config.workspaceRoot,
      model ?? this.config.model,
    );
    return session.id;
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  /**
   * Lazily load user-defined hooks from `<workspace>/.alan/hooks.json` once per
   * engine. Missing file → no-op runner. Malformed file → warn once, run without.
   */
  private async ensureHookRunner(): Promise<void> {
    if (this.hooksLoaded) return;
    this.hooksLoaded = true;
    if (this.config.enableHooks === false) return;
    try {
      this.hookRunner = await HookRunner.load(this.config.workspaceRoot);
    } catch (err) {
      console.warn(
        `[hooks] failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.hookRunner = null;
    }
  }

  private buildPermissionCheck(): PermissionCheck {
    return async ({ toolName, args }) => {
      // Rate limiter check
      if (this.rateLimiter) {
        const rateResult = this.rateLimiter.checkLimit(toolName);
        if (!rateResult.allowed) {
          return {
            allowed: false,
            reason: `Rate limit exceeded for "${toolName}". Retry after ${rateResult.retryAfterMs}ms`,
          };
        }
      }

      // Security guard pre-execution check
      if (this.securityGuard) {
        const secResult = this.securityGuard.preExecution(toolName, args);
        if (!secResult.allowed) {
          return { allowed: false, reason: secResult.reason ?? "Blocked by security guard" };
        }
      }

      // Cost budget pre-execution check
      const estimatedCost = this.costTracker.estimateToolCost(toolName);
      if (!this.costTracker.preExecutionCheck(estimatedCost)) {
        return { allowed: false, reason: "Session cost budget exceeded" };
      }

      const handler = this.registry.get(toolName);
      if (!handler) {
        return { allowed: false, reason: `Unknown tool: ${toolName}` };
      }

      // User-defined preToolUse hooks may veto the call (e.g. protect paths).
      if (this.hookRunner) {
        const hookDecision = await this.hookRunner.runPreToolUse(toolName, args);
        if (!hookDecision.allow) {
          return {
            allowed: false,
            reason: hookDecision.reason ?? "Blocked by preToolUse hook",
          };
        }
      }

      const decision = this.permissions.check(handler.schema, args);

      if (decision.type === "allowed") {
        // Record rate limiter call on approval
        this.rateLimiter?.recordCall(toolName);
        this.autoVerifier?.onToolCall();
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
      // Record rate limiter call on approval
      this.rateLimiter?.recordCall(toolName);
      this.autoVerifier?.onToolCall();
      return { allowed: true };
    };
  }

  listSessions() {
    return this.sessions.listSessions();
  }

  /** User-message turns for a session, chronological — backs the `/rewind` UI. */
  listUserTurns(sessionId: string): { seq: number; text: string }[] {
    return this.sessions
      .getEvents(sessionId, 1)
      .filter((e) => e.event.type === "user_msg")
      .map((e) => ({
        seq: e.seq,
        text: typeof e.event.payload.content === "string" ? e.event.payload.content : "",
      }));
  }

  /** Roll a session's history back, removing everything after `afterSeq`. */
  rewindTo(sessionId: string, afterSeq: number): number {
    return this.sessions.deleteEventsAfter(sessionId, afterSeq);
  }

  /** Toggle planner-executor mode for subsequent turns. */
  setPlannerMode(enabled: boolean): void {
    this.config.plannerMode = enabled;
  }

  isPlannerMode(): boolean {
    return this.config.plannerMode;
  }

  /**
   * Chat with the agent. Uses the Planner-Executor architecture if plannerMode
   * is enabled; otherwise falls back to the flat ReAct loop.
   */
  async *chat(sessionId: string, userMessage: string): AsyncGenerator<PlanRunnerEvent> {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      yield { type: "error", error: "Session not found", recoverable: false };
      return;
    }

    const runId = `${sessionId}-${Date.now()}`;

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

    await this.ensureHookRunner();

    const permCheck = this.buildPermissionCheck();
    let turnCount = 0;

    // Create a per-turn AbortController for cancellation
    const abortController = new AbortController();
    this.currentAbort = abortController;
    const signal = abortController.signal;

    // Choose agent mode
    let runner: {
      run: (...args: [string, string, string, AbortSignal?]) => AsyncGenerator<PlanRunnerEvent>;
      getMessages: () => Message[];
    };

    const effortCfg = EFFORT_SETTINGS[this.effort];

    if (this.config.plannerMode) {
      const routing: ModelRouting = {
        planner: this.config.routing?.planner ?? session.model,
        executor:
          this.config.routing?.executor ?? FAST_MODELS[this.config.provider] ?? session.model,
        plannerProvider: this.config.routing?.plannerProvider ?? this.config.provider,
        executorProvider: this.config.routing?.executorProvider ?? this.config.provider,
      };

      runner = new PlanRunner(
        {
          routing,
          maxTokens: effortCfg.maxTokens,
          maxTurnsPerStep: Math.min(effortCfg.maxTurns, 20),
          maxStepRetries: 2,
          maxReplanAttempts: 2,
          systemPrompt: SYSTEM_PROMPT,
          priorMessages,
          contextEngine: this.contextEngine,
          verifier: this.verifier ?? undefined,
        },
        this.gateway,
        this.registry,
        permCheck,
      );
    } else {
      const loop = new AgentLoop(
        {
          model: session.model,
          provider: this.config.provider,
          maxTokens: effortCfg.maxTokens,
          maxTurns: effortCfg.maxTurns,
          systemPrompt: SYSTEM_PROMPT,
          priorMessages,
          contextEngine: this.contextEngine,
          verifier: this.verifier ?? undefined,
        },
        this.gateway,
        this.registry,
        permCheck,
      );
      runner = {
        run: (msg: string, sid: string, ws: string, sig?: AbortSignal) =>
          loop.run(msg, sid, ws, sig) as AsyncGenerator<PlanRunnerEvent>,
        getMessages: () => loop.getMessages(),
      };
    }

    let runError: string | null = null;
    try {
      for await (const event of runner.run(userMessage, sessionId, this.config.workspaceRoot, signal)) {
        if (event.type === "error" && !event.recoverable) {
          runError = event.error;
        }

        // Track turns, checkpoint, and context management
        if (event.type === "turn_complete") {
          turnCount++;

          // Checkpoint save per policy
          if (
            this.checkpointStore &&
            turnCount % this.checkpointPolicy.intervalTurns === 0
          ) {
            try {
              const state: RunState = {
                runId,
                sessionId,
                messages: runner.getMessages(),
                turnCount,
                context: { effort: this.effort, model: session.model },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              this.checkpointStore.save(runId, state);
            } catch {
              // Checkpoint save failed — non-fatal
            }
          }

          this.sessions.appendEvent(sessionId, {
            type: "checkpoint",
            payload: { summary: `auto-checkpoint at turn ${turnCount}` },
          });
        }

        // Audit tool calls with security post-processing
        if (event.type === "tool_call_end") {
          // Redact sensitive data from tool output before persisting
          const resultContent = event.output.success
            ? event.output.result
            : (event.output.error ?? "");
          const safeResult = this.securityGuard
            ? this.securityGuard.postExecution(resultContent)
            : resultContent;

          this.sessions.appendAuditEntry({
            sessionId,
            toolName: event.output.toolName,
            argsHash: hashArgs(event.args),
            resultHash: hashResult(safeResult),
            durationMs: event.output.durationMs,
            exitCode: event.output.success ? 0 : 1,
          });

          // Fire user-defined postToolUse hooks (e.g. auto-format/lint after writes).
          if (this.hookRunner) {
            await this.hookRunner.runPostToolUse(event.output.toolName, event.output);
          }

          // Save checkpoint after successful file writes
          if (
            this.checkpointStore &&
            this.checkpointPolicy.onToolSuccess &&
            event.output.success &&
            ["write_file", "edit_file"].includes(event.output.toolName)
          ) {
            try {
              const state: RunState = {
                runId,
                sessionId,
                messages: runner.getMessages(),
                turnCount,
                context: { effort: this.effort, model: session.model },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              this.checkpointStore.save(runId, state);
            } catch {
              // Non-fatal
            }
          }
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

      // Mark session as cleanly ended
      this.sessions.appendEvent(sessionId, {
        type: "checkpoint",
        payload: { summary: "session_ended" },
      });

      // Episodic memory: extract facts from this run
      if (this.memoryManager && this.config.userId) {
        const summary = `User asked: "${userMessage.slice(0, 200)}". Turns: ${turnCount}. ${runError ? `Error: ${runError}` : "Completed successfully."}`;
        this.memoryManager.onRunComplete(this.config.userId, summary).catch(() => {});
      }

      // Clear the abort controller reference when the run is done
      if (this.currentAbort === abortController) {
        this.currentAbort = null;
      }
    }
  }

  /**
   * Abort the currently running chat() generator, if any.
   * The in-flight AgentLoop will stop cleanly at the next safe checkpoint
   * and yield a turn_complete with stopReason "aborted".
   */
  abort(): void {
    this.currentAbort?.abort();
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

  /** Switch model and/or provider at runtime. */
  switchModel(model: string, provider?: ProviderName, sessionId?: string): void {
    this.config.model = model;
    if (provider) {
      this.config.provider = provider;
      this.gateway = new LlmGateway({
        providers: {},
        defaultProvider: provider,
        maxRetries: 3,
        retryBaseMs: 1000,
      });
      // Re-register all providers
      if (this.config.anthropicApiKey || process.env.ANTHROPIC_API_KEY) {
        this.gateway.registerProvider(new AnthropicProvider(this.config.anthropicApiKey));
      }
      if (this.config.openaiApiKey || process.env.OPENAI_API_KEY) {
        this.gateway.registerProvider(new OpenAIProvider(this.config.openaiApiKey));
      }
      if (this.config.openrouterApiKey || process.env.OPENROUTER_API_KEY) {
        this.gateway.registerProvider(new OpenRouterProvider(this.config.openrouterApiKey));
      }
      if (this.config.googleApiKey || process.env.GOOGLE_API_KEY) {
        this.gateway.registerProvider(new GoogleProvider(this.config.googleApiKey));
      }
    }
    // Update the session record so chat() picks up the new model
    if (sessionId) {
      this.sessions.updateSessionModel(sessionId, model);
    }
  }

  getModel(): string {
    return this.config.model;
  }

  getProvider(): ProviderName {
    return this.config.provider;
  }

  getRegisteredProviders(): ProviderName[] {
    const providers: ProviderName[] = [];
    for (const name of [
      "anthropic",
      "openai",
      "openrouter",
      "google",
      "ollama",
    ] as ProviderName[]) {
      if (this.gateway.getProvider(name)) providers.push(name);
    }
    return providers;
  }

  setEffort(level: EffortLevel): void {
    this.effort = level;
  }

  getEffort(): EffortLevel {
    return this.effort;
  }

  getEffortSettings(): { maxTokens: number; maxTurns: number; label: string } {
    return EFFORT_SETTINGS[this.effort];
  }

  getContextUsage(): { used: number; limit: number; percent: number } {
    return this.contextEngine.getContextUsage();
  }

  getSecurityPosture(): "strict" | "standard" | "permissive" | "yolo" {
    if (this.config.yoloMode) return "yolo";
    if (this.securityGuard && this.rateLimiter) return "strict";
    if (this.securityGuard || this.rateLimiter) return "standard";
    return "permissive";
  }

  getAuditStats() {
    return this.autoVerifier?.getStats() ?? { totalCalls: 0, lastVerified: null, isValid: true };
  }

  getCostBreakdown() {
    return this.costTracker.getBreakdown();
  }

  getStatus(sessionId?: string): {
    model: string;
    provider: ProviderName;
    effort: EffortLevel;
    effortLabel: string;
    workspace: string;
    plannerMode: boolean;
    yoloMode: boolean;
    trustWorkspace: boolean;
    registeredProviders: ProviderName[];
    cost: number;
    sessionId?: string;
    contextUsage: { used: number; limit: number; percent: number };
    securityPosture: string;
  } {
    return {
      model: this.config.model,
      provider: this.config.provider,
      effort: this.effort,
      effortLabel: EFFORT_SETTINGS[this.effort].label,
      workspace: this.config.workspaceRoot,
      plannerMode: this.config.plannerMode,
      yoloMode: this.config.yoloMode,
      trustWorkspace: this.permissions.isTrustWorkspace(),
      registeredProviders: this.getRegisteredProviders(),
      cost: this.getCost(),
      sessionId,
      contextUsage: this.getContextUsage(),
      securityPosture: this.getSecurityPosture(),
    };
  }

  close(): void {
    this.sessions.close();
  }
}
