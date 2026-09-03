/**
 * P10.5 — the AWS event-stream decoder.
 *
 * Bedrock's streaming response is binary framing, not SSE. Decoding it back
 * into SSE is what lets Bedrock reuse the Anthropic adapter's stream parser
 * instead of growing a second one, so this decoder is load-bearing for every
 * streamed token on that route.
 *
 * The CRC is checked against the universal CRC-32 check value first
 * (`crc32("123456789") === 0xCBF43926`), which is what makes the frame fixtures
 * below meaningful rather than circular: the encoder that builds them and the
 * decoder that reads them share a checksum that has been verified against an
 * outside constant.
 */
import { describe, test, expect } from "bun:test";
import {
  chunkToSse,
  crc32,
  decodeMessage,
  encodeMessage,
  eventStreamToSse,
  EventStreamError,
} from "../../../packages/llm-gateway/src/providers/aws/event-stream";

/** Wrap an Anthropic event the way Bedrock does: base64 inside `{"bytes":…}`. */
function bedrockChunk(event: object): Uint8Array {
  const inner = JSON.stringify(event);
  const payload = JSON.stringify({ bytes: Buffer.from(inner, "utf-8").toString("base64") });
  return encodeMessage({
    headers: {
      ":event-type": "chunk",
      ":content-type": "application/json",
      ":message-type": "event",
    },
    payload: new TextEncoder().encode(payload),
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A ReadableStream that hands out the given byte slices, one read at a time. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) controller.close();
      else controller.enqueue(chunks[i++]!);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("crc32", () => {
  test("matches the universal check value for '123456789'", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("the empty input hashes to zero", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("frame decoding", () => {
  test("round-trips headers and payload", () => {
    const frame = encodeMessage({
      headers: { ":event-type": "chunk", ":message-type": "event" },
      payload: new TextEncoder().encode("hello"),
    });
    const decoded = decodeMessage(frame);
    expect(decoded).not.toBeNull();
    expect(decoded!.end).toBe(frame.length);
    expect(decoded!.message.headers[":event-type"]).toBe("chunk");
    expect(new TextDecoder().decode(decoded!.message.payload)).toBe("hello");
  });

  test("an incomplete frame returns null rather than throwing", () => {
    const frame = encodeMessage({ headers: { a: "b" }, payload: new Uint8Array([1, 2, 3]) });
    expect(decodeMessage(frame.subarray(0, frame.length - 1))).toBeNull();
    expect(decodeMessage(new Uint8Array(4))).toBeNull();
  });

  test("a corrupted payload fails the message checksum", () => {
    const frame = encodeMessage({
      headers: { ":event-type": "chunk" },
      payload: new TextEncoder().encode("hello"),
    });
    // Flip a byte inside the payload, leaving the prelude intact.
    frame[frame.length - 6] = frame[frame.length - 6]! ^ 0xff;
    expect(() => decodeMessage(frame)).toThrow(EventStreamError);
  });

  test("a corrupted prelude fails the prelude checksum", () => {
    const frame = encodeMessage({ headers: { a: "b" }, payload: new Uint8Array([1]) });
    frame[5] = frame[5]! ^ 0x01;
    expect(() => decodeMessage(frame)).toThrow(/prelude checksum/);
  });
});

describe("chunkToSse", () => {
  test("unwraps a Bedrock chunk into an Anthropic SSE event", () => {
    const decoded = decodeMessage(
      bedrockChunk({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }),
    )!;
    const sse = chunkToSse(decoded.message);
    expect(sse).toBe(
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
    );
  });

  test("an exception frame becomes an SSE error event, not silence", () => {
    // A stream that just stops looks like a short answer. Surfacing the
    // exception is what makes the SDK raise instead.
    const frame = encodeMessage({
      headers: { ":message-type": "exception", ":exception-type": "ThrottlingException" },
      payload: new TextEncoder().encode(JSON.stringify({ message: "Too many requests" })),
    });
    const sse = chunkToSse(decodeMessage(frame)!.message)!;
    expect(sse.startsWith("event: error\n")).toBe(true);
    expect(sse).toContain("ThrottlingException");
    expect(sse).toContain("Too many requests");
  });

  test("a non-chunk event frame is dropped rather than mis-parsed", () => {
    const frame = encodeMessage({
      headers: { ":event-type": "metadata", ":message-type": "event" },
      payload: new TextEncoder().encode("{}"),
    });
    expect(chunkToSse(decodeMessage(frame)!.message)).toBeNull();
  });
});

describe("eventStreamToSse", () => {
  const events = [
    { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
  ];

  test("decodes a whole recorded response into SSE", async () => {
    const body = streamOf(events.map((e) => bedrockChunk(e)));
    const sse = await readAll(eventStreamToSse(body));
    for (const e of events) expect(sse).toContain(`event: ${e.type}\n`);
    expect(sse).toContain('"text":"Hello"');
  });

  test("a frame split across reads is buffered, not corrupted", async () => {
    // The bug this pins: a decoder that assumed one read = one frame works on
    // short answers and breaks on long ones, where TCP boundaries fall inside
    // a frame. Here EVERY frame is split at a different offset.
    const frames = events.map((e) => bedrockChunk(e));
    const all = concat(frames);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < all.length; at += 7) pieces.push(all.subarray(at, at + 7));
    const sse = await readAll(eventStreamToSse(streamOf(pieces)));
    for (const e of events) expect(sse).toContain(`event: ${e.type}\n`);
  });

  test("several frames arriving in one read all come out", async () => {
    const sse = await readAll(
      eventStreamToSse(streamOf([concat(events.map((e) => bedrockChunk(e)))])),
    );
    expect(sse.split("event: ").length - 1).toBe(events.length);
  });

  test("a corrupt frame mid-stream errors the stream", async () => {
    const good = bedrockChunk(events[0]!);
    const bad = bedrockChunk(events[1]!);
    bad[bad.length - 3] = bad[bad.length - 3]! ^ 0xff;
    await expect(readAll(eventStreamToSse(streamOf([good, bad])))).rejects.toThrow(
      /checksum mismatch/,
    );
  });
});
