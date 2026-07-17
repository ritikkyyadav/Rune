/**
 * ChatGPT Codex subscription login + transport.
 *   • codexOAuthFlow — fixed-loopback authorize URL, token exchange, id_token →
 *     accountId, refresh.
 *   • toResponsesInput / toResponsesBody — Berne request → Responses API shape.
 *   • parseResponsesStream — Responses SSE → Berne StreamEvents.
 * All pure or network-mocked; no real ChatGPT calls.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  codexOAuthFlow,
  decodeJwtPayload,
  accountIdFromIdToken,
} from "../../../packages/llm-gateway/src/oauth/codex";
import {
  toResponsesInput,
  toResponsesBody,
  parseResponsesStream,
  codexErrorMessage,
} from "../../../packages/llm-gateway/src/providers/codex";
import type {
  InferenceRequest,
  Message,
  StreamEvent,
} from "../../../packages/llm-gateway/src/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Build a fake unsigned JWT with the given payload. */
function makeIdToken(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

/** A ByteStream (structural) that emits the given SSE chunks then closes. */
function sseStream(chunks: string[]) {
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i < chunks.length)
            return { value: new TextEncoder().encode(chunks[i++]), done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("codex id_token parsing", () => {
  it("decodes a JWT payload", () => {
    const tok = makeIdToken({ hello: "world" });
    expect(decodeJwtPayload(tok)).toEqual({ hello: "world" });
  });

  it("extracts the ChatGPT account id from the OpenAI auth claim", () => {
    const tok = makeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
    expect(accountIdFromIdToken(tok)).toBe("acct_123");
  });

  it("returns undefined for a token without the account claim", () => {
    expect(accountIdFromIdToken(makeIdToken({ sub: "u" }))).toBeUndefined();
    expect(accountIdFromIdToken(undefined)).toBeUndefined();
  });
});

describe("codexOAuthFlow", () => {
  it("uses a fixed loopback (:1455/auth/callback) and Codex authorize params", () => {
    expect(codexOAuthFlow.redirect).toBe("loopback");
    expect(codexOAuthFlow.loopbackPort).toBe(1455);
    expect(codexOAuthFlow.loopbackPath).toBe("/auth/callback");
    expect(codexOAuthFlow.credentialKind).toBe("bearer");

    const u = new URL(
      codexOAuthFlow.authorizeUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        codeChallenge: "CHAL",
        state: "STATE",
      }),
    );
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(u.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  });

  it("exchanges a code for a bearer and captures the account id from the id_token", async () => {
    const idToken = makeIdToken({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" },
    });
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          id_token: idToken,
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await codexOAuthFlow.exchange({
      code: "c",
      codeVerifier: "v",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    expect(result).toMatchObject({ secret: "at", refreshToken: "rt", expiresInSec: 3600 });
    expect(result.meta).toEqual({ accountId: "acct_9" });
    expect(sent).toMatchObject({ grant_type: "authorization_code", code: "c", code_verifier: "v" });
  });

  it("throws with the HTTP status on a failed exchange", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as typeof fetch;
    await expect(
      codexOAuthFlow.exchange({ code: "c", codeVerifier: "v", redirectUri: "x" }),
    ).rejects.toThrow(/OpenAI token endpoint failed \(400\)/);
  });
});

describe("toResponsesInput / toResponsesBody", () => {
  const convo: Message[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        {
          type: "tool_use",
          toolCallId: "call_1",
          toolName: "read_file",
          toolInput: { path: "a.txt" },
        },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "call_1", toolResultContent: "contents" }],
    },
  ];

  it("maps messages to Responses input items (message / function_call / output)", () => {
    const items = toResponsesInput(convo) as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
    expect(items[1]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "let me check" }],
    });
    expect(items[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: JSON.stringify({ path: "a.txt" }),
    });
    expect(items[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "contents",
    });
  });

  it("replays a codex reasoning item before its call, and drops another provider's opaque block", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "redacted_thinking",
            data: JSON.stringify({
              type: "reasoning",
              id: "rs_1",
              summary: [],
              encrypted_content: "enc",
            }),
            provider: "codex",
          },
          // A block from a DIFFERENT provider must never be replayed to Codex.
          { type: "redacted_thinking", data: "anthropic-only-blob", provider: "anthropic" },
          { type: "tool_use", toolCallId: "call_1", toolName: "read", toolInput: {} },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call_1", toolResultContent: "ok" }],
      },
    ];
    const items = toResponsesInput(messages) as Array<Record<string, unknown>>;
    // reasoning item replayed (verbatim) immediately before its function_call
    expect(items[1]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc",
    });
    expect(items[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
    expect(items[3]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    // the foreign (anthropic) block is dropped entirely
    expect(JSON.stringify(items)).not.toContain("anthropic-only-blob");
  });

  it("puts the system prompt in instructions and sets reasoning for a codex model", () => {
    const req: InferenceRequest = {
      messages: convo,
      system: "You are Berne.",
      model: "gpt-5.6-sol", // current ChatGPT-account Codex default
      provider: "codex",
      maxTokens: 1000,
      tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
    };
    const body = toResponsesBody(req, true, "sess-1");
    expect(body.instructions).toBe("You are Berne.");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false); // matches Codex
    expect(body.prompt_cache_key).toBe("sess-1");
    // reasoning carries summary ONLY — the backend 400s on a top-level effort.
    expect(body.reasoning).toEqual({ summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect((body.tools as unknown[]).length).toBe(1);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      name: "read_file",
    });
  });

  it("omits reasoning when the model isn't a reasoning model", () => {
    const body = toResponsesBody(
      { messages: [], model: "some-plain-model", provider: "codex", maxTokens: 10 },
      false,
    );
    expect(body.reasoning).toBeUndefined();
  });
});

describe("codexErrorMessage", () => {
  const fakeRes = (status: number, body: string) => ({
    status,
    text: async () => body,
  });

  it("unwraps {detail} onto a single line (survives first-line truncation)", async () => {
    // Pretty-printed detail like the backend returns.
    const body =
      '{\n  "detail": "The \'gpt-5\' model is not supported when using Codex with a ChatGPT account."\n}';
    const msg = await codexErrorMessage(fakeRes(400, body));
    expect(msg).toBe(
      "Codex request failed (400): The 'gpt-5' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(msg).not.toContain("\n");
  });

  it("unwraps an {error:{message}} body too", async () => {
    const msg = await codexErrorMessage(fakeRes(429, '{"error":{"message":"rate limited"}}'));
    expect(msg).toBe("Codex request failed (429): rate limited");
  });

  it("falls back to the raw body when it isn't JSON", async () => {
    const msg = await codexErrorMessage(fakeRes(502, "upstream boom"));
    expect(msg).toBe("Codex request failed (502): upstream boom");
  });
});

describe("parseResponsesStream", () => {
  it("translates a text + tool-call + completion stream into Berne events", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: " world" })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        item: { id: "item_1", type: "function_call", call_id: "call_1", name: "read_file" },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"path":',
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '"a.txt"}',
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "item_1",
          type: "function_call",
          call_id: "call_1",
          arguments: '{"path":"a.txt"}',
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { usage: { input_tokens: 10, output_tokens: 5 } },
      })}\n\n`,
    ];
    const evs = await collect(parseResponsesStream(sseStream(events)));
    const types = evs.map((e) => e.type);

    expect(types).toEqual([
      "message_start",
      "content_start",
      "content_delta",
      "content_delta",
      "content_stop", // flushed before the tool call starts
      "tool_use_start",
      "tool_use_delta",
      "tool_use_delta",
      "tool_use_stop",
      "message_stop",
    ]);
    const start = evs.find((e) => e.type === "message_start");
    expect(start).toMatchObject({ messageId: "resp_1" });
    const stop = evs.find((e) => e.type === "tool_use_stop");
    expect(stop).toMatchObject({ toolCallId: "call_1", toolInput: { path: "a.txt" } });
    const done = evs.find((e) => e.type === "message_stop");
    // CRITICAL: a response with a tool call must stop as "tool_use", or the agent
    // loop treats the turn as finished and never runs the tool ("done after one
    // step"). Not the hardcoded "end_turn".
    expect(done).toMatchObject({
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it("stops a plain (no-tool) completion as end_turn", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`,
    ];
    const evs = await collect(parseResponsesStream(sseStream(events)));
    expect(evs.find((e) => e.type === "message_stop")).toMatchObject({ stopReason: "end_turn" });
  });

  it("stops a truncated response as max_tokens", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: {},
        },
      })}\n\n`,
    ];
    const evs = await collect(parseResponsesStream(sseStream(events)));
    expect(evs.find((e) => e.type === "message_stop")).toMatchObject({ stopReason: "max_tokens" });
  });

  it("round-trips a reasoning item as a codex-tagged redacted_thinking block", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "hmm" }],
          encrypted_content: "enc",
        },
      })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`,
    ];
    const evs = await collect(parseResponsesStream(sseStream(events)));
    const rt = evs.find((e) => e.type === "redacted_thinking") as
      | { data: string; provider?: string }
      | undefined;
    expect(rt?.provider).toBe("codex"); // tagged so only Codex replays it
    expect(JSON.parse(rt!.data)).toMatchObject({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc",
    });
  });

  it("emits reasoning as thinking_delta and never as answer text", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "thinking..." })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`,
    ];
    const evs = await collect(parseResponsesStream(sseStream(events)));
    expect(evs.find((e) => e.type === "thinking_delta")).toMatchObject({ text: "thinking..." });
    const textDelta = evs.find((e) => e.type === "content_delta");
    expect(textDelta).toMatchObject({ delta: { text: "answer" } });
  });

  it("throws an ApiError when the stream reports a failure", async () => {
    const events = [
      `data: ${JSON.stringify({
        type: "response.failed",
        response: { error: { message: "quota exceeded" } },
      })}\n\n`,
    ];
    await expect(collect(parseResponsesStream(sseStream(events)))).rejects.toThrow(
      /quota exceeded/,
    );
  });
});
