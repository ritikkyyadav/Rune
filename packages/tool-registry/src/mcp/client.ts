import { type Logger, createLogger } from "@alan/shared";
import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { HttpTransport, McpSessionExpiredError, StdioTransport } from "./transport";
import {
  HEALTH_CHECK_MAX_FAILURES,
  INIT_TIMEOUT_MS,
  JSONRPC_METHOD_NOT_FOUND,
  LATEST_PROTOCOL_VERSION,
  MAX_CONCURRENT_CALLS,
  MAX_PARAM_SIZE,
  MAX_RESPONSE_SIZE,
  MCP_METHODS,
  PING_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./types";
import type {
  McpCallToolResult,
  McpContentBlock,
  McpEvent,
  McpIncomingMessage,
  McpInitializeResult,
  McpProgress,
  McpServerCapabilities,
  McpServerInfo,
  McpToolSchema,
  McpTransport,
} from "./types";

/** A JSON-RPC error returned by the server (the server is alive — it answered). */
export class McpRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

export interface McpClientConfig {
  name: string;
  /** stdio transport: process to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http transport: server URL + optional headers (e.g. Authorization). */
  type?: "stdio" | "http";
  url?: string;
  headers?: Record<string, string>;
  /** Diagnostics. Defaults to a namespaced shared logger. */
  logger?: Logger;
  /** Typed lifecycle/observability sink (server up/down, progress, logs). */
  onEvent?: (ev: McpEvent) => void;
  /** Invoked after the server's tool list changes (live update / restart) so the
   *  owner can re-register handlers. */
  onToolsChanged?: () => void;
  /** Per-server cap on concurrent in-flight tools/call requests. */
  maxConcurrentCalls?: number;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One connection to an MCP server. Transport-agnostic: stdio (local subprocess)
 * or Streamable HTTP (remote). Owns JSON-RPC request/response correlation,
 * handshake (with protocol-version + capability negotiation), tool discovery
 * (paginated, live-updating), execution (cancellable, progress-aware), and
 * health (ping-based, restart-safe).
 */
export class McpClient {
  private serverName: string;
  private transport: McpTransport;
  private transportKind: "stdio" | "http";
  private logger: Logger;
  private onEvent?: (ev: McpEvent) => void;
  private onToolsChangedCb?: () => void;

  private requestId = 0;
  private pendingRequests = new Map<number, Pending>();
  private tools: McpToolSchema[] = [];
  private ready = false;
  private lastError: string | null = null;

  private protocolVersion: string = LATEST_PROTOCOL_VERSION;
  private serverCapabilities: McpServerCapabilities = {};
  private serverInfo: McpServerInfo = {};

  // Health
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private inFlightHealthCheck = false;

  // Lifecycle
  private closing = false;
  private restarting = false;
  private startupExitReject: ((e: Error) => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // Concurrency (per-server tools/call cap) + in-flight bookkeeping
  private slots: number;
  private waiters: Array<() => void> = [];
  private inFlightCalls = 0;

  // Progress routing: progressToken → callback
  private progressHandlers = new Map<string, (p: Omit<McpProgress, "progressToken">) => void>();
  private progressSeq = 0;

  constructor(config: McpClientConfig) {
    this.serverName = config.name;
    this.logger = (config.logger ?? createLogger("mcp")).child(config.name);
    this.onEvent = config.onEvent;
    this.onToolsChangedCb = config.onToolsChanged;
    this.slots = config.maxConcurrentCalls ?? MAX_CONCURRENT_CALLS;

    if (config.url || config.type === "http") {
      this.transportKind = "http";
      this.transport = new HttpTransport({
        url: config.url!,
        headers: config.headers,
        logger: this.logger,
      });
    } else {
      this.transportKind = "stdio";
      this.transport = new StdioTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        logger: this.logger,
      });
    }
    this.transport.setMessageHandler((msg) => this.handleMessage(msg));
    this.transport.setLifecycleHandler?.((ev) => this.handleLifecycle(ev));
  }

  get name(): string {
    return this.serverName;
  }
  get isReady(): boolean {
    return this.ready;
  }
  get kind(): "stdio" | "http" {
    return this.transportKind;
  }

  getTools(): McpToolSchema[] {
    return [...this.tools];
  }

  // ─── Lifecycle ───

  /** Start the transport and perform the MCP handshake + tool discovery. */
  async start(): Promise<void> {
    this.closing = false;
    await this.transport.start();
    // Fail the handshake fast if the process dies during startup (e.g. a stdio
    // server that exits immediately) instead of waiting out the init timeout.
    const exitDuringInit = new Promise<never>((_, reject) => {
      this.startupExitReject = reject;
    });
    try {
      await Promise.race([this.handshake(), exitDuringInit]);
    } finally {
      this.startupExitReject = null;
    }
  }

  private async handshake(): Promise<void> {
    const initResult = (await this.send(
      MCP_METHODS.initialize,
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gear", version: "0.1.0" },
      },
      { timeoutMs: INIT_TIMEOUT_MS, allowReinit: false },
    )) as McpInitializeResult;

    // Negotiate protocol version: accept the server's choice if we support it.
    const serverVersion = initResult?.protocolVersion;
    if (serverVersion && !SUPPORTED_PROTOCOL_VERSIONS.includes(serverVersion as never)) {
      throw new Error(
        `unsupported MCP protocol version "${serverVersion}" (we support ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
    this.protocolVersion = serverVersion ?? LATEST_PROTOCOL_VERSION;
    this.transport.setProtocolVersion?.(this.protocolVersion);
    this.serverCapabilities = initResult?.capabilities ?? {};
    this.serverInfo = initResult?.serverInfo ?? {};

    await this.notify(MCP_METHODS.initialized, {});

    // Enumerate tools unless the server explicitly declares capabilities WITHOUT
    // a `tools` entry. Many real servers under-declare (empty capabilities), so
    // we stay lenient: attempt discovery and tolerate a failure rather than
    // silently exposing nothing.
    const caps = this.serverCapabilities;
    const declaredOtherCaps = Object.keys(caps).length > 0 && caps.tools === undefined;
    this.tools = declaredOtherCaps ? [] : await this.fetchToolsSafe();
    this.ready = true;
    this.lastError = null;
    this.onEvent?.({
      type: "server-ready",
      server: this.serverName,
      protocolVersion: this.protocolVersion,
      toolCount: this.tools.length,
    });
    this.logger.info(
      `ready — protocol ${this.protocolVersion}, ${this.tools.length} tools`,
      this.serverInfo.name
        ? { server: this.serverInfo.name, version: this.serverInfo.version }
        : undefined,
    );
  }

  /** Stop health checks and close the transport (full teardown). */
  async stop(): Promise<void> {
    this.closing = true;
    this.stopHealthChecks();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.transport.close();
    this.ready = false;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client stopped"));
    }
    this.pendingRequests.clear();
  }

  private handleLifecycle(
    ev: { type: "exit"; code: number | null } | { type: "session-expired" },
  ): void {
    if (ev.type === "exit") {
      this.ready = false;
      const tail = this.stderrTail();
      this.lastError = `process exited (code ${ev.code})${tail ? `; stderr: ${tail}` : ""}`;
      // Fail an in-progress startup immediately.
      if (this.startupExitReject) {
        this.startupExitReject(new Error(this.lastError));
        return;
      }
      this.onEvent?.({ type: "server-down", server: this.serverName, reason: this.lastError });
      this.logger.warn(`server exited unexpectedly`, { code: ev.code });
      // Attempt recovery unless we're shutting down or mid-call.
      if (!this.closing) void this.tryRestart("process exit");
    }
    // session-expired is handled inline in shipMessage (re-initialize + retry).
  }

  private stderrTail(): string {
    const t = this.transport as { getStderrTail?: () => string };
    return typeof t.getStderrTail === "function" ? t.getStderrTail() : "";
  }

  // ─── JSON-RPC over the transport ───

  private handleMessage(msg: McpIncomingMessage): void {
    if (!msg || typeof msg !== "object") return;
    const m = msg as {
      id?: number | string;
      method?: string;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    const hasId = m.id !== undefined && m.id !== null;
    const hasMethod = typeof m.method === "string";

    if (hasId && !hasMethod) {
      // Response to one of our requests.
      const pending = this.pendingRequests.get(m.id as number);
      if (!pending) return;
      this.pendingRequests.delete(m.id as number);
      clearTimeout(pending.timer);
      if (m.error) {
        pending.reject(new McpRpcError(m.error.code, m.error.message, m.error.data));
      } else {
        pending.resolve(m.result);
      }
      return;
    }

    if (hasId && hasMethod) {
      // Server→client request. We don't implement sampling/roots/elicitation;
      // reply with "method not found" so the server doesn't hang awaiting us.
      void this.transport
        .send({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${m.method}` },
        })
        .catch(() => {});
      return;
    }

    if (hasMethod)
      this.handleNotification(
        m.method as string,
        (m as { params?: Record<string, unknown> }).params ?? {},
      );
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case MCP_METHODS.toolsListChanged:
        this.scheduleToolsRefresh();
        break;
      case MCP_METHODS.progress: {
        const token = String(params.progressToken ?? "");
        const progress = Number(params.progress ?? 0);
        const total = params.total != null ? Number(params.total) : undefined;
        const message = typeof params.message === "string" ? params.message : undefined;
        this.progressHandlers.get(token)?.({ progress, total, message });
        this.onEvent?.({ type: "progress", server: this.serverName, progress, total, message });
        break;
      }
      case MCP_METHODS.loggingMessage: {
        const level = String(params.level ?? "info");
        const data = params.data;
        const text = typeof data === "string" ? data : JSON.stringify(data ?? params);
        this.logger.debug(`server log [${level}] ${text}`);
        this.onEvent?.({ type: "log", server: this.serverName, level, message: text });
        break;
      }
      // resources/prompts list_changed are out of scope — ignored.
      default:
        break;
    }
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number; allowReinit?: boolean },
  ): Promise<unknown> {
    const id = ++this.requestId;
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      let timer!: ReturnType<typeof setTimeout>;
      const signal = opts?.signal;

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settleResolve = (v: unknown) => {
        cleanup();
        resolve(v);
      };
      const settleReject = (e: Error) => {
        cleanup();
        reject(e);
      };
      const onAbort = () => {
        if (this.pendingRequests.delete(id)) {
          this.sendCancelled(id, "client aborted");
          settleReject(new Error(`MCP request aborted: ${method}`));
        }
      };

      if (signal?.aborted) {
        // Already aborted before we shipped anything.
        reject(new Error(`MCP request aborted: ${method}`));
        return;
      }

      timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          // Per spec, tell the server to stop working on it.
          this.sendCancelled(id, "timeout");
          settleReject(new Error(`MCP request timed out: ${method}`));
        }
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
      this.pendingRequests.set(id, { resolve: settleResolve, reject: settleReject, timer });

      this.shipMessage({ jsonrpc: "2.0", id, method, params }, opts?.allowReinit ?? true).catch(
        (err: unknown) => {
          if (this.pendingRequests.delete(id)) {
            settleReject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  }

  /** Ship a framed message; transparently re-initialize once on HTTP session expiry. */
  private async shipMessage(message: object, allowReinit: boolean): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (err) {
      if (allowReinit && err instanceof McpSessionExpiredError) {
        this.logger.warn("HTTP session expired — re-initializing");
        await this.reinitialize();
        await this.transport.send(message); // retry once with the fresh session
        return;
      }
      throw err;
    }
  }

  /** Re-run the handshake (no tool re-list) after an HTTP session reset. */
  private async reinitialize(): Promise<void> {
    const initResult = (await this.send(
      MCP_METHODS.initialize,
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "gear", version: "0.1.0" },
      },
      { timeoutMs: INIT_TIMEOUT_MS, allowReinit: false },
    )) as McpInitializeResult;
    const v = initResult?.protocolVersion;
    this.protocolVersion =
      v && SUPPORTED_PROTOCOL_VERSIONS.includes(v as never) ? v : this.protocolVersion;
    this.transport.setProtocolVersion?.(this.protocolVersion);
    await this.notify(MCP_METHODS.initialized, {});
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private sendCancelled(requestId: number, reason: string): void {
    void this.notify(MCP_METHODS.cancelled, { requestId, reason }).catch(() => {});
  }

  // ─── Tool discovery (paginated + live) ───

  /** fetchTools that never throws — a tools/list hiccup shouldn't abort the
   *  handshake (the server still connects, just with no tools). */
  private async fetchToolsSafe(): Promise<McpToolSchema[]> {
    try {
      return await this.fetchTools();
    } catch (err) {
      this.logger.warn(`tools/list failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private async fetchTools(): Promise<McpToolSchema[]> {
    const all: McpToolSchema[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = (await this.send(MCP_METHODS.toolsList, cursor ? { cursor } : {})) as {
        tools?: McpToolSchema[];
        nextCursor?: string;
      };
      if (Array.isArray(res?.tools)) all.push(...res.tools);
      const next = res?.nextCursor;
      // Guard against a server that loops the same cursor forever.
      cursor = next && next !== cursor ? next : undefined;
    } while (cursor && ++pages < 100);
    return all;
  }

  private scheduleToolsRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Debounce bursts of list_changed notifications.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshTools();
    }, 250);
  }

  private async refreshTools(): Promise<void> {
    try {
      const tools = await this.fetchTools();
      this.tools = tools;
      this.onEvent?.({ type: "tools-changed", server: this.serverName, toolCount: tools.length });
      this.onToolsChangedCb?.();
      this.logger.info(`tool list changed — ${tools.length} tools`);
    } catch (err) {
      this.logger.warn(`tool refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Tool execution ───

  private validateToolInput(
    schema: McpToolSchema | undefined,
    args: Record<string, unknown>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (schema?.inputSchema) {
      const s = schema.inputSchema as Record<string, unknown>;
      if (Array.isArray(s.required)) {
        for (const req of s.required as string[]) {
          if (!(req in args)) errors.push(`Missing required param: ${req}`);
        }
      }
    }
    for (const [key, val] of Object.entries(args)) {
      if (typeof val === "string" && val.length > MAX_PARAM_SIZE) {
        errors.push(`Param ${key} exceeds 1MB limit`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  private limitResponseSize(result: McpCallToolResult): McpCallToolResult {
    const totalSize = result.content.reduce(
      (sum, c) => sum + (c.text?.length ?? 0) + (c.data?.length ?? 0),
      0,
    );
    if (totalSize <= MAX_RESPONSE_SIZE) return result;

    let remaining = MAX_RESPONSE_SIZE;
    const truncatedContent = result.content.map((c) => {
      if (c.text == null || remaining <= 0) return c.text == null ? c : { ...c, text: "" };
      if (c.text.length <= remaining) {
        remaining -= c.text.length;
        return c;
      }
      const truncated = c.text.slice(0, remaining);
      remaining = 0;
      return { ...c, text: truncated };
    });
    truncatedContent.push({
      type: "text",
      text: `\n[WARNING: Response truncated from ${totalSize} to ${MAX_RESPONSE_SIZE} bytes]`,
    });
    return { ...result, content: truncatedContent };
  }

  /** Render mixed content blocks (text/image/audio/resource/structured) into the
   *  single text payload our tool layer consumes. Non-text blocks degrade to a
   *  compact placeholder rather than vanishing. */
  flattenContent(result: McpCallToolResult): string {
    const parts: string[] = [];
    for (const c of result.content ?? []) parts.push(this.renderBlock(c));
    if (result.structuredContent !== undefined) {
      try {
        parts.push("```json\n" + JSON.stringify(result.structuredContent, null, 2) + "\n```");
      } catch {
        // Non-serializable structured content — skip.
      }
    }
    return parts.filter((p) => p.length > 0).join("\n");
  }

  private renderBlock(c: McpContentBlock): string {
    switch (c.type) {
      case "text":
        return c.text ?? "";
      case "image":
        return `[image${c.mimeType ? ` ${c.mimeType}` : ""}${c.data ? `, ${c.data.length} base64 bytes` : ""}]`;
      case "audio":
        return `[audio${c.mimeType ? ` ${c.mimeType}` : ""}]`;
      case "resource_link":
        return `[resource ${c.uri ?? c.name ?? "(unnamed)"}]`;
      case "resource": {
        const r = c.resource ?? {};
        if (r.text) return `[resource ${r.uri ?? ""}]\n${r.text}`;
        return `[resource ${r.uri ?? ""}${r.mimeType ? ` (${r.mimeType})` : ""}]`;
      }
      default:
        return c.text ?? `[${c.type}]`;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; onProgress?: (p: Omit<McpProgress, "progressToken">) => void },
  ): Promise<McpCallToolResult> {
    const toolSchema = this.tools.find((t) => t.name === name);
    const validation = this.validateToolInput(toolSchema, args);
    if (!validation.valid) {
      return {
        content: [{ type: "text", text: `Validation failed: ${validation.errors.join("; ")}` }],
        isError: true,
      };
    }

    await this.acquireSlot();
    this.inFlightCalls++;

    // Wire progress: register a token so notifications/progress route to onProgress.
    const token = `${this.serverName}-${++this.progressSeq}`;
    const params: Record<string, unknown> = { name, arguments: args };
    if (opts?.onProgress) {
      this.progressHandlers.set(token, opts.onProgress);
      params._meta = { progressToken: token };
    }

    try {
      const result = (await this.send(MCP_METHODS.toolsCall, params, {
        signal: opts?.signal,
      })) as McpCallToolResult;
      return this.limitResponseSize(result);
    } finally {
      this.progressHandlers.delete(token);
      this.inFlightCalls--;
      this.releaseSlot();
    }
  }

  // ─── Concurrency gate ───

  private acquireSlot(): Promise<void> {
    if (this.slots > 0) {
      this.slots--;
      return Promise.resolve();
    }
    return new Promise<void>((res) => this.waiters.push(res));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot directly to the next waiter
    } else {
      this.slots++;
    }
  }

  /**
   * Create ToolHandler instances for every tool on this server.
   * @param autoApprove - predicate; tools it approves register at "auto" permission.
   */
  toToolHandlers(autoApprove?: (toolName: string) => boolean): ToolHandler[] {
    return this.tools.map((tool) => this.createHandler(tool, autoApprove?.(tool.name) ?? false));
  }

  private createHandler(mcpTool: McpToolSchema, autoApproved: boolean): ToolHandler {
    const client = this;
    const prefixedName = `mcp_${this.serverName}_${mcpTool.name}`;

    const schema: ToolSchema = {
      name: prefixedName,
      version: "0.1.0",
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name} (${this.serverName})`,
      inputSchema: (mcpTool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      permissionLevel: autoApproved ? "auto" : "confirm",
      category: "network",
    };

    return {
      schema,
      validate: () => ({ valid: true }),
      execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
        const start = performance.now();
        try {
          const result = await client.callTool(mcpTool.name, input.args, {
            signal: input.signal,
            onProgress: (p) =>
              client.onEvent?.({
                type: "progress",
                server: client.serverName,
                callId: input.callId,
                progress: p.progress,
                total: p.total,
                message: p.message,
              }),
          });
          const textContent = client.flattenContent(result);
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: !result.isError,
            result: textContent,
            error: result.isError ? textContent : undefined,
            durationMs: Math.round(performance.now() - start),
          };
        } catch (err) {
          return {
            callId: input.callId,
            toolName: input.toolName,
            success: false,
            result: "",
            error: err instanceof Error ? err.message : String(err),
            durationMs: Math.round(performance.now() - start),
          };
        }
      },
    };
  }

  // ─── Health ───

  startHealthChecks(intervalMs = PING_INTERVAL_MS): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(() => void this.healthTick(), intervalMs);
  }

  private async healthTick(): Promise<void> {
    // Re-entrancy guard: never let a slow probe stack on the previous one.
    if (this.inFlightHealthCheck || this.restarting || this.closing || !this.ready) return;
    this.inFlightHealthCheck = true;
    try {
      await this.send(MCP_METHODS.ping, {}, { timeoutMs: 10_000 });
      this.consecutiveFailures = 0;
    } catch (err) {
      // A JSON-RPC error means the server is alive (it answered) — even if it
      // doesn't implement ping. Only transport/timeout failures count as down.
      if (err instanceof McpRpcError) {
        this.consecutiveFailures = 0;
        return;
      }
      this.consecutiveFailures++;
      this.logger.warn(
        `health check failed (${this.consecutiveFailures}/${HEALTH_CHECK_MAX_FAILURES})`,
      );
      if (this.consecutiveFailures >= HEALTH_CHECK_MAX_FAILURES) {
        await this.tryRestart("health check failures");
      }
    } finally {
      this.inFlightHealthCheck = false;
    }
  }

  /** Restart the transport + re-handshake. Skipped while a tool call is running
   *  (don't yank a call out from under the model) or while already restarting. */
  private async tryRestart(reason: string): Promise<void> {
    if (this.restarting || this.closing) return;
    if (this.inFlightCalls > 0) return; // defer to a later tick
    this.restarting = true;
    this.logger.warn(`restarting server (${reason})`);
    try {
      await this.transport.close();
      await this.transport.start();
      await this.handshake();
      this.consecutiveFailures = 0;
      this.onEvent?.({ type: "server-restarted", server: this.serverName });
      // Tools may have changed across the restart — reconcile the registry.
      this.onToolsChangedCb?.();
    } catch (err) {
      this.ready = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ type: "server-down", server: this.serverName, reason: this.lastError });
      this.logger.error(`restart failed: ${this.lastError}`);
    } finally {
      this.restarting = false;
    }
  }

  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  getServerHealth(): {
    name: string;
    status: "healthy" | "degraded" | "down";
    failureCount: number;
  } {
    let status: "healthy" | "degraded" | "down" = "healthy";
    if (!this.ready) {
      status = "down";
    } else if (this.consecutiveFailures > 0) {
      status = this.consecutiveFailures >= HEALTH_CHECK_MAX_FAILURES ? "down" : "degraded";
    }
    return { name: this.serverName, status, failureCount: this.consecutiveFailures };
  }

  /** Richer info for `/mcp` and `/status`. */
  getServerInfo(): {
    name: string;
    protocolVersion: string;
    serverInfo: McpServerInfo;
    capabilities: McpServerCapabilities;
    lastError: string | null;
  } {
    return {
      name: this.serverName,
      protocolVersion: this.protocolVersion,
      serverInfo: this.serverInfo,
      capabilities: this.serverCapabilities,
      lastError: this.lastError,
    };
  }
}
