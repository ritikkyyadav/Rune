// ─── AWS event-stream (`application/vnd.amazon.eventstream`) ───
//
// Bedrock's `invoke-model-with-response-stream` does not speak SSE. It speaks
// AWS's binary framing, and the payload inside each frame is a base64 blob
// which — for the Anthropic models — decodes to exactly the SSE event JSON the
// Anthropic API would have sent.
//
// That is the whole reason Bedrock can be an ENDPOINT VARIANT rather than a new
// transport: decode the framing, base64-decode the payload, re-emit it as
// `event: <type>\ndata: <json>` and the Anthropic SDK's own stream parser
// handles the rest — every content block, thinking delta, tool-use accumulation
// and usage field, unchanged. A second Anthropic event parser is the thing this
// avoids, and the thing that would drift.
//
// Frame layout:
//
//   ┌────────────────┬──────────────────┬─────────────┐
//   │ total length 4 │ headers length 4 │ prelude CRC │   12-byte prelude
//   ├────────────────┴──────────────────┴─────────────┤
//   │ headers (headers length bytes)                  │
//   │ payload (total - headers - 16 bytes)            │
//   ├─────────────────────────────────────────────────┤
//   │ message CRC 4                                   │
//   └─────────────────────────────────────────────────┘
//
// All integers big-endian. A header is `[u8 name len][name][u8 type][value]`.

/** CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — AWS's frame checksum. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface EventStreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/** A frame whose checksum does not match — corrupt, truncated, or not a frame. */
export class EventStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventStreamError";
  }
}

/**
 * Decode one message starting at `offset`. Returns null when the buffer does
 * not yet hold a complete frame, so the caller can wait for more bytes.
 */
export function decodeMessage(
  buf: Uint8Array,
  offset = 0,
): { message: EventStreamMessage; end: number } | null {
  if (buf.length - offset < 16) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + offset, buf.length - offset);
  const totalLength = view.getUint32(0, false);
  if (totalLength < 16) throw new EventStreamError(`frame length ${totalLength} is impossible`);
  if (buf.length - offset < totalLength) return null;

  const headersLength = view.getUint32(4, false);
  const preludeCrc = view.getUint32(8, false);
  const actualPreludeCrc = crc32(buf.subarray(offset, offset + 8));
  if (preludeCrc !== actualPreludeCrc) {
    throw new EventStreamError("event-stream prelude checksum mismatch");
  }

  const messageCrc = view.getUint32(totalLength - 4, false);
  const actualMessageCrc = crc32(buf.subarray(offset, offset + totalLength - 4));
  if (messageCrc !== actualMessageCrc) {
    throw new EventStreamError("event-stream message checksum mismatch");
  }

  const headers = decodeHeaders(buf.subarray(offset + 12, offset + 12 + headersLength));
  const payload = buf.subarray(offset + 12 + headersLength, offset + totalLength - 4);
  return { message: { headers, payload }, end: offset + totalLength };
}

/**
 * Decode the header block. Every header type in the spec is consumed so the
 * cursor stays correct, but only the string/byte-array ones carry values Rune
 * reads (`:event-type`, `:message-type`, `:exception-type`); the rest are
 * rendered as their scalar text.
 */
function decodeHeaders(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const decoder = new TextDecoder();
  let i = 0;
  while (i < bytes.length) {
    const nameLength = view.getUint8(i);
    i += 1;
    const name = decoder.decode(bytes.subarray(i, i + nameLength));
    i += nameLength;
    const type = view.getUint8(i);
    i += 1;
    switch (type) {
      case 0: // bool true
        out[name] = "true";
        break;
      case 1: // bool false
        out[name] = "false";
        break;
      case 2: // byte
        out[name] = String(view.getInt8(i));
        i += 1;
        break;
      case 3: // short
        out[name] = String(view.getInt16(i, false));
        i += 2;
        break;
      case 4: // integer
        out[name] = String(view.getInt32(i, false));
        i += 4;
        break;
      case 5: // long
        out[name] = String(view.getBigInt64(i, false));
        i += 8;
        break;
      case 6: {
        // byte array
        const len = view.getUint16(i, false);
        i += 2;
        out[name] = decoder.decode(bytes.subarray(i, i + len));
        i += len;
        break;
      }
      case 7: {
        // string
        const len = view.getUint16(i, false);
        i += 2;
        out[name] = decoder.decode(bytes.subarray(i, i + len));
        i += len;
        break;
      }
      case 8: // timestamp (ms since epoch)
        out[name] = new Date(Number(view.getBigInt64(i, false))).toISOString();
        i += 8;
        break;
      case 9: // uuid
        out[name] = Buffer.from(bytes.subarray(i, i + 16)).toString("hex");
        i += 16;
        break;
      default:
        throw new EventStreamError(`unknown event-stream header type ${type}`);
    }
  }
  return out;
}

/**
 * Encode one message. Used by the fixture tests — and only by them: Rune never
 * sends event-stream frames. It lives beside the decoder so a fixture is built
 * from the same field layout the decoder reads, which is what makes a
 * round-trip test meaningful.
 */
export function encodeMessage(message: EventStreamMessage): Uint8Array {
  const encoder = new TextEncoder();
  const headerParts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(message.headers)) {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    const dv = new DataView(part.buffer);
    part[0] = nameBytes.length;
    part.set(nameBytes, 1);
    part[1 + nameBytes.length] = 7; // string
    dv.setUint16(1 + nameBytes.length + 1, valueBytes.length, false);
    part.set(valueBytes, 1 + nameBytes.length + 3);
    headerParts.push(part);
  }
  const headersLength = headerParts.reduce((n, p) => n + p.length, 0);
  const totalLength = 16 + headersLength + message.payload.length;
  const frame = new Uint8Array(totalLength);
  const dv = new DataView(frame.buffer);
  dv.setUint32(0, totalLength, false);
  dv.setUint32(4, headersLength, false);
  dv.setUint32(8, crc32(frame.subarray(0, 8)), false);
  let at = 12;
  for (const part of headerParts) {
    frame.set(part, at);
    at += part.length;
  }
  frame.set(message.payload, at);
  dv.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}

/**
 * The Anthropic event carried by one Bedrock chunk.
 *
 * Bedrock wraps each Anthropic SSE event as `{"bytes": "<base64 of the event
 * JSON>"}`. An `exception` frame carries the error instead, and is surfaced as
 * an `error` event so the Anthropic SDK's stream raises rather than ending the
 * turn silently — a stream that stops without a `message_stop` is the failure
 * shape that looks like a short answer instead of an error.
 */
export function chunkToSse(message: EventStreamMessage): string | null {
  const messageType = message.headers[":message-type"];
  const eventType = message.headers[":event-type"];
  const text = new TextDecoder().decode(message.payload);

  if (messageType === "exception" || messageType === "error") {
    const exceptionType =
      message.headers[":exception-type"] ?? message.headers[":error-code"] ?? "BedrockException";
    const detail = safeMessage(text) ?? text;
    const body = JSON.stringify({
      type: "error",
      error: { type: exceptionType, message: detail },
    });
    return `event: error\ndata: ${body}\n\n`;
  }

  if (eventType !== "chunk") return null;

  let inner: string;
  try {
    const wrapper = JSON.parse(text) as { bytes?: string };
    if (typeof wrapper.bytes !== "string") return null;
    inner = Buffer.from(wrapper.bytes, "base64").toString("utf-8");
  } catch {
    return null;
  }

  let type: string;
  try {
    type = (JSON.parse(inner) as { type?: string }).type ?? "message_delta";
  } catch {
    return null;
  }
  return `event: ${type}\ndata: ${inner}\n\n`;
}

function safeMessage(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { message?: string; Message?: string };
    return json.message ?? json.Message;
  } catch {
    return undefined;
  }
}

/**
 * Transform a Bedrock event-stream body into an SSE body.
 *
 * Buffers across chunk boundaries: a frame can and does span TCP reads, and a
 * decoder that assumed otherwise would work on short answers and corrupt long
 * ones — the bug that only shows up in production.
 */
export function eventStreamToSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let buffer = new Uint8Array(0);
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        // Drain every complete frame already buffered before reading more.
        let progressed = false;
        for (;;) {
          let decoded: { message: EventStreamMessage; end: number } | null;
          try {
            decoded = decodeMessage(buffer, 0);
          } catch (err) {
            controller.error(err);
            return;
          }
          if (!decoded) break;
          buffer = buffer.slice(decoded.end);
          const sse = chunkToSse(decoded.message);
          if (sse) {
            controller.enqueue(encoder.encode(sse));
            progressed = true;
          }
        }
        if (progressed) return;

        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value && value.length) {
          const next = new Uint8Array(buffer.length + value.length);
          next.set(buffer, 0);
          next.set(value, buffer.length);
          buffer = next;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
