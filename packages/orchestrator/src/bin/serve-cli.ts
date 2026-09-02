// ─── gear serve: the engine as a server ───
//
// The engine has been a daemon in all but the door. `engine-host` already
// speaks the protocol over stdio and over a unix socket; a unix socket is not
// something a browser, an editor extension, or a machine on your LAN can open.
// This adds the third transport and the one thing the other two never needed:
// a door with a lock on it.
//
// Two decisions shape the whole file.
//
// It is a SUPERVISOR, not another engine. `Engine` holds one `currentAbort`
// and one `liveLoop`, so one process can run one turn. Rather than refactor
// that for in-process multiplexing, `gear serve` spawns one engine-host per
// session — the same spawn + registry pattern `gear detach` has used since it
// shipped — and proxies frames. Sessions are genuinely concurrent because they
// are genuinely separate processes, and a wedged session cannot take the
// server with it.
//
// And it is CLOSED by default. Before this, any client that could open the
// socket could call `save_settings`, which writes API keys to disk. Loopback
// bind, a bearer token required on every connection, an Origin allowlist, and
// credential writes refused outright over a non-loopback link unless the token
// was minted for it.

import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerWebSocket } from "bun";

import {
  PROTOCOL_VERSION,
  RPC_ERROR,
  SETTINGS_COMMANDS,
  encodeFrame,
  isWellFormedToken,
  rpcFailure,
  streamNotification,
  timingSafeEqual,
  toRequest,
  toResult,
  toStream,
} from "@gear/protocol";
import { adoptLegacyEnv, getGearHome, migrateLegacyHome } from "@gear/shared";

import { HostClient } from "../host-client";

// ─── Where the door key lives ───

export interface ServeConfig {
  /** URL-safe, 43 chars of base64url over 32 random bytes. */
  token: string;
  createdAt: string;
  port: number;
  host: string;
  /**
   * Whether THIS token may write credentials over a non-loopback link.
   *
   * On the token rather than on the server because the answer must survive a
   * restart with different flags: a token minted for local use must not become
   * a remote key-writing token because someone later passed `--host`.
   */
  allowRemoteSettings: boolean;
  /** Browser origins allowed to open a socket. Non-browser clients send none. */
  origins: string[];
  pid: number;
}

export function serveConfigPath(): string {
  return join(getGearHome(), "serve.json");
}

function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function readServeConfig(): ServeConfig | null {
  try {
    const raw = JSON.parse(readFileSync(serveConfigPath(), "utf8")) as Partial<ServeConfig>;
    if (!isWellFormedToken(raw.token)) return null;
    return {
      token: raw.token,
      createdAt: String(raw.createdAt ?? ""),
      port: Number(raw.port ?? 0),
      host: String(raw.host ?? "127.0.0.1"),
      allowRemoteSettings: raw.allowRemoteSettings === true,
      origins: Array.isArray(raw.origins) ? raw.origins.map(String) : [],
      pid: Number(raw.pid ?? 0),
    };
  } catch {
    return null;
  }
}

function writeServeConfig(cfg: ServeConfig): void {
  const path = serveConfigPath();
  mkdirSync(getGearHome(), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode only applies on CREATE. An existing file keeps
  // whatever mode it had, which for a token file is not good enough.
  chmodSync(path, 0o600);
}

// ─── Origin policy ───

/** The origins a browser page may open a socket from, without being told. */
const DEFAULT_ORIGINS = [
  "http://localhost",
  "http://127.0.0.1",
  "https://localhost",
  "https://127.0.0.1",
];

/**
 * A missing Origin is a NON-BROWSER client (curl, the SDK, an editor
 * extension) and is allowed: browsers always send one, so its absence cannot
 * be forged from a page. A present Origin must match the allowlist by scheme
 * and host — this is what stops a page you happen to have open from driving
 * your agent with a token it guessed or scraped.
 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const base = `${url.protocol}//${url.hostname}`;
  return allowed.some((a) => {
    if (a === "*") return true;
    try {
      const u = new URL(a);
      return `${u.protocol}//${u.hostname}` === base;
    } catch {
      return a === origin;
    }
  });
}

// ─── Token extraction ───

/**
 * Three ways in, in preference order: the standard header, the WebSocket
 * subprotocol (the only header a browser's `WebSocket` constructor lets you
 * set), and a query parameter (last resort — it lands in server logs, which is
 * why it is last and why the docs say so).
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) {
    for (const part of proto.split(",")) {
      const p = part.trim();
      if (p.startsWith("gear.bearer.")) return p.slice("gear.bearer.".length);
    }
  }

  const q = new URL(req.url).searchParams.get("token");
  return q && q.length > 0 ? q : null;
}

/** Whether a connection came from this machine. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost" || a.startsWith("127.");
}

// ─── The host pool (the supervisor half of P2.3) ───

const RUN_DIR = (): string => join(getGearHome(), "run");
const SERVE_REGISTRY = (): string => join(RUN_DIR(), "serve-hosts.json");

interface PooledHost {
  key: string;
  socket: string;
  pid: number;
  client: HostClient;
  lastUsedAt: number;
}

/** Reaped after this long with nothing routed to it. */
const IDLE_REAP_MS = 30 * 60_000;

export class HostPool {
  private readonly hosts = new Map<string, PooledHost>();
  private readonly starting = new Map<string, Promise<PooledHost>>();
  private readonly onStream: (key: string, stream: string, payload: unknown) => void;
  private readonly workspace: string;

  constructor(opts: {
    workspace: string;
    onStream: (key: string, stream: string, payload: unknown) => void;
  }) {
    this.workspace = opts.workspace;
    this.onStream = opts.onStream;
  }

  get size(): number {
    return this.hosts.size;
  }

  keys(): string[] {
    return [...this.hosts.keys()];
  }

  /**
   * The host for a routing key — a session id, or "control" for the commands
   * that belong to no session (status, provider list, memory).
   *
   * Concurrent callers share one spawn: without `starting`, two clients
   * opening the same session at once would race two hosts onto one socket and
   * the second would exit(1) by design, taking a client's request with it.
   */
  async acquire(key: string): Promise<PooledHost> {
    const live = this.hosts.get(key);
    if (live && !live.client.isClosed) {
      live.lastUsedAt = Date.now();
      return live;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;

    const promise = this.spawn(key).finally(() => this.starting.delete(key));
    this.starting.set(key, promise);
    return promise;
  }

  private async spawn(key: string): Promise<PooledHost> {
    mkdirSync(RUN_DIR(), { recursive: true });
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
    const id = `serve-${safe}-${Date.now().toString(36)}`;
    const socket = join(RUN_DIR(), `${id}.sock`);
    const logFd = openSync(join(RUN_DIR(), `${id}.log`), "a");

    const hostScript = join(import.meta.dir, "engine-host.ts");
    const child = Bun.spawn(["bun", hostScript, "--socket", socket], {
      env: { ...process.env, GEAR_WORKSPACE: this.workspace },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    // The server's exit must not take a running session down — the same
    // promise `gear detach` makes, and the reason shutdown is graceful.
    child.unref();

    const client = await connectWithRetry(socket, 20_000);
    client.onStream((frame) => this.onStream(key, frame.stream, frame.payload));

    const host: PooledHost = { key, socket, pid: child.pid, client, lastUsedAt: Date.now() };
    this.hosts.set(key, host);
    this.persist();
    return host;
  }

  /** Close idle hosts. Their processes exit on SIGTERM and free their socket. */
  reapIdle(maxIdleMs = IDLE_REAP_MS, now = Date.now()): number {
    let reaped = 0;
    for (const [key, host] of [...this.hosts]) {
      if (now - host.lastUsedAt < maxIdleMs) continue;
      host.client.close();
      try {
        process.kill(host.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      this.hosts.delete(key);
      reaped++;
    }
    if (reaped > 0) this.persist();
    return reaped;
  }

  /**
   * Let go of every host WITHOUT stopping it.
   *
   * The point of graceful shutdown: `gear serve` going away must not kill a
   * turn that is halfway through editing files. The hosts stay up on their
   * sockets, the registry records where they are, and the next `gear serve`
   * reattaches — exactly as `gear attach` does today.
   */
  detachAll(): string[] {
    const sockets: string[] = [];
    for (const host of this.hosts.values()) {
      sockets.push(host.socket);
      host.client.close();
    }
    this.hosts.clear();
    this.persist();
    return sockets;
  }

  private persist(): void {
    try {
      mkdirSync(RUN_DIR(), { recursive: true });
      writeFileSync(
        SERVE_REGISTRY(),
        JSON.stringify(
          [...this.hosts.values()].map((h) => ({
            key: h.key,
            socket: h.socket,
            pid: h.pid,
            lastUsedAt: new Date(h.lastUsedAt).toISOString(),
          })),
          null,
          2,
        ) + "\n",
      );
    } catch {
      // The registry is a convenience for `--status` and the next server. A
      // failure to write it must never fail a request.
    }
  }
}

async function connectWithRetry(socket: string, timeoutMs: number): Promise<HostClient> {
  const start = Date.now();
  for (;;) {
    try {
      return await HostClient.connect(socket, 1_000);
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// ─── Routing ───

/** The commands that answer a round-trip, keyed by `requestId` rather than session. */
const ANSWER_COMMANDS = new Set([
  "respond_permission",
  "respond_question",
  "respond_brief",
  "respond_research_plan",
]);

/** The streams that OPEN a round-trip, so the answer can be routed back to it. */
const REQUEST_STREAMS = new Set([
  "permission_request",
  "question_request",
  "brief_request",
  "research_plan_request",
]);

/**
 * Which host a command belongs to.
 *
 * A round-trip ANSWER is the subtle case, and getting it wrong is silent: a
 * `respond_question` carries a requestId and no sessionId, so routing it by
 * session sends it to the control host, which has no such pending request and
 * cheerfully replies `{stale:true}` while the session that asked waits out its
 * full ten-minute timeout. The supervisor watches the request streams go past
 * and remembers which host each requestId came from.
 */
export function routingKey(
  method: string,
  params: Record<string, unknown>,
  requestOwners?: Map<string, string>,
): string {
  if (ANSWER_COMMANDS.has(method)) {
    const requestId = typeof params.requestId === "string" ? params.requestId : "";
    const owner = requestOwners?.get(requestId);
    if (owner) return owner;
  }
  const sid = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : null;
  if (sid) return sid;
  // A turn with no session id opens one, and that one gets its own host.
  if (method === "chat_start" || method === "research_start") return `new-${Date.now()}`;
  return "control";
}

/** Note a round-trip's owner from the stream frame that opened it. */
export function noteRequestOwner(
  owners: Map<string, string>,
  key: string,
  stream: string,
  payload: unknown,
): void {
  if (!REQUEST_STREAMS.has(stream)) return;
  const requestId = (payload as { requestId?: unknown })?.requestId;
  if (typeof requestId === "string" && requestId) owners.set(requestId, key);
}

// ─── Connection state ───

interface ConnState {
  authed: boolean;
  loopback: boolean;
  /** Routing keys this connection has touched, so streams reach it. */
  keys: Set<string>;
}

// ─── The server ───

export interface ServeOptions {
  port?: number;
  host?: string;
  workspace?: string;
  allowRemoteSettings?: boolean;
  origins?: string[];
  /** Injected by tests so they do not have to parse stdout. */
  onListening?: (info: { port: number; host: string; token: string }) => void;
}

export async function runServe(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<void> {
  adoptLegacyEnv();
  migrateLegacyHome();

  if (positionals[1] === "status" || values.status === true) {
    printStatus();
    return;
  }

  const port = Number(values.port ?? 0) || 4762;
  const bindAll = values.host === "0.0.0.0" || values.host === true || values.host === "all";
  const host = bindAll ? "0.0.0.0" : typeof values.host === "string" ? values.host : "127.0.0.1";
  const allowRemoteSettings = values["allow-remote-settings"] === true;
  const workspace = typeof values.workspace === "string" ? values.workspace : process.cwd();
  const origins =
    typeof values.origin === "string" ? [...DEFAULT_ORIGINS, values.origin] : [...DEFAULT_ORIGINS];

  const running = await serve({ port, host, workspace, allowRemoteSettings, origins });

  // `serve()` returns as soon as it is listening, so the CLI must park here or
  // the process falls straight through and exits with a token file on disk and
  // nothing behind it. Resolved only by the signal handlers, which stop the
  // front door and deliberately leave the session hosts running.
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      running.stop();
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

export async function serve(opts: ServeOptions = {}): Promise<{ stop: () => void; port: number }> {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 4762;
  const workspace = opts.workspace ?? process.cwd();
  const allowRemoteSettings = opts.allowRemoteSettings === true;
  const origins = opts.origins ?? [...DEFAULT_ORIGINS];

  // A fresh token every start. A long-lived server key sitting in a file
  // forever is a credential nobody remembers granting.
  const token = mintToken();
  const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";

  const sockets = new Map<ServerWebSocket<ConnState>, ConnState>();
  // requestId -> the host that opened that round-trip. See `routingKey`.
  const requestOwners = new Map<string, string>();

  const pool = new HostPool({
    workspace,
    onStream: (key, stream, payload) => {
      noteRequestOwner(requestOwners, key, stream, payload);
      if (stream === "roundtrip_resolved") {
        const id = (payload as { requestId?: unknown })?.requestId;
        if (typeof id === "string") requestOwners.delete(id);
      }
      const frame = encodeFrame(streamNotification(stream, payload));
      for (const [ws, state] of sockets) {
        // Control-plane streams (status, ready) go to everyone; a session's
        // events go only to the clients that asked about that session.
        if (key === "control" || state.keys.has(key) || state.keys.size === 0) {
          try {
            ws.send(frame);
          } catch {
            sockets.delete(ws);
          }
        }
      }
    },
  });

  const server = Bun.serve<ConnState, never>({
    port: requestedPort,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);

      // A tiny liveness endpoint that requires no token: it reveals only that
      // something is listening, which the TCP handshake already revealed.
      if (url.pathname === "/health") {
        return Response.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
      }

      const origin = req.headers.get("origin");
      if (!originAllowed(origin, origins)) {
        return new Response("origin not allowed", { status: 403 });
      }

      const supplied = extractToken(req);
      if (!supplied || !timingSafeEqual(supplied, token)) {
        return new Response("unauthorized", { status: 401 });
      }

      const address = srv.requestIP(req)?.address;
      const state: ConnState = {
        authed: true,
        loopback: isLoopbackAddress(address),
        keys: new Set(),
      };
      // Echo the subprotocol back when the client used that channel, or the
      // browser tears the connection down for a protocol mismatch.
      const proto = req.headers.get("sec-websocket-protocol");
      const echo = proto
        ?.split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith("gear.bearer."));
      if (
        srv.upgrade(req, { data: state, headers: echo ? { "Sec-WebSocket-Protocol": echo } : {} })
      ) {
        return undefined;
      }
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws, ws.data);
        ws.send(
          encodeFrame(
            streamNotification("ready", {
              state: "connected",
              protocolVersion: PROTOCOL_VERSION,
              workspace,
            }),
          ),
        );
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        const line = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          ws.send(encodeFrame(rpcFailure(null, RPC_ERROR.parse, "malformed frame")));
          return;
        }
        const req = toRequest(parsed);
        if (!req) {
          ws.send(encodeFrame(rpcFailure(null, RPC_ERROR.invalidRequest, "not a request frame")));
          return;
        }

        // The one rule that survives every other flag: writing credentials
        // over a link that is not this machine requires a token minted for it.
        if (
          SETTINGS_COMMANDS.includes(req.method as never) &&
          !ws.data.loopback &&
          !allowRemoteSettings
        ) {
          ws.send(
            encodeFrame(
              rpcFailure(
                req.id,
                RPC_ERROR.forbidden,
                `${req.method} writes credentials and is refused over a non-loopback connection; ` +
                  "restart with --allow-remote-settings if that is genuinely what you want",
              ),
            ),
          );
          return;
        }

        const key = routingKey(req.method, req.params, requestOwners);
        ws.data.keys.add(key);
        if (ANSWER_COMMANDS.has(req.method)) {
          const id = req.params.requestId;
          if (typeof id === "string") requestOwners.delete(id);
        }
        try {
          const pooled = await pool.acquire(key);
          const result = await pooled.client.request(req.method, req.params, 15 * 60_000);
          ws.send(encodeFrame({ jsonrpc: "2.0", id: req.id, result }));
        } catch (err) {
          ws.send(
            encodeFrame(
              rpcFailure(
                req.id,
                RPC_ERROR.internal,
                err instanceof Error ? err.message : String(err),
              ),
            ),
          );
        }
      },
    },
  });

  const boundPort = server.port ?? requestedPort;

  writeServeConfig({
    token,
    createdAt: new Date().toISOString(),
    port: boundPort,
    host,
    allowRemoteSettings,
    origins,
    pid: process.pid,
  });

  const reaper = setInterval(() => pool.reapIdle(), 5 * 60_000);
  (reaper as unknown as { unref?: () => void }).unref?.();

  const url = `ws://${loopbackOnly ? "127.0.0.1" : host}:${boundPort}`;
  console.log(`gear serve — protocol ${PROTOCOL_VERSION}`);
  console.log(`  listening  ${url}`);
  console.log(`  workspace  ${workspace}`);
  console.log(`  token      ${serveConfigPath()} (0600)`);
  if (!loopbackOnly) {
    // Never quiet about this. The banner names what is now reachable, because
    // "it worked" is not the same as "you meant it".
    console.log("");
    console.log(`  ! bound to ${host} — every machine that can reach this port can drive`);
    console.log(`    this agent with the token, running tools in ${workspace}.`);
    console.log(
      `    Credential writes are ${allowRemoteSettings ? "ALLOWED (--allow-remote-settings)" : "refused"} off-loopback.`,
    );
    console.log("");
  }
  opts.onListening?.({ port: boundPort, host, token });

  const stop = (): void => {
    clearInterval(reaper);
    // Let go of the hosts; do NOT stop them. A turn halfway through editing
    // files must not die because the front door closed.
    const left = pool.detachAll();
    server.stop(true);
    if (left.length > 0) {
      console.log(`\n${left.length} session host(s) left running; reattach with gear serve`);
    }
  };

  return { stop, port: boundPort };
}

function printStatus(): void {
  const cfg = readServeConfig();
  if (!cfg) {
    console.log("gear serve: not running (no ~/.gear/serve.json)");
    return;
  }
  console.log(`gear serve`);
  console.log(`  bind       ${cfg.host}:${cfg.port}`);
  console.log(`  started    ${cfg.createdAt}`);
  console.log(`  pid        ${cfg.pid}`);
  console.log(`  remote settings ${cfg.allowRemoteSettings ? "allowed" : "refused"}`);
  console.log(`  origins    ${cfg.origins.join(", ")}`);
  try {
    const hosts = JSON.parse(readFileSync(SERVE_REGISTRY(), "utf8")) as Array<{ key: string }>;
    console.log(`  hosts      ${hosts.length}`);
    for (const h of hosts) console.log(`    - ${h.key}`);
  } catch {
    console.log(`  hosts      0`);
  }
  const alive = cfg.pid > 0 && processAlive(cfg.pid);
  console.log(`  state      ${alive ? "listening" : "stale (the recorded pid is gone)"}`);
  if (!existsSync(serveConfigPath())) console.log("  token file missing");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Re-exported for the SDK and tests: read one stream frame off the wire. */
export { toStream, toResult };
