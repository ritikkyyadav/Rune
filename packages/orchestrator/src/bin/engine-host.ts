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

import {
  Engine,
  type PermissionHandler,
  type PermissionPrompt,
  type UserPermissionDecision,
} from "../engine";
import type { ProviderName } from "@gear/llm-gateway";
import {
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

function send(obj: unknown): void {
  rawWrite(JSON.stringify(obj) + "\n");
}
function emitStream(stream: string, payload: unknown): void {
  if (SOCKET_PATH) {
    const frame = JSON.stringify({ stream, payload }) + "\n";
    for (const client of connectedClients) {
      try {
        client.write(frame);
      } catch {
        connectedClients.delete(client);
      }
    }
    return;
  }
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

  // Sticky last-used model wins if its provider still has credentials.
  const lastUsed = loadLastModel();
  const sticky =
    lastUsed && isCliProvider(lastUsed.provider) && hasCreds(lastUsed.provider) ? lastUsed : null;

  let provider: CliProvider;
  let model: string;
  if (sticky) {
    provider = sticky.provider as CliProvider;
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
    disabledProviders: secrets.disabled,
    search: config.search,
    research: config.research,
    tiers: config.tiers,
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

// Permission round-trip: emit a request to the UI, await its decision.
let permSeq = 0;
const pendingPerms = new Map<string, (d: UserPermissionDecision) => void>();
const permissionHandler: PermissionHandler = (prompt: PermissionPrompt) =>
  new Promise<UserPermissionDecision>((resolve) => {
    const requestId = `perm-${++permSeq}`;
    pendingPerms.set(requestId, resolve);
    emitStream("permission_request", {
      requestId,
      prompt: {
        toolName: prompt.toolName,
        argsSummary: prompt.argsSummary,
        rawArgs: prompt.rawArgs,
        safety: prompt.safety,
        exactSessionGrant: prompt.exactSessionGrant,
      },
    });
  });
engine.setPermissionHandler(permissionHandler);

let activeChat = false;

async function runChat(
  id: number,
  frontendSessionId: string,
  message: string,
  respond: (obj: unknown) => void,
): Promise<void> {
  const sid = resolveSession(frontendSessionId);
  // Ack immediately with the resolved session id — a detaching client needs
  // it to reattach later. The turn streams via chat_event and ends with
  // turn_complete; in socket mode events are tagged with the session so
  // attach clients can filter (the stdio/desktop shape is unchanged).
  respond({ id, ok: true, result: { sessionId: sid } });
  activeChat = true;
  let sawTurnComplete = false;
  const emitChat = (event: unknown): void => {
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
    activeChat = false;
    // Guarantee the UI never hangs in "processing".
    if (!sawTurnComplete) {
      emitChat({ type: "turn_complete", stopReason: "end", totalTurns: 1 });
    }
    emitStream("engine_status", mappedStatus(engine, sid));
  }
}

async function dispatch(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
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

    case "abort_chat":
      engine.abort();
      return null;

    case "interject_chat":
      // Mid-turn steering: fold a user message into the run in flight.
      // Returns whether a live run accepted it — on false the frontend
      // should hold the message and send it as the next turn instead.
      return { accepted: engine.interject(String(args.text ?? "")) };

    case "respond_permission": {
      const requestId = args.requestId as string;
      const decision = args.decision as UserPermissionDecision["kind"];
      const resolve = pendingPerms.get(requestId);
      if (resolve) {
        pendingPerms.delete(requestId);
        resolve({ kind: decision });
      }
      return null;
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

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

// ─── Request handling (shared by stdio and socket transports) ───

function handleRequestLine(line: string, respond: (obj: unknown) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: { id?: number; cmd?: string; args?: Record<string, unknown> };
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    logErr("engine-host: bad request line:", trimmed, err);
    return;
  }
  const { id, cmd, args = {} } = req;
  if (typeof cmd !== "string" || typeof id !== "number") {
    logErr("engine-host: malformed request:", trimmed);
    return;
  }

  // chat_start owns its own response + streaming lifecycle.
  if (cmd === "chat_start") {
    if (activeChat) {
      respond({ id, ok: false, error: "a turn is already in progress" });
      return;
    }
    void runChat(id, args.sessionId as string, String(args.message ?? ""), respond);
    return;
  }

  void dispatch(cmd, args)
    .then((result) => respond({ id, ok: true, result }))
    .catch((err) =>
      respond({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
}

function shutdown(code: number): void {
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
        socket.write(JSON.stringify({ stream: "ready", payload: mappedStatus(engine) }) + "\n");
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
      },
      error(socket) {
        connectedClients.delete(socket);
        buffers.delete(socket);
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
  emitStream("ready", mappedStatus(engine));
}
logErr("engine-host: ready");
