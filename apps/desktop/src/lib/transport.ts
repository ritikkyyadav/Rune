// ─── One client, two transports ───
//
// The desktop and the web client are the same React bundle. What differs is how
// it reaches the engine, and that difference lives here and nowhere else:
//
//   tauri  invoke("engine_call", {cmd, args})  → the sidecar the app spawned
//   ws     GearClient over `gear serve`        → a running engine, local or LAN
//   none   the browser preview                 → no engine; the demo turn only
//
// Everything above this file — `useEngine`, the reducers, every component —
// talks to the same six methods and never learns which one it got. That is the
// whole reason `gear web` is a transport swap and not a second application.
//
// The round-trips are the only asymmetry worth naming. Over Tauri the host
// streams `{requestId, prompt}` and the client answers by name. The SDK instead
// takes a handler and answers FOR you, which means the requestId never reaches
// the page. So ws mode mints its own local id, holds the SDK's resolver against
// it, and both transports present the identical `(id, payload)` / `answer(id)`
// shape upward.

import type {
  Brief,
  BriefDecision,
  HostCommandArgs,
  HostCommandName,
  HostCommandResult,
  PermissionPrompt,
  PermissionDecisionKind,
  UserQuestion,
} from "@gear/protocol";

export type TransportKind = "tauri" | "ws" | "none";

export interface ServeEndpoint {
  url: string;
  token: string;
  /** Where the endpoint came from, for the connection banner. */
  source: "embedded" | "fragment" | "query" | "saved" | "env";
}

export interface TransportHandlers {
  onStream: (name: string, payload: Record<string, unknown>) => void;
  /** A round-trip opened. Answer it with `answer(id, body)`. */
  onRoundTrip: (kind: RoundTripKind, id: string, payload: unknown) => void;
  onClose?: (info: { code: number; reason: string }) => void;
}

export type RoundTripKind = "permission" | "question" | "brief";

export interface EngineTransport {
  readonly kind: TransportKind;
  /** Human label for the status line: "sidecar", "ws://127.0.0.1:4762", "preview". */
  readonly label: string;
  call<K extends HostCommandName>(
    cmd: K,
    args?: HostCommandArgs<K>,
  ): Promise<HostCommandResult<K> | null>;
  /** Answer a round-trip this transport opened. */
  answer(kind: RoundTripKind, id: string, body: unknown): void;
  close(): void;
}

// ─── Runtime detection ───

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** What `gear web` embeds into the first page load. */
interface EmbeddedServe {
  url?: string;
  token?: string;
}

const SAVED_SERVER_KEY = "gear.serve.endpoint";

/**
 * The engine this page's own address implies.
 *
 * `gear web` serves the page and the socket on ONE port, so when the fragment
 * carries only a token the server is wherever the page came from. That is what
 * lets the printed LAN URL be a token and nothing else.
 */
function serverFromLocation(): string | null {
  try {
    const loc = window.location;
    if (!loc?.host) return null;
    return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}`;
  } catch {
    return null;
  }
}

/** Take the token out of the address bar once it has been read. */
function scrubFragment(): void {
  try {
    const loc = window.location;
    window.history?.replaceState?.(null, "", `${loc.pathname}${loc.search}`);
  } catch {
    /* no history API: the token stays visible, which is cosmetic, not a leak */
  }
}

/**
 * Where a WebSocket engine is, if anything names one.
 *
 * Five sources, in the order that respects intent: the page `gear web` served
 * on loopback (it embedded the token it just minted), the URL FRAGMENT that a
 * LAN or remote link carries, a legacy `?server=&token=` query, a server the
 * user saved in this browser, and finally the build-time `GEAR_SERVE_URL` a
 * developer set for a dev build.
 *
 * The fragment, not the query, is where a remote link puts its token (P5.5).
 * A fragment is never sent to the server, so it cannot land in an access log,
 * a proxy log, or a `Referer` header on the way to somewhere else — and a
 * bearer token that grants remote code execution has no business in any of
 * those. It is read once and removed from the address bar.
 */
export function configuredServer(): ServeEndpoint | null {
  if (typeof window === "undefined") return null;

  const embedded = (window as unknown as { __GEAR_SERVE__?: EmbeddedServe }).__GEAR_SERVE__;
  if (embedded?.url && embedded.token) {
    return { url: embedded.url, token: embedded.token, source: "embedded" };
  }

  try {
    const raw = window.location?.hash ?? "";
    const params = new URLSearchParams(raw.startsWith("#") ? raw.slice(1) : raw);
    const token = params.get("token");
    const url = params.get("server") ?? serverFromLocation();
    if (url && token) {
      scrubFragment();
      return { url, token, source: "fragment" };
    }
  } catch {
    /* no location (tests): fall through */
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("server");
    const token = params.get("token");
    if (url && token) return { url, token, source: "query" };
  } catch {
    /* no location (tests): fall through */
  }

  try {
    const raw = window.localStorage?.getItem(SAVED_SERVER_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as EmbeddedServe;
      if (saved.url && saved.token) return { url: saved.url, token: saved.token, source: "saved" };
    }
  } catch {
    /* storage blocked or corrupt: not an error, just no saved server */
  }

  const envUrl = import.meta.env?.VITE_GEAR_SERVE_URL as string | undefined;
  const envToken = import.meta.env?.VITE_GEAR_SERVE_TOKEN as string | undefined;
  if (envUrl && envToken) return { url: envUrl, token: envToken, source: "env" };

  return null;
}

export function saveServer(endpoint: { url: string; token: string } | null): void {
  try {
    if (!endpoint) window.localStorage?.removeItem(SAVED_SERVER_KEY);
    else window.localStorage?.setItem(SAVED_SERVER_KEY, JSON.stringify(endpoint));
  } catch {
    /* a browser that refuses storage still works; the server is just not remembered */
  }
}

// ─── Tauri passthrough ───

class TauriTransport implements EngineTransport {
  readonly kind = "tauri" as const;
  readonly label = "sidecar";
  private unlisteners: Array<() => void> = [];

  static async open(handlers: TransportHandlers): Promise<TauriTransport> {
    const t = new TauriTransport();
    const { listen } = await import("@tauri-apps/api/event");
    // Every stream the host emits arrives as a webview event of the same name.
    const streams = [
      "ready",
      "engine_status",
      "chat_event",
      "research_event",
      "auto_notice",
      "held_steps",
      "roundtrip_resolved",
    ];
    for (const name of streams) {
      const un = await listen(name, (ev: { payload: unknown }) => {
        handlers.onStream(name, (ev.payload ?? {}) as Record<string, unknown>);
      });
      t.unlisteners.push(un);
    }
    const roundTrips: Array<[string, RoundTripKind, string]> = [
      ["permission_request", "permission", "prompt"],
      ["question_request", "question", "question"],
      ["brief_request", "brief", "brief"],
    ];
    for (const [stream, kind, field] of roundTrips) {
      const un = await listen(stream, (ev: { payload: unknown }) => {
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        const id = typeof p.requestId === "string" ? p.requestId : "";
        if (!id || p[field] == null) return;
        handlers.onRoundTrip(kind, id, p[field]);
      });
      t.unlisteners.push(un);
    }
    return t;
  }

  async call<K extends HostCommandName>(
    cmd: K,
    args?: HostCommandArgs<K>,
  ): Promise<HostCommandResult<K> | null> {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("engine_call", { cmd, args: args ?? {} })) as HostCommandResult<K>;
  }

  answer(kind: RoundTripKind, id: string, body: unknown): void {
    const method =
      kind === "permission"
        ? "respond_permission"
        : kind === "question"
          ? "respond_question"
          : "respond_brief";
    void this.call(
      method as HostCommandName,
      {
        requestId: id,
        ...(body as Record<string, unknown>),
      } as never,
    );
  }

  close(): void {
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
  }
}

// ─── WebSocket (the SDK) ───

class WsTransport implements EngineTransport {
  readonly kind = "ws" as const;
  readonly label: string;
  private seq = 0;
  private readonly waiting = new Map<string, (body: unknown) => void>();

  private constructor(
    private readonly client: import("@gear/sdk/client").GearClient,
    url: string,
  ) {
    this.label = url;
  }

  static async open(endpoint: ServeEndpoint, handlers: TransportHandlers): Promise<WsTransport> {
    const { GearClient } = await import("@gear/sdk/client");
    // `self` so the instance can be referenced from the handlers it constructs.
    let self: WsTransport | null = null;

    /** Hold the SDK's resolver against a local id, and hand the id upward. */
    const hold = <T>(kind: RoundTripKind, payload: unknown, map: (body: unknown) => T) =>
      new Promise<T>((resolve) => {
        const t = self;
        if (!t) return; // impossible in practice: handlers only fire after connect
        const id = `${kind}-${++t.seq}`;
        t.waiting.set(id, (body) => resolve(map(body)));
        handlers.onRoundTrip(kind, id, payload);
      });

    const client = await GearClient.connect(
      { url: endpoint.url, token: endpoint.token },
      {
        onEvent: (event, sessionId) => handlers.onStream("chat_event", { event, sessionId }),
        onResearchEvent: (event, runId) => handlers.onStream("research_event", { event, runId }),
        onStatus: (status) => handlers.onStream("engine_status", status),
        onHeldSteps: (steps, sessionId) => handlers.onStream("held_steps", { steps, sessionId }),
        onRoundTripResolved: (info) =>
          handlers.onStream("roundtrip_resolved", info as unknown as Record<string, unknown>),
        onClose: (info) => handlers.onClose?.(info),
        onPermission: (prompt: PermissionPrompt) =>
          hold("permission", prompt, (body) => ({
            kind: (body as { decision: PermissionDecisionKind }).decision,
          })),
        onQuestion: (question: UserQuestion) =>
          hold("question", question, (body) => String((body as { answer: string }).answer)),
        onBrief: (brief: Brief) =>
          hold("brief", brief, (body) => (body as { decision: BriefDecision }).decision),
      },
    );
    self = new WsTransport(client, endpoint.url);
    return self;
  }

  async call<K extends HostCommandName>(
    cmd: K,
    args?: HostCommandArgs<K>,
  ): Promise<HostCommandResult<K> | null> {
    return this.client.call(cmd, (args ?? {}) as HostCommandArgs<K>);
  }

  answer(_kind: RoundTripKind, id: string, body: unknown): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return; // already answered, or resolved unattended by the host
    this.waiting.delete(id);
    resolve(body);
  }

  close(): void {
    this.client.close();
  }
}

// ─── No engine ───

class NullTransport implements EngineTransport {
  readonly kind = "none" as const;
  readonly label = "preview";
  async call(): Promise<null> {
    return null;
  }
  answer(): void {}
  close(): void {}
}

// ─── Selection ───

/**
 * The transport the app is currently on.
 *
 * A module-level handle, not a context, because `useSession` needs it from
 * outside the engine hook and threading a provider through for one call would
 * be ceremony. There is exactly one engine connection per window.
 */
let active: EngineTransport | null = null;
export function activeTransport(): EngineTransport | null {
  return active;
}

/**
 * Choose a transport.
 *
 * A configured server wins over the sidecar even inside Tauri: someone who
 * pointed the app at `gear serve` meant it, and the alternative — silently
 * running a second engine beside the one they are watching — is worse than any
 * connection error.
 */
export async function openTransport(handlers: TransportHandlers): Promise<EngineTransport> {
  const server = configuredServer();
  if (server) {
    try {
      active = await WsTransport.open(server, handlers);
      return active;
    } catch (err) {
      if (!isTauriRuntime()) throw err;
      // In the app, a dead saved server falls back to the sidecar rather than
      // stranding the window: the engine is right there.
      handlers.onStream("transport_note", {
        note: `could not reach ${server.url}: ${err instanceof Error ? err.message : String(err)} — using the local engine`,
      });
    }
  }
  active = isTauriRuntime() ? await TauriTransport.open(handlers) : new NullTransport();
  return active;
}
