import { type Logger, nullLogger } from "@alan/shared";
import { STDERR_RING_LINES } from "./types";
import type { McpIncomingMessage, McpTransport, McpTransportLifecycle } from "./types";

/** Thrown when the HTTP server rejects our session id (404) — the client
 *  re-initializes and retries once. */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("MCP HTTP session expired");
    this.name = "McpSessionExpiredError";
  }
}

// ─── stdio transport ───
// MCP stdio framing is newline-delimited JSON (one JSON-RPC message per line),
// per the spec and the reference SDK — NOT LSP-style Content-Length headers.

export interface StdioTransportConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  logger?: Logger;
}

export class StdioTransport implements McpTransport {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private buffer = "";
  private handler: (msg: McpIncomingMessage) => void = () => {};
  private lifecycle: ((ev: McpTransportLifecycle) => void) | null = null;
  // Structural type — we only ever cancel() it (avoids Bun-vs-node ReadableStream flavor clash).
  private reader: { cancel(): Promise<void> } | null = null;
  private stderrReader: { cancel(): Promise<void> } | null = null;
  private stderrRing: string[] = [];
  private exited = false;
  private closing = false;
  private logger: Logger;

  constructor(private config: StdioTransportConfig) {
    this.logger = config.logger ?? nullLogger;
  }

  setMessageHandler(handler: (msg: McpIncomingMessage) => void): void {
    this.handler = handler;
  }

  setLifecycleHandler(handler: (ev: McpTransportLifecycle) => void): void {
    this.lifecycle = handler;
  }

  /** Last few stderr lines — surfaced as a diagnostic when a server dies. */
  getStderrTail(): string {
    return this.stderrRing.join("\n");
  }

  async start(): Promise<void> {
    this.exited = false;
    this.closing = false;
    try {
      this.proc = Bun.spawn([this.config.command, ...(this.config.args ?? [])], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(this.config.env ?? {}) },
      });
    } catch (err) {
      // Synchronous spawn failure (ENOENT — command not found, EACCES, …).
      throw new Error(
        `failed to spawn "${this.config.command}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Don't let the MCP subprocess keep the host process alive on its own — the
    // session's own handles (CLI/agent loop) do that. This lets the host exit
    // promptly on shutdown even if a wrapped (npx) server is slow to terminate.
    this.proc.unref();
    this.buffer = "";
    this.stderrRing = [];
    // Watch for unexpected death so the client can mark the server down / restart.
    // Suppressed when we initiated the shutdown (close sets `closing`).
    void this.proc.exited.then((code) => {
      this.exited = true;
      if (!this.closing) this.lifecycle?.({ type: "exit", code });
    });
    void this.readLoop();
    // CRITICAL: drain stderr. An un-read "pipe" fills the ~64KB OS buffer and
    // then blocks the server's next stderr write forever (a chatty server would
    // hang the whole session). We keep only the last N lines for diagnostics.
    void this.drainStderr();
  }

  async send(message: object): Promise<void> {
    if (this.exited) throw new Error("MCP stdio transport: process has exited");
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (stdin && typeof stdin !== "number" && "write" in stdin) {
      (stdin as { write(data: Uint8Array): number }).write(new TextEncoder().encode(line));
    } else {
      throw new Error("MCP stdio transport: stdin not available");
    }
  }

  async close(): Promise<void> {
    // Cancel the read loops first so they stop awaiting and release the event
    // loop, THEN kill the process. Killing alone doesn't unblock the reader when
    // the server was spawned via a wrapper (e.g. npx) whose grandchild keeps the
    // stdout pipe open — that would otherwise hang a clean shutdown.
    this.closing = true; // suppress the exit event we're about to cause (kept across restart)
    try {
      await this.reader?.cancel();
    } catch {
      // Reader already released.
    }
    try {
      await this.stderrReader?.cancel();
    } catch {
      // Reader already released.
    }
    this.reader = null;
    this.stderrReader = null;
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
    this.exited = true;
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

  private async drainStderr(): Promise<void> {
    const stderr = this.proc?.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    this.stderrReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          this.pushStderr(line);
        }
      }
    } catch {
      // Stream closed / reader cancelled.
    } finally {
      this.stderrReader = null;
    }
  }

  private pushStderr(line: string): void {
    this.stderrRing.push(line);
    if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
    this.logger.debug(`[stderr] ${line}`);
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
// A session id returned on initialize is echoed on subsequent requests, and the
// negotiated protocol version is sent as MCP-Protocol-Version (2025-06-18 spec).

export interface HttpTransportConfig {
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
}

export class HttpTransport implements McpTransport {
  private handler: (msg: McpIncomingMessage) => void = () => {};
  private lifecycle: ((ev: McpTransportLifecycle) => void) | null = null;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private closing = false;
  private logger: Logger;

  constructor(private config: HttpTransportConfig) {
    this.logger = config.logger ?? nullLogger;
  }

  setMessageHandler(handler: (msg: McpIncomingMessage) => void): void {
    this.handler = handler;
  }

  setLifecycleHandler(handler: (ev: McpTransportLifecycle) => void): void {
    this.lifecycle = handler;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async start(): Promise<void> {
    // No persistent connection to open — the first POST is `initialize`.
    this.closing = false;
  }

  async send(message: object): Promise<void> {
    const res = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(message),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202 || res.status === 204) return; // accepted notification, no body

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const wic = res.headers.get("www-authenticate");
      throw new Error(
        `MCP HTTP ${res.status} unauthorized${wic ? ` (${wic})` : ""}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }

    if (res.status === 404 && this.sessionId) {
      // The server forgot our session — signal so the client can re-initialize.
      this.sessionId = null;
      if (!this.closing) this.lifecycle?.({ type: "session-expired" });
      throw new McpSessionExpiredError();
    }

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
    this.closing = true;
    if (!this.sessionId) return;
    try {
      await fetch(this.config.url, {
        method: "DELETE",
        headers: {
          "mcp-session-id": this.sessionId,
          ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
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
