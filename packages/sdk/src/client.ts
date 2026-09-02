// ─── GearClient: the typed way to drive a session over `gear serve` ───
//
// `HostClient` (packages/orchestrator/src/host-client.ts) is the same idea over
// a unix socket, and it lives inside the orchestrator because that is what
// `gear attach` needs. This one runs anywhere a WebSocket does — Node, Bun, a
// browser, a VS Code extension — and depends on nothing but `@gear/protocol`.
//
// The design constraint that shapes it: an agent stops for a human. A client
// that can only send prompts and read text cannot drive Gear, because the
// interesting half of a real turn is the four round-trips it opens. So the
// round-trips are first-class here — you register a handler and the client
// answers for you — rather than something you assemble from raw frames.

import type {
  AgentTurnEvent,
  Brief,
  BriefDecision,
  HostCommandArgs,
  HostCommandName,
  HostCommandResult,
  PermissionPrompt,
  ResearchEvent,
  ResearchPlan,
  UserPermissionDecision,
  UserQuestion,
} from "@gear/protocol";
import {
  PROTOCOL_VERSION,
  encodeFrame,
  isCompatibleVersion,
  rpcRequest,
  toResult,
  toStream,
} from "@gear/protocol";

export interface GearClientOptions {
  /** e.g. `ws://127.0.0.1:4762`. */
  url: string;
  /** The bearer token from `~/.gear/serve.json`. Required. */
  token: string;
  /** Default per-request timeout. A turn can take minutes; this is per CALL. */
  timeoutMs?: number;
  /** Injected in Node < 22, where `WebSocket` is not global. */
  WebSocketImpl?: typeof WebSocket;
}

/** Everything a client can be told about, without reading raw frames. */
export interface GearHandlers {
  /** Turn events. The same 22-member union every Gear surface reads. */
  onEvent?: (event: AgentTurnEvent, sessionId?: string) => void;
  /** Research events, when a research run is in flight. */
  onResearchEvent?: (event: ResearchEvent, runId: string) => void;
  /** Engine status pushes (model, provider, context, cost, posture). */
  onStatus?: (status: Record<string, unknown>) => void;
  /**
   * A tool wants permission.
   *
   * Return a decision and the client answers for you. Leave it unset and the
   * host applies its unattended policy — which for a permission is `deny`,
   * because the alternative is granting whatever a model asked for to a
   * program that was not watching.
   */
  onPermission?: (prompt: PermissionPrompt) => Promise<UserPermissionDecision>;
  /** The agent is asking the person a question (`ask_user`). */
  onQuestion?: (question: UserQuestion) => Promise<string>;
  /** The agent is reading its understanding back before it starts work. */
  onBrief?: (brief: Brief) => Promise<BriefDecision>;
  /** A research plan is waiting for approval before anything is spent on it. */
  onResearchPlan?: (plan: ResearchPlan) => Promise<{ approved: boolean; note?: string }>;
  /** Auto mode's end-of-turn ledger of outward steps it declined to take. */
  onHeldSteps?: (steps: unknown[], sessionId?: string) => void;
  /** A round-trip resolved without you — timed out, or every client left. */
  onRoundTripResolved?: (info: {
    requestId: string;
    kind: string;
    reason: string;
    applied: string;
  }) => void;
  /** The socket closed. */
  onClose?: (info: { code: number; reason: string }) => void;
}

export class GearClient {
  private ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly handlers: GearHandlers;
  private readonly timeoutMs: number;
  private closed = false;

  private constructor(ws: WebSocket, handlers: GearHandlers, timeoutMs: number) {
    this.ws = ws;
    this.handlers = handlers;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Connect and complete the handshake.
   *
   * The token goes on the `gear.bearer.<token>` subprotocol because that is the
   * only header a browser's `WebSocket` constructor lets you set — the same
   * client then works from a page and from a shell.
   */
  static async connect(opts: GearClientOptions, handlers: GearHandlers = {}): Promise<GearClient> {
    const Impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Impl) {
      throw new Error(
        "no WebSocket implementation — pass WebSocketImpl (Node 18/20 need `ws` or undici)",
      );
    }
    const ws = new Impl(opts.url, [`gear.bearer.${opts.token}`]);
    const client = new GearClient(ws, handlers, opts.timeoutMs ?? 15 * 60_000);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer from ${opts.url}`)), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        // The server answers 401 before the upgrade, which a browser reports
        // only as a failed connection — so say the likely cause out loud.
        reject(new Error(`could not open ${opts.url} — check the token and the Origin allowlist`));
      };
    });

    ws.onmessage = (ev: MessageEvent) => client.onData(String(ev.data));
    ws.onclose = (ev: CloseEvent) => {
      client.closed = true;
      for (const p of client.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("connection closed"));
      }
      client.pending.clear();
      handlers.onClose?.({ code: ev.code, reason: ev.reason });
    };

    const hello = await client.call("hello", { protocolVersion: PROTOCOL_VERSION, client: "sdk" });
    if (!isCompatibleVersion(hello.protocolVersion)) {
      client.close();
      throw new Error(
        `protocol mismatch: this client speaks ${PROTOCOL_VERSION}, the server speaks ${hello.protocolVersion}`,
      );
    }
    return client;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Every command, typed against the protocol's command map. */
  call<K extends HostCommandName>(
    method: K,
    params: HostCommandArgs<K> = {} as HostCommandArgs<K>,
    timeoutMs = this.timeoutMs,
  ): Promise<HostCommandResult<K>> {
    if (this.closed) return Promise.reject(new Error("connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to "${method}" in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(encodeFrame(rpcRequest(id, method, params)));
    });
  }

  // ─── Conveniences ───

  createSession(model?: string): Promise<string> {
    return this.call("create_session", model ? { model } : {});
  }

  /**
   * Start a turn and resolve when it completes.
   *
   * `chat_start` acks immediately with the session id — the turn itself
   * arrives as events — so waiting for `turn_complete` is what a caller
   * usually means by "run this".
   */
  async run(sessionId: string, message: string): Promise<{ sessionId: string }> {
    const done = this.once((event) => event.type === "turn_complete");
    const ack = await this.call("chat_start", { sessionId, message });
    await done;
    return ack;
  }

  /** Resolve on the first turn event matching a predicate. */
  once(match: (event: AgentTurnEvent) => boolean): Promise<AgentTurnEvent> {
    return new Promise((resolve) => {
      this.oneShots.push({ match, resolve });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  // ─── Frames ───

  private readonly oneShots: Array<{
    match: (event: AgentTurnEvent) => boolean;
    resolve: (event: AgentTurnEvent) => void;
  }> = [];

  private onData(data: string): void {
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // a torn frame: nothing sane to do with it
      }

      const stream = toStream(frame);
      if (stream) {
        this.onStream(stream.stream, stream.payload as Record<string, unknown>);
        continue;
      }

      const result = toResult(frame);
      if (result && typeof result.id === "number") {
        const p = this.pending.get(result.id);
        if (!p) continue;
        this.pending.delete(result.id);
        clearTimeout(p.timer);
        if (result.ok) p.resolve(result.result);
        else p.reject(new Error(result.error.message));
      }
    }
  }

  private onStream(name: string, payload: Record<string, unknown>): void {
    switch (name) {
      case "chat_event": {
        // Both shapes: the socket transport tags events with a session, and
        // the stdio sidecar sends the bare event.
        const event = (payload.event ?? payload) as AgentTurnEvent;
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
        this.handlers.onEvent?.(event, sessionId);
        for (let i = this.oneShots.length - 1; i >= 0; i--) {
          const shot = this.oneShots[i]!;
          if (!shot.match(event)) continue;
          this.oneShots.splice(i, 1);
          shot.resolve(event);
        }
        return;
      }
      case "research_event":
        this.handlers.onResearchEvent?.(
          payload.event as ResearchEvent,
          String(payload.runId ?? ""),
        );
        return;
      case "ready":
      case "engine_status":
        this.handlers.onStatus?.(payload);
        return;
      case "permission_request":
        void this.answer("respond_permission", payload.requestId, async () => {
          const decision = await this.handlers.onPermission?.(payload.prompt as PermissionPrompt);
          return decision ? { decision: decision.kind } : null;
        });
        return;
      case "question_request":
        void this.answer("respond_question", payload.requestId, async () => {
          const answer = await this.handlers.onQuestion?.(payload.question as UserQuestion);
          return answer === undefined ? null : { answer };
        });
        return;
      case "brief_request":
        void this.answer("respond_brief", payload.requestId, async () => {
          const decision = await this.handlers.onBrief?.(payload.brief as Brief);
          return decision ? { decision } : null;
        });
        return;
      case "research_plan_request":
        void this.answer("respond_research_plan", payload.requestId, async () => {
          const decision = await this.handlers.onResearchPlan?.(payload.plan as ResearchPlan);
          return decision ?? null;
        });
        return;
      case "held_steps":
        this.handlers.onHeldSteps?.(
          Array.isArray(payload.steps) ? payload.steps : [],
          typeof payload.sessionId === "string" ? payload.sessionId : undefined,
        );
        return;
      case "roundtrip_resolved":
        this.handlers.onRoundTripResolved?.({
          requestId: String(payload.requestId ?? ""),
          kind: String(payload.kind ?? ""),
          reason: String(payload.reason ?? ""),
          applied: String(payload.applied ?? ""),
        });
        return;
      default:
        // A stream this client does not know is a NEWER server, not a bug.
        // Ignoring it is the additive-minor contract, not laziness.
        return;
    }
  }

  /**
   * Run a handler and send its answer, or send nothing at all.
   *
   * Sending nothing is a real choice, not a failure path: with no handler
   * registered, the host applies its stated unattended policy after the
   * timeout — which is the right outcome for a program that genuinely has no
   * human behind it, and a much better one than a client inventing an answer.
   */
  private async answer(
    method: "respond_permission" | "respond_question" | "respond_brief" | "respond_research_plan",
    requestId: unknown,
    produce: () => Promise<Record<string, unknown> | null>,
  ): Promise<void> {
    if (typeof requestId !== "string") return;
    let body: Record<string, unknown> | null;
    try {
      body = await produce();
    } catch {
      // A handler that throws must not be read as an approval.
      return;
    }
    if (!body) return;
    try {
      await this.call(method as HostCommandName, { requestId, ...body } as never);
    } catch {
      // The request may have been overtaken by its own timeout. The host tells
      // us so through `roundtrip_resolved`; nothing to repair here.
    }
  }
}
