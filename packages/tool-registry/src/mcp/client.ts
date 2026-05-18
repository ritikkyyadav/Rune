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
   * Call a tool on this MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    const result = (await this.send("tools/call", {
      name,
      arguments: args,
    })) as McpCallToolResult;
    return result;
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

  private async send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
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
        (stdin as { write(data: string | Uint8Array): number }).write(new TextEncoder().encode(message));
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

  private async notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const notification = { jsonrpc: "2.0" as const, method, params };
    const json = JSON.stringify(notification);
    const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;

    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "write" in stdin) {
      (stdin as { write(data: string | Uint8Array): number }).write(new TextEncoder().encode(message));
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
