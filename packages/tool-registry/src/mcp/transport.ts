import type { McpIncomingMessage, McpTransport } from "./types";

// ─── stdio transport ───
// MCP stdio framing is newline-delimited JSON (one JSON-RPC message per line),
// per the spec and the reference SDK — NOT LSP-style Content-Length headers.

export interface StdioTransportConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class StdioTransport implements McpTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  private handler: (msg: McpIncomingMessage) => void = () => {};
  // Structural type — we only ever cancel() it (avoids Bun-vs-node ReadableStream flavor clash).
  private reader: { cancel(): Promise<void> } | null = null;

  constructor(private config: StdioTransportConfig) {}

  setMessageHandler(handler: (msg: McpIncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(this.config.env ?? {}) },
    });
    // Don't let the MCP subprocess keep the host process alive on its own — the
    // session's own handles (CLI/agent loop) do that. This lets the host exit
    // promptly on shutdown even if a wrapped (npx) server is slow to terminate.
    this.proc.unref();
    this.buffer = "";
    void this.readLoop();
  }

  async send(message: object): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "write" in stdin) {
      (stdin as { write(data: Uint8Array): number }).write(new TextEncoder().encode(line));
    } else {
      throw new Error("MCP stdio transport: stdin not available");
    }
  }

  async close(): Promise<void> {
    // Cancel the read loop first so it stops awaiting and releases the event
    // loop, THEN kill the process. Killing alone doesn't unblock the reader when
    // the server was spawned via a wrapper (e.g. npx) whose grandchild keeps the
    // stdout pipe open — that would otherwise hang a clean shutdown.
    try {
      await this.reader?.cancel();
    } catch {
      // Reader already released.
    }
    this.reader = null;
    // Close stdin so a wrapped server (npx → node) sees EOF and exits on its own,
    // then signal the immediate child.
    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "end" in stdin) {
      try {
        (stdin as { end(): void }).end();
      } catch {
        // Already closed.
      }
    }
    this.proc?.kill();
    this.proc = null;
  }

  private async readLoop(): Promise<void> {
    const stdout = this.proc?.stdout;
    if (!stdout || typeof stdout === "number") return;

    const reader = (stdout as ReadableStream<Uint8Array>).getReader();
    this.reader = reader;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.drainLines();
      }
    } catch {
      // Server closed the stream, or the reader was cancelled on close().
    } finally {
      this.reader = null;
    }
  }

  private drainLines(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        this.handler(JSON.parse(line) as McpIncomingMessage);
      } catch {
        // Non-JSON line (some servers log to stdout) — skip.
      }
    }
  }
}

// ─── Streamable HTTP transport ───
// Posts JSON-RPC messages to the server URL. The server replies either with a
// single JSON body or a text/event-stream (SSE) carrying one or more messages.
// A session id returned on initialize is echoed on subsequent requests.

export interface HttpTransportConfig {
  url: string;
  headers?: Record<string, string>;
}

export class HttpTransport implements McpTransport {
  private handler: (msg: McpIncomingMessage) => void = () => {};
  private sessionId: string | null = null;

  constructor(private config: HttpTransportConfig) {}

  setMessageHandler(handler: (msg: McpIncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // No persistent connection to open — the first POST is `initialize`.
  }

  async send(message: object): Promise<void> {
    const res = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(message),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202 || res.status === 204) return; // accepted notification, no body

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && res.body) {
      await this.consumeSse(res.body as ReadableStream<Uint8Array>);
    } else if (contentType.includes("application/json")) {
      const json = await res.json();
      this.dispatch(json);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.config.url, {
        method: "DELETE",
        headers: {
          "mcp-session-id": this.sessionId,
          ...(this.config.headers ?? {}),
        },
      });
    } catch {
      // Best-effort session teardown.
    }
    this.sessionId = null;
  }

  private dispatch(json: unknown): void {
    if (Array.isArray(json)) {
      for (const m of json) this.handler(m as McpIncomingMessage);
    } else if (json && typeof json === "object") {
      this.handler(json as McpIncomingMessage);
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const dataLine = event.split(/\r?\n/).find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice("data:".length).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            this.dispatch(JSON.parse(payload));
          } catch {
            // Malformed SSE data — skip.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
