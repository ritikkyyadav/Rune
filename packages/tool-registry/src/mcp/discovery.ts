import { McpClient } from "./client";
import type { ToolHandler } from "../types";

// ─── MCP Config Format ───
// Loaded from .alan/mcp.json in the workspace root. Supports local subprocess
// (stdio) servers and remote (Streamable HTTP) servers.
//
//   {
//     "mcpServers": {
//       "files":  { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."] },
//       "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
//                   "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
//                   "autoApprove": ["search_issues"] }
//     }
//   }

interface McpServerConfig {
  /** "stdio" (default when `command` is set) or "http" (default when `url` is set). */
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Auto-approve tool calls: true (all) or a list of tool names. */
  autoApprove?: boolean | string[];
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/** Replace `${VAR}` tokens with process.env values so tokens aren't committed. */
function interpolateEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Za-z0-9_]+)\}/g,
      (_, name) => process.env[name] ?? "",
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out as unknown as T;
  }
  return value;
}

/** Build the autoApprove predicate from the config field. */
function makeAutoApprove(auto?: boolean | string[]): ((toolName: string) => boolean) | undefined {
  if (auto === true) return () => true;
  if (Array.isArray(auto)) {
    const set = new Set(auto);
    return (name) => set.has(name);
  }
  return undefined;
}

export class McpDiscovery {
  private clients: Map<string, McpClient> = new Map();
  private configPath: string;

  constructor(workspaceRoot: string) {
    this.configPath = `${workspaceRoot}/.alan/mcp.json`;
  }

  /**
   * Load the MCP config, start all configured servers, and return tool handlers
   * for every discovered tool. A server that fails to start is logged and
   * skipped — it never breaks the others or the session.
   */
  async discover(): Promise<ToolHandler[]> {
    const config = await this.loadConfig();
    if (!config?.mcpServers) return [];

    const handlers: ToolHandler[] = [];
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const serverConfig = interpolateEnv(raw);
      try {
        const client = new McpClient({
          name,
          type: serverConfig.type,
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          url: serverConfig.url,
          headers: serverConfig.headers,
        });

        await client.start();
        this.clients.set(name, client);
        client.startHealthChecks();

        handlers.push(...client.toToolHandlers(makeAutoApprove(serverConfig.autoApprove)));
      } catch (err) {
        console.error(
          `[MCP] Failed to start server "${name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return handlers;
  }

  /** Reload config and restart all servers. */
  async reload(): Promise<ToolHandler[]> {
    await this.stopAll();
    return this.discover();
  }

  /** Stop all MCP servers. */
  async stopAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.stop();
    }
    this.clients.clear();
  }

  /** Per-server status for the `/mcp` command and `/status`. */
  getStatus(): Array<{
    name: string;
    ready: boolean;
    kind: "stdio" | "http";
    toolCount: number;
    tools: string[];
    health: "healthy" | "degraded" | "down";
  }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      ready: client.isReady,
      kind: client.kind,
      toolCount: client.getTools().length,
      tools: client.getTools().map((t) => t.name),
      health: client.getServerHealth().status,
    }));
  }

  private async loadConfig(): Promise<McpConfigFile | null> {
    try {
      const file = Bun.file(this.configPath);
      if (!(await file.exists())) return null;
      const text = await file.text();
      return JSON.parse(text) as McpConfigFile;
    } catch {
      return null;
    }
  }
}
