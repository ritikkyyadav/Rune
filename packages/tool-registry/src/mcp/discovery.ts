import { type Logger, createLogger, openCredentialStore, type CredentialStore } from "@gear/shared";
import { McpClient } from "./client";
import { McpOAuth } from "./oauth";
import type { ToolHandler } from "../types";
import type { McpEvent, McpServerInfo } from "./types";
import { workspaceConfigPath } from "@gear/shared";

// ─── MCP Config Format ───
// Loaded from .gear/mcp.json in the workspace root. Supports local subprocess
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

export interface McpServerConfig {
  /** "stdio" (default when `command` is set) or "http" (default when `url` is set). */
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Auto-approve tool calls: true (all) or a list of tool names. */
  autoApprove?: boolean | string[];
  /**
   * OAuth 2.1 for a remote connector (P4.2). Present-but-empty is the normal
   * case: everything is discovered from the server's own metadata. A
   * pre-registered `clientId` is only needed when the authorization server
   * offers no dynamic client registration.
   */
  oauth?: {
    clientId?: string;
    /** Fixed loopback port, for servers that registered exactly one redirect. */
    callbackPort?: number;
    scopes?: string[];
    /** Set false to send static headers only and never attempt OAuth. */
    enabled?: boolean;
  };
  /** Set false to keep the entry on file without starting it (`gear mcp disable`). */
  enabled?: boolean;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpDiscoveryOptions {
  logger?: Logger;
  /** Typed lifecycle/observability sink, forwarded to every client. */
  onEvent?: (ev: McpEvent) => void;
  /** Fired after any server's tool set changes (live update / restart). The owner
   *  should reconcile its registry against `getHandlers()`. */
  onToolsChanged?: () => void;
  /** Built-in servers merged BENEATH mcp.json — a user entry with the same
   *  name overrides its built-in counterpart (e.g. the `browser` server). */
  extraServers?: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  name: string;
  ready: boolean;
  kind: "stdio" | "http";
  toolCount: number;
  tools: string[];
  health: "healthy" | "degraded" | "down";
  protocolVersion?: string;
  serverInfo?: McpServerInfo;
  lastError?: string | null;
  /** The connector answered 401 and holds no usable token — needs `gear mcp login`. */
  needsAuth?: boolean;
  /** Whether a token set exists in the credential store for this connector. */
  hasCredentials?: boolean;
}

/** Replace `${VAR}` tokens with process.env values, tracking any that are unset
 *  so we can warn (an empty Authorization header is worse than a loud failure). */
function interpolateEnv<T>(value: T, missing: Set<string>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      if (process.env[name] === undefined) missing.add(name);
      return process.env[name] ?? "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, missing)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, missing);
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

/** Validate one server entry. Returns an error string, or null if valid. */
function validateServer(c: McpServerConfig): string | null {
  const hasCmd = typeof c.command === "string" && c.command.length > 0;
  const hasUrl = typeof c.url === "string" && c.url.length > 0;
  if (!hasCmd && !hasUrl) return 'must specify either "command" (stdio) or "url" (http)';
  if (hasCmd && hasUrl) return 'specify only one of "command" or "url"';
  if (c.type && c.type !== "stdio" && c.type !== "http") return `invalid type "${c.type}"`;
  return null;
}

/** Sanitize a tool name to the provider-safe charset and length. */
function sanitizeName(name: string): string {
  const s = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 64 ? s.slice(0, 64) : s;
}

export class McpDiscovery {
  private clients: Map<string, { client: McpClient; autoApprove?: (n: string) => boolean }> =
    new Map();
  private configPath: string;
  private options: McpDiscoveryOptions;
  private logger: Logger;

  // Final (sanitized, namespaced) handler set, with owner tracking for diffs.
  private handlers: Map<string, ToolHandler> = new Map();
  private handlerOwner: Map<string, string> = new Map();
  // Per-server errors (config-invalid or failed-to-start servers have no client).
  private serverErrors: Map<string, { error: string; kind: "stdio" | "http" }> = new Map();
  // OAuth state per remote connector, kept so login, refresh and doctor all
  // read the same tokens. Opened lazily -- a workspace with only stdio servers
  // never touches the keychain.
  private oauthProviders: Map<string, McpOAuth> = new Map();
  private credentialStore: CredentialStore | null = null;
  private credentialStorePromise: Promise<CredentialStore> | null = null;

  constructor(workspaceRoot: string, options: McpDiscoveryOptions = {}) {
    this.configPath = workspaceConfigPath(workspaceRoot, "mcp.json");
    this.options = options;
    this.logger = options.logger ?? createLogger("mcp");
  }

  /** The credential store, opened at most once per discovery. */
  private async store(): Promise<CredentialStore> {
    if (this.credentialStore) return this.credentialStore;
    if (!this.credentialStorePromise) this.credentialStorePromise = openCredentialStore();
    this.credentialStore = await this.credentialStorePromise;
    return this.credentialStore;
  }

  /**
   * The OAuth provider for one remote connector, or undefined when the entry
   * cannot use OAuth: stdio servers, and any entry that already carries its own
   * Authorization header (a hand-written ${TOKEN} is the user's explicit
   * choice and outranks a discovered flow).
   */
  private async oauthFor(name: string, config: McpServerConfig): Promise<McpOAuth | undefined> {
    if (!config.url) return undefined;
    if (config.oauth?.enabled === false) return undefined;
    const headerNames = Object.keys(config.headers ?? {}).map((h) => h.toLowerCase());
    if (headerNames.includes("authorization")) return undefined;
    const existing = this.oauthProviders.get(name);
    if (existing) return existing;
    const provider = new McpOAuth({
      serverName: name,
      serverUrl: config.url,
      store: await this.store(),
      logger: this.logger,
      clientId: config.oauth?.clientId,
      callbackPort: config.oauth?.callbackPort,
      scopes: config.oauth?.scopes,
    });
    this.oauthProviders.set(name, provider);
    return provider;
  }

  /** The OAuth provider for a connector, if one was built during discovery. */
  getOAuth(name: string): McpOAuth | undefined {
    return this.oauthProviders.get(name);
  }

  /** Re-handshake one connector after an interactive sign-in. */
  async reconnect(name: string): Promise<boolean> {
    const entry = this.clients.get(name);
    if (!entry) return false;
    const ok = await entry.client.reconnect();
    if (ok) this.reindexServer(name, entry.client, entry.autoApprove);
    return ok;
  }

  /**
   * Load the MCP config, start all configured servers, and return tool handlers
   * for every discovered tool. A server that fails to start (or is misconfigured)
   * is recorded with a `lastError` and skipped — it never breaks the others or
   * the session.
   */
  async discover(): Promise<ToolHandler[]> {
    const { config, error } = await this.loadConfig();
    if (error) this.logger.error(`mcp.json: ${error}`);
    // Built-ins first, then mcp.json — so a user entry with the same name
    // (e.g. their own "browser" server) replaces the built-in spec.
    const servers: Record<string, McpServerConfig> = {
      ...(this.options.extraServers ?? {}),
      ...(config?.mcpServers ?? {}),
    };
    if (Object.keys(servers).length === 0) return [];

    for (const [name, raw] of Object.entries(servers)) {
      const missing = new Set<string>();
      const serverConfig = interpolateEnv(raw, missing);
      if (missing.size > 0) {
        this.logger.warn(`server "${name}": unset env var(s) ${[...missing].join(", ")}`);
      }

      const kind: "stdio" | "http" =
        serverConfig.type === "http" || serverConfig.url ? "http" : "stdio";

      // A disabled entry stays on file and out of the session: the point of
      // `gear mcp disable` is to stop paying for a connector without losing
      // the configuration that took a sign-in to produce.
      if (serverConfig.enabled === false) continue;

      const invalid = validateServer(serverConfig);
      if (invalid) {
        this.serverErrors.set(name, { error: invalid, kind });
        this.logger.error(`server "${name}" misconfigured: ${invalid}`);
        continue;
      }

      try {
        const autoApprove = makeAutoApprove(serverConfig.autoApprove);
        const client = new McpClient({
          name,
          type: serverConfig.type,
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          url: serverConfig.url,
          headers: serverConfig.headers,
          auth: await this.oauthFor(name, serverConfig),
          logger: this.logger,
          onEvent: this.options.onEvent,
          onToolsChanged: () => this.handleServerToolsChanged(name),
        });

        await client.start();
        this.clients.set(name, { client, autoApprove });
        this.serverErrors.delete(name);
        client.startHealthChecks();
        this.reindexServer(name, client, autoApprove);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.serverErrors.set(name, { error: msg, kind });
        this.logger.error(`failed to start server "${name}": ${msg}`);
        this.options.onEvent?.({ type: "server-down", server: name, reason: msg });
      }
    }
    return this.getHandlers();
  }

  /** Rebuild one server's handlers, sanitizing names and disambiguating collisions
   *  across all servers. Replaces any previously-registered handlers for it. */
  private reindexServer(
    serverName: string,
    client: McpClient,
    autoApprove?: (n: string) => boolean,
  ): void {
    // Drop this server's previous entries first so a shrunk tool list is reflected.
    for (const [n, owner] of [...this.handlerOwner]) {
      if (owner === serverName) {
        this.handlers.delete(n);
        this.handlerOwner.delete(n);
      }
    }
    for (const h of client.toToolHandlers(autoApprove)) {
      const base = sanitizeName(h.schema.name);
      let name = base;
      if (this.handlers.has(name)) {
        let i = 2;
        while (this.handlers.has(`${base}_${i}`)) i++;
        name = `${base}_${i}`;
        this.logger.warn(`tool name collision for "${base}" — registered as "${name}"`);
      }
      if (name !== h.schema.name) h.schema.name = name;
      this.handlers.set(name, h);
      this.handlerOwner.set(name, serverName);
    }
  }

  private handleServerToolsChanged(serverName: string): void {
    const entry = this.clients.get(serverName);
    if (!entry) return;
    this.reindexServer(serverName, entry.client, entry.autoApprove);
    this.options.onToolsChanged?.();
  }

  /** Current full handler set across all live servers. */
  getHandlers(): ToolHandler[] {
    return [...this.handlers.values()];
  }

  /** Reload config and restart all servers. */
  async reload(): Promise<ToolHandler[]> {
    await this.stopAll();
    return this.discover();
  }

  /** Stop all MCP servers. */
  async stopAll(): Promise<void> {
    for (const [, { client }] of this.clients) {
      await client.stop();
    }
    this.clients.clear();
    this.handlers.clear();
    this.handlerOwner.clear();
    this.serverErrors.clear();
    this.oauthProviders.clear();
  }

  /** Per-server status for the `/mcp` command and `/status`. */
  getStatus(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const [name, { client }] of this.clients) {
      const info = client.getServerInfo();
      out.push({
        name,
        ready: client.isReady,
        kind: client.kind,
        toolCount: client.getTools().length,
        tools: client.getTools().map((t) => t.name),
        health: client.getServerHealth().status,
        protocolVersion: info.protocolVersion,
        serverInfo: info.serverInfo,
        lastError: info.lastError,
        needsAuth: info.needsAuth,
      });
    }
    // Servers that never started (bad config / spawn failure) — surface them too.
    for (const [name, { error, kind }] of this.serverErrors) {
      if (this.clients.has(name)) continue;
      out.push({
        name,
        ready: false,
        kind,
        toolCount: 0,
        tools: [],
        health: "down",
        lastError: error,
      });
    }
    return out;
  }

  private async loadConfig(): Promise<{ config: McpConfigFile | null; error?: string }> {
    try {
      const file = Bun.file(this.configPath);
      if (!(await file.exists())) return { config: null };
      const text = await file.text();
      try {
        return { config: JSON.parse(text) as McpConfigFile };
      } catch (e) {
        return {
          config: null,
          error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    } catch (e) {
      return { config: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
