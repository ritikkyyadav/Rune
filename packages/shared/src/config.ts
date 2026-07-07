import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Config Types ───

export interface AlanConfig {
  engine: {
    socketPath: string;
    logDir: string;
    dbPath: string;
    maxSessions: number;
  };
  llm: {
    defaultProvider: "anthropic" | "openai" | "openrouter" | "ollama" | "ollama-turbo" | "google";
    anthropic?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    openai?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    openrouter?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    google?: {
      apiKey: string;
      model: string;
      maxTokens: number;
    };
    ollama?: {
      baseUrl: string;
      model: string;
    };
    lmstudio?: {
      baseUrl: string;
      model: string;
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
     * Auto-approve in-workspace writes/edits and bash without prompting. Out-of-workspace
     * writes and network tools still prompt. Default false. Intended for trusted, sandboxed
     * test workspaces — set per-project in `<workspace>/.alan/config.toml`.
     */
    trustWorkspace?: boolean;
  };
  sandbox: {
    enabled: boolean;
    networkDeny: boolean;
    fsAllowlist: string[];
  };
  telemetry: {
    enabled: boolean;
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
    /** Directory for saved reports. Default `<workspace>/.alan/research`. */
    outputDir?: string;
  };
  ui?: {
    /**
     * Default color theme name (see orchestrator ui/themes.ts). Used at startup unless
     * overridden by the ALAN_THEME env var or a runtime `/theme` choice (~/.alan/theme.json).
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
   * System Memory ("dreaming") — Alan's evergreen, narrative profile of the user and the
   * codebases they work in, injected into the system prompt so even small models get cheap,
   * personalised context. Stored at ~/.alan/system-memory.md (see shared/system-memory.ts).
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
   * Black box (flight recorder) — local incident capture to ~/.alan/blackbox.db:
   * every failure, degradation, and struggle, with trail forensics. Local-only;
   * nothing is ever transmitted. Default on.
   */
  diagnostics?: {
    enabled?: boolean;
  };
  /**
   * Tactics notebook (evolution loop) — learned facts/tactics from past
   * sessions, injected under a hard token budget. Capture is rule-based
   * (zero extra model spend). Default on; `alan --pristine` disables per run.
   */
  notebook?: {
    enabled?: boolean;
    /** Injection budget in tokens. Default 600. */
    maxInjectTokens?: number;
  };
  /**
   * Git integration. autoCommit: after every successful run that wrote files,
   * commit exactly those files as one revertible "berne:" commit; revert with
   * /undo. Default false.
   */
  git?: {
    autoCommit?: boolean;
  };
  /**
   * Context assembly. repoMap: include a compact, cache-stable file-tree map
   * of the repository in the system prompt so the model knows what exists
   * without exploratory turns. Default true (auto-skipped for huge repos).
   */
  context?: {
    repoMap?: boolean;
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
}

export interface PermissionRule {
  tool: string;
  level: "auto" | "confirm" | "sandbox";
  pattern?: string;
  scope: "session" | "project" | "global";
}

// ─── Defaults ───

const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
const alanHome = join(home, ".alan");

const DEFAULT_CONFIG: AlanConfig = {
  engine: {
    socketPath: join(alanHome, "alan.sock"),
    logDir: join(alanHome, "logs"),
    dbPath: join(alanHome, "alan.db"),
    maxSessions: 50,
  },
  llm: {
    // Dev/test default = free tier (Gemini). Override via ~/.alan/config.toml,
    // <workspace>/.alan/config.toml, or ALAN_PROVIDER for production validation.
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
    ALAN_PROVIDER: (c) => setNested(c, "llm.defaultProvider", process.env.ALAN_PROVIDER!),
    ALAN_MODEL: (c) => {
      const provider = getDefaultProvider(c);
      setNested(c, `llm.${provider}.model`, process.env.ALAN_MODEL!);
    },
    ALAN_MAX_TOKENS: (c) =>
      setNested(c, `llm.${getDefaultProvider(c)}.maxTokens`, Number(process.env.ALAN_MAX_TOKENS!)),
    ALAN_DB_PATH: (c) => setNested(c, "engine.dbPath", process.env.ALAN_DB_PATH!),
    ALAN_SOCKET_PATH: (c) => setNested(c, "engine.socketPath", process.env.ALAN_SOCKET_PATH!),
    ALAN_LOG_DIR: (c) => setNested(c, "engine.logDir", process.env.ALAN_LOG_DIR!),
    ALAN_SANDBOX_ENABLED: (c) =>
      setNested(c, "sandbox.enabled", process.env.ALAN_SANDBOX_ENABLED === "true"),
    ALAN_SANDBOX_NETWORK: (c) =>
      setNested(c, "sandbox.networkDeny", process.env.ALAN_SANDBOX_NETWORK !== "allow"),
    ALAN_TRUST_WORKSPACE: (c) =>
      setNested(c, "permissions.trustWorkspace", process.env.ALAN_TRUST_WORKSPACE === "true"),
    ALAN_TELEMETRY: (c) => setNested(c, "telemetry.enabled", process.env.ALAN_TELEMETRY === "true"),
    ALAN_SEARCH_BACKEND: (c) => setNested(c, "search.provider", process.env.ALAN_SEARCH_BACKEND!),
    ALAN_NATIVE_GROUNDING: (c) =>
      setNested(c, "search.nativeGrounding", process.env.ALAN_NATIVE_GROUNDING !== "false"),
    ALAN_RESEARCH_DEPTH: (c) => setNested(c, "research.depth", process.env.ALAN_RESEARCH_DEPTH!),
    ALAN_RESEARCH_MAX_ROUNDS: (c) =>
      setNested(c, "research.maxRounds", Number(process.env.ALAN_RESEARCH_MAX_ROUNDS!)),
    ALAN_RESEARCH_MAX_PARALLEL: (c) =>
      setNested(c, "research.maxParallel", Number(process.env.ALAN_RESEARCH_MAX_PARALLEL!)),
    ALAN_RESEARCH_MAX_SUBQUESTIONS: (c) =>
      setNested(c, "research.maxSubQuestions", Number(process.env.ALAN_RESEARCH_MAX_SUBQUESTIONS!)),
    ALAN_RESEARCH_AUTO_APPROVE: (c) =>
      setNested(c, "research.autoApprove", process.env.ALAN_RESEARCH_AUTO_APPROVE === "true"),
    ALAN_RESEARCH_SAVE: (c) =>
      setNested(c, "research.save", process.env.ALAN_RESEARCH_SAVE !== "false"),
    ALAN_MEMORY_ENABLED: (c) =>
      setNested(c, "memory.enabled", process.env.ALAN_MEMORY_ENABLED !== "false"),
    ALAN_MEMORY_SCHEDULE: (c) => setNested(c, "memory.schedule", process.env.ALAN_MEMORY_SCHEDULE!),
    ALAN_MEMORY_MODEL: (c) => setNested(c, "memory.model", process.env.ALAN_MEMORY_MODEL!),
    ALAN_MEMORY_MAX_TOKENS: (c) =>
      setNested(c, "memory.maxTokens", Number(process.env.ALAN_MEMORY_MAX_TOKENS!)),
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
 * Load Alan configuration with this precedence (later wins):
 * 1. Built-in defaults
 * 2. ~/.alan/config.toml (global)
 * 3. <workspace>/.alan/config.toml (project)
 * 4. ALAN_* environment variables
 */
export function loadConfig(workspaceRoot?: string): AlanConfig {
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Global config
  const globalConfig = join(alanHome, "config.toml");
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
    const projectConfig = join(workspaceRoot, ".alan", "config.toml");
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

  return merged as unknown as AlanConfig;
}

/**
 * Resolve the Alan home directory (~/.alan).
 */
export function getAlanHome(): string {
  return alanHome;
}
