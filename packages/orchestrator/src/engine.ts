import { LlmGateway, CostTracker } from "@alan/llm-gateway";
import type { Message, ProviderName } from "@alan/llm-gateway";
import {
  ToolRegistry,
  registerBuiltinTools,
  ToolRateLimiter,
  McpDiscovery,
  SkillLoader,
  createSkillTool,
} from "@alan/tool-registry";
import type { PluginCatalogEntry, SkillSearchHit } from "@alan/tool-registry";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  hashArgs,
  hashResult,
  SqliteCheckpointStore,
  DEFAULT_CHECKPOINT_POLICY,
  createAutoVerifier,
  deriveSessionTitle,
  PROVIDER_PRESETS,
  getPreset,
  loadSystemMemory,
  loadSystemMemoryMeta,
  saveSystemMemory,
  saveSystemMemoryMeta,
  clearSystemMemory as clearSystemMemoryStore,
  effectiveSchedule,
  describeSchedule,
  isReflectionDue,
  estimateMemoryTokens,
  clampToBudget,
  createLogger,
} from "@alan/shared";
import type {
  CheckpointStore,
  CheckpointPolicy,
  RunState,
  CustomEndpoint,
  SessionStatus,
  SessionInfoInternal,
  SystemMemoryMeta,
} from "@alan/shared";
import { buildGateway, providerStatus } from "./provider-registry";
import type { ProviderStatusRow, BuildGatewayOpts } from "./provider-registry";
import { AgentLoop } from "./agent-loop";
import type { PermissionCheck, AgentTurnEvent } from "./agent-loop";
import { PermissionBroker, nextPermissionMode } from "./permissions";
import type { PermissionScope, PermissionMode } from "./permissions";

export type { PermissionMode } from "./permissions";
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
import {
  AGENT_DOCTRINE,
  loadProjectMemory,
  renderEnvironmentBlock,
  snapshotEnvironment,
} from "./prompts";
import { CommandVerifier } from "./verifier";
import type { Verifier } from "./verifier";
import { planResearch, runResearch as executeResearch } from "./research";
import type { ResearchDeps, PlanResearchOpts } from "./research";
import { isClarification } from "./research-types";
import type {
  ResearchClarification,
  ResearchEvent,
  ResearchOptions,
  ResearchPlan,
  ResearchReport,
} from "./research-types";

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

// ─── Transcript replay ───

/** One display line of a session's history, returned by `getTranscript` for UI replay. */
export interface TranscriptLine {
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  /** For tool lines: the structured detail needed to replay the call faithfully
   *  (target/command from the args, plus the result). The renderer uses these to
   *  show `Edited foo.ts +A -B` / `Read bar.ts` instead of a bare tool name. */
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  /** For tool lines: the tool reported an error. */
  isError?: boolean;
}

/**
 * Build display-oriented transcript lines from a session's raw event log.
 * Pure (no engine/db) so it can be unit-tested directly. Correlates each
 * `tool_result` back to the tool name announced in the preceding assistant turn.
 */
export function eventsToTranscript(
  events: Array<{ seq: number; event: { type: string; payload: Record<string, unknown> } }>,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  // callId → the tool name + the args it was called with (kept so the result
  // line can show the real target/command, not just the tool's name).
  const tools = new Map<string, { toolName: string; toolInput: Record<string, unknown> }>();

  for (const { event } of events) {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "user_msg": {
        const content = typeof p.content === "string" ? p.content : "";
        if (content.trim()) lines.push({ role: "user", text: content });
        break;
      }
      case "assistant_msg": {
        const content = typeof p.content === "string" ? p.content : "";
        if (content.trim()) lines.push({ role: "assistant", text: content });
        const toolUses = Array.isArray(p.toolUses) ? p.toolUses : [];
        for (const tu of toolUses as Array<Record<string, unknown>>) {
          if (typeof tu.callId === "string" && typeof tu.toolName === "string") {
            const toolInput =
              tu.toolInput && typeof tu.toolInput === "object"
                ? (tu.toolInput as Record<string, unknown>)
                : {};
            tools.set(tu.callId, { toolName: tu.toolName, toolInput });
          }
        }
        break;
      }
      case "tool_result": {
        const callId = typeof p.callId === "string" ? p.callId : "";
        const tu = tools.get(callId);
        lines.push({
          role: "tool",
          text: tu?.toolName ?? "tool",
          toolName: tu?.toolName ?? "tool",
          args: tu?.toolInput ?? {},
          result: typeof p.content === "string" ? p.content : "",
          isError: p.isError === true,
        });
        break;
      }
      case "compaction": {
        lines.push({ role: "note", text: "context compacted earlier in this session" });
        break;
      }
      default:
        break; // checkpoint, research_*, etc. carry no transcript line
    }
  }
  return lines;
}

/**
 * Best-effort map of a model id back to the provider that hosts it, using the
 * curated preset lists. Used when resuming a session whose provider wasn't
 * recorded (pre-migration rows). Returns undefined for unknown/custom models.
 */
function inferProviderFromModel(model: string): string | undefined {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.defaultModel === model) return preset.id;
    if (preset.models?.some((m) => m.id === model)) return preset.id;
  }
  return undefined;
}

// ─── Engine Config ───

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
  /** Keys for additional providers by id (groq/xai/deepseek/…), e.g. from the BYOK store. */
  providerKeys?: Record<string, string>;
  /** User-defined OpenAI-compatible endpoint registered as the "custom" provider. */
  customEndpoint?: CustomEndpoint;
  /** Provider ids toggled off — kept configured but excluded from the gateway. */
  disabledProviders?: string[];
  /** Base URLs for local runtimes (ollama / lmstudio) by id; overrides preset defaults. */
  localBaseUrls?: Record<string, string>;
  /** Base URL for a local Ollama server (default http://localhost:11434). */
  ollamaBaseUrl?: string;
  contextBudget?: Partial<ContextBudget>;
  enableSecurity?: boolean;
  enableRateLimiting?: boolean;
  enableCheckpoints?: boolean;
  enableHooks?: boolean;
  /** Discover and load MCP servers from <workspace>/.alan/mcp.json. Default on. */
  enableMcp?: boolean;
  /** Load skills (bundled `skills/` + <workspace>/.alan/skills) and the `skill` tool. Default on. */
  enableSkills?: boolean;
  /** Explicit skill root dirs; when set, bundled + .alan/skills auto-detection is skipped. */
  skillRoots?: string[];
  /** Run project checks (typecheck/test/cargo) after edits so the agent self-corrects. Default on. */
  enableVerification?: boolean;
  /** Explicit verification commands; when set, project auto-detection is skipped. */
  verifyCommand?: string[];
  checkpointPolicy?: Partial<CheckpointPolicy>;
  egressAllowlist?: string[];
  redactOutputs?: boolean;
  userId?: string;
  /** Web-search configuration (backend preference + native grounding). */
  search?: {
    /** Preferred web_search backend: auto | tavily | brave | duckduckgo. */
    provider?: string;
    /** Use provider-native grounding (Gemini/Anthropic) when available. Default true. */
    nativeGrounding?: boolean;
  };
  /** Deep-research ("/research") defaults: depth, fan-out, sources. */
  research?: ResearchOptions;
  /** System Memory ("dreaming") — evergreen profile config (enabled/schedule/model/maxTokens). */
  memory?: {
    enabled?: boolean;
    schedule?: string;
    model?: string;
    maxTokens?: number;
  };
}

// Generation budget per step. 8k routinely truncated multi-file edits and
// long tool-call sequences mid-response; 32k gives coding responses room.
// The agent loop clamps this to each model's real per-response output cap
// (getMaxOutputTokens), so smaller models are unaffected.
const MAX_TOKENS = 32000;
const MAX_TURNS = 50;

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
// The full doctrine, environment block, and project memory live in prompts.ts.
// SYSTEM_PROMPT is the doctrine half; the engine appends the per-session
// environment snapshot + ALAN.md/CLAUDE.md/AGENTS.md at turn start.

const SYSTEM_PROMPT = AGENT_DOCTRINE;

// ─── System Memory ("dreaming") helpers ───

// Cheap/fast model per provider for the memory distillation. The dream is just
// summarization, so default to the inexpensive tier regardless of the active
// chat model. Mirrors the summarizer fallbacks in context-engine.ts.
const MEMORY_CHEAP_MODELS: Partial<Record<ProviderName, string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
  openrouter: "qwen/qwen3-coder:free",
  groq: "llama-3.3-70b-versatile",
  xai: "grok-2-latest",
  deepseek: "deepseek-chat",
  "ollama-turbo": "qwen3-coder:480b",
  ollama: "llama3",
};

/** Max characters of any single message kept in the activity digest. */
const MEMORY_MSG_CHARS = 600;

function systemMemoryDistillSystemPrompt(maxTokens: number): string {
  return [
    "You maintain a SHORT, evergreen profile of a software developer and the codebases they work in, so an AI coding assistant (Alan) can serve them better from the very first message.",
    "",
    "Write a GUIDE, not rules. Describe — never command. This is background context the assistant tailors to, not rigid instructions.",
    "",
    "Cover, ONLY where the activity actually supports it:",
    "- About the user: who they are, how they communicate (tone, terseness, language), how they like to work, clear likes and dislikes.",
    "- Style & preferences: languages, frameworks, tools, conventions, testing/verification habits, what they value (e.g. concise answers, minimal diffs).",
    "- Their codebases: the kinds of projects Alan is used for, recurring stacks and patterns, and what they typically ask for.",
    "",
    "Rules:",
    `- Keep it SMALL — aim well under ~${maxTokens} tokens. Short markdown sections with terse bullets. It must fit a tiny model's context window like butter.`,
    "- Merge new observations INTO the existing profile: keep durable facts, update what changed, drop trivia and one-off events.",
    "- Prefer stable preferences over momentary details. NEVER invent — if the activity doesn't show it, leave it out.",
    "- No secrets, API keys, file contents, long verbatim quotes, timestamps, or session ids.",
    "- Output ONLY the profile as markdown — no preamble, no 'here is', no surrounding code fence.",
  ].join("\n");
}

function systemMemoryDistillUserPrompt(existing: string, activity: string, focus?: string): string {
  const f = focus?.trim() ? `\n\nThe user asked you to focus on: ${focus.trim()}` : "";
  return [
    "EXISTING PROFILE (may be empty):",
    existing.trim() || "(empty — this is the first profile)",
    "",
    "RECENT ACTIVITY (newest first; user/assistant turns and which tools ran):",
    activity.trim(),
    f,
    "",
    "Return the full updated profile in markdown, ready to replace the existing one.",
  ].join("\n");
}

/** Compact one message to a single signal-rich line (skips bulky tool outputs). */
function compactMessageText(m: Message): string {
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text" && b.text.trim()) parts.push(b.text.trim());
    else if (b.type === "tool_use") parts.push(`[used ${b.toolName}]`);
    // tool_result bodies are intentionally dropped — noisy and large.
  }
  const body = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!body) return "";
  const role = m.role === "assistant" ? "Alan" : m.role === "user" ? "User" : m.role;
  return `${role}: ${body.slice(0, MEMORY_MSG_CHARS)}`;
}

/**
 * Build a compact, recency-first digest of one session's messages within a token
 * budget, then restore chronological order. Returns "" when nothing useful fits.
 */
function digestSessionMessages(
  messages: Message[],
  session: SessionInfoInternal,
  tokenCap: number,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = compactMessageText(messages[i]);
    if (!text) continue;
    const t = Math.ceil(text.length / 4);
    if (used + t > tokenCap) break;
    lines.push(text);
    used += t;
  }
  if (!lines.length) return "";
  lines.reverse();
  const label = session.title?.trim() || session.id.slice(0, 8);
  return `Session "${label}" (${session.workspaceRoot}):\n${lines.join("\n")}`;
}

// ─── Engine ───

/** Result of a runtime key/toggle/endpoint change that may force a model switch. */
export interface ProviderChangeResult {
  /** Set when the active provider became unusable and we auto-moved the session. */
  switchedTo?: { provider: ProviderName; model: string };
}

export class Engine {
  private gateway: LlmGateway;
  private registry: ToolRegistry;
  private sessions: SessionManager;
  private permissions: PermissionBroker;
  private config: EngineConfig;
  private permissionHandler?: PermissionHandler;
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
  private mcpDiscovery: McpDiscovery | null = null;
  private mcpLoaded = false;
  private skillLoader: SkillLoader | null = null;
  private skillsLoaded = false;
  private skillCatalog = "";
  // BYOK key state — the single source of truth the gateway is (re)built from.
  private providerKeys: Record<string, string> = {};
  private customEndpoint?: CustomEndpoint;
  private disabledProviders: Set<string> = new Set();
  // Base URLs for local runtimes (ollama / lmstudio), live-editable via /keys.
  private localBaseUrls: Record<string, string> = {};
  // Guards against overlapping System Memory "dreams" (auto + manual at once).
  private memoryReflecting = false;
  // Per-session environment snapshot (cwd/platform/git state at session start).
  // Cached so the system prompt stays byte-stable across turns — a churning
  // prompt would invalidate the provider's prefix cache on every call.
  private envBlocks: Map<string, string> = new Map();

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

    // Seed BYOK key state from config, then build the gateway. The named
    // *ApiKey fields and the generic providerKeys map are merged into one
    // id→key table (providerKeys wins) that every (re)build reads from — so a
    // key added at runtime takes effect by simply rebuilding.
    this.providerKeys = {
      ...(this.config.anthropicApiKey ? { anthropic: this.config.anthropicApiKey } : {}),
      ...(this.config.openaiApiKey ? { openai: this.config.openaiApiKey } : {}),
      ...(this.config.openrouterApiKey ? { openrouter: this.config.openrouterApiKey } : {}),
      ...(this.config.googleApiKey ? { google: this.config.googleApiKey } : {}),
      ...(this.config.providerKeys ?? {}),
    };
    this.customEndpoint = this.config.customEndpoint;
    this.disabledProviders = new Set(this.config.disabledProviders ?? []);
    this.localBaseUrls = { ...(this.config.localBaseUrls ?? {}) };
    this.gateway = buildGateway(this.gatewayOpts());

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

    // Initialize Context Engine — always on, manages token budgets. Seed the
    // summarizer with the active model/provider (not the anthropic default) so
    // /compress and rolling compaction work on whatever provider is in use.
    this.contextEngine = new ContextEngine(
      {
        budget: this.config.contextBudget,
        summarizerModel: this.config.model,
        summarizerProvider: this.config.provider,
      },
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
      this.config.provider,
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
      console.warn(`[hooks] failed to load: ${err instanceof Error ? err.message : String(err)}`);
      this.hookRunner = null;
    }
  }

  /**
   * Lazily discover MCP servers from `<workspace>/.alan/mcp.json` once per
   * engine and register their tools into the main registry. Missing file →
   * no-op. A server that fails to start is logged and skipped (mirrors hooks).
   * MCP tools are NOT added to the read-only sub-agent registry.
   */
  private async ensureMcpServers(): Promise<void> {
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    if (this.config.enableMcp === false) return;
    const logger = createLogger("mcp");
    try {
      this.mcpDiscovery = new McpDiscovery(this.config.workspaceRoot, {
        logger,
        // Live tool-list changes (or a server restart) reconcile the registry so
        // the model always sees the current tool set without a session restart.
        onToolsChanged: () => this.reconcileMcpTools(),
      });
      const handlers = await this.mcpDiscovery.discover();
      for (const handler of handlers) {
        this.registry.register(handler);
      }
    } catch (err) {
      logger.warn(`discovery failed: ${err instanceof Error ? err.message : String(err)}`);
      this.mcpDiscovery = null;
    }
  }

  /** Reconcile registered MCP tools against the discovery's current set: drop
   *  tools that disappeared, (re)register the rest. Safe to call repeatedly. */
  private reconcileMcpTools(): void {
    if (!this.mcpDiscovery) return;
    const current = this.mcpDiscovery.getHandlers();
    const wanted = new Set(current.map((h) => h.schema.name));
    for (const schema of this.registry.list()) {
      if (schema.name.startsWith("mcp_") && !wanted.has(schema.name)) {
        this.registry.unregister(schema.name);
      }
    }
    for (const handler of current) this.registry.register(handler);
  }

  /** Ensure MCP servers are discovered, then return their status (backs `/mcp`). */
  async listMcpServers(): Promise<ReturnType<McpDiscovery["getStatus"]>> {
    await this.ensureMcpServers();
    return this.mcpDiscovery?.getStatus() ?? [];
  }

  /**
   * Lazily load skills once per engine: discover SKILL.md files from the bundled
   * `skills/` catalog and `<workspace>/.alan/skills`, register the `skill` tool,
   * and build the compact catalog injected into the system prompt. Missing dirs →
   * no-op. Any failure is logged and skipped (mirrors hooks/MCP) — skills never
   * break a session. Not added to the read-only sub-agent registry.
   */
  private async ensureSkills(): Promise<void> {
    if (this.skillsLoaded) return;
    this.skillsLoaded = true;
    if (this.config.enableSkills === false) return;
    try {
      const roots = this.resolveSkillRoots();
      if (roots.length === 0) return;
      this.skillLoader = new SkillLoader({ roots });
      await this.skillLoader.loadAll();
      if (this.skillLoader.count() > 0) {
        this.registry.register(createSkillTool(this.skillLoader));
        this.skillCatalog = this.skillLoader.catalogPrompt();
      }
    } catch (err) {
      console.warn(`[skills] load failed: ${err instanceof Error ? err.message : String(err)}`);
      this.skillLoader = null;
    }
  }

  /**
   * Resolve which directories to scan for skills. Explicit `skillRoots` win;
   * otherwise use the bundled catalog (resolved relative to this module, with an
   * ALAN_SKILLS_DIR / cwd fallback) plus the workspace's `.alan/skills`.
   */
  private resolveSkillRoots(): string[] {
    if (this.config.skillRoots && this.config.skillRoots.length > 0) {
      return this.config.skillRoots.filter((r) => existsSync(r));
    }
    const candidates = [
      process.env.ALAN_SKILLS_DIR,
      join(import.meta.dir, "../../../skills"), // packages/orchestrator/src → repo root
      join(process.cwd(), "skills"),
    ].filter((c): c is string => typeof c === "string" && c.length > 0);

    const roots: string[] = [];
    for (const c of candidates) {
      if (existsSync(c)) {
        roots.push(c);
        break; // one bundled catalog is enough
      }
    }
    const userSkills = join(this.config.workspaceRoot, ".alan", "skills");
    if (existsSync(userSkills)) roots.push(userSkills);
    return roots;
  }

  /** Ensure skills are loaded, then return them grouped by plugin (backs `/skills`). */
  async listSkills(): Promise<{ total: number; plugins: PluginCatalogEntry[] }> {
    await this.ensureSkills();
    return { total: this.skillLoader?.count() ?? 0, plugins: this.skillLoader?.catalog() ?? [] };
  }

  /** Ensure skills are loaded, then rank them against a query (backs `/skills <query>`). */
  async searchSkills(query: string): Promise<SkillSearchHit[]> {
    await this.ensureSkills();
    return this.skillLoader?.search(query) ?? [];
  }

  /** Loaded skill count without triggering discovery (for `/status`). */
  getSkillCount(): number {
    return this.skillLoader?.count() ?? 0;
  }

  /** Current MCP server status without triggering discovery. */
  getMcpStatus(): ReturnType<McpDiscovery["getStatus"]> {
    return this.mcpDiscovery?.getStatus() ?? [];
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

  /** Sessions for the manager. Defaults to active; pass a status (or "all") for archived/deleted. */
  listSessions(opts?: { status?: SessionStatus | "all" }) {
    return this.sessions.listSessions(opts);
  }

  /** A single session regardless of status (active/archived/deleted). */
  getSessionInfo(sessionId: string): SessionInfoInternal | null {
    return this.sessions.getSessionInfo(sessionId);
  }

  /** Rename a session (the title shown in the manager). Empty clears back to the auto-title slot. */
  renameSession(sessionId: string, title: string): void {
    this.sessions.renameSession(sessionId, title);
  }

  /** Hide a session from the default list without losing its data (reversible via restoreSession). */
  archiveSession(sessionId: string): void {
    this.sessions.setSessionStatus(sessionId, "archived");
  }

  /** Bring an archived/deleted session back into the active list. */
  restoreSession(sessionId: string): void {
    this.sessions.setSessionStatus(sessionId, "active");
  }

  /** Soft-delete: hidden everywhere but recoverable until purged. */
  deleteSession(sessionId: string): void {
    this.sessions.setSessionStatus(sessionId, "deleted");
  }

  /** Permanently destroy a session and every event/file/permission it owns. Irreversible. */
  purgeSession(sessionId: string): number {
    return this.sessions.purgeSession(sessionId);
  }

  /**
   * The session's conversation as display-oriented lines (user / assistant /
   * tool / note), for replaying history into the UI when a session is resumed.
   * Formatting (colour/theme) is the UI's job — this stays presentation-agnostic.
   */
  getTranscript(sessionId: string): TranscriptLine[] {
    return eventsToTranscript(this.sessions.getEvents(sessionId, 1));
  }

  /**
   * Resume a session for continued chat. Restores it to active if it was
   * archived/deleted and reconciles the active model+provider to the ones the
   * session ran on — so a qwen/Ollama session isn't accidentally sent to Google
   * after a /model switch. Provider comes from the stored column when present,
   * else is inferred from the model id, else the current provider is kept.
   * Returns the resolved session info (null if it doesn't exist).
   */
  resumeSession(sessionId: string): {
    session: SessionInfoInternal;
    switched: boolean;
    providerKnown: boolean;
  } | null {
    const info = this.sessions.getSessionInfo(sessionId);
    if (!info) return null;
    if (info.status !== "active") this.sessions.setSessionStatus(sessionId, "active");

    const wanted = info.provider ?? inferProviderFromModel(info.model);
    const registered = this.getRegisteredProviders();
    let switched = false;
    const providerKnown = !!wanted;
    if (
      wanted &&
      registered.includes(wanted as ProviderName) &&
      (wanted !== this.config.provider || info.model !== this.config.model)
    ) {
      this.switchModel(info.model, wanted as ProviderName, sessionId);
      switched = true;
    } else if (info.model !== this.config.model && wanted === this.config.provider) {
      // Same provider, different model — adopt the session's model.
      this.switchModel(info.model, undefined, sessionId);
      switched = true;
    }
    return { session: { ...info, status: "active" }, switched, providerKnown };
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

  /**
   * Manually compact a session (`/compress`): summarize the entire conversation
   * so far into one summary and append a `compaction` event. Subsequent turns
   * replay the summary in place of the full history, freeing context — while
   * the underlying event log stays intact for audit/replay.
   *
   * @param instructions Optional focus, e.g. "keep the API contract details".
   * @returns stats on success, or { compacted: false, reason } when there is
   *          nothing to compact or summarization failed.
   */
  async compactSession(
    sessionId: string,
    instructions?: string,
  ): Promise<
    | { compacted: false; reason: string }
    | {
        compacted: true;
        summary: string;
        originalMessages: number;
        sourceTokens: number;
        summaryTokens: number;
      }
  > {
    const session = this.sessions.getSession(sessionId);
    if (!session) return { compacted: false, reason: "session not found" };

    const events = this.sessions.getEvents(sessionId, 1);
    const messages = eventsToMessages(events);

    // Need a couple of exchanges before compaction is worthwhile.
    if (messages.length < 2) {
      return { compacted: false, reason: "not enough conversation yet" };
    }

    const result = await this.contextEngine.summarizeConversation(messages, instructions);
    if (!result) return { compacted: false, reason: "summarization failed" };

    const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0;
    this.sessions.appendEvent(sessionId, {
      type: "compaction",
      payload: {
        summary: result.summary,
        replacedThroughSeq: lastSeq,
        originalMessages: messages.length,
        sourceTokens: result.sourceTokens,
        summaryTokens: result.summaryTokens,
        trigger: "manual",
        ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
      },
    });

    return {
      compacted: true,
      summary: result.summary,
      originalMessages: messages.length,
      sourceTokens: result.sourceTokens,
      summaryTokens: result.summaryTokens,
    };
  }

  // ─── System Memory ("dreaming") ───
  //
  // An evergreen, narrative profile of the user and their codebases, stored at
  // ~/.alan/system-memory.md (see @alan/shared system-memory.ts) and injected into
  // every session's system prompt. Small by design so even tiny models load it
  // cheaply. Refreshed manually (`/memory update`) or automatically on a cadence.

  /** Resolved memory config with defaults applied. */
  private memoryConfig(): { enabled: boolean; schedule: string; model: string; maxTokens: number } {
    const m = this.config.memory ?? {};
    return {
      enabled: m.enabled !== false,
      schedule: m.schedule ?? "manual",
      model: m.model ?? "cheapest",
      maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 1500,
    };
  }

  /** Current memory + status, for the `/memory` panel and the desktop Settings UI. */
  getSystemMemory(): {
    content: string;
    meta: SystemMemoryMeta;
    enabled: boolean;
    schedule: string;
    scheduleLabel: string;
    tokens: number;
    maxTokens: number;
  } {
    const cfg = this.memoryConfig();
    const { content, meta } = loadSystemMemory();
    const schedule = effectiveSchedule(meta, cfg.schedule);
    return {
      content,
      meta,
      enabled: cfg.enabled,
      schedule,
      scheduleLabel: describeSchedule(schedule),
      tokens: estimateMemoryTokens(content),
      maxTokens: cfg.maxTokens,
    };
  }

  /** Set the auto-refresh cadence live (persisted to the meta sidecar, overrides config). */
  setSystemMemorySchedule(schedule: string): { schedule: string; label: string } {
    saveSystemMemoryMeta({ schedule });
    return { schedule, label: describeSchedule(schedule) };
  }

  /** Replace the whole memory (desktop save / post-$EDITOR round-trip). Clamps to budget. */
  setSystemMemoryContent(content: string): { tokens: number } {
    const cfg = this.memoryConfig();
    const clamped = clampToBudget(content, cfg.maxTokens);
    saveSystemMemory(clamped, {
      updatedAt: new Date().toISOString(),
      tokens: estimateMemoryTokens(clamped),
    });
    return { tokens: estimateMemoryTokens(clamped) };
  }

  /** Quick manual capture: append a dated note under a "Notes" heading, then clamp. */
  appendSystemMemoryNote(text: string): { tokens: number } {
    const note = text.trim();
    const { content } = loadSystemMemory();
    if (!note) return { tokens: estimateMemoryTokens(content) };
    const stamp = new Date().toISOString().slice(0, 10);
    let next: string;
    if (/(^|\n)#{1,6}\s*Notes\b/i.test(content)) {
      // Insert under the existing Notes heading.
      next = content.replace(/(#{1,6}\s*Notes\b[^\n]*\n)/i, `$1- (${stamp}) ${note}\n`);
    } else {
      next = `${content ? content + "\n\n" : ""}## Notes\n- (${stamp}) ${note}`;
    }
    return this.setSystemMemoryContent(next);
  }

  /** Wipe the memory (keeps the chosen cadence, resets the dream bookkeeping). */
  clearSystemMemory(): void {
    clearSystemMemoryStore();
  }

  /** Ordered provider/model candidates for the dream, per the configured preference. */
  private memoryModelCandidates(
    modelPref: string,
  ): Array<{ provider: ProviderName; model: string }> {
    const registered = this.gateway.getRegisteredProviderNames();
    const active = this.config.provider;
    const order = [active, ...registered.filter((p) => p !== active)].filter((p) =>
      registered.includes(p),
    );
    const cheap = (p: ProviderName) => MEMORY_CHEAP_MODELS[p] ?? this.config.model;

    // Explicit "provider/model" (note: model ids may contain '/', so split once).
    if (
      modelPref &&
      modelPref !== "cheapest" &&
      modelPref !== "active" &&
      modelPref.includes("/")
    ) {
      const slash = modelPref.indexOf("/");
      const prov = modelPref.slice(0, slash) as ProviderName;
      const model = modelPref.slice(slash + 1);
      if (registered.includes(prov) && model) {
        const rest = order.map((p) => ({ provider: p, model: cheap(p) }));
        return [{ provider: prov, model }, ...rest];
      }
    }
    if (modelPref === "active") {
      return order.map((p) => ({
        provider: p,
        model: p === active ? this.config.model : cheap(p),
      }));
    }
    return order.map((p) => ({ provider: p, model: cheap(p) }));
  }

  /**
   * Gather new activity since the last fold, newest sessions first, token-capped.
   * Returns the digest text plus the per-session high-water seq to record so the
   * next dream skips what's already been learned.
   */
  private collectActivityDigest(
    meta: SystemMemoryMeta,
    tokenCap: number,
  ): { text: string; foldedSeqBySession: Record<string, number> } {
    const folded = meta.foldedSeqBySession ?? {};
    const sessions = this.sessions.listSessions({ status: "all" }); // newest-activity first
    const chunks: string[] = [];
    const newFolded: Record<string, number> = {};
    let budget = tokenCap;

    for (const s of sessions) {
      if (budget <= 0) break;
      const fromSeq = (folded[s.id] ?? 0) + 1;
      const events = this.sessions.getEvents(s.id, fromSeq);
      if (events.length === 0) continue;
      const maxSeq = events[events.length - 1].seq;
      const text = digestSessionMessages(eventsToMessages(events), s, Math.min(budget, 4000));
      if (text.trim()) {
        chunks.push(text);
        budget -= estimateMemoryTokens(text);
        newFolded[s.id] = Math.max(folded[s.id] ?? 0, maxSeq);
      }
    }
    return { text: chunks.join("\n\n---\n\n"), foldedSeqBySession: newFolded };
  }

  /**
   * The "dream": distill recent activity (across all sessions) into the evergreen
   * profile. Reuses the gateway with a cheap model and walks provider candidates
   * itself (infer() does no fallback). Always feeds the existing profile so re-runs
   * refine rather than duplicate. No-ops when there is nothing new to learn from.
   */
  async reflectSystemMemory(opts: { focus?: string; trigger?: "manual" | "auto" } = {}): Promise<{
    updated: boolean;
    reason?: string;
    tokensBefore: number;
    tokensAfter: number;
    content?: string;
  }> {
    const cfg = this.memoryConfig();
    const { content: existing, meta } = loadSystemMemory();
    const tokensBefore = estimateMemoryTokens(existing);
    const unchanged = { updated: false as const, tokensBefore, tokensAfter: tokensBefore };

    if (this.memoryReflecting) {
      return { ...unchanged, reason: "a memory refresh is already running" };
    }
    if (this.gateway.getRegisteredProviderNames().length === 0) {
      return { ...unchanged, reason: "no provider configured — add a key with /keys" };
    }

    this.memoryReflecting = true;
    try {
      const digest = this.collectActivityDigest(meta, opts.trigger === "auto" ? 12000 : 20000);
      if (!digest.text.trim()) {
        return { ...unchanged, reason: "no new activity to learn from yet" };
      }

      const system = systemMemoryDistillSystemPrompt(cfg.maxTokens);
      const user = systemMemoryDistillUserPrompt(existing, digest.text, opts.focus);

      let out = "";
      for (const { provider, model } of this.memoryModelCandidates(cfg.model)) {
        try {
          const resp = await this.gateway.infer({
            messages: [{ role: "user", content: [{ type: "text", text: user }] }],
            system,
            model,
            provider,
            maxTokens: Math.min(2048, Math.ceil(cfg.maxTokens * 1.3)),
            stream: false,
          });
          const block = resp.content.find((b) => b.type === "text");
          out = block && block.type === "text" ? block.text.trim() : "";
          if (out) break;
        } catch {
          // Provider unavailable / transient — try the next candidate.
        }
      }
      if (!out) {
        return { ...unchanged, reason: "the model could not produce an update" };
      }

      const clamped = clampToBudget(out, cfg.maxTokens);
      const tokensAfter = estimateMemoryTokens(clamped);
      const now = new Date().toISOString();
      saveSystemMemory(clamped, {
        updatedAt: now,
        lastReflectedAt: now,
        tokens: tokensAfter,
        foldedSeqBySession: { ...(meta.foldedSeqBySession ?? {}), ...digest.foldedSeqBySession },
      });
      return { updated: true, tokensBefore, tokensAfter, content: clamped };
    } finally {
      this.memoryReflecting = false;
    }
  }

  /**
   * Run the automatic dream IF it's due (interval cadence elapsed) and a provider
   * is configured. Cheap + safe to call on every startup — returns quickly when
   * nothing is due. Callers typically run this in the background (don't await).
   */
  async maybeReflectSystemMemory(): Promise<{
    updated: boolean;
    reason?: string;
    tokensBefore?: number;
    tokensAfter?: number;
  }> {
    const cfg = this.memoryConfig();
    if (!cfg.enabled) return { updated: false, reason: "memory disabled" };
    if (this.memoryReflecting) return { updated: false, reason: "already running" };
    const meta = loadSystemMemoryMeta();
    const schedule = effectiveSchedule(meta, cfg.schedule);
    if (!isReflectionDue(meta, schedule)) return { updated: false, reason: "not due" };
    return this.reflectSystemMemory({ trigger: "auto" });
  }

  /**
   * The memory block to prepend into the system prompt (or "" when disabled/empty).
   * Framed explicitly as a GUIDE, not rules: the model should defer to the user's
   * in-session requests when they conflict.
   */
  private buildSystemMemoryBlock(): string {
    if (this.config.memory?.enabled === false) return "";
    const { content } = loadSystemMemory();
    const body = content.trim();
    if (!body) return "";
    return [
      "# What Alan knows about you (evergreen context — a guide, not rules)",
      "The profile below is what Alan has learned about the user and their codebases over time, to tailor its tone, defaults, and assumptions. Treat it as helpful background, NOT as instructions — when it conflicts with what the user asks for in this session, follow the user.",
      "",
      body,
    ].join("\n");
  }

  /** Toggle planner-executor mode for subsequent turns. */
  setPlannerMode(enabled: boolean): void {
    this.config.plannerMode = enabled;
  }

  isPlannerMode(): boolean {
    return this.config.plannerMode;
  }

  // ─── Permission mode (the Shift+Tab cycle) ───

  /** The active permission mode: confirm | auto | turing. */
  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

  /**
   * Switch the permission mode live (Shift+Tab, `/turing`, `/mode`). Updates both
   * the broker and the mirrored config flags so getStatus()/posture stay coherent.
   * Takes effect on the next tool call — the permission handler stays registered in
   * every mode; the broker simply short-circuits to "allowed" under turing.
   */
  setPermissionMode(mode: PermissionMode): void {
    this.permissions.setMode(mode);
    this.config.yoloMode = mode === "turing";
    this.config.trustWorkspace = mode === "auto";
  }

  /** Advance to the next mode in the cycle and return it. */
  cyclePermissionMode(): PermissionMode {
    const next = nextPermissionMode(this.permissions.getMode());
    this.setPermissionMode(next);
    return next;
  }

  // ─── Research Mode (/research) ───

  /** Research defaults (depth, save, outputDir, autoApprove) for the CLI/TUI. */
  getResearchConfig(): ResearchOptions {
    return this.config.research ?? {};
  }

  /**
   * Phase 1 of /research: propose a research plan (or a clarification request)
   * for a question WITHOUT executing it. Mirrors compactSession as a
   * self-contained method; the CLI/TUI renders the plan and gates execution.
   * Persists the proposed plan as a `research_plan` event for audit.
   */
  async proposeResearch(
    sessionId: string,
    question: string,
    opts?: PlanResearchOpts,
  ): Promise<ResearchPlan | ResearchClarification> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const plan = await planResearch(
      { gateway: this.gateway, model: session.model, provider: this.config.provider },
      question,
      { ...this.config.research, ...opts },
    );
    if (!isClarification(plan)) {
      this.sessions.appendEvent(sessionId, { type: "research_plan", payload: { plan } });
    }
    return plan;
  }

  /** Revise a proposed plan using the user's free-text feedback (no clarifying Qs). */
  async reviseResearch(
    sessionId: string,
    plan: ResearchPlan,
    feedback: string,
  ): Promise<ResearchPlan | ResearchClarification> {
    return this.proposeResearch(sessionId, plan.question, {
      priorPlan: plan,
      feedback,
      allowClarification: false,
    });
  }

  /**
   * Phase 2 of /research: execute an approved plan — fan out investigators and
   * stream a cited report. Persists the question + report into the session so
   * follow-up chat turns can reference them, plus a `research_report` audit
   * event. Honors abort() like chat().
   */
  async *runResearch(
    sessionId: string,
    plan: ResearchPlan,
    opts?: ResearchOptions,
  ): AsyncGenerator<ResearchEvent> {
    const session = this.sessions.getSession(sessionId);
    if (!session) {
      yield { type: "error", error: "Session not found", recoverable: false };
      return;
    }

    // Persist the question as a user turn so follow-up chat sees it.
    this.sessions.appendEvent(sessionId, { type: "user_msg", payload: { content: plan.question } });

    const abortController = new AbortController();
    this.currentAbort = abortController;

    const deps: ResearchDeps = {
      gateway: this.gateway,
      binaryPath: this.config.toolsBinaryPath,
      model: session.model,
      provider: this.config.provider,
      workspaceRoot: this.config.workspaceRoot,
      sessionId,
    };

    let report: ResearchReport | null = null;
    try {
      for await (const ev of executeResearch(
        deps,
        plan,
        { ...this.config.research, ...opts },
        abortController.signal,
      )) {
        if (ev.type === "research_complete") report = ev.report;
        yield ev;
      }
    } finally {
      if (report) {
        this.sessions.appendEvent(sessionId, {
          type: "assistant_msg",
          payload: { content: report.markdown, toolUses: [] },
        });
        this.sessions.appendEvent(sessionId, {
          type: "research_report",
          payload: {
            question: report.question,
            sources: report.sources.map((s) => ({ index: s.index, title: s.title, url: s.url })),
            completed: report.completed,
            failed: report.failed,
            warnings: report.warnings,
          },
        });
      }
      this.sessions.appendEvent(sessionId, {
        type: "checkpoint",
        payload: { summary: "research_ended" },
      });
      if (this.currentAbort === abortController) this.currentAbort = null;
    }
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

    // Auto-name the session from its first real message so the manager shows a
    // readable title instead of a bare UUID. No-op once a title exists (manual
    // renames and later turns never clobber it).
    if (!session.title && userMessage.trim()) {
      this.sessions.setTitleIfEmpty(sessionId, deriveSessionTitle(userMessage));
    }

    // Mark session as running for crash recovery
    this.sessions.appendEvent(sessionId, {
      type: "checkpoint",
      payload: { summary: "session_started" },
    });

    await this.ensureHookRunner();
    await this.ensureMcpServers();
    await this.ensureSkills();

    // Assemble the system prompt: doctrine + environment snapshot + project
    // memory (ALAN.md/CLAUDE.md/AGENTS.md) + the evergreen System Memory
    // profile + the compact skills catalog. The environment block is
    // snapshotted once per session for prompt-cache stability; project memory
    // is read fresh each turn so file edits take effect immediately.
    let envBlock = this.envBlocks.get(sessionId);
    if (envBlock === undefined) {
      envBlock = renderEnvironmentBlock(
        snapshotEnvironment(this.config.workspaceRoot, session.model, this.config.provider),
      );
      this.envBlocks.set(sessionId, envBlock);
    }
    const projectMemory = loadProjectMemory(this.config.workspaceRoot);
    const systemPrompt = [
      SYSTEM_PROMPT,
      envBlock,
      projectMemory.block,
      this.buildSystemMemoryBlock(),
      this.skillCatalog,
    ]
      .filter((s) => s && s.trim())
      .join("\n\n");

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
          maxTokens: MAX_TOKENS,
          maxTurnsPerStep: Math.min(MAX_TURNS, 20),
          maxStepRetries: 2,
          maxReplanAttempts: 2,
          systemPrompt,
          priorMessages,
          contextEngine: this.contextEngine,
          verifier: this.verifier ?? undefined,
          nativeGrounding: this.config.search?.nativeGrounding ?? true,
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
          maxTokens: MAX_TOKENS,
          maxTurns: MAX_TURNS,
          systemPrompt,
          priorMessages,
          contextEngine: this.contextEngine,
          verifier: this.verifier ?? undefined,
          nativeGrounding: this.config.search?.nativeGrounding ?? true,
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
      for await (const event of runner.run(
        userMessage,
        sessionId,
        this.config.workspaceRoot,
        signal,
      )) {
        if (event.type === "error" && !event.recoverable) {
          runError = event.error;
        }

        // Track turns, checkpoint, and context management
        if (event.type === "turn_complete") {
          turnCount++;

          // Checkpoint save per policy
          if (this.checkpointStore && turnCount % this.checkpointPolicy.intervalTurns === 0) {
            try {
              const state: RunState = {
                runId,
                sessionId,
                messages: runner.getMessages(),
                turnCount,
                context: { model: session.model },
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
                context: { model: session.model },
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
      this.rebuildGateway();
    } else {
      // Model-only switch: keep the summarizer's model in sync (rebuildGateway,
      // which also re-syncs, doesn't run when the provider is unchanged).
      this.contextEngine?.setSummarizer(this.config.model, this.config.provider);
    }
    // Update the session record so chat() picks up the new model — and the
    // provider too, so a later resume reconciles to the right host.
    if (sessionId) {
      this.sessions.updateSessionModel(sessionId, model, provider ?? this.config.provider);
    }
  }

  // ─── BYOK: live provider-key management ───

  private gatewayOpts(): BuildGatewayOpts {
    return {
      provider: this.config.provider,
      keys: this.providerKeys,
      customEndpoint: this.customEndpoint,
      disabled: this.disabledProviders,
      localBaseUrls: this.localBaseUrls,
      ollamaBaseUrl: this.config.ollamaBaseUrl,
    };
  }

  private rebuildGateway(): void {
    this.gateway = buildGateway(this.gatewayOpts());
    // Keep the context engine pointed at the live gateway + active model so
    // /compress and rolling compaction follow key/provider/toggle changes
    // instead of using a stale gateway or the anthropic default.
    this.contextEngine?.setGateway(this.gateway);
    this.contextEngine?.setSummarizer(this.config.model, this.config.provider);
  }

  /**
   * Add (or, with null, remove) a provider API key at runtime and rebuild the
   * gateway so the change takes effect immediately. Persistence to the secrets
   * file is the caller's responsibility — this only touches in-memory state.
   * Returns a forced model switch when clearing the key left the active provider
   * unusable, so the caller can tell the user we moved them.
   */
  setProviderKey(id: string, key: string | null, sessionId?: string): ProviderChangeResult {
    if (key && key.trim()) this.providerKeys[id] = key.trim();
    else delete this.providerKeys[id];
    this.rebuildGateway();
    return { switchedTo: this.reconcileActiveProvider(sessionId) };
  }

  /** Set or clear the user-defined custom OpenAI-compatible endpoint. */
  setCustomEndpoint(ep: CustomEndpoint | null, sessionId?: string): ProviderChangeResult {
    this.customEndpoint = ep ?? undefined;
    this.rebuildGateway();
    return { switchedTo: this.reconcileActiveProvider(sessionId) };
  }

  /** Toggle a provider on/off without discarding its key. */
  setProviderDisabled(id: string, disabled: boolean, sessionId?: string): ProviderChangeResult {
    if (disabled) this.disabledProviders.add(id);
    else this.disabledProviders.delete(id);
    this.rebuildGateway();
    return { switchedTo: this.reconcileActiveProvider(sessionId) };
  }

  /**
   * Set (or, with null/empty, reset to default) the base URL of a local runtime
   * (ollama / lmstudio) at runtime and rebuild the gateway. Persistence to the
   * secrets file is the caller's job — this only touches in-memory state.
   */
  setLocalEndpoint(id: string, baseUrl: string | null): void {
    const url = baseUrl?.trim();
    if (url) this.localBaseUrls[id] = url;
    else delete this.localBaseUrls[id];
    this.rebuildGateway();
  }

  /** The configured base URL for a local runtime (or its preset default). */
  getLocalEndpoint(id: string): string | undefined {
    return this.localBaseUrls[id] ?? getPreset(id)?.baseUrl;
  }

  /**
   * After a key/toggle/endpoint change, ensure the active provider is still
   * registered. If it isn't (e.g. the user toggled OFF or cleared the provider
   * they were using), move to the first still-available provider and its default
   * model — updating config, the session record, and the summarizer together so
   * chat() doesn't fire a request at a dead provider. Returns the new
   * provider/model when a switch happened, else undefined.
   */
  private reconcileActiveProvider(
    sessionId?: string,
  ): { provider: ProviderName; model: string } | undefined {
    const registered = this.gateway.getRegisteredProviderNames();
    if (registered.length === 0) return undefined; // no providers at all — surfaced at the call site
    if (registered.includes(this.config.provider)) return undefined; // still usable
    const next = registered[0];
    const model = getPreset(next)?.defaultModel ?? this.config.model;
    this.config.provider = next;
    this.config.model = model;
    if (sessionId) this.sessions.updateSessionModel(sessionId, model, next);
    this.contextEngine?.setSummarizer(model, next);
    return { provider: next, model };
  }

  /** Per-provider status (with masked keys) for the `/keys` panel. */
  getProviderStatus(): ProviderStatusRow[] {
    return providerStatus({
      keys: this.providerKeys,
      customEndpoint: this.customEndpoint,
      disabled: this.disabledProviders,
      localBaseUrls: this.localBaseUrls,
      active: this.config.provider,
    });
  }

  /** The configured custom endpoint, if any (used to pre-fill the editor). */
  getCustomEndpoint(): CustomEndpoint | undefined {
    return this.customEndpoint;
  }

  getModel(): string {
    return this.config.model;
  }

  getProvider(): ProviderName {
    return this.config.provider;
  }

  getRegisteredProviders(): ProviderName[] {
    return this.gateway.getRegisteredProviderNames();
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
    workspace: string;
    plannerMode: boolean;
    yoloMode: boolean;
    trustWorkspace: boolean;
    permissionMode: PermissionMode;
    registeredProviders: ProviderName[];
    cost: number;
    sessionId?: string;
    contextUsage: { used: number; limit: number; percent: number };
    securityPosture: string;
    mcp: { servers: number; tools: number };
    skills: number;
  } {
    return {
      model: this.config.model,
      provider: this.config.provider,
      workspace: this.config.workspaceRoot,
      plannerMode: this.config.plannerMode,
      yoloMode: this.config.yoloMode,
      trustWorkspace: this.permissions.isTrustWorkspace(),
      permissionMode: this.permissions.getMode(),
      registeredProviders: this.getRegisteredProviders(),
      cost: this.getCost(),
      sessionId,
      contextUsage: this.getContextUsage(),
      securityPosture: this.getSecurityPosture(),
      mcp: {
        servers: this.getMcpStatus().length,
        tools: this.getMcpStatus().reduce((n, s) => n + s.toolCount, 0),
      },
      skills: this.getSkillCount(),
    };
  }

  close(): void {
    // Best-effort: stop MCP subprocesses / sessions on exit.
    this.mcpDiscovery?.stopAll().catch(() => {});
    this.sessions.close();
  }
}
