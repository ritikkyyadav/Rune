import { LlmGateway, CostTracker } from "@alan/llm-gateway";
import type { Message, ProviderName, ResolvedCredential } from "@alan/llm-gateway";
import {
  ToolRegistry,
  registerBuiltinTools,
  ToolRateLimiter,
  DEFAULT_RATE_LIMIT,
  McpDiscovery,
  BROWSER_SERVER_NAME,
  buildBrowserServerSpec,
  SkillLoader,
  createSkillTool,
  DashboardManager,
  createDashboardTool,
  isSandboxEnabled,
  setSandboxMode,
  isOsIsolationAvailable,
  probeSandboxCapability,
  setRequireOsIsolation,
  setLspAutoFeedback,
} from "@alan/tool-registry";
import type { DashboardInfo, PluginCatalogEntry, SkillSearchHit } from "@alan/tool-registry";
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
  resolveTier,
  getAlanHome,
  setToolArgsSalvageListener,
} from "@alan/shared";
import type { ModelTier, TierRef, TiersConfig } from "@alan/shared";
import type { IncidentClass, IncidentInput, IncidentSeverity } from "@alan/shared";
import { Recorder } from "@alan/telemetry";
import type {
  CheckpointStore,
  CheckpointPolicy,
  RunState,
  CustomEndpoint,
  StoredKey,
  SessionStatus,
  SessionInfoInternal,
  SystemMemoryMeta,
} from "@alan/shared";
import { buildGateway, providerStatus } from "./provider-registry";
import type { ProviderStatusRow, BuildGatewayOpts } from "./provider-registry";
import { AgentLoop, parseInterjection } from "./agent-loop";
import type {
  PermissionCheck,
  AgentTurnEvent,
  ToolResultProcessArgs,
  ToolResultProcessor,
} from "./agent-loop";
import { createCompactTool } from "./compact-tool";
import { createUpdateConfigTool } from "./update-config-tool";
import { createResearchTool } from "./research-tool";
import {
  PermissionBroker,
  nextPermissionMode,
  PERMISSION_MODE_ORDER,
  configModeToPermissionMode,
  isPermissionModeForbidden,
  permissionModeToConfig,
} from "./permissions";
import { loadOrgPolicy, policyAllowsModel, type LoadedOrgPolicy } from "./org-policy";
import { discoverPlugins, type LoadedPlugin } from "./plugins";
import { StruggleDetector } from "./struggle-detector";
import { policyForModel, type ReliabilityPolicy } from "./reliability-policy";
import {
  NotebookStore,
  buildNotebookBlock,
  captureFromRun,
  repoKey as notebookRepoKey,
  stackKey as notebookStackKey,
} from "./notebook";
import type { NotebookBlock, NotebookEntry, ToolObservation } from "./notebook";
import type { PermissionScope, PermissionMode, PermissionModeInput } from "./permissions";

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
import {
  AutoModeSafetyController,
  GatewayActionClassifier,
  resolveAutoModeConfig,
  type AutoModePolicyConfig,
  type AutoModeReview,
} from "./auto-mode";
import { MemoryManager } from "./memory/manager";
import { EpisodicMemory } from "./memory/episodic";
import { WorkingMemory } from "./memory/working";
import { HookRunner } from "./hooks";
import { createSubagentTool } from "./subagent";
import { createWorkerTool } from "./worker";
import { createAskUserTool } from "./ask-user";
import type { QuestionHandler } from "./ask-user";
export type { QuestionHandler, UserQuestion } from "./ask-user";
import { createLoopControlTool } from "./loop-control-tool";
import {
  LoopManager,
  parseLoopRequest,
  renderLoopRunDoctrine,
  resolveLoopPrompt,
  type LoopCancelResult,
  type LoopCompletion,
  type LoopRunOutcome,
  type LoopTask,
} from "./loop-mode";
import {
  AGENT_DOCTRINE,
  loadProjectMemory,
  renderBrowserDoctrine,
  renderEnvironmentBlock,
  renderInteractiveDoctrine,
  snapshotEnvironment,
} from "./prompts";
import { buildRepoMap } from "./repo-map";
import { CommandVerifier } from "./verifier";
import type { Verifier } from "./verifier";
import { autoCommitPaths, undoLastGearCommit, type UndoResult } from "./git-undo";
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
  /** Present when classifier-backed Auto mode paused for human review. */
  safety?: {
    reason: string;
    risk: string;
    tier: string;
    source: string;
    reviewer?: { provider: string; model: string };
  };
  /** "Allow session" is deliberately narrowed to this exact payload in Auto. */
  exactSessionGrant?: boolean;
  /** Live per-minute rate-limit occupancy for this tool, for the risk row. */
  rateLimit?: { used: number; limit: number };
}

/** Payload for the inline ⛨ auto-approved chip (Auto mode, classifier allow). */
export interface AutoApprovalNotice {
  toolName: string;
  argsSummary: string;
  risk: string;
  tier: string;
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
      case "system_note": {
        // Why a turn ended abnormally ("agent loop terminated: rate limited…") is
        // part of the record — hiding it made resumed sessions look silently broken.
        const content = typeof p.content === "string" ? p.content : "";
        if (content.trim()) lines.push({ role: "note", text: content });
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
  /** Canonical startup mode. Takes precedence over legacy yolo/trust flags. */
  permissionMode?: PermissionMode;
  /**
   * Auto-approve in-workspace writes/edits and bash without prompting. Out-of-workspace
   * writes and network tools still prompt. Default false.
   */
  trustWorkspace?: boolean;
  /** Independent reviewer + trust-boundary configuration for Auto mode. */
  autoMode?: AutoModePolicyConfig;
  /**
   * Run foreground bash inside the OS sandbox (Seatbelt/Bubblewrap: deny-net,
   * workspace-confined writes). Default true; false = full host access
   * (`/sandbox off`, `--no-sandbox`). Process-wide — see tool-registry/sandbox-mode.
   */
  sandboxEnabled?: boolean;
  /**
   * Refuse sandbox-tier bash instead of silently degrading when no OS
   * isolation backend exists on this machine (`[sandbox] requireOs = true`).
   * Default false: degraded runs are allowed but lose auto-approval and are
   * labelled honestly everywhere.
   */
  sandboxRequireOs?: boolean;
  /**
   * Pull LSP diagnostics after every successful write/edit on a supported
   * file and append errors to the tool result (`[lsp] autoFeedback = true`).
   * Default false.
   */
  lspAutoFeedback?: boolean;
  /**
   * Field-tunable loop recovery bounds (`[reliability]` in config.toml),
   * overriding the per-model-family defaults. See reliability-policy.ts.
   */
  reliability?: Partial<ReliabilityPolicy>;
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
  /**
   * Multi-account key pools by provider id (from secrets.json). The gateway only
   * ever uses the active key (mirrored into `providerKeys`); these carry the full
   * pool + dates so the `/keys` panel can show and manage them.
   */
  providerKeyEntries?: Record<string, StoredKey[]>;
  /** Active entry id per provider (which pool key is live). */
  activeKeyId?: Record<string, string>;
  /** User-defined OpenAI-compatible endpoint registered as the "custom" provider. */
  customEndpoint?: CustomEndpoint;
  /** Provider ids toggled off — kept configured but excluded from the gateway. */
  disabledProviders?: string[];
  /** Base URLs for local runtimes (ollama / lmstudio) by id; overrides preset defaults. */
  localBaseUrls?: Record<string, string>;
  /** Base URL for a local Ollama server (default http://localhost:11434). */
  ollamaBaseUrl?: string;
  /**
   * BYOP: credentials pre-resolved by the auth layer at boot (keychain keys,
   * OAuth bearer tokens). Threaded into every gateway (re)build. Absent ⇒ the
   * gateway resolves keys exactly as before BYOP.
   */
  credentials?: Record<string, ResolvedCredential>;
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
  /**
   * Git integration (config.toml `[git]`): autoCommit makes every successful
   * run that wrote files land as one revertible "gear:" commit (Aider-style);
   * /undo resets the last one. Default off.
   */
  git?: {
    autoCommit?: boolean;
  };
  /** Context assembly: repoMap injects a bounded, request-aware structural map (default on). */
  context?: {
    repoMap?: boolean;
  };
  /**
   * Agent browser ([browser] in config.toml, /browser on|off at runtime).
   * When enabled the engine injects a built-in `browser` MCP server — the
   * official Playwright MCP (bunx @playwright/mcp), headless + isolated,
   * accessibility-snapshot based — so the model can navigate, read, and
   * drive real web pages. `enabled` arrives already resolved by the CLI
   * (flag > env > sidecar > config > off).
   */
  browser?: {
    enabled?: boolean;
    headless?: boolean;
    browser?: string;
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  /**
   * Interactive dashboards (config.toml `[interactive]`): auto lets the model
   * decide on its own when an answer deserves a live dashboard; off (default)
   * restricts building to explicit requests (/interactive). Runtime-togglable
   * via /interactive auto on|off.
   */
  interactive?: {
    auto?: boolean;
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
  /**
   * Model tiers (config.toml `[tiers]`): route work by weight. Values are
   * "model" (active provider) or "provider/model" (cross-provider). heavy =
   * hardest tasks, standard = main loop, light = sub-agents, compaction
   * summaries, and other internal utility calls.
   */
  tiers?: TiersConfig;
  /**
   * Black box (flight recorder): incident capture to ~/.alan/blackbox.db.
   * OFF unless enabled — unit tests and embedders stay hermetic; the CLI and
   * engine-host turn it on. `version` stamps every incident for
   * version-over-version regression queries.
   */
  blackbox?: {
    enabled?: boolean;
    dbPath?: string;
    version?: string;
    spoolPath?: string;
  };
  /**
   * Tactics notebook (evolution loop v1): learned facts/tactics injected into
   * the system prompt under a hard token budget. Capture is rule-based (zero
   * model calls). OFF unless enabled; `--pristine` forces it off.
   */
  notebook?: {
    enabled?: boolean;
    dbPath?: string;
    /** Injection budget in tokens. Default 600. */
    maxInjectTokens?: number;
  };
}

// Generation budget per step. 8k routinely truncated multi-file edits and
// long tool-call sequences mid-response; 32k gives coding responses room.
// The agent loop clamps this to each model's real per-response output cap
// (getMaxOutputTokens), so smaller models are unaffected.
const MAX_TOKENS = 32000;
// 80 agentic rounds: long autonomous builds (scaffold → install → run →
// fix → verify → polish) legitimately spend 30-50; the cap is a runaway
// guard, not a work budget. Context compaction keeps long runs viable.
const MAX_TURNS = 80;

// Per-provider cheap-model routing now lives in @alan/shared tiers.ts
// (PROVIDER_TIER_DEFAULTS) — resolved via Engine.resolveModelTier("light").

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
    "You maintain a SHORT, evergreen profile of a software developer and the codebases they work in, so an AI coding assistant (Gear) can serve them better from the very first message.",
    "",
    "Write a GUIDE, not rules. Describe — never command. This is background context the assistant tailors to, not rigid instructions.",
    "",
    "Cover, ONLY where the activity actually supports it:",
    "- About the user: who they are, how they communicate (tone, terseness, language), how they like to work, clear likes and dislikes.",
    "- Style & preferences: languages, frameworks, tools, conventions, testing/verification habits, what they value (e.g. concise answers, minimal diffs).",
    "- Their codebases: the kinds of projects Gear is used for, recurring stacks and patterns, and what they typically ask for.",
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
  const role = m.role === "assistant" ? "Gear" : m.role === "user" ? "User" : m.role;
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
  /** Verified org policy (null on unmanaged machines). */
  private orgPolicy: LoadedOrgPolicy | null = null;
  /** Plugin bundles, discovered lazily once (null = not yet scanned). */
  private pluginDiscovery: { plugins: LoadedPlugin[]; errors: string[] } | null = null;
  private config: EngineConfig;
  private permissionHandler?: PermissionHandler;
  private autoApprovalNotifier?: (notice: AutoApprovalNotice) => void;
  private questionHandler?: QuestionHandler;
  private contextEngine: ContextEngine;
  private costTracker: CostTracker;
  private rateLimiter: ToolRateLimiter | null = null;
  private securityGuard: ReturnType<typeof createToolExecutionGuard> | null = null;
  /** Classifier action gate + tool-result prompt-injection probe. */
  private autoModeSafety!: AutoModeSafetyController;
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
  // Full multi-account pools + which entry is active, for the `/keys` panel. The
  // gateway never reads these; it reads the active-key mirror above.
  private providerKeyEntries: Record<string, StoredKey[]> = {};
  private activeProviderKeyId: Record<string, string> = {};
  private customEndpoint?: CustomEndpoint;
  private disabledProviders: Set<string> = new Set();
  // Base URLs for local runtimes (ollama / lmstudio), live-editable via /keys.
  private localBaseUrls: Record<string, string> = {};
  // BYOP: credentials resolved by the auth layer (keychain / OAuth). Seeded at
  // boot and refreshed on login/logout; handed into every gateway (re)build.
  private resolvedCredentials: Record<string, ResolvedCredential> = {};
  // Guards against overlapping System Memory "dreams" (auto + manual at once).
  private memoryReflecting = false;
  // Black box: null when disabled (tests, embedders). Created BEFORE the
  // gateway so gatewayOpts() can hand the tap into every (re)build.
  private recorder: Recorder | null = null;
  // Monotonic run counter — the "turn" an incident belongs to.
  private runCounter = 0;
  // Behavioral struggle signals (thrash, rephrase, corrections) — recorder-fed.
  private struggles: StruggleDetector | null = null;
  // Tactics notebook (evolution loop v1): learned facts injected under budget.
  private notebookStore: NotebookStore | null = null;
  private notebookKeys: { repoKey: string; stackKey: string } | null = null;
  // Per-session injection blocks, cached for prompt-cache stability.
  private notebookBlocks: Map<string, NotebookBlock> = new Map();
  // Per-session environment snapshot (cwd/platform/git state at session start).
  // Cached so the system prompt stays byte-stable across turns — a churning
  // prompt would invalidate the provider's prefix cache on every call.
  private envBlocks: Map<string, string> = new Map();
  private lastAutoCommitSha: string | null = null;
  // Interactive dashboards: loopback SSE server (started lazily on first
  // create) + the autonomy toggle that shapes the injected doctrine.
  private dashboards = new DashboardManager();
  private interactiveAuto = false;
  private browserEnabled = false;
  // The flat AgentLoop currently running a chat() turn — the target for
  // mid-turn steering (interject). Null when idle or in planner mode.
  private liveLoop: AgentLoop | null = null;
  // Session-scoped /loop schedulers. Definitions are persisted as ordinary
  // session events; this map is only the live replay/claim state.
  private loopManagers: Map<string, LoopManager> = new Map();

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

    // Sandbox posture before any tool can run. Process-wide by design (one
    // real engine per process); default is ON — full access is an opt-out.
    setSandboxMode(this.config.sandboxEnabled === false ? "off" : "on");
    // Capability, not just intent: probe what this machine can actually
    // isolate with, BEFORE the first permission decision. On the missing-
    // backend path the probe records "none" and bash loses auto-approval —
    // silent degradation surfaces as prompts instead of uncontained runs.
    probeSandboxCapability(this.config.toolsBinaryPath);
    setRequireOsIsolation(this.config.sandboxRequireOs === true);
    // Opt-in semantic feedback on the write path ([lsp] autoFeedback).
    setLspAutoFeedback(this.config.lspAutoFeedback === true);

    // Black box first — the gateway build below captures its tap.
    if (this.config.blackbox?.enabled) {
      this.recorder = new Recorder({
        dbPath: this.config.blackbox.dbPath ?? join(getAlanHome(), "blackbox.db"),
        version: this.config.blackbox.version ?? "dev",
        spoolPath: this.config.blackbox.spoolPath,
      });
      // Salvaged tool-call JSON is a provider defect we recovered from — count
      // it. Module-global listener; last engine wins, which is fine: one real
      // engine per process.
      setToolArgsSalvageListener((info) => {
        this.recorder?.record({
          class:
            info.stage === "gave_up"
              ? "provider.malformed_tool_json_fatal"
              : "provider.malformed_tool_json_salvaged",
          severity: info.stage === "gave_up" ? "warn" : "debug",
          component: "gateway",
          where: "json#parseToolArguments",
          message: `tool args ${info.stage === "gave_up" ? "unsalvageable" : `salvaged via ${info.stage}`}: ${info.snippet}`,
        });
      });
      this.struggles = new StruggleDetector(
        (i) => this.recorder?.record(i),
        policyForModel(this.config.model, this.config.reliability),
      );
    }

    // Tactics notebook — rule-based learning, zero model spend. A corrupt
    // store must never block startup: quarantine by disabling for the run.
    if (this.config.notebook?.enabled) {
      try {
        this.notebookStore = new NotebookStore(
          this.config.notebook.dbPath ?? join(getAlanHome(), "notebook.db"),
        );
        this.notebookKeys = {
          repoKey: notebookRepoKey(this.config.workspaceRoot),
          stackKey: notebookStackKey(this.config.workspaceRoot),
        };
      } catch (err) {
        this.notebookStore = null;
        this.recorder?.record({
          class: "crash.store_corruption",
          severity: "error",
          component: "notebook",
          where: "engine#constructor",
          message: `notebook store failed to open: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

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
    this.providerKeyEntries = structuredClone(this.config.providerKeyEntries ?? {});
    this.activeProviderKeyId = { ...(this.config.activeKeyId ?? {}) };
    this.customEndpoint = this.config.customEndpoint;
    this.disabledProviders = new Set(this.config.disabledProviders ?? []);
    this.localBaseUrls = { ...(this.config.localBaseUrls ?? {}) };
    this.resolvedCredentials = { ...(this.config.credentials ?? {}) };
    this.gateway = buildGateway(this.gatewayOpts());

    // Initialize Tool Registry with built-in tools
    this.registry = new ToolRegistry();
    registerBuiltinTools(this.registry, this.config.toolsBinaryPath);

    // Register the `task` sub-agent tool. It runs nested investigations against
    // a SEPARATE read-only registry (built-ins only, without `task` itself) so a
    // sub-agent can never write/execute and can never recurse into more agents.
    // The resolver routes sub-agents to the cheap "light" tier and hands over
    // the CURRENT gateway at call time (the gateway is rebuilt on key edits).
    const subRegistry = new ToolRegistry();
    registerBuiltinTools(subRegistry, this.config.toolsBinaryPath);
    this.registry.register(
      createSubagentTool({
        gateway: this.gateway,
        registry: subRegistry,
        model: this.config.model,
        provider: this.config.provider,
        resolve: () => {
          const light = this.resolveModelTier("light");
          return {
            gateway: this.gateway,
            model: light.model,
            provider: light.provider as ProviderName,
          };
        },
        toolResultProcessor: (ctx) => this.processToolResult(ctx),
      }),
    );

    // ask_user: blocking clarification questions. The handler is wired later
    // by the frontend (CLI/TUI) via setQuestionHandler — the closure reads it
    // at execute time, and headless environments degrade to an instructive
    // error instead of stalling. Deliberately NOT in the sub-agent registry.
    // In 4th gear the handler is withheld even when wired:
    // the whole point of the gear is "no human in the loop", so the tool
    // degrades to its proceed-on-your-best-judgment error instead of parking
    // an autonomous run on a question nobody will answer.
    this.registry.register(
      createAskUserTool(() =>
        this.permissions.getMode() === "gear-4" ? undefined : this.questionHandler,
      ),
    );

    // `worker`: write-capable parallel sub-agents with disjoint file
    // ownership — the lead splits implementation, workers run concurrently
    // (parallelSafe + ownership claims), the lead integrates and verifies.
    // Routed to the STANDARD tier: workers write production code. Main
    // registry only — workers cannot spawn workers.
    this.registry.register(
      createWorkerTool({
        binaryPath: this.config.toolsBinaryPath,
        resolve: () => {
          const std = this.resolveModelTier("standard");
          return {
            gateway: this.gateway,
            model: std.model,
            provider: std.provider as ProviderName,
          };
        },
        toolResultProcessor: (ctx) => this.processToolResult(ctx),
      }),
    );

    // interactive_dashboard: live HTML dashboards in the browser. Main
    // registry only — sub-agents are read-only investigators and must not
    // pop browser windows.
    this.interactiveAuto = this.config.interactive?.auto === true;
    this.browserEnabled = this.config.browser?.enabled === true;
    this.registry.register(createDashboardTool(this.dashboards));

    // `research`: the /research | /deepresearch pipeline as a model-invocable
    // tool, so "do deep research on X" asked in plain chat runs the real
    // multi-source engine. Main registry only — a research run fans out its
    // own investigators and must not nest inside read-only sub-agents.
    this.registry.register(
      createResearchTool({
        binaryPath: this.config.toolsBinaryPath,
        workspaceRoot: this.config.workspaceRoot,
        resolve: () => ({
          gateway: this.gateway,
          model: this.config.model,
          provider: this.config.provider,
        }),
        defaults: () => this.config.research ?? {},
        toolResultProcessor: (ctx) => this.processToolResult(ctx),
        record: (sessionId, type, payload) => {
          try {
            this.sessions.appendEvent(sessionId, { type, payload });
          } catch {
            // audit persistence is best-effort; never fail the research run
          }
        },
      }),
    );

    // compact_context: the /compress behaviour as a model-invocable tool —
    // "compact the conversation" asked in chat schedules a forced working-set
    // compaction, executed by the agent loop at the next turn boundary.
    this.registry.register(
      createCompactTool({
        requestCompaction: () => {
          this.contextEngine.requestCompaction();
          return this.contextEngine.getContextUsage();
        },
      }),
    );

    // Adaptive /loop iterations use this once at the end to pick their next
    // delay or stop themselves. Outside a claimed adaptive iteration it fails
    // closed with a plain explanatory tool error.
    this.registry.register(
      createLoopControlTool({
        control: (sessionId, request) => this.getLoopManager(sessionId).controlActive(request),
      }),
    );

    // update_config: change Gear's own settings from plain-language requests
    // ("shift to 4th gear", "turn the sandbox off") — applied live and
    // persisted to ~/.alan/config.toml. Main registry only: sub-agents are
    // read-only investigators and must not reconfigure the host session.
    this.registry.register(
      createUpdateConfigTool({
        applyLive: (key, value) => this.applyConfigSetting(key, value),
        readSetting: (key) => this.readConfigSetting(key),
      }),
    );

    // Initialize Session Manager
    this.sessions = new SessionManager(this.config.dbPath);

    // ── Org policy: load + verify BEFORE the broker exists. A managed machine
    // with a tampered/unsigned policy refuses to start — running unpoliced is
    // exactly what the signature is there to prevent. No policy = no change.
    const policyResult = loadOrgPolicy();
    if (policyResult && !policyResult.ok) {
      throw new Error(`Refusing to start: ${policyResult.error}`);
    }
    this.orgPolicy = policyResult?.ok ? policyResult.loaded : null;
    const requestedPermissionMode: PermissionMode =
      this.config.permissionMode ??
      (this.config.yoloMode ? "gear-4" : this.config.trustWorkspace ? "gear-3" : "gear-1");
    const initialPermissionMode: PermissionMode = isPermissionModeForbidden(
      this.orgPolicy?.policy,
      requestedPermissionMode,
    )
      ? "gear-1"
      : requestedPermissionMode;

    // Initialize Permission Broker
    this.permissions = new PermissionBroker(this.config.yoloMode, {
      workspaceRoot: this.config.workspaceRoot,
      trustWorkspace: this.config.trustWorkspace,
      initialMode: initialPermissionMode,
      orgPolicy: this.orgPolicy?.policy ?? null,
    });
    this.config.permissionMode = initialPermissionMode;
    this.config.yoloMode = initialPermissionMode === "gear-4";
    this.config.trustWorkspace = initialPermissionMode === "gear-3";
    // NOTE: gears never touch the OS sandbox. 4th gear removes the permission
    // prompts; whether commands run contained is the separate `/sandbox`
    // switch (config, --sandbox/--no-sandbox). Coupling them silently widened
    // the blast radius of every legacy hands-free user — never again.

    // Independent Auto reviewer. It uses a separate inference request with a
    // stripped transcript (trusted user messages + tool calls only). The heavy
    // tier is the default reviewer; organizations can pin a distinct provider
    // and model in signed policy. Missing/misconfigured reviewers fail closed.
    const autoConfig = resolveAutoModeConfig(this.config.autoMode, this.orgPolicy?.policy.autoMode);
    if (!autoConfig.enabled && this.permissions.getMode() === "auto") {
      this.permissions.setMode("gear-1");
      this.config.permissionMode = "gear-1";
      this.config.trustWorkspace = false;
    }
    this.autoModeSafety = new AutoModeSafetyController(
      autoConfig,
      new GatewayActionClassifier(),
      () => {
        const heavy = this.resolveModelTier("heavy");
        const provider = (autoConfig.classifierProvider ?? heavy.provider) as ProviderName;
        const model =
          autoConfig.classifierModel ??
          (provider === heavy.provider
            ? heavy.model
            : (getPreset(provider)?.defaultModel ?? this.config.model));
        if (!this.gateway.getProvider(provider)) {
          throw new Error(`classifier provider "${provider}" is not configured`);
        }
        if (this.orgPolicy) {
          const denial = policyAllowsModel(this.orgPolicy.policy, provider, model);
          if (denial) throw new Error(`classifier rejected by ${denial}`);
        }
        return { gateway: this.gateway, provider, model };
      },
    );

    // Initialize Context Engine — always on, manages token budgets. Seed the
    // summarizer with the LIGHT model tier (summarization is utility work —
    // no need to burn frontier-model tokens on it). Resolution guarantees a
    // registered provider, so /compress and rolling compaction always work.
    const lightSeed = this.resolveModelTier("light");
    this.contextEngine = new ContextEngine(
      {
        budget: this.config.contextBudget,
        summarizerModel: lightSeed.model,
        summarizerProvider: lightSeed.provider as ProviderName,
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

  /** Wire the UI chip for Auto mode's silent classifier approvals. */
  setAutoApprovalNotifier(notifier: ((notice: AutoApprovalNotice) => void) | null): void {
    this.autoApprovalNotifier = notifier ?? undefined;
  }

  /** Current-minute occupancy vs. the per-tool ceiling, for the permission card. */
  private toolRateUsage(toolName: string): { used: number; limit: number } | undefined {
    if (!this.rateLimiter) return undefined;
    try {
      const used = this.rateLimiter.getStats()[toolName] ?? 0;
      const limit =
        toolName === "bash"
          ? DEFAULT_RATE_LIMIT.bashMaxPerMinute
          : ["write_file", "edit_file"].includes(toolName)
            ? DEFAULT_RATE_LIMIT.writeMaxPerMinute
            : DEFAULT_RATE_LIMIT.perToolMaxPerMinute;
      return { used, limit };
    } catch {
      return undefined;
    }
  }

  /** Gateway provider health (pruned / cooling providers) for /status. */
  getProviderHealth(): { pruned: string[]; cooling: { provider: string; untilMs: number }[] } {
    try {
      return this.gateway.getProviderHealth();
    } catch {
      return { pruned: [], cooling: [] };
    }
  }

  /** Wire the frontend's blocking-question UI for the ask_user tool. */
  setQuestionHandler(handler: QuestionHandler): void {
    this.questionHandler = handler;
  }

  /**
   * Discover plugin bundles (.alan/plugins/<name>/plugin.json) once per
   * engine. Each bundle feeds the four extension loaders: skills (auto,
   * attributed), hooks (merged after user hooks), MCP servers (before user
   * mcp.json so user entries still override), commands (tagged, user wins).
   * Refused plugins are warned once with the loader's reason.
   */
  private getPlugins(): LoadedPlugin[] {
    if (this.pluginDiscovery === null) {
      this.pluginDiscovery = discoverPlugins(this.config.workspaceRoot);
      for (const error of this.pluginDiscovery.errors) {
        console.warn(`[plugins] ${error}`);
      }
    }
    return this.pluginDiscovery.plugins;
  }

  /** Plugin bundles in force (backs `/plugins` and status attribution). */
  listPlugins(): { plugins: LoadedPlugin[]; errors: string[] } {
    this.getPlugins();
    return this.pluginDiscovery ?? { plugins: [], errors: [] };
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
      const extraHookFiles = this.getPlugins().flatMap((p) => p.hookFiles);
      this.hookRunner = await HookRunner.load(this.config.workspaceRoot, { extraHookFiles });
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
      // Plugin servers first, then the built-in browser — and the user's own
      // mcp.json still overrides ANY of them by name (discovery spreads its
      // config last). Cross-plugin name conflicts were refused at discovery.
      const pluginServers: Record<string, unknown> = {};
      for (const plugin of this.getPlugins()) {
        Object.assign(pluginServers, plugin.mcpServers);
      }
      const extraServers = {
        ...(pluginServers as Record<string, never>),
        ...(this.browserEnabled
          ? { [BROWSER_SERVER_NAME]: buildBrowserServerSpec(this.config.browser) }
          : {}),
      };
      this.mcpDiscovery = new McpDiscovery(this.config.workspaceRoot, {
        logger,
        extraServers: Object.keys(extraServers).length > 0 ? extraServers : undefined,
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
   * GEAR_SKILLS_DIR / cwd fallback) plus the workspace's `.alan/skills`.
   */
  private resolveSkillRoots(): string[] {
    if (this.config.skillRoots && this.config.skillRoots.length > 0) {
      return this.config.skillRoots.filter((r) => existsSync(r));
    }
    const candidates = [
      process.env.GEAR_SKILLS_DIR ?? process.env.ELIO_SKILLS_DIR ?? process.env.ALAN_SKILLS_DIR,
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
    // Plugin bundles: <plugins>/<name>/skills/<skill>/SKILL.md — the loader's
    // path-based attribution names each skill after its plugin directory.
    if (this.getPlugins().some((p) => p.hasSkills)) {
      roots.push(join(this.config.workspaceRoot, ".alan", "plugins"));
    }
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

  private buildPermissionCheck(context: {
    sessionId: string;
    userMessages: string[];
  }): PermissionCheck {
    // One stripped action transcript per user run. It accumulates tool calls,
    // including Tier-1/2 calls that skip model review, but never assistant prose
    // or tool output.
    const autoRun = this.autoModeSafety.startRun(context.userMessages);

    return async ({ callId, toolName, args }) => {
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
      if (decision.type === "denied") {
        return { allowed: false, reason: decision.reason };
      }

      let autoReview: AutoModeReview | undefined;
      if (this.permissions.getMode() === "auto") {
        autoReview = await autoRun.review({
          callId,
          toolName,
          args,
          schema: handler.schema,
          workspaceRoot: this.config.workspaceRoot,
          exactGrant: decision.type === "allowed" && decision.basis === "exact_grant",
        });
        this.recordAutoModeDecision(context.sessionId, toolName, args, autoReview);

        if (autoReview.verdict === "allow") {
          this.rateLimiter?.recordCall(toolName);
          this.autoVerifier?.onToolCall();
          // Auto mode's approvals are silent by design at the broker level;
          // the notifier lets a UI print the ⛨ auto-approved chip inline so
          // classifier decisions stay visible without pausing the run.
          try {
            this.autoApprovalNotifier?.({
              toolName,
              argsSummary: `${toolName} ${JSON.stringify(args).slice(0, 120)}`,
              risk: autoReview.risk,
              tier: autoReview.tier,
            });
          } catch {
            // Presentation only — never block the approval path.
          }
          return { allowed: true };
        }
        if (autoReview.verdict === "deny") {
          return {
            allowed: false,
            reason: `Auto mode blocked this action: ${autoReview.reason}`,
          };
        }
        // `ask` falls through to the same human permission handler Manual mode
        // uses, with the classifier evidence attached to the prompt.
      } else if (decision.type === "allowed") {
        this.rateLimiter?.recordCall(toolName);
        this.autoVerifier?.onToolCall();
        return { allowed: true };
      }

      if (!this.permissionHandler) {
        return {
          allowed: false,
          reason: autoReview
            ? `Auto mode requires human confirmation but no handler is registered: ${autoReview.reason}`
            : `Tool "${toolName}" requires confirmation but no handler is registered`,
        };
      }

      const argsSummary =
        decision.type === "needs_confirmation"
          ? decision.argsSummary
          : `${toolName} ${JSON.stringify(args).slice(0, 180)}`;
      const suggestedScope =
        decision.type === "needs_confirmation" ? decision.suggestedScope : "once";

      const userDecision = await this.permissionHandler({
        toolName,
        argsSummary,
        suggestedScope,
        rawArgs: args,
        rateLimit: this.toolRateUsage(toolName),
        safety: autoReview
          ? {
              reason: autoReview.reason,
              risk: autoReview.risk,
              tier: autoReview.tier,
              source: autoReview.source,
              reviewer: autoReview.reviewer,
            }
          : undefined,
        exactSessionGrant: autoReview?.tier === "classifier",
      });

      if (userDecision.kind === "deny") {
        autoRun.noteHumanDecision();
        return { allowed: false, reason: "User denied" };
      }
      if (userDecision.kind === "allow_session") {
        if (autoReview?.tier === "classifier") {
          this.permissions.grantExact(toolName, args, "session");
        } else {
          this.permissions.grantTool(toolName, "session");
        }
      }
      autoRun.noteHumanDecision();
      // Record rate limiter call on approval
      this.rateLimiter?.recordCall(toolName);
      this.autoVerifier?.onToolCall();
      return { allowed: true };
    };
  }

  /** Persist a queryable event plus a tamper-evident hash-chain entry. */
  private recordAutoModeDecision(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    review: AutoModeReview,
  ): void {
    const reason = this.securityGuard
      ? this.securityGuard.postExecution(review.reason)
      : review.reason;
    try {
      this.sessions.appendEvent(sessionId, {
        type: "safety_decision",
        payload: {
          toolName,
          argsHash: hashArgs(args),
          verdict: review.verdict,
          tier: review.tier,
          risk: review.risk,
          source: review.source,
          stage: review.stage,
          reason,
          reviewer: review.reviewer,
          matchedRule: review.matchedRule,
          durationMs: review.durationMs,
        },
      });
      this.sessions.appendAuditEntry({
        sessionId,
        toolName: `safety:${toolName}`,
        argsHash: hashArgs(args),
        resultHash: hashResult({
          verdict: review.verdict,
          tier: review.tier,
          risk: review.risk,
          source: review.source,
          reason,
        }),
        durationMs: review.durationMs,
        exitCode: review.verdict === "allow" ? 0 : review.verdict === "deny" ? 1 : 2,
      });
      this.recorder?.note(
        `safety:${toolName}`,
        `${review.verdict} ${review.risk} ${review.source}: ${reason.slice(0, 120)}`,
      );
    } catch (error) {
      // A write failure cannot silently turn a denied call into an allowed one;
      // the decision already exists in memory. Surface it in diagnostics.
      this.recorder?.record({
        class: "crash.store_corruption",
        severity: "warn",
        component: "auto-mode-audit",
        where: "engine#recordAutoModeDecision",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Shared by the lead loop, planner executors, read-only tasks and workers. */
  private processToolResult: ToolResultProcessor = (ctx: ToolResultProcessArgs) => {
    const screened = this.autoModeSafety.screenToolResult(ctx.toolName, ctx.output);
    if (!screened.warningAdded) return screened.output;

    try {
      const payload = {
        toolName: ctx.toolName,
        argsHash: hashArgs(ctx.args),
        confidence: screened.scan.confidence,
        patterns: screened.scan.patterns,
      };
      this.sessions.appendEvent(ctx.sessionId, { type: "security_probe", payload });
      this.sessions.appendAuditEntry({
        sessionId: ctx.sessionId,
        toolName: `probe:${ctx.toolName}`,
        argsHash: hashArgs(ctx.args),
        resultHash: hashResult(payload),
        durationMs: 0,
        exitCode: 2,
      });
      this.recorder?.note(
        `probe:${ctx.toolName}`,
        `prompt injection warning: ${screened.scan.patterns.slice(0, 5).join(", ")}`,
      );
    } catch {
      // The warning is already attached to the model-visible result. Audit
      // persistence is defense-in-depth and must not remove that warning.
    }
    return screened.output;
  };

  /**
   * Revert the last Gear auto-commit (guarded: only "gear:" commits, only
   * with a clean worktree). Backs the /undo command.
   */
  undoLastAutoCommit(): UndoResult {
    const r = undoLastGearCommit(this.config.workspaceRoot);
    if (r.ok) this.lastAutoCommitSha = null;
    return r;
  }

  /** Whether [git] autoCommit is active (drives /undo messaging). */
  isAutoCommitEnabled(): boolean {
    return this.config.git?.autoCommit === true;
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
    this.loopManagers.delete(sessionId);
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
    const deleted = this.sessions.deleteEventsAfter(sessionId, afterSeq);
    // Loop definitions are events too. Replay after a rewind so a task created
    // in the truncated tail cannot remain alive in memory.
    this.loopManagers.delete(sessionId);
    return deleted;
  }

  // ─── Session loops (/loop, /loops) ───

  /** Parse and create one recurring task for this conversation. */
  scheduleLoop(
    sessionId: string,
    raw: string,
  ): { task: LoopTask; warnings: string[]; promptPath?: string } {
    if (!this.sessions.getSession(sessionId))
      throw new Error("Cannot schedule a loop for this session.");
    const parsed = parseLoopRequest(raw);
    const resolved = resolveLoopPrompt(parsed.prompt, this.config.workspaceRoot, getAlanHome());
    const task = this.getLoopManager(sessionId).create({
      prompt: resolved.prompt,
      promptSource: resolved.source,
      ...(parsed.intervalMs !== undefined ? { intervalMs: parsed.intervalMs } : {}),
    });
    const warnings = [...parsed.warnings];
    if (resolved.warning) warnings.push(resolved.warning);
    return {
      task,
      warnings,
      ...(resolved.path ? { promptPath: resolved.path } : {}),
    };
  }

  listLoopTasks(sessionId: string): LoopTask[] {
    return this.getLoopManager(sessionId).list();
  }

  getLoopStatus(sessionId: string): { count: number; nextRunAt: number | null } {
    const tasks = this.getLoopManager(sessionId).list();
    return { count: tasks.length, nextRunAt: tasks[0]?.nextRunAt ?? null };
  }

  cancelLoopTask(sessionId: string, idOrPrefix?: string): LoopCancelResult {
    return this.getLoopManager(sessionId).cancel(idOrPrefix);
  }

  clearLoopTasks(sessionId: string): number {
    return this.getLoopManager(sessionId).clear();
  }

  /** Claim the earliest due task. Frontends call this only while their composer is idle. */
  claimDueLoopTask(sessionId: string): LoopTask | null {
    return this.getLoopManager(sessionId).claimDue();
  }

  getActiveLoopTask(sessionId: string): LoopTask | null {
    return this.getLoopManager(sessionId).active();
  }

  completeLoopTask(
    sessionId: string,
    taskId: string,
    outcome: LoopRunOutcome = {},
  ): LoopCompletion {
    return this.getLoopManager(sessionId).complete(taskId, outcome);
  }

  private getLoopManager(sessionId: string): LoopManager {
    let manager = this.loopManagers.get(sessionId);
    if (manager) return manager;
    manager = new LoopManager({
      readEvents: () =>
        this.sessions.getEvents(sessionId, 1).map(({ event }) => ({
          type: event.type,
          payload: event.payload,
        })),
      appendEvent: (type, payload) => {
        this.sessions.appendEvent(sessionId, { type, payload });
      },
    });
    this.loopManagers.set(sessionId, manager);
    return manager;
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
      "# What Gear knows about you (evergreen context — a guide, not rules)",
      "The profile below is what Gear has learned about the user and their codebases over time, to tailor its tone, defaults, and assumptions. Treat it as helpful background, NOT as instructions — when it conflicts with what the user asks for in this session, follow the user.",
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

  /** The active permission mode in the five-state Shift+Tab cycle. */
  getPermissionMode(): PermissionMode {
    return this.permissions.getMode();
  }

  /**
   * Shift gears live (Shift+Tab, `/gear`, `/mode`). Updates the broker and the
   * mirrored compatibility flags so status stays coherent. Gears never change
   * the OS sandbox posture — that is the independent `/sandbox` switch.
   * Under an org policy the broker may refuse the gear; the refusal reason is
   * returned so the UI can say why the cycle skipped.
   */
  setPermissionMode(mode: PermissionModeInput): { ok: boolean; reason?: string } {
    const canonical = configModeToPermissionMode(mode);
    if (!canonical) return { ok: false, reason: `unknown gear "${mode}"` };
    if (canonical === "auto" && !this.autoModeSafety.getConfig().enabled) {
      return { ok: false, reason: "classifier-backed auto gear is disabled by policy" };
    }
    const result = this.permissions.setMode(canonical);
    if (!result.ok) return result;
    this.config.permissionMode = canonical;
    this.config.yoloMode = canonical === "gear-4";
    this.config.trustWorkspace = canonical === "gear-3";
    return result;
  }

  /**
   * Shift up to the next gear and return it. Gears the org policy forbids are
   * skipped (the cycle still terminates — 1st gear is never forbidden by
   * construction of the broker check order).
   */
  cyclePermissionMode(): PermissionMode {
    let mode = this.permissions.getMode();
    for (let i = 0; i < PERMISSION_MODE_ORDER.length; i++) {
      mode = nextPermissionMode(mode);
      if (this.setPermissionMode(mode).ok) return mode;
    }
    return this.permissions.getMode();
  }

  // ─── Sandbox mode (/sandbox on|off) ───

  /** Whether foreground bash currently runs inside the OS sandbox. */
  isSandboxEnabled(): boolean {
    return isSandboxEnabled();
  }

  /**
   * Flip the OS sandbox live. Propagates through the shared sandbox-mode
   * state (Rust --sandbox flag, net preflight, broker confinement, bash tool
   * description) and drops the cached environment blocks so the very next
   * turn's system prompt states the new posture.
   */
  setSandboxEnabled(enabled: boolean): void {
    setSandboxMode(enabled ? "on" : "off");
    this.config.sandboxEnabled = enabled;
    this.envBlocks.clear();
  }

  /**
   * Toggle [git] autoCommit live. The run-completion path reads
   * `this.config.git.autoCommit` each time, so this takes effect from the next
   * successful run in this session (and callers persist it to config.toml so it
   * sticks).
   */
  setAutoCommit(enabled: boolean): void {
    this.config.git = { ...(this.config.git ?? {}), autoCommit: enabled };
  }

  // ─── Config settings (the `update_config` tool / `/config`) ───

  /**
   * Apply one already-validated config setting live. The `update_config` tool
   * calls this after the shared catalog has normalized the value; the engine owns
   * how each setting takes effect. Returns whether it took and, if not, why (e.g.
   * an org policy forbidding 4th gear) so the caller can avoid persisting a
   * setting the machine won't honor.
   */
  applyConfigSetting(key: string, canonicalValue: string): { ok: boolean; reason?: string } {
    switch (key) {
      case "gear":
      case "permission_mode": {
        const mode = configModeToPermissionMode(canonicalValue);
        if (!mode) return { ok: false, reason: `unknown gear "${canonicalValue}"` };
        return this.setPermissionMode(mode);
      }
      case "sandbox":
        this.setSandboxEnabled(canonicalValue === "true");
        return { ok: true };
      case "auto_commit":
        this.setAutoCommit(canonicalValue === "true");
        return { ok: true };
      default:
        return { ok: false, reason: `no live handler for "${key}"` };
    }
  }

  /** The current canonical value of a settable config, for the tool's reports. */
  readConfigSetting(key: string): string | undefined {
    switch (key) {
      case "gear":
      case "permission_mode":
        return permissionModeToConfig(this.getPermissionMode());
      case "sandbox":
        return this.isSandboxEnabled() ? "true" : "false";
      case "auto_commit":
        return this.isAutoCommitEnabled() ? "true" : "false";
      default:
        return undefined;
    }
  }

  // ─── Browser mode (/browser on|off) ───

  /** Whether the built-in Playwright-MCP browser server is enabled. */
  isBrowserEnabled(): boolean {
    return this.browserEnabled;
  }

  /**
   * Flip the agent browser live. When MCP has already been discovered this
   * restarts discovery so the built-in `browser` server starts or stops and
   * the tool registry reconciles; before first discovery, flipping the flag
   * is enough — the lazy MCP load picks it up. The next turn's system prompt
   * states the new posture (browser doctrine).
   */
  async setBrowserEnabled(enabled: boolean): Promise<void> {
    if (this.browserEnabled === enabled) return;
    this.browserEnabled = enabled;
    if (!this.mcpLoaded) return;
    await this.mcpDiscovery?.stopAll().catch(() => {});
    // Drop every registered MCP tool before re-discovery: reconcileMcpTools
    // can only diff against a live discovery, and a failed restart must not
    // leave phantom browser tools behind.
    for (const schema of this.registry.list()) {
      if (schema.name.startsWith("mcp_")) this.registry.unregister(schema.name);
    }
    this.mcpDiscovery = null;
    this.mcpLoaded = false;
    await this.ensureMcpServers();
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
      toolResultProcessor: this.processToolResult,
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

    // Org policy model/provider allowlist: enforced per turn (model switches
    // mid-session must not slip past a start-time-only check).
    if (this.orgPolicy) {
      const modelDenial = policyAllowsModel(
        this.orgPolicy.policy,
        session.provider ?? this.config.provider,
        session.model ?? this.config.model,
      );
      if (modelDenial) {
        yield { type: "error", error: modelDenial, recoverable: false };
        return;
      }
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

    // Black box: scope this run and start its flight trail.
    this.runCounter++;
    this.recorder?.beginRun(sessionId, this.runCounter);
    this.recorder?.note("user_msg", userMessage.slice(0, 180));
    this.struggles?.beginRun();
    this.struggles?.onUserMessage(userMessage);
    let lastTodos: Array<{ content: string; status: string }> | null = null;
    const nbObservations: ToolObservation[] = [];
    // Every file this run wrote — the exact scope of the git auto-commit.
    const writtenPaths = new Set<string>();

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
    // The map is intentionally per request rather than per session: ranking is
    // query-aware. It remains outside the cache-sensitive system prompt and is
    // admitted or evicted by ContextEngine with the rest of retrieved context.
    const repoMapChunks =
      this.config.context?.repoMap === false
        ? []
        : await buildRepoMap({
            workspaceRoot: this.config.workspaceRoot,
            binaryPath: this.config.toolsBinaryPath,
            query: userMessage,
          }).then((map) => (map ? [map] : []));
    const projectMemory = loadProjectMemory(this.config.workspaceRoot);
    const notebookBlock = this.buildNotebookInjection(sessionId);
    const activeLoop = this.getActiveLoopTask(sessionId);
    const systemPrompt = [
      SYSTEM_PROMPT,
      renderInteractiveDoctrine(this.interactiveAuto),
      renderBrowserDoctrine(this.browserEnabled),
      activeLoop ? renderLoopRunDoctrine(activeLoop) : "",
      envBlock,
      projectMemory.block,
      this.buildSystemMemoryBlock(),
      notebookBlock?.text ?? "",
      this.skillCatalog,
    ]
      .filter((s) => s && s.trim())
      .join("\n\n");

    // Injection = usage. Wins are attributed at run end if the run recovered.
    if (notebookBlock && notebookBlock.injectedIds.length > 0) {
      this.notebookStore?.touchUses(notebookBlock.injectedIds);
    }

    const trustedUserMessages = priorEvents
      .filter(({ event }) => event.type === "user_msg")
      .map(({ event }) => (typeof event.payload.content === "string" ? event.payload.content : ""))
      .filter(Boolean);
    trustedUserMessages.push(userMessage);
    const permCheck = this.buildPermissionCheck({ sessionId, userMessages: trustedUserMessages });
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
      // Planner keeps the session's (stronger) model; executor steps default to
      // the light tier — cross-provider when the user's [tiers] config says so.
      const lightTier = this.resolveModelTier("light");
      const routing: ModelRouting = {
        planner: this.config.routing?.planner ?? session.model,
        executor: this.config.routing?.executor ?? lightTier.model,
        plannerProvider: this.config.routing?.plannerProvider ?? this.config.provider,
        executorProvider:
          this.config.routing?.executorProvider ?? (lightTier.provider as ProviderName),
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
          retrievedChunks: repoMapChunks,
          verifier: this.verifier ?? undefined,
          nativeGrounding: this.config.search?.nativeGrounding ?? true,
          toolResultProcessor: this.processToolResult,
        },
        this.gateway,
        this.registry,
        permCheck,
      );
    } else {
      // Recovery bounds resolved per model family + [reliability] overrides —
      // computed at run start so a /model switch takes effect next run.
      const reliability = policyForModel(session.model, this.config.reliability);
      const loop = new AgentLoop(
        {
          model: session.model,
          provider: this.config.provider,
          maxTokens: MAX_TOKENS,
          maxTurns: MAX_TURNS,
          systemPrompt,
          priorMessages,
          contextEngine: this.contextEngine,
          retrievedChunks: repoMapChunks,
          verifier: this.verifier ?? undefined,
          nativeGrounding: this.config.search?.nativeGrounding ?? true,
          onIncident: this.recorder ? (i: IncidentInput) => this.recorder?.record(i) : undefined,
          maxConsecutiveErrors: reliability.maxConsecutiveErrors,
          maxStuckNudges: reliability.maxStuckNudges,
          maxRateWaits: reliability.maxRateWaits,
          maxOverflowCompactions: reliability.maxOverflowCompactions,
          maxEmptyCompletionRetries: reliability.maxEmptyCompletionRetries,
          maxTruncationRetries: reliability.maxTruncationRetries,
          maxVerifyAttempts: reliability.maxVerifyAttempts,
          toolResultProcessor: this.processToolResult,
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
      // Expose the live loop so interject() can steer this run mid-flight.
      this.liveLoop = loop;
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
              const saved = this.checkpointStore.load(runId);
              if (saved) {
                yield { type: "checkpoint_saved", runId, version: saved.version, turnCount };
              }
            } catch {
              // Checkpoint save failed — non-fatal
            }
          }

          this.sessions.appendEvent(sessionId, {
            type: "checkpoint",
            payload: { summary: `auto-checkpoint at turn ${turnCount}` },
          });
        }

        // Track the final todo state for the end-of-run unfinished check.
        if (event.type === "todo_updated") {
          lastTodos = event.items;
        }

        // Notebook: observe every tool call (free — the events exist anyway).
        if (event.type === "tool_call_end" && this.notebookStore && nbObservations.length < 200) {
          nbObservations.push({
            toolName: event.output.toolName,
            args: event.args,
            success: event.output.success,
            error: event.output.error,
          });
        }

        // Black box: trail + failure classification. One chokepoint sees every
        // tool result (built-in, MCP, rust bridge) — no per-tool instrumentation.
        if (event.type === "tool_call_end" && this.recorder) {
          const out = event.output;
          this.struggles?.onToolCall(out.toolName, event.args, out.success);
          this.recorder.note(
            `tool:${out.toolName}`,
            out.success
              ? `ok ${out.durationMs}ms`
              : `FAIL ${out.durationMs}ms: ${(out.error ?? "").slice(0, 120)}`,
          );
          if (!out.success) {
            const { cls, severity } = classifyToolFailure(out.toolName, out.error ?? "");
            this.recorder.record({
              class: cls,
              severity,
              component: `tool:${out.toolName}`,
              where: "engine#toolCallEnd",
              message: out.error ?? "tool failed without an error message",
              context: { tool: out.toolName, argsHash: hashArgs(event.args) },
            });
          }
        }
        if (event.type === "notice" && this.recorder) {
          this.recorder.note("notice", event.message);
        }
        if (event.type === "error" && this.recorder) {
          this.recorder.note("error", event.error);
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

          // Track written files for the run's git auto-commit scope.
          if (
            event.output.success &&
            ["write_file", "edit_file", "multi_edit"].includes(event.output.toolName) &&
            typeof event.args.path === "string" &&
            event.args.path
          ) {
            writtenPaths.add(event.args.path);
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
              const saved = this.checkpointStore.load(runId);
              if (saved) {
                yield { type: "checkpoint_saved", runId, version: saved.version, turnCount };
              }
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

        // Keep the session row's context-size readout current (sessions
        // manager metadata). Cheap column update, throttled to real reports.
        if (event.type === "usage" && event.context && event.context.used > 0) {
          try {
            this.sessions.noteContextTokens(sessionId, event.context.used);
          } catch {
            // Metadata only — never let it interrupt the stream.
          }
        }

        yield event;
      }

      // Aider-style trust: land this run's writes as ONE revertible commit
      // (opt-in via [git] autoCommit). Only on clean completion — a failed or
      // aborted run leaves the worktree as-is for inspection.
      if (
        this.config.git?.autoCommit === true &&
        !runError &&
        !signal.aborted &&
        writtenPaths.size > 0
      ) {
        const commit = autoCommitPaths(this.config.workspaceRoot, [...writtenPaths], userMessage);
        if (commit.committed) {
          this.lastAutoCommitSha = commit.sha;
          this.sessions.appendEvent(sessionId, {
            type: "checkpoint",
            payload: { summary: `auto-commit ${commit.shortSha}` },
          });
          yield {
            type: "notice",
            message: `Committed ${commit.fileCount} file${commit.fileCount === 1 ? "" : "s"} as ${commit.shortSha} — /undo reverts it.`,
          } as PlanRunnerEvent;
        } else if (
          !/no files written|no effective changes|not a git repository/.test(commit.reason)
        ) {
          // Only surface reasons the user should act on (e.g. staged changes).
          yield {
            type: "notice",
            message: `Auto-commit skipped: ${commit.reason}`,
          } as PlanRunnerEvent;
        }
      }
    } finally {
      // Stop accepting steering the moment the run winds down — anything
      // interjected after this point could never be drained by the loop.
      const steeredLoop = this.liveLoop;
      this.liveLoop = null;

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
        } else if (m.role === "user") {
          // Mid-turn interjections are real user turns — persist them at their
          // true position so resumed sessions replay the same conversation the
          // live run saw. Synthetic loop nudges (verification prompts, the
          // evidence gate, compaction summaries) don't carry the interjection
          // marker and stay unpersisted, exactly as before.
          const first = m.content.find((b) => b.type === "text");
          const raw = first && first.type === "text" ? parseInterjection(first.text) : null;
          if (raw) {
            this.sessions.appendEvent(sessionId, {
              type: "user_msg",
              payload: { content: raw },
            });
          }
        }
      }

      // Steering that arrived too late to be folded in (the run aborted or
      // errored between boundaries): persist it as user turns at the tail so
      // nothing the user typed is silently lost — a resumed session replays it
      // and the next turn picks it up.
      for (const t of steeredLoop?.takeUndrainedInterjections() ?? []) {
        this.sessions.appendEvent(sessionId, {
          type: "user_msg",
          payload: { content: t },
        });
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

      // Behavioral signals that only resolve at run end.
      this.struggles?.onRunEnd(lastTodos);

      // Notebook: distill this run's observations (rule-based, zero tokens)
      // and attribute a win to whatever was injected if the run ended clean.
      if (this.notebookStore && this.notebookKeys) {
        captureFromRun(
          {
            store: this.notebookStore,
            repoKey: this.notebookKeys.repoKey,
            stackKey: this.notebookKeys.stackKey,
            sessionId,
            workspaceRoot: this.config.workspaceRoot,
          },
          nbObservations,
        );
        const nb = this.notebookBlocks.get(sessionId);
        if (nb && nb.injectedIds.length > 0 && !runError && !signal.aborted) {
          this.notebookStore.recordWins(nb.injectedIds);
        }
      }

      // Black box: resolve every incident this run produced. A 429 that
      // recovered is noise; one that killed the run is signal — outcome is
      // what separates them.
      if (this.recorder) {
        if (signal.aborted) {
          this.recorder.record({
            class: "loop.user_abort",
            severity: "debug",
            component: "engine",
            where: "engine#chat.finally",
            message: "run aborted by the user",
          });
          this.recorder.endRun("user_interrupted");
        } else if (runError) {
          this.recorder.endRun("turn_failed");
        } else {
          this.recorder.endRun("recovered");
        }
      }

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
    if (this.currentAbort) this.struggles?.onAbort();
    this.currentAbort?.abort();
  }

  /**
   * Mid-turn steering: fold a user message into the chat() run currently in
   * flight. The agent sees it at the next turn boundary — it updates its plan
   * and keeps working instead of the message waiting for the run to finish —
   * and the engine persists it as a real user turn at its true position.
   *
   * Returns true when a live run accepted the message. Returns false when
   * there is nothing steerable (idle, planner mode, research, or the run is
   * already winding down) — callers fall back to queueing for the next turn.
   */
  interject(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    const loop = this.liveLoop;
    if (!loop) return false;
    if (!this.currentAbort || this.currentAbort.signal.aborted) return false;
    const state = loop.getState();
    if (state === "done" || state === "error") return false;
    loop.interject(t);
    this.recorder?.note("interjection", t.slice(0, 180));
    return true;
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

  /**
   * Resolve a model tier (heavy/standard/light) to a concrete provider+model:
   * user `[tiers]` config first (supports cross-provider "provider/model"),
   * then the active provider's built-in tier table, then the session model.
   * Only ever returns providers that are registered (credentials present).
   */
  resolveModelTier(tier: ModelTier): TierRef {
    const registered = new Set<string>(this.gateway.getRegisteredProviderNames());
    const known = new Set<string>(PROVIDER_PRESETS.map((p) => p.id));
    known.add("custom");
    return resolveTier(
      tier,
      this.config.tiers,
      this.config.provider,
      this.config.model,
      registered,
      known,
    );
  }

  /** Point the compaction summarizer at the current light tier. */
  private syncSummarizerTier(): void {
    const light = this.resolveModelTier("light");
    this.contextEngine?.setSummarizer(light.model, light.provider as ProviderName);
  }

  /** Switch model and/or provider at runtime. */
  switchModel(model: string, provider?: ProviderName, sessionId?: string): void {
    this.config.model = model;
    if (provider) {
      this.config.provider = provider;
      this.rebuildGateway();
    } else {
      // Model-only switch: keep the summarizer's tier in sync (rebuildGateway,
      // which also re-syncs, doesn't run when the provider is unchanged).
      this.syncSummarizerTier();
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
      credentials: this.resolvedCredentials,
      // Closure reads this.recorder lazily, so key-edit rebuilds keep the tap.
      onIncident: (gi) => {
        if (!this.recorder) return;
        const cls: IncidentClass =
          gi.kind === "fallback"
            ? "provider.fallback_triggered"
            : gi.status === 429
              ? "provider.rate_limit"
              : gi.status === 401 || gi.status === 403
                ? "provider.auth"
                : gi.status === 402
                  ? "provider.no_credits"
                  : "provider.terminal";
        this.recorder.record({
          class: cls,
          severity: gi.kind === "fallback" ? "warn" : "error",
          component: "gateway",
          where: "gateway#inferStream",
          message:
            gi.kind === "fallback"
              ? `${gi.provider}/${gi.model ?? "?"} → ${gi.fallbackTo}: ${gi.message}`
              : gi.message,
          context: { provider: gi.provider, model: gi.model, status: gi.status },
        });
      },
    };
  }

  private rebuildGateway(): void {
    this.gateway = buildGateway(this.gatewayOpts());
    // Keep the context engine pointed at the live gateway + light tier so
    // /compress and rolling compaction follow key/provider/toggle changes
    // instead of using a stale gateway or the anthropic default.
    this.contextEngine?.setGateway(this.gateway);
    this.syncSummarizerTier();
  }

  /**
   * Add (or, with null, remove) a provider API key at runtime and rebuild the
   * gateway so the change takes effect immediately. Persistence to the secrets
   * file is the caller's responsibility — this only touches in-memory state.
   * Returns a forced model switch when clearing the key left the active provider
   * unusable, so the caller can tell the user we moved them.
   */
  setProviderKey(id: string, key: string | null, sessionId?: string): ProviderChangeResult {
    if (key && key.trim()) {
      const trimmed = key.trim();
      this.providerKeys[id] = trimmed;
      // Keep the pool coherent: a bare "set" replaces the pool with one entry so
      // getProviderStatus (which reads the pool) matches the live key.
      const entryId = `legacy_${id}`;
      this.providerKeyEntries[id] = [{ id: entryId, key: trimmed }];
      this.activeProviderKeyId[id] = entryId;
    } else {
      delete this.providerKeys[id];
      delete this.providerKeyEntries[id];
      delete this.activeProviderKeyId[id];
    }
    this.rebuildGateway();
    return { switchedTo: this.reconcileActiveProvider(sessionId) };
  }

  /**
   * Adopt a provider's full key pool as the source of truth — the uniform live
   * counterpart to the secrets-store mutators (add / remove / set-active). The
   * caller persists to secrets.json (which mints the entry ids + dates) and hands
   * the resulting pool here; the engine mirrors the active key into the gateway
   * and rebuilds. Passing an empty pool drops the provider's key entirely.
   * Returns a forced model switch if the change left the active provider unusable.
   */
  setProviderKeys(
    id: string,
    entries: StoredKey[],
    activeId?: string,
    sessionId?: string,
  ): ProviderChangeResult {
    if (!entries.length) {
      delete this.providerKeys[id];
      delete this.providerKeyEntries[id];
      delete this.activeProviderKeyId[id];
    } else {
      const active = (activeId && entries.find((e) => e.id === activeId)) || entries[0]!;
      this.providerKeyEntries[id] = entries.map((e) => ({ ...e }));
      this.activeProviderKeyId[id] = active.id;
      this.providerKeys[id] = active.key;
    }
    this.rebuildGateway();
    return { switchedTo: this.reconcileActiveProvider(sessionId) };
  }

  /**
   * BYOP: apply (or, with null, drop) a credential resolved by the auth layer —
   * e.g. right after `gear login` mints an OAuth token — and rebuild the gateway
   * so it takes effect immediately. Persistence lives in the credential store;
   * this only touches in-memory state. Returns a forced switch if dropping the
   * credential left the active provider unusable.
   */
  setResolvedCredential(
    id: string,
    cred: ResolvedCredential | null,
    sessionId?: string,
  ): ProviderChangeResult {
    if (cred) this.resolvedCredentials[id] = cred;
    else delete this.resolvedCredentials[id];
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
    this.syncSummarizerTier();
    return { provider: next, model };
  }

  /** Per-provider status (with masked keys) for the `/keys` panel. */
  getProviderStatus(): ProviderStatusRow[] {
    return providerStatus({
      keys: this.providerKeys,
      keyEntries: this.providerKeyEntries,
      activeKeyId: this.activeProviderKeyId,
      customEndpoint: this.customEndpoint,
      disabled: this.disabledProviders,
      localBaseUrls: this.localBaseUrls,
      credentials: this.resolvedCredentials,
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
    if (this.permissions.getMode() === "gear-4") return "yolo";
    if (this.securityGuard && this.rateLimiter) return "strict";
    if (this.securityGuard || this.rateLimiter) return "standard";
    return "permissive";
  }

  getAuditStats() {
    return this.autoVerifier?.getStats() ?? { totalCalls: 0, lastVerified: null, isValid: true };
  }

  getAutoModeStatus(): ReturnType<AutoModeSafetyController["getStatus"]> {
    return this.autoModeSafety.getStatus();
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
    sandboxEnabled: boolean;
    sandboxDegraded: boolean;
    registeredProviders: ProviderName[];
    cost: number;
    sessionId?: string;
    contextUsage: { used: number; limit: number; percent: number };
    securityPosture: string;
    mcp: { servers: number; tools: number };
    skills: number;
    orgPolicy: { org?: string; fingerprint: string; source: string } | null;
    autoMode: ReturnType<AutoModeSafetyController["getStatus"]>;
  } {
    return {
      model: this.config.model,
      provider: this.config.provider,
      workspace: this.config.workspaceRoot,
      plannerMode: this.config.plannerMode,
      yoloMode: this.config.yoloMode,
      trustWorkspace: this.permissions.isTrustWorkspace(),
      permissionMode: this.permissions.getMode(),
      sandboxEnabled: isSandboxEnabled(),
      sandboxDegraded: isSandboxEnabled() && !isOsIsolationAvailable(),
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
      orgPolicy: this.orgPolicy
        ? {
            org: this.orgPolicy.policy.org,
            fingerprint: this.orgPolicy.fingerprint,
            source: this.orgPolicy.source,
          }
        : null,
      autoMode: this.autoModeSafety.getStatus(),
    };
  }

  /** The black-box recorder, or null when disabled. Surfaces (/bug, doctor) use this. */
  getRecorder(): Recorder | null {
    return this.recorder;
  }

  /** The tactics notebook store, or null when disabled (/notebook uses this). */
  getNotebookStore(): NotebookStore | null {
    return this.notebookStore;
  }

  /** Entries active for THIS workspace (repo + matching stack + global), ranked. */
  getNotebookEntries(limit = 10): NotebookEntry[] {
    if (!this.notebookStore || !this.notebookKeys) return [];
    try {
      return this.notebookStore.retrieve({ ...this.notebookKeys, limit });
    } catch {
      return [];
    }
  }

  /**
   * Build (and cache per session) the notebook injection block. Cached so the
   * system prompt stays byte-stable across a session's turns — churn would
   * invalidate the provider's prefix cache and cost far more than the notebook
   * saves. New learnings appear in the NEXT session, which is the contract.
   */
  private buildNotebookInjection(sessionId: string): NotebookBlock | null {
    if (!this.notebookStore || !this.notebookKeys) return null;
    const cached = this.notebookBlocks.get(sessionId);
    if (cached) return cached;
    try {
      const block = buildNotebookBlock(this.notebookStore, {
        repoKey: this.notebookKeys.repoKey,
        stackKey: this.notebookKeys.stackKey,
        maxTokens: this.config.notebook?.maxInjectTokens ?? 600,
      });
      this.notebookBlocks.set(sessionId, block);
      return block;
    } catch {
      return null; // the notebook must never break prompt assembly
    }
  }

  // ── Interactive dashboards ──

  /** Whether the model may build dashboards on its own judgment. */
  isInteractiveAuto(): boolean {
    return this.interactiveAuto;
  }

  /** Flip dashboard autonomy; takes effect on the next run's system prompt. */
  setInteractiveAuto(on: boolean): void {
    this.interactiveAuto = on;
  }

  /** The most recently created dashboard (id/title/url), if any. */
  lastDashboard(): DashboardInfo | null {
    return this.dashboards.last();
  }

  /** Re-open the last dashboard (or `id`) in the browser. */
  openDashboard(id?: string): DashboardInfo | null {
    return this.dashboards.open(id);
  }

  close(): void {
    // Best-effort: stop MCP subprocesses / sessions on exit.
    this.mcpDiscovery?.stopAll().catch(() => {});
    this.dashboards.closeAll();
    if (this.recorder) {
      setToolArgsSalvageListener(null); // never leave a listener pointing at a closed recorder
      this.recorder.close();
    }
    this.notebookStore?.close();
    this.sessions.close();
  }
}

// ─── Black-box tool-failure classification ───
// One text-based classifier at the engine chokepoint covers every tool source
// (built-in, MCP, rust bridge) without per-tool instrumentation. Patterns are
// deliberately conservative; anything unrecognized is a plain exec_failure.

export function classifyToolFailure(
  toolName: string,
  error: string,
): { cls: IncidentClass; severity: IncidentSeverity } {
  const e = error.toLowerCase();
  if (e.includes("panicked at") || e.includes("rust panic")) {
    return { cls: "crash.rust_tool_panic", severity: "critical" };
  }
  if (e.includes("permission denied") && (e.includes("user") || e.includes("broker"))) {
    return { cls: "tool.permission_denied", severity: "debug" };
  }
  if (e.includes("sandbox") || e.includes("seatbelt") || e.includes("operation not permitted")) {
    return { cls: "tool.sandbox_denial", severity: "warn" };
  }
  if (
    e.includes("outside the workspace") ||
    e.includes("outside workspace") ||
    e.includes("path traversal") ||
    e.includes("blocked path")
  ) {
    return { cls: "tool.path_violation", severity: "warn" };
  }
  if (/\btimed?\s?out\b|\btimeout\b/.test(e)) {
    return { cls: "tool.timeout", severity: "error" };
  }
  if (
    e.includes("invalid arg") ||
    e.includes("invalid input") ||
    e.includes("invalid param") ||
    e.includes("missing required") ||
    e.includes("schema validation")
  ) {
    // The model self-corrects on the schema error it gets back — small but counted.
    return { cls: "tool.invalid_input", severity: "debug" };
  }
  if (toolName.startsWith("mcp_") || e.includes("mcp ")) {
    return { cls: "tool.mcp_error", severity: "error" };
  }
  return { cls: "tool.exec_failure", severity: "error" };
}
