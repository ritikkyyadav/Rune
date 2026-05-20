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
    defaultProvider: "anthropic" | "openai" | "openrouter" | "ollama";
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
    ollama?: {
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
  };
  sandbox: {
    enabled: boolean;
    networkDeny: boolean;
    fsAllowlist: string[];
  };
  telemetry: {
    enabled: boolean;
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
    defaultProvider: "anthropic",
  },
  permissions: {
    defaultLevel: "confirm",
    rules: [],
  },
  sandbox: {
    enabled: true,
    networkDeny: true,
    fsAllowlist: [],
  },
  telemetry: {
    enabled: false,
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

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
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
    ALAN_MODEL: (c) => setNested(c, "llm.anthropic.model", process.env.ALAN_MODEL!),
    ALAN_MAX_TOKENS: (c) => setNested(c, "llm.anthropic.maxTokens", Number(process.env.ALAN_MAX_TOKENS!)),
    ALAN_DB_PATH: (c) => setNested(c, "engine.dbPath", process.env.ALAN_DB_PATH!),
    ALAN_SOCKET_PATH: (c) => setNested(c, "engine.socketPath", process.env.ALAN_SOCKET_PATH!),
    ALAN_LOG_DIR: (c) => setNested(c, "engine.logDir", process.env.ALAN_LOG_DIR!),
    ALAN_SANDBOX_ENABLED: (c) => setNested(c, "sandbox.enabled", process.env.ALAN_SANDBOX_ENABLED === "true"),
    ALAN_SANDBOX_NETWORK: (c) => setNested(c, "sandbox.networkDeny", process.env.ALAN_SANDBOX_NETWORK !== "allow"),
    ALAN_TELEMETRY: (c) => setNested(c, "telemetry.enabled", process.env.ALAN_TELEMETRY === "true"),
    ANTHROPIC_API_KEY: (c) => setNested(c, "llm.anthropic.apiKey", process.env.ANTHROPIC_API_KEY!),
    OPENAI_API_KEY: (c) => setNested(c, "llm.openai.apiKey", process.env.OPENAI_API_KEY!),
    OPENROUTER_API_KEY: (c) => setNested(c, "llm.openrouter.apiKey", process.env.OPENROUTER_API_KEY!),
  };

  for (const [envVar, apply] of Object.entries(envMap)) {
    if (process.env[envVar]) {
      apply(config);
    }
  }
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
