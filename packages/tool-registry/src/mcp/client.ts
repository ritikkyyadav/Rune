import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";
import { HttpTransport, StdioTransport } from "./transport";
import {
  HEALTH_CHECK_MAX_FAILURES,
  MAX_PARAM_SIZE,
  MAX_RESPONSE_SIZE,
  REQUEST_TIMEOUT_MS,
} from "./types";
import type {
  McpCallToolResult,
  McpIncomingMessage,
  McpJsonRpcResponse,
  McpToolSchema,
  McpTransport,
} from "./types";

const PROTOCOL_VERSION = "2025-06-18";

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
}

/**
 * One connection to an MCP server. Transport-agnostic: stdio (local subprocess)
 * or Streamable HTTP (remote). Owns JSON-RPC request/response correlation,
 * handshake, tool discovery, and execution.
 */
export class McpClient {
  private serverName: string;
  private transport: McpTransport;
  private transportKind: "stdio" | "http";
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private tools: McpToolSchema[] = [];
  private ready = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  constructor(config: McpClientConfig) {
    this.serverName = config.name;
    if (config.url || config.type === "http") {
      this.transportKind = "http";
      this.transport = new HttpTransport({ url: config.url!, headers: config.headers });
    } else {
      this.transportKind = "stdio";
      this.transport = new StdioTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
      });
    }
    this.transport.setMessageHandler((msg) => this.handleMessage(msg));
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

  /** Start the transport and perform the MCP handshake + tool discovery. */
  async start(): Promise<void> {
    await this.transport.start();

    await this.send("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "alan", version: "0.1.0" },
    });
    await this.notify("notifications/initialized", {});

    const toolsResult = (await this.send("tools/list", {})) as { tools?: McpToolSchema[] };
    this.tools = toolsResult?.tools ?? [];
    this.ready = true;
  }

  /** Stop health checks and close the transport. */
  async stop(): Promise<void> {
    this.stopHealthChecks();
    await this.transport.close();
    this.ready = false;
    for (const pending of this.pendingRequests.values()) clearTimeout(pending.timer);
    this.pendingRequests.clear();
  }

  getTools(): McpToolSchema[] {
    return [...this.tools];
  }

  // ─── JSON-RPC over the transport ───

  private handleMessage(msg: McpIncomingMessage): void {
    if (!msg || typeof msg !== "object" || !("id" in msg) || msg.id === undefined) {
      // Server-initiated request/notification — not handled in this client.
      return;
    }
    const response = msg as McpJsonRpcResponse;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      // Timer is cleared the moment the request settles — a dangling timeout
      // would otherwise keep the event loop alive for its full duration.
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      // Fire the message; failures to ship reject immediately. The response
      // resolves the promise via handleMessage().
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((err: unknown) => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          clearTimeout(pending.timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", method, params });
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
    const totalSize = result.content.reduce((sum, c) => sum + (c.text?.length ?? 0), 0);
    if (totalSize <= MAX_RESPONSE_SIZE) return result;

    let remaining = MAX_RESPONSE_SIZE;
    const truncatedContent = result.content.map((c) => {
      if (!c.text || remaining <= 0) return { ...c, text: "" };
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

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    const toolSchema = this.tools.find((t) => t.name === name);
    const validation = this.validateToolInput(toolSchema, args);
    if (!validation.valid) {
      return {
        content: [{ type: "text", text: `Validation failed: ${validation.errors.join("; ")}` }],
        isError: true,
      };
    }

    const result = (await this.send("tools/call", {
      name,
      arguments: args,
    })) as McpCallToolResult;
    return this.limitResponseSize(result);
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
          const result = await client.callTool(mcpTool.name, input.args);
          const textContent = result.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!)
            .join("\n");
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

  startHealthChecks(intervalMs = 30000): void {
    this.stopHealthChecks();
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.send("tools/list", {});
        this.consecutiveFailures = 0;
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= HEALTH_CHECK_MAX_FAILURES) {
          console.error(
            `[MCP] Server ${this.serverName} failed ${this.consecutiveFailures} health checks, restarting...`,
          );
          try {
            await this.stop();
            await this.start();
            this.consecutiveFailures = 0;
          } catch (restartErr) {
            console.error(
              `[MCP] Failed to restart ${this.serverName}: ${restartErr instanceof Error ? restartErr.message : restartErr}`,
            );
          }
        }
      }
    }, intervalMs);
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
}
