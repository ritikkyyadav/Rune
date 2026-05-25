import type { ToolCallInput, ToolCallOutput, ToolHandler, ToolSchema } from "../types";

// ─── MCP Protocol Types ───
// Subset of the Model Context Protocol needed for tool discovery and execution.

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Constants ───

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_PARAM_SIZE = 1_000_000; // 1MB per string param
const HEALTH_CHECK_MAX_FAILURES = 3;

// ─── MCP Client ───

export class McpClient {
  private serverName: string;
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private responseBuffer = "";
  private tools: McpToolSchema[] = [];
  private ready = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;

  constructor(config: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }) {
    this.serverName = config.name;
    this.command = config.command;
    this.args = config.args ?? [];
    this.env = config.env ?? {};
  }

  get name(): string {
    return this.serverName;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Start the MCP server subprocess and perform handshake.
   */
  async start(): Promise<void> {
    this.proc = Bun.spawn([this.command, ...this.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.env },
    });

    // Start reading stdout for JSON-RPC responses
    this.readLoop();

    // Initialize handshake
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "alan", version: "0.1.0" },
    });

    // Send initialized notification
    await this.notify("notifications/initialized", {});

    // Discover tools
    const toolsResult = (await this.send("tools/list", {})) as {
      tools?: McpToolSchema[];
    };
    this.tools = toolsResult?.tools ?? [];
    this.ready = true;
  }

  /**
   * Stop the MCP server subprocess.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.ready = false;
    this.pendingRequests.clear();
  }

  /**
   * Get the tools exposed by this MCP server.
   */
  getTools(): McpToolSchema[] {
    return [...this.tools];
  }

  /**
   * Validate tool input arguments against the tool's schema.
   */
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
    // Check string values aren't too large
    for (const [key, val] of Object.entries(args)) {
      if (typeof val === "string" && val.length > MAX_PARAM_SIZE) {
        errors.push(`Param ${key} exceeds 1MB limit`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Enforce a max response size, truncating with a warning if exceeded.
   */
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

  /**
   * Start periodic health checks for this MCP server.
   */
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

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get current health status of this MCP server.
   */
  getServerHealth(): {
    name: string;
    status: "healthy" | "degraded" | "down";
    failureCount: number;
  } {
    let status: "healthy" | "degraded" | "down" = "healthy";
    if (!this.ready || !this.proc) {
      status = "down";
    } else if (this.consecutiveFailures > 0) {
      status = this.consecutiveFailures >= HEALTH_CHECK_MAX_FAILURES ? "down" : "degraded";
    }
    return { name: this.serverName, status, failureCount: this.consecutiveFailures };
  }

  /**
   * Call a tool on this MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    // Find schema for the tool and validate input
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
   * Create ToolHandler instances for all tools on this server.
   */
  toToolHandlers(): ToolHandler[] {
    return this.tools.map((tool) => this.createHandler(tool));
  }

  private createHandler(mcpTool: McpToolSchema): ToolHandler {
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
      permissionLevel: "confirm",
      category: "network",
    };

    return {
      schema,
      validate: () => ({ valid: true }),
      execute: async (input: ToolCallInput): Promise<ToolCallOutput> => {
        const start = performance.now();
        try {
          const result = await client.callTool(mcpTool.name, input.args);
          const durationMs = Math.round(performance.now() - start);

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
            durationMs,
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

  // ─── JSON-RPC over stdio ───

  private async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request: McpJsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const json = JSON.stringify(request);
      const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;

      const stdin = this.proc?.stdin;
      if (stdin && typeof stdin !== "number" && "write" in stdin) {
        (stdin as { write(data: string | Uint8Array): number }).write(
          new TextEncoder().encode(message),
        );
      } else {
        reject(new Error("MCP server stdin not available"));
      }

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const notification = { jsonrpc: "2.0" as const, method, params };
    const json = JSON.stringify(notification);
    const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;

    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "write" in stdin) {
      (stdin as { write(data: string | Uint8Array): number }).write(
        new TextEncoder().encode(message),
      );
    }
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.responseBuffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch {
      // Server closed
    }
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.responseBuffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed — skip to next header
        this.responseBuffer = this.responseBuffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.responseBuffer.length < bodyEnd) break; // Incomplete

      const body = this.responseBuffer.slice(bodyStart, bodyEnd);
      this.responseBuffer = this.responseBuffer.slice(bodyEnd);

      try {
        const response = JSON.parse(body) as McpJsonRpcResponse;
        if (response.id !== undefined) {
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error.message));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch {
        // Malformed JSON — skip
      }
    }
  }
}
