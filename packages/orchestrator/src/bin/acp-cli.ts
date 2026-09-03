// ─── gear acp — an Agent Client Protocol server over stdio ───
//
// Zed (and anything else that speaks ACP) drives an agent by spawning it and
// talking JSON-RPC over its stdin and stdout. This is that door.
//
// It is a TRANSLATION, not a second engine. Underneath it is the same
// supervisor `gear serve` is: one `engine-host` process per session, spoken to
// through `HostClient`, routed by the same `routingKey`. Everything specific to
// ACP is the mapping in this file, and there are only three interesting pieces
// of it.
//
// 1. Events → `session/update`. Gear's 22-member turn union does not line up
//    with ACP's update kinds, so members that have no ACP shape are either
//    projected into a thought chunk or deliberately dropped. Dropped is a
//    decision on the record here, not an accident — see `toUpdate`. The full
//    table, with the reason per event, is in docs/editors.md, and
//    tests/unit/orchestrator/acp-mapping.test.ts fails if the two disagree.
//
// 2. Permission → `session/request_permission`. This is the whole reason an
//    editor integration is worth having: the agent stops, the editor shows the
//    prompt, the person answers in the editor. A client that could only stream
//    text would have to run Gear in 4th gear to get anything done.
//
// 3. `ask_user` has no ACP primitive. ACP v1 has no way for an agent to ask a
//    free-text question, so a question WITH options is offered as a permission
//    request whose options are the answers — the person is genuinely choosing,
//    which is what the round-trip is for — and a question with no options is
//    answered immediately with the host's documented "no answer" instruction
//    rather than stalling the editor for ten minutes on a dialog that cannot be
//    shown. Both are announced in the transcript, so the person can see what
//    was asked and what was assumed.
//
// stdout carries protocol frames and nothing else. Every diagnostic goes to
// stderr, because one stray `console.log` desynchronises the client's parser
// and the failure looks like a protocol bug.

import { adoptLegacyEnv, loadConfig, migrateLegacyHome } from "@gear/shared";

import { DEFAULT_IDLE_HOST_SECS, HostPool, noteRequestOwner, routingKey } from "./serve-cli";

/** The ACP major this build speaks. */
export const ACP_PROTOCOL_VERSION = 1;

// ─── Frames ───

interface RpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

// ─── Event → session/update ───

export interface AcpUpdate {
  sessionUpdate: string;
  [k: string]: unknown;
}

const textBlock = (text: string): Json => ({ type: "text", text });

/**
 * Which ACP tool kind a Gear tool is.
 *
 * The kind drives the icon and the grouping an editor shows, so "other" for
 * everything would work and would also make every tool call look the same.
 */
export function toolKind(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === "bash" || n.includes("shell") || n.includes("exec")) return "execute";
  if (n.includes("search") || n.includes("grep") || n.includes("glob")) return "search";
  if (n.startsWith("read") || n.includes("read_file") || n === "ls") return "read";
  // Thinking BEFORE editing, because `todo_write` contains "write" and is not
  // an edit: with the two the other way round an editor drew every plan update
  // as a file modification. P10.6's conformance test is what caught it.
  if (n.includes("think") || n.includes("plan") || n.includes("todo")) return "think";
  if (n.includes("write") || n.includes("edit") || n.includes("patch")) return "edit";
  if (n.includes("delete") || n.includes("rm")) return "delete";
  if (n.includes("fetch") || n.includes("web") || n.includes("browser")) return "fetch";
  return "other";
}

/**
 * One turn event as one ACP update, or null for "deliberately not sent".
 *
 * Null is a decision, not a gap. `usage`, `retry`, `fallback`, `checkpoint_saved`
 * and the rest are harness bookkeeping: an editor that rendered them would show
 * a person a stream of things they cannot act on, and `gear audit` is where
 * that record belongs.
 */
export function toUpdate(event: { type: string } & Record<string, unknown>): AcpUpdate | null {
  switch (event.type) {
    case "text_delta":
      return { sessionUpdate: "agent_message_chunk", content: textBlock(String(event.text)) };
    case "thinking_delta":
      return { sessionUpdate: "agent_thought_chunk", content: textBlock(String(event.text)) };
    case "tool_call_start":
      return {
        sessionUpdate: "tool_call",
        toolCallId: String(event.callId),
        title: String(event.toolName),
        kind: toolKind(String(event.toolName)),
        status: "in_progress",
      };
    case "tool_call_end": {
      const out = (event.output ?? {}) as { success?: boolean; result?: string; error?: string };
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: String(event.callId),
        status: out.success === false ? "failed" : "completed",
        content: [{ type: "content", content: textBlock(String(out.error ?? out.result ?? "")) }],
      };
    }
    case "todo_updated": {
      const items = Array.isArray(event.items) ? event.items : [];
      return {
        sessionUpdate: "plan",
        entries: items.map((raw) => {
          const item = raw as { content?: string; text?: string; status?: string };
          return {
            content: String(item.content ?? item.text ?? ""),
            priority: "medium",
            status:
              item.status === "completed" || item.status === "in_progress"
                ? item.status
                : "pending",
          };
        }),
      };
    }
    case "error":
      return {
        sessionUpdate: "agent_message_chunk",
        content: textBlock(`\n[error] ${String(event.error)}\n`),
      };
    case "notice":
    case "context_warning":
      return { sessionUpdate: "agent_thought_chunk", content: textBlock(String(event.message)) };

    // ── the harness's own progress, as thoughts ──
    //
    // These used to be sent as the event NAME and nothing else: an editor was
    // told "verification completed" without being told whether it passed. A
    // status line that cannot distinguish success from failure is worse than
    // no status line, because it reads as reassurance. Each carries the one
    // fact a person acts on, clipped, and `gear audit` keeps the full record.
    case "verification_started":
      return thought(`verification started (attempt ${String(event.attempt ?? "?")})`);
    case "verification_completed":
      return thought(
        event.ran === false
          ? "verification: nothing runnable detected"
          : `verification: ${event.passed === true ? "passed" : "FAILED"}` + clause(event.report),
      );
    case "step_check":
      return thought(
        event.ran === false
          ? `step check skipped — ${String(event.step ?? "")}`
          : `step check ${event.passed === true ? "passed" : "FAILED"} — ` +
              `${String(event.step ?? "")}${clause(event.report)}`,
      );
    case "replanning":
      return thought(
        `re-planning (${String(event.trigger ?? "?")}) — ${String(event.reason ?? "")}`,
      );
    case "handoff":
      // The state-of-work handoff is the whole content of the event: without it
      // an editor shows "handoff" and the person has no idea what was left.
      return thought(`handoff — ${String(event.reason ?? "")}${clause(event.state)}`);

    // ── The narrative, as thoughts ──
    //
    // A hypothesis and its verdict are the one part of the narrative an editor
    // can use in place: they are the reasoning, in the reasoning stream, while
    // it happens. The reader of an editor's thought panel is watching the work,
    // and "cache eviction — refuted, TTL unchanged" is exactly what they want
    // there. The rest of the model (kinds, artifacts, the record) is state for
    // a surface that can lay it out, and an editor has nowhere to put it.
    case "hypothesis": {
      const h = (event.hypothesis ?? {}) as { text?: string; id?: string };
      return thought(`hypothesis ${String(h.id ?? "")}: ${String(h.text ?? "")}`);
    }
    case "hypothesis_updated":
      return thought(
        `hypothesis ${String(event.id ?? "")} ${String(event.status ?? "")}` +
          clause(typeof event.reason === "string" ? event.reason : undefined),
      );
    case "decision": {
      const d = (event.decision ?? {}) as { text?: string; basedOn?: unknown[] };
      const n = Array.isArray(d.basedOn) ? d.basedOn.length : 0;
      return thought(
        `decision: ${String(d.text ?? "")} (on ${n} piece${n === 1 ? "" : "s"} of evidence)`,
      );
    }

    default:
      // tool_call_args_delta · turn_complete · stream_reset · fallback ·
      // retry · usage · compaction · checkpoint_saved · tool_progress ·
      // task_kind · artifact · pending_decision · decision_resolved ·
      // decision_record. Bookkeeping, a duplicate of something already sent,
      // the signal that ends the prompt rather than an update within it, or
      // task state an editor has no surface for. The reason for each one is in
      // docs/editors.md, and `acp-mapping.test.ts` asserts this list and that
      // table say the same thing.
      return null;
  }
}

/** A thought chunk, which is where every harness-progress event lands. */
function thought(text: string): AcpUpdate {
  return { sessionUpdate: "agent_thought_chunk", content: textBlock(text) };
}

/**
 * A report, appended as one clipped clause, or nothing at all.
 *
 * A verifier report is a whole build log. An editor's thought stream is one
 * line; the full text is in `gear audit`.
 */
function clause(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value.trim().split("\n")[0]?.trim() : "";
  if (!text) return "";
  return `: ${text.length > max ? `${text.slice(0, max - 1)}…` : text}`;
}

/** The permission options an ACP client renders as buttons. */
export function permissionOptions(canGrantSession: boolean): Json[] {
  return [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    ...(canGrantSession
      ? [{ optionId: "allow_session", name: "Allow for this session", kind: "allow_always" }]
      : []),
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
}

// ─── The server ───

class AcpServer {
  private nextOutgoingId = 1;
  private readonly awaitingClient = new Map<number, (result: Json | null) => void>();
  private readonly requestOwners = new Map<string, string>();
  /** Per Gear session: the pending `session/prompt` waiting for turn_complete. */
  private readonly running = new Map<string, (stopReason: string) => void>();
  private readonly pool: HostPool;
  private initialized = false;

  private readonly reaper: ReturnType<typeof setInterval>;

  constructor(private readonly workspace: string) {
    this.pool = new HostPool({
      workspace,
      idleMs:
        Math.max(1, loadConfig(workspace).serve?.idleHostSecs ?? DEFAULT_IDLE_HOST_SECS) * 1000,
      onStream: (key, stream, payload) => this.onEngineStream(key, stream, payload),
    });
    // An editor can hold one `gear acp` open for a week. Sessions it opened and
    // walked away from are stopped on the same window `gear serve` uses; a
    // session with a turn running is never idle.
    this.reaper = setInterval(() => this.pool.reapIdle(), 60_000);
    (this.reaper as unknown as { unref?: () => void }).unref?.();
  }

  // ── writing ──

  private send(frame: Json): void {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  private notify(method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Ask the client something and wait for its answer. */
  private request(method: string, params: Json): Promise<Json | null> {
    const id = this.nextOutgoingId++;
    return new Promise((resolve) => {
      this.awaitingClient.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private update(sessionId: string, update: AcpUpdate): void {
    this.notify("session/update", { sessionId, update });
  }

  // ── the engine → the client ──

  private onEngineStream(key: string, stream: string, payload: unknown): void {
    noteRequestOwner(this.requestOwners, key, stream, payload);
    const p = (payload ?? {}) as Json;
    const sessionId = typeof p.sessionId === "string" && p.sessionId ? p.sessionId : key;

    switch (stream) {
      case "chat_event": {
        const event = (p.event ?? p) as { type: string } & Json;
        if (event.type === "turn_complete") {
          this.finish(sessionId, "end_turn");
          return;
        }
        const update = toUpdate(event);
        if (update) this.update(sessionId, update);
        return;
      }
      case "permission_request":
        void this.askPermission(sessionId, p);
        return;
      case "question_request":
        void this.askQuestion(sessionId, p);
        return;
      case "brief_request":
        void this.acceptBrief(sessionId, p);
        return;
      case "held_steps": {
        const steps = Array.isArray(p.steps) ? p.steps : [];
        if (steps.length === 0) return;
        const lines = steps
          .map((s) => `  · ${(s as { summary?: string }).summary ?? "(step)"}`)
          .join("\n");
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: textBlock(`\n${steps.length} step(s) held, unrun:\n${lines}\n`),
        });
        return;
      }
      case "auto_notice": {
        const notice = (p.notice ?? {}) as { toolName?: string; kind?: string; risk?: string };
        this.update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: textBlock(
            `auto: ${notice.kind ?? "approved"} ${notice.toolName ?? ""} (${notice.risk ?? "?"})`,
          ),
        });
        return;
      }
      case "roundtrip_resolved": {
        const id = p.requestId;
        if (typeof id === "string") this.requestOwners.delete(id);
        this.update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: textBlock(`${String(p.kind)} resolved without an answer: ${String(p.applied)}`),
        });
        return;
      }
      default:
        // ready · engine_status · research_event · research_plan_request.
        // Nothing in ACP v1 carries them.
        return;
    }
  }

  private async askPermission(sessionId: string, p: Json): Promise<void> {
    const prompt = (p.prompt ?? {}) as {
      toolName?: string;
      argsSummary?: string;
      rawArgs?: Json;
      sessionGrantUnavailable?: boolean;
      safety?: { reason?: string; risk?: string };
    };
    const requestId = String(p.requestId ?? "");
    const answer = await this.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: requestId,
        title: `${prompt.toolName ?? "tool"}: ${prompt.argsSummary ?? ""}`,
        kind: toolKind(String(prompt.toolName ?? "")),
        status: "pending",
        rawInput: prompt.rawArgs ?? {},
      },
      options: permissionOptions(prompt.sessionGrantUnavailable !== true),
      ...(prompt.safety ? { _gearSafety: prompt.safety } : {}),
    });

    const decision = decisionFrom(answer);
    await this.call("respond_permission", { requestId, decision }).catch(() => {});
  }

  /**
   * `ask_user`, which ACP has no primitive for.
   *
   * With options, the person chooses one in the permission dialog and the
   * choice IS the answer. Without options there is nothing an ACP client can
   * render, so rather than stalling the editor on a dialog it cannot show, the
   * host's unattended policy is applied at once and the assumption is said out
   * loud in the transcript.
   */
  private async askQuestion(sessionId: string, p: Json): Promise<void> {
    const q = (p.question ?? {}) as { question?: string; options?: string[] };
    const requestId = String(p.requestId ?? "");
    const options = Array.isArray(q.options) ? q.options : [];

    this.update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: textBlock(`\n${q.question ?? ""}\n`),
    });

    if (options.length === 0) {
      this.update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: textBlock("no options to offer in ACP — proceeding on the agent's judgment"),
      });
      await this.call("respond_question", { requestId, answer: "" }).catch(() => {});
      return;
    }

    const answer = await this.request("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: requestId,
        title: String(q.question ?? "The agent is asking"),
        kind: "think",
        status: "pending",
      },
      options: options.map((opt, i) => ({
        optionId: String(i),
        name: opt,
        kind: "allow_once",
      })),
    });

    const outcome = (answer?.outcome ?? {}) as { outcome?: string; optionId?: string };
    const picked = outcome.outcome === "selected" ? options[Number(outcome.optionId)] : undefined;
    await this.call("respond_question", { requestId, answer: picked ?? "" }).catch(() => {});
  }

  /**
   * The read-back, accepted as stated.
   *
   * That is the host's own unattended policy for a brief, so applying it at
   * once costs nothing and saves the editor a ten-minute stall. The reading is
   * shown, so a person who disagrees can say so in the next message — which is
   * what a read-back is for.
   */
  private async acceptBrief(sessionId: string, p: Json): Promise<void> {
    const brief = (p.brief ?? {}) as { reading?: string; criteria?: Array<{ text?: string }> };
    const criteria = (brief.criteria ?? []).map((c) => `  · ${c.text ?? ""}`).join("\n");
    this.update(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: textBlock(`reading: ${brief.reading ?? ""}\n${criteria}`),
    });
    await this.call("respond_brief", {
      requestId: String(p.requestId ?? ""),
      decision: { accepted: true },
    }).catch(() => {});
  }

  private finish(sessionId: string, stopReason: string): void {
    const settle = this.running.get(sessionId);
    if (!settle) return;
    this.running.delete(sessionId);
    settle(stopReason);
  }

  // ── the client → the engine ──

  private async call(method: string, params: Json): Promise<unknown> {
    const key = routingKey(method, params, this.requestOwners);
    // Through the pool, not around it: `request` is what counts the call in
    // flight, and the idle reaper reads that count to tell a parked session
    // from one that has been compiling for twelve minutes.
    return this.pool.request(key, method, params, 15 * 60_000);
  }

  /**
   * Stop every engine this server started.
   *
   * An editor spawns `gear acp` and kills it when the window closes. Before
   * P10.0 the engines it had spawned stayed up forever, one per session, with
   * nothing left that knew they existed.
   */
  async shutdown(): Promise<number> {
    clearInterval(this.reaper);
    return this.pool.shutdownAll();
  }

  async handle(req: RpcRequest): Promise<Json | null> {
    const params = req.params ?? {};
    switch (req.method) {
      case "initialize": {
        this.initialized = true;
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            // No `session/load`: replay exists in the protocol (`subscribe`)
            // but ACP session loading has its own replay contract, and
            // claiming a capability that is only half true is worse than not
            // claiming it.
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          // Gear authenticates providers itself, through `gear login`. There is
          // nothing for the editor to authenticate.
          authMethods: [],
        };
      }

      case "authenticate":
        return {};

      case "session/new": {
        if (!this.initialized) throw rpcError(RPC.invalidRequest, "initialize first");
        const sessionId = (await this.call("create_session", {})) as string;
        return { sessionId };
      }

      case "session/prompt": {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) throw rpcError(RPC.invalidParams, "sessionId is required");
        const message = promptText(params.prompt);
        if (!message) throw rpcError(RPC.invalidParams, "prompt had no text content");

        const done = new Promise<string>((resolve) => this.running.set(sessionId, resolve));
        await this.call("chat_start", { sessionId, message });
        const stopReason = await done;
        return { stopReason };
      }

      case "session/cancel": {
        const sessionId = String(params.sessionId ?? "");
        await this.call("abort_chat", { sessionId }).catch(() => {});
        this.finish(sessionId, "cancelled");
        return null; // a notification: no response
      }

      default:
        throw rpcError(RPC.methodNotFound, `no such method: ${req.method}`);
    }
  }

  /** A response to something WE asked the client. */
  settle(id: number, result: Json | null): void {
    const resolve = this.awaitingClient.get(id);
    if (!resolve) return;
    this.awaitingClient.delete(id);
    resolve(result);
  }

  async run(): Promise<void> {
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += new TextDecoder().decode(chunk);
      let at: number;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) void this.dispatch(line);
      }
    }
  }

  private async dispatch(line: string): Promise<void> {
    let frame: Json;
    try {
      frame = JSON.parse(line) as Json;
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: "not JSON" } });
      return;
    }

    // A response to one of our own requests (permission, and nothing else yet).
    if (typeof frame.id === "number" && frame.method === undefined) {
      this.settle(frame.id, (frame.result ?? null) as Json | null);
      return;
    }
    if (typeof frame.method !== "string") return;

    const req = frame as unknown as RpcRequest;
    const isNotification = req.id === undefined || req.id === null;
    try {
      const result = await this.handle(req);
      if (!isNotification) this.send({ jsonrpc: "2.0", id: req.id, result: result ?? {} });
    } catch (err) {
      if (isNotification) return;
      const e = err as { code?: number; message?: string };
      this.send({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: typeof e.code === "number" ? e.code : RPC.internal,
          message: e.message ?? String(err),
        },
      });
    }
  }
}

// ─── Helpers ───

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/** The text of an ACP prompt, ignoring blocks this build cannot use. */
export function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((raw) => {
      const block = raw as { type?: string; text?: string; resource?: { text?: string } };
      if (block.type === "text") return block.text ?? "";
      // An embedded resource is context the editor pasted in — a file the
      // person @-mentioned. Dropping it would silently lose what they meant.
      if (block.type === "resource") return block.resource?.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * The client's answer, as a permission decision.
 *
 * Anything that is not an explicit selection — a cancelled dialog, a closed
 * editor, a client that answered with something this build does not know — is a
 * DENY. It is the same rule the host applies unattended, and the alternative is
 * reading silence as consent.
 */
export function decisionFrom(answer: Json | null): string {
  const outcome = (answer?.outcome ?? {}) as { outcome?: string; optionId?: string };
  if (outcome.outcome !== "selected") return "deny";
  return outcome.optionId === "allow_once" || outcome.optionId === "allow_session"
    ? outcome.optionId
    : "deny";
}

export async function runAcp(values: Record<string, unknown> = {}): Promise<void> {
  adoptLegacyEnv();
  migrateLegacyHome();
  const workspace =
    typeof values.workspace === "string"
      ? values.workspace
      : (process.env.GEAR_WORKSPACE ?? process.cwd());
  process.stderr.write(`gear acp — ACP ${ACP_PROTOCOL_VERSION}, workspace ${workspace}\n`);
  const server = new AcpServer(workspace);
  // Both ways out: the editor closes our stdin, or it signals us. Either way
  // the session engines this process spawned go with it.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void server.shutdown().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.run();
  } finally {
    await server.shutdown();
  }
}
