// ─── Framed socket writes that survive backpressure ───
//
// Bun's socket `write` returns how many BYTES it accepted and queues nothing:
// when the kernel buffer is full it writes a prefix and drops the rest on the
// floor. Every engine-host response under about 64 KB therefore worked and
// every response over it was truncated mid-JSON, so the caller waited for the
// end of a line that would never arrive — a fifteen-minute hang (the pool's
// request timeout) on exactly the commands worth having:
//
//   get_turn_context   the whole assembled system prompt, tens of KB
//   export_trace       a signed transcript, unbounded
//   read_text_file     up to 512 KB by contract
//
// The symptom was worse than one dead command. Bun processes a socket's frames
// in order, so the first oversized response wedged EVERY later request on that
// connection — a trace-rail click that made the whole app stop answering.
//
// The fix is an outbox per socket, in BYTES rather than characters (`write`
// counts UTF-8 bytes, and slicing a string at a byte offset cuts a multi-byte
// character in half), flushed again when the socket drains.
//
// Its own module, with no side effects, so it can be tested without starting
// an engine — the reason the bug survived this long is that the only way to
// reach the writer was to run one.

/** The part of a Bun socket this needs: a write that reports what it took. */
export interface FramedSocket {
  write(data: string | Uint8Array): number;
}

const ENCODER = new TextEncoder();

/**
 * One outbox per socket.
 *
 * A class rather than module state so a test can hold its own, and so two
 * listeners in one process cannot share a queue.
 */
export class FrameWriter {
  private readonly pending = new Map<FramedSocket, Uint8Array>();

  /** Bytes still waiting for this socket to drain. Zero when it is caught up. */
  backlog(socket: FramedSocket): number {
    return this.pending.get(socket)?.length ?? 0;
  }

  /** Write one newline-delimited frame, queueing whatever the socket refuses. */
  write(socket: FramedSocket, text: string): void {
    const bytes = ENCODER.encode(text);
    const queued = this.pending.get(socket);
    if (!queued || queued.length === 0) {
      this.flushBytes(socket, bytes);
      return;
    }
    const joined = new Uint8Array(queued.length + bytes.length);
    joined.set(queued, 0);
    joined.set(bytes, queued.length);
    this.flushBytes(socket, joined);
  }

  /** The socket can take more: send whatever the last write left behind. */
  flush(socket: FramedSocket): void {
    const queued = this.pending.get(socket);
    if (queued && queued.length > 0) this.flushBytes(socket, queued);
  }

  /** Forget a socket that closed or errored. */
  forget(socket: FramedSocket): void {
    this.pending.delete(socket);
  }

  private flushBytes(socket: FramedSocket, bytes: Uint8Array): void {
    if (bytes.length === 0) {
      this.pending.delete(socket);
      return;
    }
    let wrote = 0;
    try {
      wrote = socket.write(bytes);
    } catch {
      // The client vanished mid-frame. Dropping the queue is right: there is
      // nobody to finish the sentence for, and the run continues regardless.
      this.pending.delete(socket);
      return;
    }
    // A socket that reports something other than a byte count is one this
    // cannot reason about; assume it took everything rather than resending.
    if (typeof wrote !== "number" || wrote >= bytes.length) this.pending.delete(socket);
    else this.pending.set(socket, bytes.subarray(Math.max(0, wrote)));
  }
}
