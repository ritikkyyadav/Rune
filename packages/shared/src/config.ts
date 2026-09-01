import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { AuthMethod } from "./providers.js";
import { adoptLegacyEnv, getGearHome, workspaceConfigPath } from "./paths.js";

// ─── Config Types ───

export interface GearConfig {
  engine: {
    socketPath: string;
    logDir: string;
    dbPath: string;
    maxSessions: number;
  };
  llm: {
    // Full ProviderName set (was missing groq/xai/deepseek/lmstudio/custom, which
    // are valid providers — widened so config.toml can name any of them).
    defaultProvider:
      | "anthropic"
      | "openai"
      | "openrouter"
      | "ollama"
      | "ollama-turbo"
      | "lmstudio"
      | "google"
      | "groq"
      | "xai"
      | "deepseek"
      | "custom";
    /**
     * Optional default auth method for all providers when a provider block omits
     * its own. When unset, the method is auto-selected (see the auth resolver):
     * the first supported method with stored credentials, else the provider's
     * default (api_key for cloud, local for runtimes). Additive — no existing
     * config needs it.
     */
    authentication?: AuthMethod;
    /**
     * Reasoning depth sent to every provider that has the dial (Codex/OpenAI
     * `reasoning.effort`). Unset means "high" — see AgentLoop. This exists
     * because the dial was previously unreachable: a ChatGPT-subscription
     * session ran at the server default forever, with `max` available and no
     * way to ask for it.
     */
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    /** "jit" (default) injects situational doctrine at first relevance; "full" keeps it in every request. */
    doctrineDelivery?: "jit" | "full";
    /** "conservative" (default) steps ordinary turns one effort notch down, escalating on difficulty; "off" disables routing. */
    effortRouting?: "conservative" | "off";
    anthropic?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      /** Override the auth method for this provider (api_key | oauth | device | local). */
      authentication?: AuthMethod;
    };
    openai?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    openrouter?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    google?: {
      apiKey: string;
      model: string;
      maxTokens: number;
      authentication?: AuthMethod;
    };
    ollama?: {
      baseUrl: string;
      model: string;
      authentication?: AuthMethod;
    };
    lmstudio?: {
      baseUrl: string;
      model: string;
      authentication?: AuthMethod;
    };
    planner?: {
      provider: string;
      model: string;
    };
    executor?: {
      provider: string;
      model: string;
    };
  };
  permissions: {
    defaultLevel: "auto" | "confirm" | "sandbox";
    rules: PermissionRule[];
    /**
     * The gear the session STARTS in — the persisted counterpart of the
     * Shift+Tab cycle ("shift up"):
     *   1 | "1"   — 1st gear: guided — ask before writes and commands (default)
     *   2 | "2"   — 2nd gear: workspace file edits proceed; commands still ask
     *   3 | "3"   — 3rd gear: also sandboxed commands and confined delegation
     *   4 | "4"   — 4th gear: full autonomy, no permission prompts
     *               (the OS sandbox is the separate [sandbox] switch)
     *   "auto"    — automatic: a separate classifier reviews risky actions
     * Ordinals ("3rd"), ids ("gear-3") and the legacy autonomy names are read
     * too. Explicit `--gear` / `--yolo` / `--trust` flags override this at
     * launch. Absent ⇒ 1st gear. Org policy can forbid gears regardless.
     */
    gear?: 1 | 2 | 3 | 4 | "1" | "2" | "3" | "4" | "auto" | (string & {});
    /**
     * LEGACY key (pre-gear). Still read when `gear` is absent. Historical
     * values: confirm → 1st gear; autonomy-i/ii/iii → 2nd/3rd/4th;
     * hands-free/turing → 4th; and the OLD meaning of "auto" (auto-approve
     * workspace work) → 3rd gear — never the classifier.
     */
    mode?:
      "confirm" | "autonomy-i" | "autonomy-ii" | "autonomy-iii" | "auto" | "hands-free" | "turing";
    /**
     * LEGACY storage flag for the old "workspace trust" (today's 3rd gear).
     * Read when neither `gear` nor `mode` is set.
     */
    trustWorkspace?: boolean;
    /**
     * Classifier-backed Auto mode. Semantic policy text shapes the isolated
     * reviewer; *Rules are mechanical tool/glob gates evaluated deny -> ask -> allow.
     */
    autoMode?: {
      enabled?: boolean;
      classifierProvider?: string;
      classifierModel?: string;
      environment?: string[];
      allow?: string[];
      softDeny?: string[];
      hardDeny?: string[];
      allowRules?: string[];
      askRules?: string[];
      denyRules?: string[];
      timeoutMs?: number;
      maxAutomaticDenials?: number;
      /**
       * Default true. `false` (reviewer outage = allow everything) is honored
       * only when the signed org policy permits fail-open (`autoMode.allowFailOpen`
       * or its own `failClosed = false`); otherwise it is ignored with a loud
       * one-time warning and reported in /status as `failOpenAllowed = false`.
       */
      failClosed?: boolean;
      /**
       * Default true. Screens UNTRUSTED-SOURCE tool results (web, MCP, browser,
       * shell stdout, webhooks) for prompt injection; workspace reads are never probed.
       */
      probeToolResults?: boolean;
      /**
       * Default true. Reviewer "ask" verdicts return to the ACTING AGENT as an
       * actionable block ("needs explicit user authorization — ask the user
       * directly via ask_user") instead of an immediate modal prompt; the
       * user's typed answer authorizes the retry. Modal prompts remain the
       * backstop (repeated blocks, catastrophic circuit breakers, guardrail
       * changes, reviewer outage, askRules).
       */
      conversationalEscalation?: boolean;
      /**
       * Default true. Retry a failed reviewer call once — against the engine's
       * own heavy/standard tier when distinct from the pinned reviewer — before
       * failing closed. Stays within the session's existing data boundary.
       */
      reviewerFallback?: boolean;
      /**
       * Default true. The end-of-turn list of held steps is interactive: each
       * one can be approved ("run exactly this") or left unrun, per step.
       * `false` keeps the plain printed list.
       */
      heldStepPrompt?: boolean;
    };
  };
  sandbox: {
    enabled: boolean;
    networkDeny: boolean;
    fsAllowlist: string[];
    /**
     * Refuse sandbox-tier bash instead of degrading when this machine has no
     * OS isolation backend (sandbox-exec/bwrap). Default false: degraded runs
     * are allowed but lose auto-approval and are labelled honestly.
     */
    requireOs?: boolean;
  };
  /**
   * Language-server integration. `autoFeedback = true` pulls LSP diagnostics
   * after every successful write/edit on a supported file (1.5s budget,
   * errors only, appended to the tool result). Default false until
   * eval-proven — servers are heavyweight where edits are hot.
   */
  lsp?: {
    autoFeedback?: boolean;
  };
  /**
   * Loop recovery bounds — how many times the agent retries/waits/nudges
   * before giving up. Absent fields use per-model-family defaults
   * (orchestrator/reliability-policy.ts). All plain integers, e.g.
   * `[reliability] maxConsecutiveErrors = 5`.
   */
  reliability?: {
    maxConsecutiveErrors?: number;
    maxStuckNudges?: number;
    maxRateWaits?: number;
    maxOverflowCompactions?: number;
    maxEmptyCompletionRetries?: number;
    maxTruncationRetries?: number;
    maxVerifyAttempts?: number;
    readThrashCount?: number;
    editChurnCount?: number;
    maxPlanNudges?: number;
    maxReplanNudges?: number;
    maxStruggleNudges?: number;
  };
  /**
   * Which provider the gateway hands the work to when the active one fails
   * MID-TASK (`[fallback] order = ["anthropic", "codex"]`).
   *
   * Absent, the built-in capacity ranking decides: funded API keys, then
   * subscription seats, then free tiers, then local runtimes — so a capped
   * frontier session degrades as little as possible instead of landing on
   * whichever provider happened to register next. Names here are tried first,
   * in this order; providers left out are NOT excluded, they simply follow.
   */
  fallback?: {
    order?: string[];
    /**
     * Auto-resume the interactive session when a quota stop's retry window
     * passes (default true). `false` restores the old behavior: the run stays
     * stopped until the user sends something.
     */
    autoResume?: boolean;
    /**
     * What a plan/QUOTA cap does mid-task: "stop" (default) ends the run with
     * the retry window and keeps the work, rather than letting a weaker model
     * inherit an extensive task; "degrade" restores automatic downgrade.
     * Ordinary rate limits are unaffected — they clear in seconds.
     */
    onQuotaExceeded?: string;
  };
  /**
   * Post-edit verification (`[verify]`). Auto-detection covers the common
   * stacks; `commands` overrides it with the project's own checks, e.g.
   * `[verify] commands = ["bun run lint", "bun test tests/unit/"]`.
   * These fields were previously ENGINE-ONLY — no config key, no flag — so a
   * user could not point verification at their real checks at all.
   */
  verify?: {
    /** Default true. Set false to skip post-edit verification entirely. */
    enabled?: boolean;
    /** Explicit check commands; when non-empty, auto-detection is skipped. */
    commands?: string[];
    /** Per-command timeout in seconds. Default 120. */
    timeoutSecs?: number;
  };
  /**
   * Opt-in, transparent telemetry — the ONLY path by which anything leaves the
   * machine. Off by default; even `enabled = true` transmits nothing until BOTH
   * an `endpoint` is configured AND the local user has granted consent
   * (~/.gear/telemetry.json, set by the first-run prompt or `gear telemetry on`).
   * What ships is the already-redacted Black Box incident stream plus an
   * anonymous daily usage heartbeat — never file contents, never raw IPs, never
   * device fingerprints. `gear telemetry preview` prints the exact bytes.
   */
  telemetry: {
    /** Master switch / hard kill-switch. Default false. */
    enabled: boolean;
    /**
     * Collector URL that reports POST to. Empty/undefined ⇒ no network, ever —
     * this is the second half of the hard gate. Vendors bake their own
     * collector URL in here for shipped builds; users/enterprises can blank it.
     */
    endpoint?: string;
    /** Optional bearer token sent to the collector (shared secret). */
    token?: string;
    /** Send redacted crash/incident reports. Default true (only when enabled+consented). */
    crashReports?: boolean;
    /** Send the anonymous daily usage heartbeat. Default true (only when enabled+consented). */
    usageStats?: boolean;
  };
  checkpoint?: {
    enabled: boolean;
    intervalTurns: number;
    autoVerifyAudit: boolean;
  };
  search?: {
    /** Preferred web_search backend. Keys come from env (TAVILY_API_KEY / BRAVE_API_KEY). */
    provider?: "auto" | "tavily" | "brave" | "duckduckgo";
    /** Use provider-native grounding (Gemini/Anthropic) when available. Default true. */
    nativeGrounding?: boolean;
  };
  /** Deep-research (`/research`) defaults. */
  research?: {
    /** Depth preset: quick | standard | deep. Default standard. */
    depth?: "quick" | "standard" | "deep";
    /** Investigate→reflect cycles (round 1 = the plan, later rounds fill gaps). */
    maxRounds?: number;
    /** Max sub-questions in a plan. */
    maxSubQuestions?: number;
    /** Max investigators run in parallel (keep modest for keyless DuckDuckGo). */
    maxParallel?: number;
    /** Max sources fetched per sub-question. */
    maxSourcesPerStep?: number;
    /** Skip the approve gate and run immediately. Default false. */
    autoApprove?: boolean;
    /** Save the finished report as a markdown file. Default true. */
    save?: boolean;
    /** Directory for saved reports. Default `<workspace>/.gear/research`. */
    outputDir?: string;
  };
  ui?: {
    /**
     * Default color theme name (see orchestrator ui/themes.ts). Used at startup unless
     * overridden by the GEAR_THEME env var or a runtime `/theme` choice (~/.gear/theme.json).
     */
    theme?: string;
  };
  /**
   * Model tiers — route work by weight instead of hardcoding one model.
   * Values are "model" (active provider) or "provider/model" (cross-provider),
   * e.g.  heavy = "anthropic/claude-opus-4-8", light = "deepseek/deepseek-chat".
   * heavy: hardest tasks · standard: main loop · light: sub-agents, compaction
   * summaries, and other internal utility calls.
   */
  tiers?: {
    heavy?: string;
    standard?: string;
    light?: string;
  };
  /**
   * System Memory ("dreaming") — Gear's evergreen, narrative profile of the user and the
   * codebases they work in, injected into the system prompt so even small models get cheap,
   * personalised context. Stored at ~/.gear/system-memory.md (see shared/system-memory.ts).
   */
  memory?: {
    /** Inject the memory into the system prompt. Default true. */
    enabled?: boolean;
    /**
     * Automatic-refresh cadence: `manual` (no auto refresh) | `daily` | `weekly` | `3d` (every
     * N days). A live choice via `/memory <cadence>` overrides this. Default `manual` — the
     * dream never spends credits until the user opts in.
     */
    schedule?: string;
    /**
     * Model used for the refresh distillation: `cheapest` (a cheap model on an available
     * provider) | `active` (the current chat model) | `"<provider>/<model>"`. Default `cheapest`.
     */
    model?: string;
    /** Hard cap on the memory size in tokens — keeps it butter-smooth for tiny models. Default 1500. */
    maxTokens?: number;
  };
  /**
   * Black box (flight recorder) — local incident capture to ~/.gear/blackbox.db:
   * every failure, degradation, and struggle, with trail forensics. Local-only;
   * nothing is ever transmitted. Default on.
   */
  diagnostics?: {
    enabled?: boolean;
  };
  /**
   * Tactics notebook (evolution loop) — learned facts/tactics from past
   * sessions, injected under a hard token budget. Capture is rule-based
   * (zero extra model spend). Default on; `gear --pristine` disables per run.
   */
  notebook?: {
    enabled?: boolean;
    /** Injection budget in tokens. Default 600. */
    maxInjectTokens?: number;
  };
  /**
   * Git integration. autoCommit: after every successful run that wrote files,
   * commit exactly those files as one revertible "gear:" commit; revert with
   * /undo. Default false.
   */
  git?: {
    autoCommit?: boolean;
  };
  /**
   * Context assembly. repoMap: include a bounded, request-aware structural
   * map as retrieval context so the model knows what exists without
   * exploratory turns. Default true (falls back to a tracked file tree).
   */
  context?: {
    repoMap?: boolean;
  };
  /**
   * Agent web browser. When enabled, Gear mounts the official Playwright
   * MCP server (bunx @playwright/mcp) as a built-in `browser` MCP server:
   * headless, isolated (fresh profile), accessibility-snapshot based.
   * `/browser on|off` toggles it at runtime and persists to
   * ~/.gear/browser.json; --browser/--no-browser force it for one run.
   * Default off.
   */
  browser?: {
    enabled?: boolean;
    /** Run headless (default true); set false to watch the browser work. */
    headless?: boolean;
    /** Browser: chromium (managed, default) | chrome | firefox | webkit | msedge. */
    browser?: string;
    /** Origins the browser may navigate to; everything else is blocked. */
    allowedOrigins?: string[];
    /** Origins the browser must never touch. */
    blockedOrigins?: string[];
  };
  /**
   * Interactive dashboards. auto: let the model decide on its own when an
   * answer deserves a live HTML dashboard (reports, metrics, comparisons).
   * Default false — dashboards are built only on explicit request
   * (/interactive). Runtime toggle: /interactive auto on|off.
   */
  interactive?: {
    auto?: boolean;
  };
  /**
   * Multi-instance teamwork (config.toml `[team]`). When several Gear
   * processes work in the same repository they register on a local shared
   * bus (~/.gear/team.db): each sees the others' presence and intent, can
   * message them, and can lease path claims. claimEnforcement decides what a
   * write into a PEER's claimed scope does: "warn" (default) lets it proceed
   * with a loud warning in the tool result, "block" refuses it, "off"
   * disables the check. Everything is local to this machine and user.
   */
  team?: {
    enabled?: boolean;
    claimEnforcement?: "warn" | "block" | "off";
    /** Presence heartbeat interval in seconds (default 15). */
    heartbeatSecs?: number;
  };
}

export interface PermissionRule {
  tool: string;
  level: "auto" | "confirm" | "sandbox";
  pattern?: string;
  scope: "session" | "project" | "global";
}

// ─── Defaults ───

// Legacy ALAN_* env names are adopted before anything reads the environment.
adoptLegacyEnv();
const gearHome = getGearHome();

const DEFAULT_CONFIG: GearConfig = {
  engine: {
    socketPath: join(gearHome, "gear.sock"),
    logDir: join(gearHome, "logs"),
    dbPath: join(gearHome, "gear.db"),
    maxSessions: 50,
  },
  llm: {
    // Dev/test default = free tier (Gemini). Override via ~/.gear/config.toml,
    // <workspace>/.gear/config.toml, or GEAR_PROVIDER for production validation.
    defaultProvider: "google",
  },
  permissions: {
    defaultLevel: "confirm",
    rules: [],
    trustWorkspace: false,
  },
  sandbox: {
    enabled: true,
    networkDeny: true,
    fsAllowlist: [],
  },
  telemetry: {
    enabled: false,
  },
  search: {
    provider: "auto",
    nativeGrounding: true,
  },
  research: {
    depth: "standard",
    save: true,
  },
  memory: {
    enabled: true,
    schedule: "manual",
    model: "cheapest",
    maxTokens: 1500,
  },
  team: {
    enabled: true,
    claimEnforcement: "warn",
    heartbeatSecs: 15,
  },
};

// ─── TOML Parser (minimal, handles our config shape) ───

function parseToml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentSection: Record<string, unknown> = result;
  let sectionPath: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    // Section header: [section] or [section.subsection]
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      sectionPath = sectionMatch[1].split(".");
      currentSection = result;
      for (const key of sectionPath) {
        if (!(key in currentSection) || typeof currentSection[key] !== "object") {
          currentSection[key] = {};
        }
        currentSection = currentSection[key] as Record<string, unknown>;
      }
      continue;
    }

    // Key-value: key = value
    const kvMatch = line.match(/^(\w[\w-]*)?\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, rawValue] = kvMatch;
      currentSection[key] = parseTomlValue(rawValue.trim());
    }
  }

  return result;
}

function parseTomlValue(raw: string): unknown {
  // String (double or single quoted)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Array (simple one-line)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseTomlValue(s.trim()));
  }
  return raw;
}

// ─── Deep Merge ───

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      tv &&
      typeof tv === "object" &&
      !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else if (sv !== undefined) {
      result[key] = sv;
    }
  }
  return result;
}

// ─── Environment Variable Overlay ───

function applyEnvOverrides(config: Record<string, unknown>): void {
  const envMap: Record<string, (c: Record<string, unknown>) => void> = {
    GEAR_PROVIDER: (c) => setNested(c, "llm.defaultProvider", process.env.GEAR_PROVIDER!),
    GEAR_MODEL: (c) => {
      const provider = getDefaultProvider(c);
      setNested(c, `llm.${provider}.model`, process.env.GEAR_MODEL!);
    },
    GEAR_MAX_TOKENS: (c) =>
      setNested(c, `llm.${getDefaultProvider(c)}.maxTokens`, Number(process.env.GEAR_MAX_TOKENS!)),
    GEAR_DB_PATH: (c) => setNested(c, "engine.dbPath", process.env.GEAR_DB_PATH!),
    GEAR_SOCKET_PATH: (c) => setNested(c, "engine.socketPath", process.env.GEAR_SOCKET_PATH!),
    GEAR_LOG_DIR: (c) => setNested(c, "engine.logDir", process.env.GEAR_LOG_DIR!),
    GEAR_SANDBOX_ENABLED: (c) =>
      setNested(c, "sandbox.enabled", process.env.GEAR_SANDBOX_ENABLED === "true"),
    GEAR_SANDBOX_NETWORK: (c) =>
      setNested(c, "sandbox.networkDeny", process.env.GEAR_SANDBOX_NETWORK !== "allow"),
    GEAR_TRUST_WORKSPACE: (c) =>
      setNested(c, "permissions.trustWorkspace", process.env.GEAR_TRUST_WORKSPACE === "true"),
    GEAR_PERMISSION_MODE: (c) =>
      setNested(c, "permissions.mode", process.env.GEAR_PERMISSION_MODE!),
    // New-style: the gear itself (1|2|3|4|auto). `auto` here = the classifier.
    GEAR_GEAR: (c) => setNested(c, "permissions.gear", process.env.GEAR_GEAR!),
    GEAR_AUTO_CLASSIFIER_PROVIDER: (c) =>
      setNested(
        c,
        "permissions.autoMode.classifierProvider",
        process.env.GEAR_AUTO_CLASSIFIER_PROVIDER!,
      ),
    GEAR_AUTO_CLASSIFIER_MODEL: (c) =>
      setNested(c, "permissions.autoMode.classifierModel", process.env.GEAR_AUTO_CLASSIFIER_MODEL!),
    GEAR_AUTO_FAIL_CLOSED: (c) =>
      setNested(
        c,
        "permissions.autoMode.failClosed",
        process.env.GEAR_AUTO_FAIL_CLOSED !== "false",
      ),
    GEAR_TELEMETRY: (c) => setNested(c, "telemetry.enabled", process.env.GEAR_TELEMETRY === "true"),
    GEAR_TELEMETRY_ENDPOINT: (c) =>
      setNested(c, "telemetry.endpoint", process.env.GEAR_TELEMETRY_ENDPOINT!),
    GEAR_TELEMETRY_TOKEN: (c) => setNested(c, "telemetry.token", process.env.GEAR_TELEMETRY_TOKEN!),
    GEAR_SEARCH_BACKEND: (c) => setNested(c, "search.provider", process.env.GEAR_SEARCH_BACKEND!),
    GEAR_NATIVE_GROUNDING: (c) =>
      setNested(c, "search.nativeGrounding", process.env.GEAR_NATIVE_GROUNDING !== "false"),
    GEAR_RESEARCH_DEPTH: (c) => setNested(c, "research.depth", process.env.GEAR_RESEARCH_DEPTH!),
    GEAR_RESEARCH_MAX_ROUNDS: (c) =>
      setNested(c, "research.maxRounds", Number(process.env.GEAR_RESEARCH_MAX_ROUNDS!)),
    GEAR_RESEARCH_MAX_PARALLEL: (c) =>
      setNested(c, "research.maxParallel", Number(process.env.GEAR_RESEARCH_MAX_PARALLEL!)),
    GEAR_RESEARCH_MAX_SUBQUESTIONS: (c) =>
      setNested(c, "research.maxSubQuestions", Number(process.env.GEAR_RESEARCH_MAX_SUBQUESTIONS!)),
    GEAR_RESEARCH_AUTO_APPROVE: (c) =>
      setNested(c, "research.autoApprove", process.env.GEAR_RESEARCH_AUTO_APPROVE === "true"),
    GEAR_RESEARCH_SAVE: (c) =>
      setNested(c, "research.save", process.env.GEAR_RESEARCH_SAVE !== "false"),
    GEAR_MEMORY_ENABLED: (c) =>
      setNested(c, "memory.enabled", process.env.GEAR_MEMORY_ENABLED !== "false"),
    GEAR_MEMORY_SCHEDULE: (c) => setNested(c, "memory.schedule", process.env.GEAR_MEMORY_SCHEDULE!),
    GEAR_MEMORY_MODEL: (c) => setNested(c, "memory.model", process.env.GEAR_MEMORY_MODEL!),
    GEAR_MEMORY_MAX_TOKENS: (c) =>
      setNested(c, "memory.maxTokens", Number(process.env.GEAR_MEMORY_MAX_TOKENS!)),
    GEAR_TEAM: (c) => setNested(c, "team.enabled", process.env.GEAR_TEAM !== "false"),
    GEAR_TEAM_ENFORCEMENT: (c) =>
      setNested(c, "team.claimEnforcement", process.env.GEAR_TEAM_ENFORCEMENT!),
    ANTHROPIC_API_KEY: (c) => setNested(c, "llm.anthropic.apiKey", process.env.ANTHROPIC_API_KEY!),
    OPENAI_API_KEY: (c) => setNested(c, "llm.openai.apiKey", process.env.OPENAI_API_KEY!),
    OPENROUTER_API_KEY: (c) =>
      setNested(c, "llm.openrouter.apiKey", process.env.OPENROUTER_API_KEY!),
    GOOGLE_API_KEY: (c) => setNested(c, "llm.google.apiKey", process.env.GOOGLE_API_KEY!),
  };

  for (const [envVar, apply] of Object.entries(envMap)) {
    if (process.env[envVar]) {
      apply(config);
    }
  }
}

function getDefaultProvider(config: Record<string, unknown>): string {
  const llm = config.llm as Record<string, unknown> | undefined;
  return typeof llm?.defaultProvider === "string" ? llm.defaultProvider : "anthropic";
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ─── Config Loader ───

/**
 * Load Gear configuration with this precedence (later wins):
 * 1. Built-in defaults
 * 2. ~/.gear/config.toml (global)
 * 3. <workspace>/.gear/config.toml (project)
 * 4. GEAR_* environment variables
 */
export function loadConfig(workspaceRoot?: string): GearConfig {
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Global config (GEAR_CONFIG_PATH overrides ~/.gear/config.toml — see the writer).
  const globalConfig = globalConfigPath();
  if (existsSync(globalConfig)) {
    try {
      const text = readFileSync(globalConfig, "utf-8");
      merged = deepMerge(merged, parseToml(text));
    } catch {
      // Ignore malformed global config
    }
  }

  // Project config
  if (workspaceRoot) {
    const projectConfig = workspaceConfigPath(workspaceRoot, "config.toml");
    if (existsSync(projectConfig)) {
      try {
        const text = readFileSync(projectConfig, "utf-8");
        merged = deepMerge(merged, parseToml(text));
      } catch {
        // Ignore malformed project config
      }
    }
  }

  // Env overrides
  applyEnvOverrides(merged);

  return merged as unknown as GearConfig;
}

// ─── Config Writer ───
// Persist a single setting back into config.toml so a change made at runtime
// (Shift+Tab, `/config`, or "shift to 4th gear" spoken in chat) survives
// the next launch. This is deliberately a LINE-ORIENTED editor, not a
// serialize-the-whole-object writer: it rewrites only the one key's line and
// leaves every comment, blank line, and unrelated key exactly as the user wrote
// them. The reader above stays the source of truth for precedence/merging.

export type ConfigScope = "global" | "project";

/** The config.toml path for a scope: global = ~/.gear, project = <root>/.gear. */
export function getConfigFilePath(scope: ConfigScope, workspaceRoot?: string): string {
  if (scope === "project") {
    if (!workspaceRoot) throw new Error("project config scope requires a workspaceRoot");
    return workspaceConfigPath(workspaceRoot, "config.toml");
  }
  // GEAR_CONFIG_PATH overrides the global file (tests + advanced setups); the
  // loader honors the same override so reader and writer never disagree.
  return globalConfigPath();
}

/** The effective global config.toml path (honors GEAR_CONFIG_PATH). */
function globalConfigPath(): string {
  return process.env.GEAR_CONFIG_PATH || join(getGearHome(), "config.toml");
}

/** Render a JS value as a TOML scalar/array literal. */
function toTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => tomlString(v)).join(", ")}]`;
  return tomlString(value);
}

/** Quote a string as a TOML basic string, escaping the essentials. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Is this line the `[section.path]` header we're looking for? */
function isSectionHeader(line: string): string | null {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  return m ? m[1].trim() : null;
}

export interface SetConfigResult {
  /** The file that was written. */
  path: string;
  /** The value the key held before (undefined if it was newly added). */
  previousRaw?: string;
  /** Whether a brand-new key/section was created vs an in-place replace. */
  created: boolean;
}

/**
 * Set one dotted key (e.g. `permissions.mode`, `sandbox.enabled`) in a
 * config.toml, creating the file / section / key as needed and preserving
 * everything else byte-for-byte. The final path segment is the key; the rest is
 * the (possibly dotted) section. Returns what changed so callers can report it.
 */
export function setConfigValue(
  dottedKey: string,
  value: string | number | boolean | string[],
  opts: { scope?: ConfigScope; workspaceRoot?: string } = {},
): SetConfigResult {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`config key must be "<section>.<key>" (got "${dottedKey}")`);
  }
  const key = parts[parts.length - 1]!;
  const section = parts.slice(0, -1).join(".");
  const rendered = toTomlValue(value);
  const path = getConfigFilePath(opts.scope ?? "global", opts.workspaceRoot);

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const hadTrailingNewline = existing.endsWith("\n") || existing === "";
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");

  // Locate the target section's line range (header index → next-header index).
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const hdr = isSectionHeader(lines[i]!);
    if (hdr === null) continue;
    if (sectionStart === -1 && hdr === section) {
      sectionStart = i;
    } else if (sectionStart !== -1) {
      sectionEnd = i;
      break;
    }
  }

  const keyLineRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
  let previousRaw: string | undefined;
  let created: boolean;

  if (sectionStart === -1) {
    // Section absent — append a fresh block at EOF.
    if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
    lines.push(`[${section}]`);
    lines.push(`${key} = ${rendered}`);
    created = true;
  } else {
    // Search for the key within the section body.
    let keyLine = -1;
    for (let i = sectionStart + 1; i < sectionEnd; i++) {
      if (keyLineRe.test(lines[i]!)) {
        keyLine = i;
        break;
      }
    }
    if (keyLine === -1) {
      // Key absent — insert at the end of the section body (after the last
      // non-blank line so we don't strand it past trailing blanks).
      let insertAt = sectionEnd;
      while (insertAt - 1 > sectionStart && lines[insertAt - 1]!.trim() === "") insertAt--;
      lines.splice(insertAt, 0, `${key} = ${rendered}`);
      created = true;
    } else {
      const indent = lines[keyLine]!.match(/^(\s*)/)![1] ?? "";
      previousRaw = lines[keyLine]!.slice(indent.length + key.length)
        .replace(/^\s*=\s*/, "")
        .trim();
      lines[keyLine] = `${indent}${key} = ${rendered}`;
      created = false;
    }
  }

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, lines.join("\n") + (hadTrailingNewline ? "\n" : ""));
  return { path, previousRaw, created };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
