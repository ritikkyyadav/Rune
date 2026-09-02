import { type Logger, nullLogger } from "@gear/shared";
import { INIT_TIMEOUT_MS, STDERR_RING_LINES } from "./types";
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

/**
 * What the transport needs from an authorization provider. Kept to two methods
 * so the transport never learns what OAuth is: it asks for a header, and on a
 * 401 it asks whether a retry is worth attempting.
 */
export interface McpAuthProvider {
  /** The Authorization header to send, or null when nothing is stored yet. */
  authorizationHeader(): Promise<string | null>;
  /** Try to become authorized again (token refresh). True ⇒ retry the request. */
  refresh(): Promise<boolean>;
  /** Re-read stored credentials, picking up a sign-in from another process. */
  reload?(): Promise<void>;
}

/** Thrown when a connector needs an interactive login before it can be used. */
export class McpUnauthorizedError extends Error {
  constructor(
    message: string,
    /** Verbatim WWW-Authenticate, so the login flow can read its metadata hint. */
    public wwwAuthenticate: string | null,
    public status: number,
  ) {
    super(message);
    this.name = "McpUnauthorizedError";
  }
}

export interface HttpTransportConfig {
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
  /** OAuth 2.1 provider for this server (P4.2). Absent ⇒ static headers only. */
  auth?: McpAuthProvider;
}

export class HttpTransport implements McpTransport {
  private handler: (msg: McpIncomingMessage) => void = () => {};
  private lifecycle: ((ev: McpTransportLifecycle) => void) | null = null;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private closing = false;
  private logger: Logger;
  /** The optional GET stream carrying server-initiated messages. */
  private streamController: AbortController | null = null;

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

  /** Headers for one request, including the OAuth bearer when we hold one. */
  private async requestHeaders(): Promise<Record<string, string>> {
    // The configured headers win: a user who hand-wrote an Authorization header
    // in mcp.json means it, and their explicit choice outranks our token.
    const bearer = this.config.auth ? await this.config.auth.authorizationHeader() : null;
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: bearer } : {}),
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  async send(message: object): Promise<void> {
    let res = await fetch(this.config.url, {
      method: "POST",
      headers: await this.requestHeaders(),
      body: JSON.stringify(message),
    });

    // One refresh-and-retry on 401. A token that expired mid-session is the
    // common case and must not surface to the user at all.
    if (res.status === 401 && this.config.auth) {
      const refreshed = await this.config.auth.refresh().catch(() => false);
      if (refreshed) {
        res = await fetch(this.config.url, {
          method: "POST",
          headers: await this.requestHeaders(),
          body: JSON.stringify(message),
        });
      }
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202 || res.status === 204) return; // accepted notification, no body

    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      const wic = res.headers.get("www-authenticate");
      // A typed error, not a string: the client turns this into
      // `server-needs-auth` and keeps the session alive.
      throw new McpUnauthorizedError(
        `MCP HTTP ${res.status} unauthorized${wic ? ` (${wic})` : ""}${text ? `: ${text.slice(0, 200)}` : ""}`,
        wic,
        res.status,
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

  /**
   * Open the server→client stream.
   *
   * The 2025-03-26 spec makes GET optional: a server may use it to push
   * requests (elicitation, sampling) and notifications outside any POST
   * response. Without it, a connector that asks the user a question mid-call
   * is simply never heard. A server that does not offer one answers 405 and we
   * carry on — the POST path is complete on its own.
   */
  async openServerStream(): Promise<void> {
    if (this.streamController) return;
    const controller = new AbortController();
    this.streamController = controller;
    try {
      const bearer = this.config.auth ? await this.config.auth.authorizationHeader() : null;
      const res = await fetch(this.config.url, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          ...(bearer ? { authorization: bearer } : {}),
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
          ...(this.config.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        // 405 is the documented "I do not offer one"; anything else is equally
        // survivable, because this stream is additive.
        this.streamController = null;
        return;
      }
      void this.consumeSse(res.body as ReadableStream<Uint8Array>).finally(() => {
        if (this.streamController === controller) this.streamController = null;
      });
    } catch {
      this.streamController = null;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      this.streamController?.abort();
    } catch {
      // Already torn down.
    }
    this.streamController = null;
    if (!this.sessionId) return;
    try {
      const bearer = this.config.auth ? await this.config.auth.authorizationHeader() : null;
      await fetch(this.config.url, {
        method: "DELETE",
        headers: {
          "mcp-session-id": this.sessionId,
          ...(bearer ? { authorization: bearer } : {}),
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

// ─── Legacy SSE transport (protocol 2024-11-05) ───
//
// Before Streamable HTTP, a remote MCP server was TWO endpoints: a long-lived
// `GET` returning `text/event-stream` for server→client messages, and a POST
// endpoint whose URL the server announces in an `endpoint` event on that
// stream. Plenty of deployed servers still speak only this.
//
// Detection is the transport's own job, not the user's: HttpTransport falls
// back to this when a server rejects the streamable handshake in the way an
// older one does. Nobody should have to know which vintage their connector is.

export interface SseTransportConfig {
  /** The GET endpoint that opens the server→client stream. */
  url: string;
  headers?: Record<string, string>;
  logger?: Logger;
  auth?: McpAuthProvider;
}

export class SseTransport implements McpTransport {
  private handler: (msg: McpIncomingMessage) => void = () => {};
  private lifecycle: ((ev: McpTransportLifecycle) => void) | null = null;
  private protocolVersion: string | null = null;
  private closing = false;
  private logger: Logger;
  /** Where to POST, announced by the server's `endpoint` event. */
  private postUrl: string | null = null;
  private endpointReady: Promise<string> | null = null;
  private controller: AbortController | null = null;

  constructor(private config: SseTransportConfig) {
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

  private async headers(): Promise<Record<string, string>> {
    const bearer = this.config.auth ? await this.config.auth.authorizationHeader() : null;
    return {
      ...(bearer ? { authorization: bearer } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...(this.config.headers ?? {}),
    };
  }

  async start(): Promise<void> {
    this.closing = false;
    this.controller = new AbortController();
    let resolveEndpoint!: (url: string) => void;
    let rejectEndpoint!: (err: Error) => void;
    this.endpointReady = new Promise<string>((res, rej) => {
      resolveEndpoint = res;
      rejectEndpoint = rej;
    });
    // A rejection can land before anyone awaits it (start() throws first).
    void this.endpointReady.catch(() => {});

    const res = await fetch(this.config.url, {
      method: "GET",
      headers: { ...(await this.headers()), accept: "text/event-stream" },
      signal: this.controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new McpUnauthorizedError(
        `MCP SSE ${res.status} unauthorized`,
        res.headers.get("www-authenticate"),
        res.status,
      );
    }
    if (!res.ok || !res.body) {
      throw new Error(`MCP SSE ${res.status}: could not open the event stream`);
    }

    // The stream outlives start(); only the endpoint announcement is awaited.
    void this.consume(res.body as ReadableStream<Uint8Array>, resolveEndpoint).finally(() => {
      if (!this.closing) this.lifecycle?.({ type: "exit", code: null });
    });

    const timer = setTimeout(
      () => rejectEndpoint(new Error("MCP SSE: server never announced its POST endpoint")),
      INIT_TIMEOUT_MS,
    );
    try {
      this.postUrl = await this.endpointReady;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: object): Promise<void> {
    const target = this.postUrl ?? (this.endpointReady ? await this.endpointReady : null);
    if (!target) throw new Error("MCP SSE: no POST endpoint");
    const res = await fetch(target, {
      method: "POST",
      headers: { ...(await this.headers()), "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (res.status === 401 || res.status === 403) {
      throw new McpUnauthorizedError(
        `MCP SSE ${res.status} unauthorized`,
        res.headers.get("www-authenticate"),
        res.status,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP SSE POST ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    // Replies arrive on the GET stream, not in this response body.
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      this.controller?.abort();
    } catch {
      // Already torn down.
    }
    this.controller = null;
    this.postUrl = null;
  }

  /** Read the event stream, routing `endpoint` once and `message` forever. */
  private async consume(
    body: ReadableStream<Uint8Array>,
    onEndpoint: (url: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let announced = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          let event = "message";
          const data: string[] = [];
          for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          const payload = data.join("\n");
          if (!payload) continue;
          if (event === "endpoint") {
            if (announced) continue;
            announced = true;
            // Relative per the 2024-11-05 spec; resolved against the GET URL.
            onEndpoint(new URL(payload, this.config.url).toString());
            continue;
          }
          try {
            this.handler(JSON.parse(payload) as McpIncomingMessage);
          } catch {
            // Malformed SSE data — skip, exactly as the streamable path does.
          }
        }
      }
    } catch {
      // Aborted on close, or the server hung up.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
  }
}
