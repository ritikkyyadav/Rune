// ─── HostClient: talk to a socket-mode engine-host ───
//
// The thin side of the detach/attach split: connects to the rendezvous path a
// `bun engine-host --socket <path>` process listens on, sends line-delimited
// JSON requests, and surfaces stream frames (chat events, status) to a
// handler. Killing the client — or the whole terminal — never touches the
// host; reattach and the session store has everything that happened.
//
// "Rendezvous path" rather than "unix socket" since P13.2: on Windows that
// path is a 0600 JSON file naming a loopback port and a token, because a unix
// socket is not something Windows can bind. See host-transport.ts — the choice
// lives there, once, and this file only asks it where to dial.

import type { HostCommandArgs, HostCommandName, HostCommandResult } from "@rune/protocol";
import { encodeFrame, rpcRequest, toResult, toStream } from "@rune/protocol";

import { type HostTarget, authFrame, resolveHostTarget } from "./host-transport";

/** The part of a Bun socket this file uses, so both dials share one handler. */
interface DialSocket {
  write(data: string | Uint8Array): number;
  end(): void;
}

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
  /** Set while a TCP connect is waiting for the post-handshake `ready`. */
  private readyWaiter: (() => void) | null = null;

  private constructor(socket: { write(data: string): unknown; end(): void }) {
    this.socket = socket;
  }

  /**
   * Connect to a host. Rejects when nothing is listening.
   *
   * On a unix host, "connected" means the socket opened — the same contract
   * this has always had. On a TCP host it means one thing more: the token was
   * accepted and the host answered `ready`. That extra step is not ceremony.
   * A rendezvous file outlives a host that was killed rather than shut down,
   * and the port it names can by then belong to something else entirely; a
   * caller that got a client back for that would sit in a fifteen-minute
   * request timeout instead of spawning a new host.
   */
  static connect(socketPath: string, timeoutMs = 3_000): Promise<HostClient> {
    return new Promise<HostClient>((resolve, reject) => {
      let target: HostTarget;
      try {
        target = resolveHostTarget(socketPath);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let client: HostClient | null = null;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new Error(`no engine host answered at ${socketPath} within ${timeoutMs}ms`));
      }, timeoutMs);

      function done(value: HostClient): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
      function fail(err: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }

      const onOpen = (socket: DialSocket): void => {
        const opened = new HostClient(socket);
        client = opened;
        if (target.kind !== "tcp") {
          done(opened);
          return;
        }
        opened.readyWaiter = () => done(opened);
        socket.write(authFrame(target.token));
      };
      const onChunk = (chunk: Uint8Array): void => client?.onData(chunk.toString());
      const onClosed = (): void => {
        client?.onClose();
        // Only meaningful before the handshake finished: a TCP host that
        // refuses the token closes without a word, and that must surface as a
        // failed connect rather than a client nobody can use.
        fail(new Error(`the engine host at ${socketPath} closed the connection`));
      };
      const onError = (err: unknown): void => {
        if (client) client.onClose();
        fail(err);
      };

      const dial =
        target.kind === "unix"
          ? Bun.connect({
              unix: target.path,
              socket: {
                open: (socket) => onOpen(socket),
                data: (_socket, chunk) => onChunk(chunk),
                close: () => onClosed(),
                error: (_socket, err) => onError(err),
                connectError: (_socket, err) => onError(err),
              },
            })
          : Bun.connect({
              hostname: target.host,
              port: target.port,
              socket: {
                open: (socket) => onOpen(socket),
                data: (_socket, chunk) => onChunk(chunk),
                close: () => onClosed(),
                error: (_socket, err) => onError(err),
                connectError: (_socket, err) => onError(err),
              },
            });
      dial.catch((err) => fail(err));
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
      this.socket.write(encodeFrame(rpcRequest(id, cmd, args)));
    });
  }

  /**
   * The typed front door: `call("switch_model", { model })` is checked against
   * the protocol's command map at both ends, so a client cannot invent a
   * command name or pass the wrong argument shape and find out at runtime.
   *
   * `request` stays as the untyped escape hatch for a client talking to a host
   * older or newer than its own protocol package.
   */
  call<K extends HostCommandName>(
    cmd: K,
    args: HostCommandArgs<K> = {} as HostCommandArgs<K>,
    timeoutMs = 30_000,
  ): Promise<HostCommandResult<K>> {
    return this.request(cmd, args as Record<string, unknown>, timeoutMs) as Promise<
      HostCommandResult<K>
    >;
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
      // Both envelopes, read by the protocol package rather than by two
      // hand-written branches here: a host that speaks JSON-RPC and one still
      // speaking `{stream,payload}` are the same client's problem, not two.
      const streamFrame = toStream(frame);
      if (streamFrame) {
        if (streamFrame.stream === "ready" && this.readyWaiter) {
          const waiter = this.readyWaiter;
          this.readyWaiter = null;
          waiter();
        }
        for (const handler of this.streamHandlers) handler(streamFrame);
        continue;
      }
      const result = toResult(frame);
      if (result && typeof result.id === "number") {
        const pending = this.pending.get(result.id);
        if (!pending) continue;
        this.pending.delete(result.id);
        if (result.ok) pending.resolve(result.result);
        else pending.reject(new Error(result.error.message));
      }
    }
  }

  private onClose(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("host connection closed"));
    this.pending.clear();
  }
}
