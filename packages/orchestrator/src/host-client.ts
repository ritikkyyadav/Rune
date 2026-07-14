// ─── HostClient: talk to a socket-mode engine-host ───
//
// The thin side of the detach/attach split: connects to the unix socket a
// `bun engine-host --socket <path>` process listens on, sends line-delimited
// JSON requests, and surfaces stream frames (chat events, status) to a
// handler. Killing the client — or the whole terminal — never touches the
// host; reattach and the session store has everything that happened.

export interface HostStreamFrame {
  stream: string;
  payload: unknown;
}

type PendingResolver = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
};

export class HostClient {
  private socket: { write(data: string): unknown; end(): void };
  private pending = new Map<number, PendingResolver>();
  private nextId = 1;
  private buffer = "";
  private streamHandlers: Array<(frame: HostStreamFrame) => void> = [];
  private closed = false;

  private constructor(socket: { write(data: string): unknown; end(): void }) {
    this.socket = socket;
  }

  /** Connect to a host socket. Rejects when nothing is listening. */
  static connect(socketPath: string, timeoutMs = 3_000): Promise<HostClient> {
    return new Promise<HostClient>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no engine host answered at ${socketPath} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      let client: HostClient | null = null;
      Bun.connect({
        unix: socketPath,
        socket: {
          open(socket) {
            clearTimeout(timer);
            client = new HostClient(socket);
            resolve(client);
          },
          data(_socket, chunk) {
            client?.onData(chunk.toString());
          },
          close() {
            client?.onClose();
          },
          error(_socket, err) {
            clearTimeout(timer);
            if (client) client.onClose();
            else reject(err instanceof Error ? err : new Error(String(err)));
          },
          connectError(_socket, err) {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        },
      }).catch((err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Send a command and await its response. */
  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("host connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`host did not answer "${cmd}" within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
  }

  /** Subscribe to stream frames (chat_event, engine_status, ready, …). */
  onStream(handler: (frame: HostStreamFrame) => void): void {
    this.streamHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // torn frame — nothing sane to do with it
      }
      if (typeof frame.stream === "string") {
        const f: HostStreamFrame = { stream: frame.stream, payload: frame.payload };
        for (const handler of this.streamHandlers) handler(f);
        continue;
      }
      if (typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(String(frame.error ?? "host error")));
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("host connection closed"));
    this.pending.clear();
  }
}
