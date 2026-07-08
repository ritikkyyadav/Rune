#!/usr/bin/env bun
// ──────────────────────────────────────────────────────────────────────────
//  Alan — Engine Host (desktop sidecar)
//
//  A headless bridge that runs the SAME orchestrator Engine the CLI runs and
//  exposes it over line-delimited JSON on stdio. The Tauri desktop app spawns
//  this process and pumps its stdin/stdout, so the GUI gets the exact same
//  models, providers, BYOK keys (~/.alan/secrets.json), web search (Brave/
//  Tavily), MCP servers and skills as `alan` on the terminal — for free,
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
import { existsSync, mkdirSync } from "node:fs";

import {
  Engine,
  type PermissionHandler,
  type PermissionPrompt,
  type UserPermissionDecision,
} from "../engine";
import type { ProviderName } from "@alan/llm-gateway";
import {
  loadConfig,
  loadSecrets,
  applySearchKeysToEnv,
  setProviderKey as persistProviderKey,
  clearProviderKey as persistClearKey,
  searchKeyStatus,
  PROVIDER_PRESETS,
  loadLastModel,
  saveLastModel,
  loadSavedSandboxState,
  resolveInitialSandbox,
} from "@alan/shared";

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

function send(obj: unknown): void {
  rawWrite(JSON.stringify(obj) + "\n");
}
function emitStream(stream: string, payload: unknown): void {
  send({ stream, payload });
}

// ─── Engine construction (mirrors alan-cli.ts main()) ───
// Same provider/model resolution, same key sources, so the desktop behaves
// identically to the terminal.

type CliProvider = "anthropic" | "openai" | "openrouter" | "google" | "ollama-turbo";
const DEFAULT_MODELS: Record<CliProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  openrouter: "qwen/qwen3-coder:free",
  google: "gemini-2.5-flash",
  "ollama-turbo": "qwen3-coder:480b",
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
  const dir = `${process.env.HOME}/.alan`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function buildEngine(): Engine {
  ensureDataDir();
  const workspaceRoot = process.env.ALAN_WORKSPACE || process.env.HOME || process.cwd();
  const config = loadConfig(workspaceRoot);
  const secrets = loadSecrets();

  const hasCreds = (p: CliProvider): boolean =>
    !!process.env[PROVIDER_ENV[p]] ||
    !!(p !== "ollama-turbo" && (config.llm[p] as { apiKey?: string } | undefined)?.apiKey) ||
    !!secrets.keys[p];

  // Detect the best provider from available credentials (free-tier friendly order).
  function detectProvider(): CliProvider {
    for (const p of ["google", "anthropic", "openai", "openrouter"] as CliProvider[]) {
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
    !process.env.ALAN_SEARCH_BACKEND
  ) {
    process.env.ALAN_SEARCH_BACKEND = config.search.provider;
  }
  applySearchKeysToEnv();

  const engine = new Engine({
    model,
    provider: provider as ProviderName,
    workspaceRoot,
    dbPath: config.engine.dbPath,
    toolsBinaryPath: process.env.ALAN_TOOLS_BIN || "alan-tools",
    yoloMode: false,
    trustWorkspace: config.permissions?.trustWorkspace ?? false,
    // Same posture resolution as the CLI, minus CLI flags (desktop has none).
    sandboxEnabled: resolveInitialSandbox({
      env: process.env.ALAN_SANDBOX_ENABLED ?? null,
      saved: loadSavedSandboxState(),
      configured: config.sandbox?.enabled ?? null,
    }),
    plannerMode: false,
    // Config-file keys count as "saved" unless they merely echo an env var.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ? undefined : config.llm.anthropic?.apiKey,
    openaiApiKey: process.env.OPENAI_API_KEY ? undefined : config.llm.openai?.apiKey,
    openrouterApiKey: process.env.OPENROUTER_API_KEY ? undefined : config.llm.openrouter?.apiKey,
    googleApiKey: process.env.GOOGLE_API_KEY ? undefined : config.llm.google?.apiKey,
    // BYOK keys + custom endpoint + toggles from ~/.alan/secrets.json (win over config.toml).
    providerKeys: secrets.keys,
    customEndpoint: secrets.custom,
    disabledProviders: secrets.disabled,
    search: config.search,
    research: config.research,
    tiers: config.tiers,
    git: config.git,
    context: config.context,
    interactive: config.interactive,
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
      },
    });
  });
engine.setPermissionHandler(permissionHandler);

let activeChat = false;

async function runChat(id: number, frontendSessionId: string, message: string): Promise<void> {
  // Ack immediately; the turn streams via chat_event and ends with turn_complete.
  send({ id, ok: true, result: null });
  const sid = resolveSession(frontendSessionId);
  activeChat = true;
  let sawTurnComplete = false;
  try {
    for await (const event of engine.chat(sid, message)) {
      if (event.type === "turn_complete") sawTurnComplete = true;
      emitStream("chat_event", event);
    }
  } catch (err) {
    emitStream("chat_event", {
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
  } finally {
    activeChat = false;
    // Guarantee the UI never hangs in "processing".
    if (!sawTurnComplete) {
      emitStream("chat_event", { type: "turn_complete", stopReason: "end", totalTurns: 1 });
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
          persistProviderKey(pid, key); // → ~/.alan/secrets.json (0600)
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
        const mode =
          permissionLevel === "auto_allow" ? "auto" : permissionLevel === "ask" ? "confirm" : null;
        if (mode) {
          try {
            engine.setPermissionMode(mode as never);
          } catch {
            /* unknown mode — ignore */
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

// ─── stdin read loop ───

const rl = readline.createInterface({ input: process.stdin });
// Access the EventEmitter surface explicitly — Bun's readline typings don't
// expose `.on` on Interface, but it is an EventEmitter at runtime.
const rlEvents = rl as unknown as NodeJS.EventEmitter;
rlEvents.on("line", (line: string) => {
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
      send({ id, ok: false, error: "a turn is already in progress" });
      return;
    }
    void runChat(id, args.sessionId as string, String(args.message ?? ""));
    return;
  }

  void dispatch(cmd, args)
    .then((result) => send({ id, ok: true, result }))
    .catch((err) =>
      send({ id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
});

rlEvents.on("close", () => {
  try {
    engine.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

// Announce readiness with the initial status so the bridge/UI can render immediately.
emitStream("ready", mappedStatus(engine));
logErr("engine-host: ready");
