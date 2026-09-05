// ─── LSP JSON-RPC transport (stdio, Content-Length framing) ───
//
// The minimal protocol layer under the LSP manager: spawn a language server,
// correlate request ids to responses, surface notifications. Deliberately no
// dependency on vscode-jsonrpc — the framing is ~40 lines and owning it means
// the failure modes (partial frames, garbage on stdout, dead server) are OUR
// failure modes, handled the way the rest of Rune handles them: bounded
// timeouts, errors as values, never a hang.

export interface RpcError {
  code: number;
  message: string;
}

type Resolver = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class JsonRpcConnection {
  private proc: ReturnType<typeof Bun.spawn>;
  // stdin: "pipe" guarantees a FileSink at runtime; the spawn type union
  // (number | FileSink) doesn't narrow through the options, so pin it once.
  private sink: { write(data: Uint8Array): unknown; flush(): unknown };
  private nextId = 1;
  private pending = new Map<number, Resolver>();
  private buffer: Uint8Array = new Uint8Array(0);
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private dead: string | null = null;
  private stderrTail = "";

  constructor(cmd: string[], cwd: string) {
    this.proc = Bun.spawn(cmd, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.sink = this.proc.stdin as unknown as {
      write(data: Uint8Array): unknown;
      flush(): unknown;
    };
    void this.readLoop();
    void this.stderrLoop();
    void this.proc.exited.then((code) => {
      this.markDead(`language server exited (code ${code})${this.stderrHint()}`);
    });
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  isDead(): boolean {
    return this.dead !== null;
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Send a request and await its response (bounded — never hangs the loop). */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 8000): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms (server busy or indexing)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.dead) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Best-effort graceful stop, then SIGKILL. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (!this.dead) {
      try {
        await this.request("shutdown", null, 800).catch(() => {});
        this.notify("exit", null);
      } catch {
        // dying anyway
      }
    }
    this.kill();
    await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 500))]);
  }

  /** Synchronous kill for process-exit teardown (no awaiting allowed there). */
  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
    this.markDead("language server stopped");
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim().slice(-300);
    return tail ? ` — stderr: ${tail}` : "";
  }

  private write(message: Record<string, unknown>): void {
    const body = new TextEncoder().encode(JSON.stringify(message));
    const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
    const frame = new Uint8Array(header.length + body.length);
    frame.set(header, 0);
    frame.set(body, header.length);
    try {
      this.sink.write(frame);
      this.sink.flush();
    } catch (err) {
      this.markDead(`write to language server failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        const merged = new Uint8Array(this.buffer.length + chunk.length);
        merged.set(this.buffer, 0);
        merged.set(chunk, this.buffer.length);
        this.buffer = merged;
        this.drainFrames();
      }
    } catch {
      // stream closed — exit handler reports it
    }
  }

  private async stderrLoop(): Promise<void> {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of this.proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        this.stderrTail = (this.stderrTail + decoder.decode(chunk)).slice(-2000);
      }
    } catch {
      // stream closed
    }
  }

  private drainFrames(): void {
    for (;;) {
      const headerEnd = indexOfSeq(this.buffer, [13, 10, 13, 10]); // \r\n\r\n
      if (headerEnd === -1) return;
      const header = new TextDecoder().decode(this.buffer.slice(0, headerEnd));
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Garbage before a real header (some servers log to stdout) — resync.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return; // partial frame
      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      try {
        this.dispatch(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        // Malformed frame from the server — skip it rather than dying.
      }
    }
  }

  private dispatch(message: {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: RpcError;
  }): void {
    if (message.id !== undefined && message.method === undefined) {
      // Response to one of our requests.
      const waiter = this.pending.get(Number(message.id));
      if (!waiter) return;
      this.pending.delete(Number(message.id));
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(`${message.error.message} (LSP ${message.error.code})`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // Server-to-client request (configuration, registerCapability, …).
      // Phase-1: answer with null/empty so the server never blocks on us.
      this.write({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params);
    }
  }
}

function indexOfSeq(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
