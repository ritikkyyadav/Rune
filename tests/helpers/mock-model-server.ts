/**
 * A scripted OpenAI-compatible model, on a loopback port, for process-level tests.
 *
 * Every fake model in this repository before this one lived INSIDE the test
 * process: `tests/eval/mock-provider.ts` is injected by reaching into a private
 * gateway field, and `tests/helpers/usage-provider.ts` is registered over a
 * provider slot on an Engine the test constructed itself. Neither can drive a
 * `rune` that a test SPAWNED, which is the only way to ask what survives a
 * SIGKILL — the question `docs/program/phase-2-lifecycle.md` §2.8 records
 * nothing in the repository asks.
 *
 * The seam that does cross a process boundary is the `custom` provider: base
 * URL, model and key all come from `secrets.json` on disk
 * (`packages/shared/src/providers.ts:323`, wired at
 * `packages/orchestrator/src/bin/rune-cli.ts:1084`), and `OpenAIProvider` takes
 * any key and any base URL with `maxRetries: 0`. Six existing tests already
 * point a child at a `Bun.serve` this way — `acp-conformance`, `engine-serve`,
 * `rune-action`, `fresh-home-onboarding` among them — but each writes its own
 * three-line SSE script inline, so none can fail a request, none can say which
 * role a request came from, and none can kill the child at a chosen boundary.
 *
 * This is that server, once, with those levers:
 *
 *   * scripted BY ROLE and by index within the role, with a clamped tail, so a
 *     harness-injected call (a nudge, an intent read, a retro) shifts nothing;
 *   * every request body recorded, because §7's rule is to assert on what the
 *     child SENT, never on how many requests it made;
 *   * per-request actions: reply, tool calls, an empty final, an HTTP status
 *     (the summarizer 500 of §3.4), a context-length rejection (§3.5), a
 *     latency knob, and a `kill` hook that SIGKILLs the child at the moment a
 *     request arrives and never answers it (§3.6);
 *   * `GET /v1/models`, which a child asks for at startup.
 *
 * What it is NOT: a provider. It fakes one wire format well enough to drive
 * Rune's own OpenAI adapter and nothing else. It will drift from that adapter —
 * §7 says so — which is why it is one file with one owner and why its tests
 * assert on request bodies rather than on its own bookkeeping.
 */

import type { Subprocess } from "bun";

// ─── What the server can be told to do ───

/** Provider-reported usage. `prompt` is what drives compaction — see below. */
export interface MockUsage {
  /**
   * `prompt_tokens`, verbatim.
   *
   * This is the cheap deterministic compaction lever. `ContextEngine`
   * replaces its own estimate with the provider's count
   * (`context-engine.ts:406-421`) and `shouldCompact(0.7)` compares that
   * against the model's context limit (`:1151-1159`), so a request answered
   * with a large `prompt_tokens` makes the next turn boundary compact —
   * without sending a single byte of the ~300 KB of transcript it would
   * otherwise take.
   */
  prompt: number;
  completion: number;
  /** Cached portion of `prompt`. The adapter SUBTRACTS it (`openai.ts:60-70`). */
  cached?: number;
}

export interface MockToolCall {
  /**
   * Tool-call id. Defaults to one that is unique across the whole run.
   *
   * Not cosmetic. `isSafeCut` refuses any compaction cut that would put a
   * `tool_use` in the folded head and its `tool_result` in the verbatim tail
   * (`context-engine.ts:1373-1399`). A server that reuses one id for every
   * call makes EVERY cut look like that split, `findSafeCutPoint` walks down
   * to 0, and `compactWorkingSet` returns "compacted: false" silently — so a
   * scenario built on such a server can never observe compaction and has no
   * error to explain why. Measured, at the cost of an afternoon.
   */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export type MockAction =
  /** Plain assistant text, finish_reason `stop`. */
  | { kind: "text"; text: string; usage?: MockUsage; delayMs?: number }
  /** One or more tool calls, finish_reason `tool_calls`, with optional lead-in text. */
  | { kind: "tools"; calls: MockToolCall[]; text?: string; usage?: MockUsage; delayMs?: number }
  /** A completion with no content at all — the "empty final" case of §5.5. */
  | { kind: "empty"; usage?: MockUsage; delayMs?: number }
  /** An HTTP failure. `status: 500` on a `stream:false` request is §3.4's summarizer failure. */
  | { kind: "status"; status: number; message?: string; delayMs?: number }
  /** A context-length rejection, in the shape OpenAI-compatible hosts send (§3.5). */
  | { kind: "context_length"; limit?: number; message?: string; delayMs?: number }
  /**
   * Kill the child the moment this request arrives, and never answer it.
   *
   * The ordering guarantee §5.3 needs: the request is recorded BEFORE the
   * signal, so "the kill landed after the child asked for its next step and
   * before it got one" is a fact, not a sleep.
   */
  | { kind: "kill"; signal?: NodeJS.Signals; delayMs?: number }
  /** Hold the request open for `ms`, then answer with `then` (default: an empty reply). */
  | { kind: "hang"; ms: number; then?: MockAction };

/**
 * Which of the child's model calls a request is.
 *
 * `lead` and `child` are both streamed; the delegated child is identified by a
 * marker the harness plants in the `worker`/`task` prompt, which is the only
 * thing that reliably crosses the boundary — `InferenceRequest.role` is an
 * internal field and is never serialised onto the wire (`openai.ts:169-205`,
 * `:203-240`).
 *
 * `summarizer` and `utility` are the non-streamed `infer()` calls: compaction
 * (`context-engine.ts:958`), the sub-agent report synthesiser
 * (`subagent-result.ts:461`), the intent read (`engine.ts:2184`), memory
 * distillation (`engine.ts:3974`) and the Auto reviewer (`auto-mode.ts:513`).
 */
export type MockRole = "lead" | "child" | "summarizer" | "utility";

export interface MockScript {
  lead: MockAction[];
  child?: MockAction[];
  summarizer?: MockAction[];
  utility?: MockAction[];
}

export interface MockChatMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

/** One request as it arrived, plus what the server decided to do about it. */
export interface RecordedRequest {
  /** 1-based across every request the server saw. */
  index: number;
  /** 1-based within `role`. This is what the script indexes. */
  roleIndex: number;
  role: MockRole;
  /** `stream: true` in the body — the agent loop; false/absent — an `infer()`. */
  stream: boolean;
  model: string;
  /** The system prompt, flattened to text. */
  system: string;
  messages: MockChatMessage[];
  /** Names of the tools offered on this request, in order. */
  toolNames: string[];
  /** Every message flattened to one searchable string, system included. */
  text: string;
  /** The raw body, for an assertion this helper did not anticipate. */
  raw: string;
  /** `action.kind`, or `"unscripted"` when the tail clamped. */
  action: MockAction["kind"];
  usage: MockUsage;
  at: number;
}

export interface MockServerOptions {
  script: MockScript;
  /**
   * A substring that appears in a delegated child's prompt and nowhere else.
   *
   * Put it in the `worker`/`task` tool's `prompt` argument: the child's first
   * user message is that prompt verbatim, so every request in the child's own
   * loop carries it and no request in the lead's does.
   */
  childMarker?: string;
  /** The model id the child was configured with. Echoed back on every frame. */
  model?: string;
  /** Answer `GET /v1/models` with this window. See the caveat on `MODELS_CAVEAT`. */
  contextLength?: number;
  /** Added to every response, before the action's own `delayMs`. */
  latencyMs?: number;
  /** Default usage for an action that names none. */
  defaultUsage?: MockUsage;
  /** Called with every request as it is recorded, before the response is built. */
  onRequest?: (req: RecordedRequest) => void;
}

/**
 * `listModels()` drops the window, so `GET /v1/models` cannot shrink a child's
 * context.
 *
 * §3.5 of the phase plan proposes answering `/v1/models` with a small
 * `context_length` to simulate an overlarge fixed prompt across a process
 * boundary. It does not work against today's adapter: `OpenAIProvider.listModels`
 * maps each entry to `{id, label, live}` and keeps no window
 * (`packages/llm-gateway/src/providers/openai.ts:409-412`), it has no
 * `describeModel`, and `Engine.warmContextLimits` only calls either when the
 * static table already returned its unknown-model fallback
 * (`packages/orchestrator/src/engine.ts:6000-6021`). The endpoint is still
 * served — a child asks for it — and the field is still sent, so this becomes
 * true for free the day the adapter reads it.
 */
export const MODELS_CAVEAT =
  "GET /v1/models carries context_length, but OpenAIProvider.listModels() drops it " +
  "(openai.ts:409-412), so it does not change the child's window today.";

const DEFAULT_USAGE: MockUsage = { prompt: 1200, completion: 40 };

// ─── SSE framing ───

function frame(model: string, delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "cmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/**
 * The trailing usage chunk `stream_options.include_usage` asks for: an empty
 * `choices` array and the counts. The adapter takes usage from wherever it
 * appears (`openai.ts:342-348`) but emits `message_stop` only at stream end,
 * so this must come after the finish frame and before `[DONE]`.
 */
function usageFrame(model: string, usage: MockUsage): string {
  return `data: ${JSON.stringify({
    id: "cmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
      ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}),
    },
  })}\n\n`;
}

function sseBody(model: string, action: MockAction, usage: MockUsage, idPrefix: string): string {
  const head = frame(model, { role: "assistant" }, null);
  if (action.kind === "text") {
    return (
      head +
      frame(model, { content: action.text }, null) +
      frame(model, {}, "stop") +
      usageFrame(model, usage) +
      "data: [DONE]\n\n"
    );
  }
  if (action.kind === "tools") {
    let body = head;
    if (action.text) body += frame(model, { content: action.text }, null);
    action.calls.forEach((call, i) => {
      // Two frames per call, exactly as a real host streams them: the id and
      // name first, the arguments as a later delta. A server that sent both at
      // once would never exercise the adapter's argument accumulator.
      body += frame(
        model,
        {
          tool_calls: [
            {
              index: i,
              id: call.id ?? `${idPrefix}_${i + 1}`,
              type: "function",
              function: { name: call.name, arguments: "" },
            },
          ],
        },
        null,
      );
      body += frame(
        model,
        { tool_calls: [{ index: i, function: { arguments: JSON.stringify(call.args) } }] },
        null,
      );
    });
    return body + frame(model, {}, "tool_calls") + usageFrame(model, usage) + "data: [DONE]\n\n";
  }
  // empty: a completion that says nothing and calls nothing.
  return head + frame(model, {}, "stop") + usageFrame(model, usage) + "data: [DONE]\n\n";
}

function jsonBody(model: string, action: MockAction, usage: MockUsage, idPrefix: string): unknown {
  const message: Record<string, unknown> = { role: "assistant", content: null };
  let finish = "stop";
  if (action.kind === "text") message.content = action.text;
  else if (action.kind === "tools") {
    message.content = action.text ?? null;
    message.tool_calls = action.calls.map((call, i) => ({
      id: call.id ?? `${idPrefix}_${i + 1}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    finish = "tool_calls";
  } else message.content = "";
  return {
    id: "cmpl-mock",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
      ...(usage.cached ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}),
    },
  };
}

// ─── Body inspection ───

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flatten).join(" ");
  if (content && typeof content === "object") {
    const part = content as Record<string, unknown>;
    if (typeof part.text === "string") return part.text;
    return JSON.stringify(part);
  }
  return "";
}

/**
 * Is this non-streamed call the compaction summarizer?
 *
 * `generateSummary` sends exactly one user message whose text ends with the
 * transcript under a `Conversation:` / `New conversation segment:` heading
 * (`context-engine.ts:948-967`). The other `infer()` callers — intent, memory,
 * the sub-agent report, the Auto reviewer — do not use those headings, so this
 * separates the one call §3.4 wants to fail from the four it must not.
 */
function looksLikeSummarizer(text: string): boolean {
  return text.includes("New conversation segment:") || text.includes("\n\nConversation:\n");
}

// ─── The server ───

export class MockModelServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private child: Subprocess | { kill: (signal?: NodeJS.Signals) => void } | null = null;
  private stopped = false;
  private releaseHeld: (() => void) | null = null;
  private held: Promise<void>;
  private waiters: Array<{
    pred: (r: RecordedRequest) => boolean;
    resolve: (r: RecordedRequest) => void;
  }> = [];
  private counts: Record<MockRole, number> = { lead: 0, child: 0, summarizer: 0, utility: 0 };

  /** Every request, in arrival order. The evidence §7 says to assert on. */
  readonly requests: RecordedRequest[] = [];
  /** Set once `kill` has fired, so a test can prove the kill was the server's. */
  killedAt: RecordedRequest | null = null;

  constructor(private readonly opts: MockServerOptions) {
    this.held = new Promise<void>((resolve) => {
      this.releaseHeld = resolve;
    });
  }

  get port(): number {
    const port = this.server?.port;
    if (port === undefined) throw new Error("mock model server is not listening");
    return port;
  }

  /** What `secrets.json` must carry for a child to talk to this server. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get model(): string {
    return this.opts.model ?? "fake-model";
  }

  /**
   * The process a `kill` action kills.
   *
   * Set after spawning. Anything with `kill(signal)` works, which keeps this
   * file independent of whether the harness spawned with `Bun.spawn` or
   * `node:child_process`.
   */
  attach(child: Subprocess | { kill: (signal?: NodeJS.Signals) => void } | null): void {
    this.child = child;
  }

  start(): this {
    this.server = Bun.serve({
      port: 0,
      // A held request (`kill`, `hang`) must not be cut off by Bun's default
      // 10s idle timeout: the kill case deliberately never answers.
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.releaseHeld?.();
    this.server?.stop(true);
    this.server = null;
  }

  /** Requests matching `pred`, oldest first. */
  matching(pred: (r: RecordedRequest) => boolean): RecordedRequest[] {
    return this.requests.filter(pred);
  }

  countOf(role: MockRole): number {
    return this.counts[role];
  }

  /**
   * Point a role's script at a chosen entry for its next request.
   *
   * A restarted process talks to the SAME server, so the recovery half of a
   * scenario would otherwise depend on exactly how many requests the killed
   * half happened to make — and a run makes more than its script says: a
   * refused duplicate tool call, a nudge, or an over-limit retry each consume
   * an entry. Rebasing at the restart makes the recovery script independent of
   * all of that, which is the same reason §7 says to assert on sets.
   */
  scriptFrom(role: MockRole, index: number): void {
    this.counts[role] = Math.max(0, index - 1);
  }

  /** Summed usage the server REPORTED, for comparison with the `cost` rows. */
  usageTotals(pred: (r: RecordedRequest) => boolean = () => true): {
    prompt: number;
    completion: number;
    cached: number;
    requests: number;
  } {
    let prompt = 0;
    let completion = 0;
    let cached = 0;
    let requests = 0;
    for (const r of this.requests) {
      // A killed or failed request was never answered, so it was never billed.
      if (r.action === "kill" || r.action === "status" || r.action === "context_length") continue;
      if (!pred(r)) continue;
      prompt += r.usage.prompt;
      completion += r.usage.completion;
      cached += r.usage.cached ?? 0;
      requests += 1;
    }
    return { prompt, completion, cached, requests };
  }

  /**
   * Resolve when a request matching `pred` arrives — checking the ones already
   * seen first, so a caller that awaits after the fact is never wedged.
   *
   * macOS has no `timeout(1)` and `bun test`'s per-test deadline reports only
   * "timed out", so the deadline is enforced here and says what it was waiting
   * for.
   */
  waitFor(
    pred: (r: RecordedRequest) => boolean,
    opts: { timeoutMs?: number; label?: string } = {},
  ): Promise<RecordedRequest> {
    const existing = this.requests.find(pred);
    if (existing) return Promise.resolve(existing);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise<RecordedRequest>((resolve, reject) => {
      const entry = {
        pred,
        resolve: (r: RecordedRequest) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(
          new Error(
            `mock server waited ${timeoutMs}ms for ${opts.label ?? "a matching request"}; ` +
              `saw ${this.requests.length}: ` +
              this.requests.map((r) => `${r.index}:${r.role}/${r.action}`).join(", "),
          ),
        );
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  /** The nth request of a role (1-based). */
  waitForRole(role: MockRole, roleIndex: number, timeoutMs = 60_000): Promise<RecordedRequest> {
    return this.waitFor((r) => r.role === role && r.roleIndex === roleIndex, {
      timeoutMs,
      label: `${role} request #${roleIndex}`,
    });
  }

  // ── request handling ──

  private classify(body: Record<string, unknown>, text: string): MockRole {
    const streaming = body.stream === true;
    if (!streaming) return looksLikeSummarizer(text) ? "summarizer" : "utility";
    const marker = this.opts.childMarker;
    if (marker && text.includes(marker)) return "child";
    return "lead";
  }

  private pick(role: MockRole, roleIndex: number): MockAction | null {
    const list =
      role === "lead"
        ? this.opts.script.lead
        : role === "child"
          ? this.opts.script.child
          : role === "summarizer"
            ? this.opts.script.summarizer
            : this.opts.script.utility;
    if (!list || list.length === 0) return null;
    // Clamped tail (`acp-conformance.test.ts:120`): past the end of the script
    // the last entry repeats, so an extra harness-generated call never
    // desynchronises the ones that matter.
    return list[Math.min(roleIndex - 1, list.length - 1)] ?? null;
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [
          {
            id: this.model,
            object: "model",
            owned_by: "mock",
            ...(this.opts.contextLength ? { context_length: this.opts.contextLength } : {}),
          },
        ],
      });
    }
    if (!path.endsWith("/chat/completions")) return new Response("not found", { status: 404 });

    const raw = await req.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* recorded as an empty body; the assertions read `raw` */
    }
    const messages = Array.isArray(body.messages) ? (body.messages as MockChatMessage[]) : [];
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => flatten(m.content))
      .join("\n");
    const text = [system, ...messages.map((m) => flatten(m.content))].join("\n");
    const role = this.classify(body, text);
    const roleIndex = ++this.counts[role];
    const action = this.pick(role, roleIndex);
    const usage = action && "usage" in action && action.usage ? action.usage : this.fallbackUsage();

    const record: RecordedRequest = {
      index: this.requests.length + 1,
      roleIndex,
      role,
      stream: body.stream === true,
      model: typeof body.model === "string" ? body.model : "",
      system,
      messages,
      toolNames: Array.isArray(body.tools)
        ? (body.tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name ?? "")
        : [],
      text,
      raw,
      action: action?.kind ?? "text",
      usage,
      at: Date.now(),
    };
    this.requests.push(record);
    this.opts.onRequest?.(record);
    for (const waiter of this.waiters.filter((w) => w.pred(record))) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.resolve(record);
    }

    return this.respond(record, action, usage);
  }

  private fallbackUsage(): MockUsage {
    return this.opts.defaultUsage ?? DEFAULT_USAGE;
  }

  private async respond(
    record: RecordedRequest,
    action: MockAction | null,
    usage: MockUsage,
  ): Promise<Response> {
    if (this.opts.latencyMs) await this.sleep(this.opts.latencyMs);
    if (action && "delayMs" in action && action.delayMs) await this.sleep(action.delayMs);

    const chosen: MockAction = action ?? {
      kind: "text",
      // Unscripted tail on a role with no script: end the turn rather than
      // leave the child looping against a server with nothing to say.
      text: `[mock] no script for ${record.role} #${record.roleIndex}; ending the turn.`,
    };

    if (chosen.kind === "kill") {
      this.killedAt = record;
      this.child?.kill(chosen.signal ?? "SIGKILL");
      // Never answer. The child is being killed while this request is in
      // flight, which is precisely the tool-boundary crash of §5.3.
      await this.held;
      return new Response("server stopping", { status: 503 });
    }
    if (chosen.kind === "hang") {
      await Promise.race([this.sleep(chosen.ms), this.held]);
      if (this.stopped) return new Response("server stopping", { status: 503 });
      return this.respond(record, chosen.then ?? { kind: "empty" }, usage);
    }
    if (chosen.kind === "status") {
      return Response.json(
        { error: { message: chosen.message ?? `mock failure ${chosen.status}`, type: "mock" } },
        { status: chosen.status },
      );
    }
    if (chosen.kind === "context_length") {
      // The shape OpenAI-compatible hosts reject an overlong prompt with. 400
      // is deliberate: a retryable status would exercise the retry ladder
      // instead of the context path.
      return Response.json(
        {
          error: {
            message:
              chosen.message ??
              `This model's maximum context length is ${chosen.limit ?? 8000} tokens. ` +
                "However, your messages resulted in more than that. " +
                "Please reduce the length of the messages.",
            type: "invalid_request_error",
            code: "context_length_exceeded",
            param: "messages",
          },
        },
        { status: 400 },
      );
    }

    // Unique per request, so no two tool calls in one conversation share an id.
    const idPrefix = `call_${record.role}_${record.index}`;
    if (record.stream) {
      return new Response(sseBody(this.model, chosen, usage, idPrefix), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(jsonBody(this.model, chosen, usage, idPrefix));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Start a server and hand it back listening. */
export function startMockModelServer(opts: MockServerOptions): MockModelServer {
  return new MockModelServer(opts).start();
}
