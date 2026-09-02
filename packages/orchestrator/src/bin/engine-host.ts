#!/usr/bin/env bun
// ──────────────────────────────────────────────────────────────────────────
//  Gear — Engine Host (desktop sidecar)
//
//  A headless bridge that runs the SAME orchestrator Engine the CLI runs and
//  exposes it over line-delimited JSON on stdio. The Tauri desktop app spawns
//  this process and pumps its stdin/stdout, so the GUI gets the exact same
//  models, providers, BYOK keys, web search (Brave/Tavily), MCP servers and
//  skills as `gear` on the terminal — for free,
//  because it is literally the same engine reading the same key files.
//
//  Protocol (one JSON object per line, UTF-8):
//    in  (request) : {"id": <n>, "cmd": "<name>", "args": {...}}
//    out (response): {"id": <n>, "ok": true, "result": <any>}
//                    {"id": <n>, "ok": false, "error": "<message>"}
//    out (stream)  : {"stream": "<name>", "payload": <any>}
//        streams: "ready" | "chat_event" | "engine_status" | "permission_request"
//
//  IMPORTANT: stdout carries ONLY protocol JSON. All stray logging from the
//  engine/gateway/tools is redirected to stderr below so it can never corrupt
//  the frame stream.
// ──────────────────────────────────────────────────────────────────────────

import * as readline from "node:readline";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

import { Engine } from "../engine";
import type { AgentTurnEvent, HostCommandName, RpcError } from "@gear/protocol";
import {
  HOST_COMMANDS,
  PROTOCOL_VERSION,
  ProtocolError,
  RPC_ERROR,
  assertNever,
  decodeFrame,
  optionalBoolean,
  optionalCount,
  optionalString,
  optionalStringArray,
  requireBriefDecision,
  requireCommand,
  requirePermissionDecision,
  requireString,
  rpcFailure,
  streamNotification,
  toRequest,
  toResponse,
} from "@gear/protocol";
import { RoundTripRegistry } from "./host-roundtrips";
import { HeldStepLedger } from "./host-held-steps";
import type { ResearchEvent, ResearchOptions } from "../research-types";
import { isClarification } from "../research-types";
import type { ProviderName } from "@gear/llm-gateway";
import {
  hasStoredCredential,
  getPreset,
  adoptLegacyEnv,
  ensureGearHome,
  migrateLegacyHome,
  loadConfig,
  loadSecrets,
  providerKeyEntries,
  applySearchKeysToEnv,
  setProviderKey as persistProviderKey,
  clearProviderKey as persistClearKey,
  searchKeyStatus,
  PROVIDER_PRESETS,
  AUTO_PROVIDER_PRIORITY,
  normalizeFallbackOrder,
  normalizeQuotaPolicy,
  normalizeSubagentEffort,
  normalizeSubagentMode,
  loadLastModel,
  saveLastModel,
  loadSavedSandboxState,
  resolveInitialSandbox,
  setConfigValue,
} from "@gear/shared";
import {
  configModeToPermissionMode,
  resolveStartupPermissionFlags,
  permissionModeToConfig,
} from "../permissions";
import type { PermissionMode } from "../permissions";

// ─── stdout discipline ───
// Grab the real writer FIRST, then route every console.* to stderr so nothing
// the engine prints can break the JSON framing on stdout.
const rawWrite = process.stdout.write.bind(process.stdout);
const logErr = (...args: unknown[]) =>
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ") + "\n");
function inspect(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
console.log = logErr as typeof console.log;
console.info = logErr as typeof console.info;
console.debug = logErr as typeof console.debug;
console.warn = logErr as typeof console.warn;
// console.error already goes to stderr — leave it.

// ─── Transport seam ───
// Default (stdio): frames go to stdout — the desktop sidecar contract, byte-
// identical to before. `--socket <path>`: the SAME frames serve over a unix
// domain socket instead; responses go to the requesting client, stream events
// broadcast to every connected client, and — the point of the mode — the
// engine keeps running when the last client disconnects. Reattaching clients
// recover missed turns from the session store (resume/replay), so nothing is
// lost while nobody is watching.

const socketArgIdx = process.argv.indexOf("--socket");
const SOCKET_PATH = socketArgIdx !== -1 ? process.argv[socketArgIdx + 1] : null;

type SocketLike = { write(data: string): unknown };
const connectedClients = new Set<SocketLike>();

/**
 * Extra sinks a wrapper transport registers to receive every stream frame.
 *
 * `gear serve` (P2.4) wraps this host rather than reimplementing it: it adds
 * itself here and fans frames out to its websocket clients, so the websocket,
 * the unix socket and stdio are provably the same stream and not three
 * hand-kept copies of one.
 */
const streamSinks = new Set<(stream: string, payload: unknown) => void>();

export function addStreamSink(sink: (stream: string, payload: unknown) => void): () => void {
  streamSinks.add(sink);
  return () => streamSinks.delete(sink);
}

function send(obj: unknown): void {
  rawWrite(JSON.stringify(obj) + "\n");
}

function emitStream(stream: string, payload: unknown): void {
  for (const sink of streamSinks) {
    try {
      sink(stream, payload);
    } catch {
      // A wrapper transport that throws must never break the primary one.
    }
  }
  if (SOCKET_PATH) {
    // Sockets get the JSON-RPC notification envelope; `toStream` in the
    // protocol reads both, so an old attach client is unaffected.
    const frame = JSON.stringify(streamNotification(stream, payload)) + "\n";
    for (const client of connectedClients) {
      try {
        client.write(frame);
      } catch {
        connectedClients.delete(client);
      }
    }
    return;
  }
  // stdio keeps the legacy `{stream,payload}` shape byte-for-byte: the
  // desktop sidecar contract is a shipped binary's contract.
  send({ stream, payload });
}

// ─── Engine construction (mirrors gear-cli.ts main()) ───
// Same provider/model resolution, same key sources, so the desktop behaves
// identically to the terminal.

type CliProvider = "anthropic" | "openai" | "openrouter" | "google" | "ollama-turbo";
const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  // qwen/qwen3-coder:free and qwen3-coder:480b were retired 2026-07-15, and
  // deepseek-v4-flash:free was withdrawn from the free tier 2026-08-26;
  // these mirror the gateway's refreshed, live-verified defaults.
  openrouter: "minimax/minimax-m3:free",
  google: "gemini-2.5-flash",
  "ollama-turbo": "gpt-oss:120b",
};
const PROVIDER_ENV: Record<CliProvider, string> = {
  google: "GOOGLE_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "ollama-turbo": "OLLAMA_API_KEY",
};

function isCliProvider(p: string): p is CliProvider {
  return p in PROVIDER_ENV;
}

function ensureDataDir(): string {
  return ensureGearHome();
}

function buildEngine(): Engine {
  adoptLegacyEnv();
  migrateLegacyHome();
  ensureDataDir();
  const workspaceRoot =
    process.env.GEAR_WORKSPACE || process.env.GEAR_WORKSPACE || process.env.HOME || process.cwd();
  const config = loadConfig(workspaceRoot);
  const secrets = loadSecrets();

  const hasCreds = (p: CliProvider): boolean =>
    !!process.env[PROVIDER_ENV[p]] ||
    !!(p !== "ollama-turbo" && (config.llm[p] as { apiKey?: string } | undefined)?.apiKey) ||
    !!secrets.keys[p];

  // Detect the best provider from available credentials. Paid-capacity direct
  // providers outrank quota-constrained free/developer endpoints; an explicit
  // config or sticky model still wins before this fallback is consulted.
  function detectProvider(): CliProvider {
    for (const p of AUTO_PROVIDER_PRIORITY) {
      if (hasCreds(p)) return p;
    }
    return "openrouter";
  }

  // The model you last used IS the model you get. Same fix as gear-cli's: the
  // gate used to be a five-id hand-written list plus a credential check that
  // only understood env vars and API keys, so a subscription provider (codex,
  // failed both halves and the session opened on an auto-detected
  // provider instead of the one that was chosen.
  const lastUsed = loadLastModel();
  const stickyUsable = (p: string): boolean =>
    getPreset(p) !== undefined &&
    (p === "ollama" || hasStoredCredential(p) || (isCliProvider(p) && hasCreds(p)));
  const sticky = lastUsed && stickyUsable(lastUsed.provider) ? lastUsed : null;

  let provider: ProviderName;
  let model: string;
  if (sticky) {
    provider = sticky.provider as ProviderName;
    model = sticky.model;
  } else {
    const configProvider = config.llm.defaultProvider;
    if (configProvider && isCliProvider(configProvider) && hasCreds(configProvider))
      provider = configProvider;
    else provider = detectProvider();
    const cfgModel = (
      config.llm[provider as keyof typeof config.llm] as { model?: string } | undefined
    )?.model;
    model = cfgModel ?? DEFAULT_MODELS[provider];
  }

  // Make [search].provider visible to the env-based web_search backend selector,
  // and copy saved Tavily/Brave keys into the env so /research + web_search use them.
  if (
    config.search?.provider &&
    config.search.provider !== "auto" &&
    !process.env.GEAR_SEARCH_BACKEND &&
    !process.env.GEAR_SEARCH_BACKEND
  ) {
    process.env.GEAR_SEARCH_BACKEND = config.search.provider;
  }
  applySearchKeysToEnv();

  const permissionFlags = resolveStartupPermissionFlags({
    configGear: config.permissions?.gear,
    configMode: config.permissions?.mode,
    configTrustWorkspace: config.permissions?.trustWorkspace,
  });

  const engine = new Engine({
    model,
    provider: provider as ProviderName,
    workspaceRoot,
    dbPath: config.engine.dbPath,
    toolsBinaryPath: process.env.GEAR_TOOLS_BIN || process.env.GEAR_TOOLS_BIN || "gear-tools",
    yoloMode: permissionFlags.yoloMode,
    trustWorkspace: permissionFlags.trustWorkspace,
    permissionMode: permissionFlags.permissionMode,
    reasoningEffort: config.llm?.reasoningEffort,
    doctrineDelivery: config.llm?.doctrineDelivery,
    effortRouting: config.llm?.effortRouting,
    autoMode: config.permissions?.autoMode,
    // Same posture resolution as the CLI, minus CLI flags (desktop has none).
    sandboxEnabled: resolveInitialSandbox({
      env: process.env.GEAR_SANDBOX_ENABLED ?? null,
      saved: loadSavedSandboxState(),
      configured: config.sandbox?.enabled ?? null,
    }),
    // Config-file keys count as "saved" unless they merely echo an env var.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? undefined : config.llm.anthropic?.apiKey,
    openaiApiKey: process.env.OPENAI_API_KEY ? undefined : config.llm.openai?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ? undefined : config.llm.openrouter?.apiKey,
    googleApiKey: process.env.GOOGLE_API_KEY ? undefined : config.llm.google?.apiKey,
    // BYOK keys + custom endpoint + toggles from ~/.gear/secrets.json (win over config.toml).
    providerKeys: secrets.keys,
    providerKeyEntries: Object.fromEntries(
      PROVIDER_PRESETS.map((p) => [p.id, providerKeyEntries(secrets, p.id)]).filter(
        ([, e]) => (e as unknown[]).length,
      ),
    ),
    activeKeyId: secrets.activeKeyId,
    customEndpoint: secrets.custom,
    // Base URLs for local runtimes. The CLI has honoured these since /keys
    // could edit them; the host never read them, so an Ollama or LM Studio
    // server on a non-default port worked in the terminal and failed in the
    // desktop with nothing to explain the difference.
    localBaseUrls: secrets.endpoints,
    disabledProviders: secrets.disabled,
    search: config.search,
    research: config.research,
    tiers: config.tiers,
    subagents: {
      mode: normalizeSubagentMode(config.subagents?.mode),
      model: config.subagents?.model,
      effort: normalizeSubagentEffort(config.subagents?.effort),
    },
    // Same mid-task fallback policy as the CLI. Unknown ids are dropped here
    // silently — this host has no console to warn into; the CLI reports them.
    fallbackOrder: normalizeFallbackOrder(config.fallback?.order).order as ProviderName[],
    quotaPolicy: normalizeQuotaPolicy(config.fallback?.onQuotaExceeded),
    git: config.git,
    context: config.context,
    interactive: config.interactive,
    team: config.team,
    // Black box: same local incident capture as the CLI (config can disable).
    blackbox:
      config.diagnostics?.enabled !== false
        ? { enabled: true, version: "0.1.0-desktop" }
        : undefined,
    notebook: { enabled: config.notebook?.enabled !== false },
  });
  return engine;
}

// ─── Status mapping (engine → frontend EngineStatus shape) ───

function mappedStatus(engine: Engine, sessionId?: string) {
  const s = engine.getStatus(sessionId);
  return {
    state: "connected" as const,
    model: s.model,
    provider: s.provider,
    contextUsed: s.contextUsage.used,
    contextMax: s.contextUsage.limit,
    totalCost: s.cost,
    workspace: s.workspace,
    permissionMode: s.permissionMode,
    securityPosture: s.securityPosture,
    autoMode: s.autoMode,
  };
}

// ─── Main ───

const engine = buildEngine();

// Map the frontend's locally-invented session ids → real engine session ids,
// so a chat against an unknown id transparently spins up a real session.
const sessionMap = new Map<string, string>();
function resolveSession(frontendId: string | undefined): string {
  const fe = frontendId || "default";
  const mapped = sessionMap.get(fe);
  if (mapped) return mapped;
  // If the id is already a real engine session (e.g. picked from the list), use it.
  const known = engine.listSessions().some((x: { id: string }) => x.id === fe);
  const engId = known ? fe : engine.createSession();
  sessionMap.set(fe, engId);
  return engId;
}

// ─── The five round-trips (P2.2) ───
//
// Every human-in-the-loop path, not just permission. Before this the host
// wired one of five, so `ask_user` answered "No interactive user is available"
// for every desktop and detached run, the read-back could not be corrected off
// the terminal, and Auto mode's held steps were invisible — the work simply
// did not happen, with nothing on screen to say so.
//
// The registry owns timeouts, disconnect handling and the unattended policy;
// see host-roundtrips.ts for why each substitution is the one it is.

const roundTrips = new RoundTripRegistry({
  emit: emitStream,
  // stdio has exactly one client — the parent process — and it is attached for
  // as long as this host is alive. Only socket mode can lose its last client.
  clientCount: () => (SOCKET_PATH ? connectedClients.size : 1),
});

const heldSteps = new HeldStepLedger();

engine.setPermissionHandler((prompt) => roundTrips.permission(prompt, currentSessionId()));
engine.setQuestionHandler((question) => roundTrips.question(question, currentSessionId()));
engine.setBriefHandler((brief) => roundTrips.brief(brief, currentSessionId()));
engine.setAutoApprovalNotifier((notice) =>
  emitStream("auto_notice", { sessionId: currentSessionId(), notice }),
);
engine.setAutoDeferralNotifier((deferrals) => {
  const sid = currentSessionId();
  if (!sid) return;
  emitStream("held_steps", { sessionId: sid, steps: heldSteps.record(sid, deferrals) });
});

// ─── Runs (P2.3, in-host half) ───
//
// `activeChat` was one module-level boolean, so the host could not name which
// session was busy, could not abort a specific one, and reported "a turn is
// already in progress" without saying whose. It is a map now.
//
// This host still runs ONE session at a time, because `Engine` holds a single
// `currentAbort`/`liveLoop` and refactoring it for in-process multiplexing was
// explicitly declined. True concurrency is `gear serve`'s job: one host process
// per session, which is the supervisor half of P2.3. What changes here is that
// the host is HONEST about it — a chat_start for a second session is refused
// naming the one that holds the engine, instead of a bare "already in progress".

interface RunHandle {
  sessionId: string;
  startedAt: number;
  /** Live frames, newest last. Bounded — see RING_CAPACITY. */
  ring: AgentTurnEvent[];
}

/** Enough to cover a reconnect mid-tool-call without unbounded retention. */
const RING_CAPACITY = 200;

const runs = new Map<string, RunHandle>();
/** Frames from finished turns, kept per session so a late client still sees them. */
const rings = new Map<string, AgentTurnEvent[]>();

function currentSessionId(): string | undefined {
  for (const sid of runs.keys()) return sid;
  return undefined;
}

function pushRing(sessionId: string, event: AgentTurnEvent): void {
  const ring = rings.get(sessionId) ?? [];
  ring.push(event);
  // `text_delta` would fill the buffer with keystrokes and evict the tool call
  // a reconnecting client actually needs to see. It is not kept, for the same
  // reason it is not persisted: it is not state.
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  rings.set(sessionId, ring);
}

async function runChat(
  reply: (outcome: { ok: true; result: unknown } | { ok: false; error: RpcError }) => void,
  frontendSessionId: string | undefined,
  message: string,
): Promise<void> {
  const sid = resolveSession(frontendSessionId);
  // Ack immediately with the resolved session id — a detaching client needs
  // it to reattach later. The turn streams via chat_event and ends with
  // turn_complete; in socket mode events are tagged with the session so
  // attach clients can filter (the stdio/desktop shape is unchanged).
  reply({ ok: true, result: { sessionId: sid } });
  const handle: RunHandle = { sessionId: sid, startedAt: Date.now(), ring: [] };
  runs.set(sid, handle);
  let sawTurnComplete = false;
  const emitChat = (event: AgentTurnEvent): void => {
    if (event.type !== "text_delta") pushRing(sid, event);
    emitStream("chat_event", SOCKET_PATH ? { sessionId: sid, event } : event);
  };
  try {
    for await (const event of engine.chat(sid, message)) {
      if (event.type === "turn_complete") sawTurnComplete = true;
      emitChat(event);
    }
  } catch (err) {
    emitChat({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  } finally {
    runs.delete(sid);
    // Guarantee the UI never hangs in "processing".
    if (!sawTurnComplete) {
      emitChat({ type: "turn_complete", stopReason: "end", totalTurns: 1 });
    }
    emitStream("engine_status", mappedStatus(engine, sid));
  }
}

/**
 * Drive one research run over the protocol (P2.7).
 *
 * Plan approval is a round-trip, exactly like the brief: the plan is proposed,
 * pushed to every client, and the run waits for an answer. Unattended it
 * declines — a research run costs real money in provider calls and web
 * fetches, and "nobody answered" is not consent to spend it.
 */
async function runResearchOverProtocol(
  sessionId: string,
  runId: string,
  question: string,
  depth: string | undefined,
  autoApprove: boolean,
): Promise<void> {
  const emit = (event: ResearchEvent): void =>
    emitStream("research_event", { sessionId, runId, event });
  try {
    const proposed = await engine.proposeResearch(sessionId, question, {
      depth: depth as ResearchOptions["depth"],
    });
    if (isClarification(proposed)) {
      // The planner could not plan it. That is information, not a failure.
      emit({
        type: "notice",
        message: `needs clarification: ${proposed.questions.join(" / ")}`,
      });
      return;
    }
    emit({ type: "research_plan", plan: proposed });
    if (!autoApprove) {
      const decision = await roundTrips.researchPlan(proposed, sessionId);
      if (!decision.approved) {
        emit({ type: "notice", message: "research plan was not approved — nothing was run" });
        return;
      }
    }
    for await (const event of engine.runResearch(sessionId, proposed, {
      depth: depth as ResearchOptions["depth"],
    })) {
      emit(event);
    }
  } catch (err) {
    emit({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  }
}

async function dispatch(cmd: HostCommandName, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "hello":
      // The handshake. A peer on a different protocol MAJOR is told so here,
      // rather than being left to fail on a field it does not understand three
      // frames later.
      return {
        protocolVersion: PROTOCOL_VERSION,
        server: "gear-engine-host",
        commands: [...HOST_COMMANDS],
      };

    case "get_status":
      return mappedStatus(engine, args.sessionId as string | undefined);

    case "create_session":
      return engine.createSession(args.model as string | undefined);

    case "list_sessions":
      return engine.listSessions().map((session) => {
        const s = session as unknown as Record<string, unknown>;
        return {
          id: String(s.id ?? ""),
          title: String(s.title ?? s.firstMessage ?? "Session"),
          model: String(s.model ?? engine.getModel()),
          workspace: String(s.workspaceRoot ?? s.workspace ?? ""),
          eventCount: Number(s.eventCount ?? s.turnCount ?? 0),
          createdAt: String(s.createdAt ?? s.created_at ?? new Date().toISOString()),
          updatedAt: String(s.updatedAt ?? s.updated_at ?? new Date().toISOString()),
        };
      });

    case "resume_session": {
      // v1: return the user turns as message history. Selecting a real session id
      // keeps continuity (chat_start against it continues the same engine session).
      const sid = args.sessionId as string;
      try {
        const turns = engine.listUserTurns(sid);
        return turns.map((t) => ({
          id: `turn-${t.seq}`,
          role: "user" as const,
          content: t.text,
          timestamp: new Date().toISOString(),
        }));
      } catch {
        return [];
      }
    }

    case "delete_session":
      // No hard delete in the engine yet; the UI drops it from its own list.
      return null;

    case "switch_model": {
      const model = args.model as string;
      const provider = args.provider as ProviderName | undefined;
      engine.switchModel(model, provider);
      if (provider && isCliProvider(provider)) {
        try {
          saveLastModel({ provider, model });
        } catch {
          /* best-effort persistence */
        }
      }
      const st = mappedStatus(engine);
      emitStream("engine_status", st);
      return st;
    }

    case "subscribe": {
      // P2.5. Settled history from the store, then the host's live ring for
      // anything newer than the last row — so a client reconnecting mid-turn
      // sees the tool call running right now, not just the last write.
      const sid = resolveSession(optionalString(args, "sessionId"));
      const sinceSeq = optionalCount(args, "sinceSeq") ?? 0;
      const { frames, userTurns, lastSeq } = engine.replaySession(sid, sinceSeq);
      return {
        sessionId: sid,
        seq: lastSeq,
        backfill: frames,
        userTurns,
        live: rings.get(sid) ?? [],
        settled: true as const,
        running: runs.has(sid),
      };
    }

    case "abort_chat": {
      // Named, not global. `Engine` still holds one abort controller, so this
      // aborts the run in flight — but a client that asked about a session
      // that is NOT running is told so instead of being quietly told "done".
      const asked = optionalString(args, "sessionId");
      const running = currentSessionId();
      if (asked && running && sessionMap.get(asked) !== running && asked !== running) {
        return { aborted: false };
      }
      if (!running) return { aborted: false };
      engine.abort();
      return { aborted: true };
    }

    case "interject_chat": {
      // Mid-turn steering: fold a user message into the run in flight.
      // Returns whether a live run accepted it — on false the frontend
      // should hold the message and send it as the next turn instead.
      const asked = optionalString(args, "sessionId");
      const running = currentSessionId();
      if (asked && running && sessionMap.get(asked) !== running && asked !== running) {
        return { accepted: false };
      }
      return { accepted: engine.interject(requireString(args, "text")) };
    }

    // ─── The five round-trips, answered ───

    case "respond_permission": {
      const requestId = requireString(args, "requestId");
      const decision = requirePermissionDecision(args);
      // `answer` returns false for a request that already timed out or was
      // settled by policy. Reporting that is the point: a client whose card
      // was overtaken must learn it, not think its click landed.
      return roundTrips.answer(requestId, { kind: decision }) ? null : { stale: true };
    }

    case "respond_question": {
      const requestId = requireString(args, "requestId");
      const answer = requireString(args, "answer");
      return roundTrips.answer(requestId, answer) ? null : { stale: true };
    }

    case "respond_brief": {
      const requestId = requireString(args, "requestId");
      const decision = requireBriefDecision(args);
      return roundTrips.answer(requestId, decision) ? null : { stale: true };
    }

    case "list_held_steps":
      return heldSteps.list(resolveSession(optionalString(args, "sessionId")));

    case "run_held_step": {
      // The client names an id; the HOST supplies the arguments it already
      // holds. A client never sends the payload of a declined call back —
      // that is what keeps "run exactly this" exact and keeps raw, unredacted
      // arguments off the wire.
      const sid = resolveSession(optionalString(args, "sessionId"));
      const stepId = requireString(args, "stepId");
      const step = heldSteps.get(sid, stepId);
      if (!step) {
        return { ran: false, refusal: `no held step ${stepId} in this session` };
      }
      const result = await engine.runHeldStep(sid, step);
      // Only forget it once it actually ran. A refusal (org policy, a deny
      // rule, a hook veto, a live run) leaves it in the ledger to try again.
      if (result.ran) heldSteps.remove(sid, stepId);
      return result;
    }

    case "dismiss_held_steps": {
      const sid = resolveSession(optionalString(args, "sessionId"));
      const taken = heldSteps.take(sid, optionalStringArray(args, "stepIds"));
      engine.dismissHeldSteps(taken);
      return { dismissed: taken.length };
    }

    case "list_providers": {
      const rows = engine.getProviderStatus().map((r) => ({
        ...r,
        models: PROVIDER_PRESETS.find((p) => p.id === r.id)?.models ?? [],
      }));
      return {
        providers: rows,
        search: searchKeyStatus(),
        active: { provider: engine.getProvider(), model: engine.getModel() },
      };
    }

    case "save_settings": {
      const apiKeys = (args.apiKeys as Record<string, string>) ?? {};
      let touchedSearch = false;
      for (const [pid, value] of Object.entries(apiKeys)) {
        if (typeof value !== "string") continue;
        const key = value.trim();
        if (key) {
          persistProviderKey(pid, key); // → ~/.gear/secrets.json (0600)
          engine.setProviderKey(pid, key); // live, rebuilds the gateway
        } else {
          // Empty string = clear that key.
          persistClearKey(pid);
          engine.setProviderKey(pid, null);
        }
        if (pid === "brave" || pid === "tavily") touchedSearch = true;
      }
      if (touchedSearch) applySearchKeysToEnv();

      const permissionLevel = args.permissionLevel as string | undefined;
      if (permissionLevel) {
        // Desktop vocabulary: "auto_allow" was workspace trust (3rd gear), "ask"
        // is 1st gear; anything else is a gear spelling. The change applies to
        // THIS engine only — a desktop toggle must not silently rewrite the
        // CLI's global config.toml (pass `persist: true` to opt in).
        const mode: PermissionMode | undefined =
          permissionLevel === "auto_allow"
            ? "gear-3"
            : permissionLevel === "ask"
              ? "gear-1"
              : configModeToPermissionMode(permissionLevel);
        if (mode) {
          const changed = engine.setPermissionMode(mode);
          if (!changed.ok) throw new Error(changed.reason ?? `gear ${mode} is unavailable`);
          if (args.persist === true) {
            setConfigValue("permissions.gear", permissionModeToConfig(mode), {
              scope: "global",
            });
          }
        }
      }

      const provider = args.provider as ProviderName | undefined;
      const model = args.model as string | undefined;
      if (model) {
        engine.switchModel(model, provider);
        if (provider && isCliProvider(provider)) {
          try {
            saveLastModel({ provider, model });
          } catch {
            /* best-effort */
          }
        }
      }
      const st = mappedStatus(engine);
      emitStream("engine_status", st);
      return st;
    }

    // ─── Research over the protocol (P2.7) ───

    case "research_start": {
      // Research was reachable only from the terminal. It streams its own
      // 9-member union, so it gets its own stream rather than being flattened
      // into chat_event — a client that renders a report differently from a
      // turn needs to tell them apart.
      const sid = resolveSession(optionalString(args, "sessionId"));
      const question = requireString(args, "question");
      const depth = optionalString(args, "depth");
      const autoApprove = optionalBoolean(args, "autoApprove") ?? false;
      const runId = `research-${Date.now().toString(36)}`;
      void runResearchOverProtocol(sid, runId, question, depth, autoApprove);
      return { runId };
    }

    case "respond_research_plan": {
      const requestId = requireString(args, "requestId");
      const approved = optionalBoolean(args, "approved") ?? false;
      const note = optionalString(args, "note");
      return roundTrips.answer(requestId, { approved, note }) ? null : { stale: true };
    }

    // ─── System Memory ("dreaming") ───
    case "get_system_memory":
      return engine.getSystemMemory();

    case "save_system_memory": {
      const content = String(args.content ?? "");
      const res = engine.setSystemMemoryContent(content);
      return { ...res, memory: engine.getSystemMemory() };
    }

    case "add_memory_note": {
      const text = String(args.text ?? "").trim();
      if (text) engine.appendSystemMemoryNote(text);
      return { memory: engine.getSystemMemory() };
    }

    case "set_memory_schedule": {
      const schedule = String(args.schedule ?? "manual");
      engine.setSystemMemorySchedule(schedule);
      return { memory: engine.getSystemMemory() };
    }

    case "reflect_system_memory": {
      const focus = typeof args.focus === "string" ? args.focus : undefined;
      const res = await engine.reflectSystemMemory({ focus, trigger: "manual" });
      return { ...res, memory: engine.getSystemMemory() };
    }

    case "clear_system_memory":
      engine.clearSystemMemory();
      return { memory: engine.getSystemMemory() };

    case "chat_start":
      // Owns its own response + streaming lifecycle, and is intercepted in
      // `handleRequestLine` before dispatch. Named here only so the switch
      // stays exhaustive against the protocol's command map.
      throw new ProtocolError(RPC_ERROR.internal, "chat_start is handled before dispatch");

    default:
      // Exhaustive against `HostCommandName`: a command added to the protocol
      // map is a compile error here until the host serves it. That replaces a
      // runtime `unknown command` a client only discovered in production.
      return assertNever(cmd, "host command");
  }
}

// ─── Request handling (shared by stdio, socket and websocket) ───
//
// One entry point, three transports. The envelope is normalised in
// `@gear/protocol`: a legacy `{id,cmd,args}` frame and a JSON-RPC 2.0 frame
// both arrive here as the same thing, and the response goes back in the
// dialect the request came in — a desktop binary already on someone's machine
// must keep working against a host it did not ship with.

export type HostReply = (frame: unknown) => void;

/**
 * Per-connection policy. `gear serve` supplies one that refuses credential
 * writes over a non-loopback link; stdio and unix-socket connections are
 * already as local as a process gets and supply none.
 */
export interface RequestPolicy {
  /** Return a refusal message to block a command, or null to allow it. */
  refuse?: (cmd: string) => string | null;
}

export function handleRequestLine(
  line: string,
  respond: HostReply,
  policy: RequestPolicy = {},
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = decodeFrame(trimmed);
  } catch (err) {
    logErr("engine-host: bad request line:", trimmed, err);
    respond(rpcFailure(null, RPC_ERROR.parse, err instanceof Error ? err.message : String(err)));
    return;
  }

  const req = toRequest(parsed);
  if (!req) {
    logErr("engine-host: malformed request:", trimmed);
    respond(rpcFailure(null, RPC_ERROR.invalidRequest, "not a request frame"));
    return;
  }

  const fail = (code: number, message: string): void =>
    respond(toResponse(req, { ok: false, error: { code, message } }));

  const refusal = policy.refuse?.(req.method);
  if (refusal) {
    fail(RPC_ERROR.forbidden, refusal);
    return;
  }

  let cmd: HostCommandName;
  try {
    cmd = requireCommand(req.method);
  } catch (err) {
    const e = err as ProtocolError;
    fail(e.code ?? RPC_ERROR.methodNotFound, e.message);
    return;
  }

  // chat_start owns its own response + streaming lifecycle.
  if (cmd === "chat_start") {
    const running = currentSessionId();
    if (running) {
      // Name the session that holds the engine. "a turn is already in
      // progress" told a client nothing it could act on.
      fail(RPC_ERROR.busy, `a turn is already in progress on session ${running}`);
      return;
    }
    let message: string;
    try {
      message = requireString(req.params, "message");
    } catch (err) {
      const e = err as ProtocolError;
      fail(e.code ?? RPC_ERROR.invalidParams, e.message);
      return;
    }
    void runChat(
      (outcome) => respond(toResponse(req, outcome)),
      optionalString(req.params, "sessionId"),
      message,
    );
    return;
  }

  void dispatch(cmd, req.params)
    .then((result) => respond(toResponse(req, { ok: true, result })))
    .catch((err) => {
      const code = err instanceof ProtocolError ? err.code : RPC_ERROR.internal;
      fail(code, err instanceof Error ? err.message : String(err));
    });
}

function shutdown(code: number): void {
  // Settle every pending round-trip by policy before the process goes. A
  // permission promise left hanging on a dying process is the wedge this
  // phase removed; recreating it at shutdown would be the same bug.
  try {
    roundTrips.drain();
  } catch {
    /* ignore */
  }
  try {
    engine.close();
  } catch {
    /* ignore */
  }
  if (SOCKET_PATH) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

if (SOCKET_PATH) {
  // ─── Socket mode: the host outlives its clients ───
  // A stale socket file from a crashed host would block startup forever, so
  // probe it: if nothing answers, remove and claim; if a live host answers,
  // refuse — two hosts on one socket is a corruption factory.
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  if (existsSync(SOCKET_PATH)) {
    const live = await new Promise<boolean>((resolveProbe) => {
      Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          open(s) {
            resolveProbe(true);
            s.end();
          },
          data() {},
          error() {
            resolveProbe(false);
          },
          connectError() {
            resolveProbe(false);
          },
        },
      }).catch(() => resolveProbe(false));
    });
    if (live) {
      logErr(`engine-host: a live host already owns ${SOCKET_PATH} — refusing to start`);
      process.exit(1);
    }
    unlinkSync(SOCKET_PATH);
  }

  // Per-connection line buffering: unix sockets deliver arbitrary chunks.
  const buffers = new Map<SocketLike, string>();
  Bun.listen({
    unix: SOCKET_PATH,
    socket: {
      open(socket) {
        connectedClients.add(socket);
        buffers.set(socket, "");
        // Same readiness contract as stdio, scoped to the new client.
        socket.write(
          JSON.stringify(
            streamNotification("ready", {
              ...mappedStatus(engine),
              protocolVersion: PROTOCOL_VERSION,
            }),
          ) + "\n",
        );
      },
      data(socket, chunk) {
        const buffered = (buffers.get(socket) ?? "") + chunk.toString();
        const lines = buffered.split("\n");
        buffers.set(socket, lines.pop() ?? "");
        for (const line of lines) {
          handleRequestLine(line, (obj) => {
            try {
              socket.write(JSON.stringify(obj) + "\n");
            } catch {
              /* client vanished mid-response — the run continues regardless */
            }
          });
        }
      },
      close(socket) {
        // THE point of socket mode: dropping a client never stops the engine.
        connectedClients.delete(socket);
        buffers.delete(socket);
        // But a pending question with nobody left to answer it is a wedge, not
        // resilience. When the LAST client goes, every open round-trip settles
        // by the stated policy and the run continues, contained.
        if (connectedClients.size === 0) roundTrips.clientsGone();
      },
      error(socket) {
        connectedClients.delete(socket);
        buffers.delete(socket);
        if (connectedClients.size === 0) roundTrips.clientsGone();
      },
    },
  });
  logErr(`engine-host: listening on ${SOCKET_PATH}`);
} else {
  // ─── stdio mode (desktop sidecar) — unchanged contract ───
  const rl = readline.createInterface({ input: process.stdin });
  // Access the EventEmitter surface explicitly — Bun's readline typings don't
  // expose `.on` on Interface, but it is an EventEmitter at runtime.
  const rlEvents = rl as unknown as NodeJS.EventEmitter;
  rlEvents.on("line", (line: string) => handleRequestLine(line, send));
  rlEvents.on("close", () => shutdown(0));

  // Announce readiness with the initial status so the bridge/UI can render immediately.
  emitStream("ready", { ...mappedStatus(engine), protocolVersion: PROTOCOL_VERSION });
}
logErr("engine-host: ready");
