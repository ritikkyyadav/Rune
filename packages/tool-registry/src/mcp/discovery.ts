import { McpClient } from "./client";
import type { ToolHandler } from "../types";

// ─── MCP Config Format ───
// Loaded from .alan/mcp.json in the workspace root.

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Auto-approve all tool calls from this server. */
  autoApprove?: boolean;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

// ─── MCP Discovery ───

export class McpDiscovery {
  private clients: Map<string, McpClient> = new Map();
  private configPath: string;

  constructor(workspaceRoot: string) {
    this.configPath = `${workspaceRoot}/.alan/mcp.json`;
  }

  /**
   * Load the MCP config file and start all configured servers.
   * Returns tool handlers for all discovered tools.
   */
  async discover(): Promise<ToolHandler[]> {
    const config = await this.loadConfig();
    if (!config?.mcpServers) return [];

    const handlers: ToolHandler[] = [];

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        const client = new McpClient({
          name,
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        await client.start();
        this.clients.set(name, client);

        const tools = client.toToolHandlers();
        handlers.push(...tools);
      } catch (err) {
        console.error(
          `[MCP] Failed to start server "${name}": ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return handlers;
  }

  /**
   * Reload config and restart any changed servers.
   */
  async reload(): Promise<ToolHandler[]> {
    await this.stopAll();
    return this.discover();
  }

  /**
   * Stop all MCP server subprocesses.
   */
  async stopAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.stop();
    }
    this.clients.clear();
  }

  /**
   * Health check all running servers.
   */
  getStatus(): Array<{ name: string; ready: boolean; toolCount: number }> {
    return [...this.clients.entries()].map(([name, client]) => ({
      name,
      ready: client.isReady,
      toolCount: client.getTools().length,
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
