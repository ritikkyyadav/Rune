/**
 * The engine host's socket writer, and the bug it exists because of.
 *
 * Bun's socket `write` reports how many BYTES it accepted and queues nothing.
 * The host ignored that number, so every response larger than the kernel
 * buffer — `get_turn_context` carries the whole assembled system prompt, tens
 * of kilobytes — went out truncated mid-JSON, and the caller waited fifteen
 * minutes for the end of a line that would never arrive. Worse: Bun handles a
 * socket's frames in order, so the first oversized response wedged every later
 * request on that connection. Clicking a span in the trace rail made the whole
 * app stop answering.
 *
 * These tests are the reason the writer is its own module: reaching it before
 * meant starting an engine, which is why nobody reached it.
 */

import { describe, expect, test } from "bun:test";

import {
  FrameWriter,
  type FramedSocket,
} from "../../../packages/orchestrator/src/bin/host-framing";

/** A socket that accepts at most `capacity` bytes per write, like a real one. */
function socket(capacity = Infinity): FramedSocket & { seen: Uint8Array[]; text(): string } {
  const seen: Uint8Array[] = [];
  return {
    seen,
    write(data: string | Uint8Array): number {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const took = bytes.subarray(0, Math.min(capacity, bytes.length));
      seen.push(took);
      return took.length;
    },
    text(): string {
      const total = seen.reduce((n, b) => n + b.length, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const b of seen) {
        all.set(b, at);
        at += b.length;
      }
      return new TextDecoder().decode(all);
    },
  };
}

describe("frames that fit", () => {
  test("go out in one piece and leave nothing queued", () => {
    const w = new FrameWriter();
    const s = socket();
    w.write(s, '{"id":1,"ok":true}\n');
    expect(s.text()).toBe('{"id":1,"ok":true}\n');
    expect(w.backlog(s)).toBe(0);
  });
});

describe("frames that do not fit", () => {
  test("are not truncated — the remainder is queued, not dropped", () => {
    // The whole bug in one assertion: before the fix, `text()` here was the
    // first 8 bytes and the other 4,092 were gone.
    const w = new FrameWriter();
    const s = socket(8);
    const frame = `${"x".repeat(4_090)}\n`;
    w.write(s, frame);
    expect(w.backlog(s)).toBe(frame.length - 8);
    for (let i = 0; i < 600; i++) w.flush(s);
    expect(s.text()).toBe(frame);
    expect(w.backlog(s)).toBe(0);
  });

  test("keep their order when a second frame arrives mid-flush", () => {
    // A stream event landing while a big response is still draining must not
    // overtake it: the client reassembles by line, and interleaved bytes are
    // two corrupt frames rather than two frames.
    const w = new FrameWriter();
    const s = socket(4);
    w.write(s, "first-frame\n");
    w.write(s, "second\n");
    for (let i = 0; i < 20; i++) w.flush(s);
    expect(s.text()).toBe("first-frame\nsecond\n");
  });

  test("never split a multi-byte character", () => {
    // The reason the outbox holds BYTES: `write` counts UTF-8 bytes, so
    // resuming at a byte offset in a STRING would cut "→" in half and the
    // client would decode a replacement character into the middle of the JSON.
    const w = new FrameWriter();
    const s = socket(3);
    const frame = `{"note":"→ ✓ ünicode"}\n`;
    w.write(s, frame);
    for (let i = 0; i < 200; i++) w.flush(s);
    expect(s.text()).toBe(frame);
  });
});

describe("sockets that go away", () => {
  test("a throwing write drops the queue instead of retrying forever", () => {
    const w = new FrameWriter();
    const dead: FramedSocket = {
      write() {
        throw new Error("EPIPE");
      },
    };
    w.write(dead, "anything\n");
    expect(w.backlog(dead)).toBe(0);
  });

  test("forget clears a closed socket's backlog", () => {
    const w = new FrameWriter();
    const s = socket(1);
    w.write(s, "long enough to queue\n");
    expect(w.backlog(s)).toBeGreaterThan(0);
    w.forget(s);
    expect(w.backlog(s)).toBe(0);
  });

  test("a write that reports something other than a byte count is taken at its word", () => {
    // Rather than resending forever against a socket this cannot reason about.
    const w = new FrameWriter();
    const odd = { write: () => undefined as unknown as number };
    w.write(odd, "frame\n");
    expect(w.backlog(odd)).toBe(0);
  });

  test("flushing a socket with nothing queued writes nothing", () => {
    const w = new FrameWriter();
    const s = socket();
    w.flush(s);
    expect(s.seen).toHaveLength(0);
  });
});
