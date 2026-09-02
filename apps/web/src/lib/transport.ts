// ─── One client, one transport ───
//
// The product is a web page the engine serves. There is exactly one way it
// reaches the engine — a WebSocket through `@gear/sdk` — and this file is the
// whole seam:
//
//   ws     GearClient over `gear serve --web`   → the engine that served the page
//   none   a bundle opened with no server        → nothing to drive; the demo turn
//
// Phase 3 had a second branch here, a Tauri `invoke` passthrough into a sidecar
// the native shell spawned. That shell is gone (Phase 9): one URL-based product
// on three operating systems means one transport, and a second one that exists
// only inside a wrapper is a second product to keep working.
//
// The round-trip asymmetry is the only thing left worth naming. The SDK takes a
// handler and answers FOR you, so the engine's requestId never reaches the page.
// This mints a local id, holds the SDK's resolver against it, and presents the
// `(id, payload)` / `answer(id)` shape the components upstream already speak.

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

export type TransportKind = "ws" | "none";

export interface ServeEndpoint {
  url: string;
  token: string;
  /** Where the endpoint came from, for the connection line. */
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
  /** Human label for the status line: "ws://127.0.0.1:4762", "no engine". */
  readonly label: string;
  call<K extends HostCommandName>(
    cmd: K,
    args?: HostCommandArgs<K>,
  ): Promise<HostCommandResult<K> | null>;
  /** Answer a round-trip this transport opened. */
  answer(kind: RoundTripKind, id: string, body: unknown): void;
  close(): void;
}

/** What `gear serve --web` embeds into the first page load. */
interface EmbeddedServe {
  url?: string;
  token?: string;
}

const SAVED_SERVER_KEY = "gear.serve.endpoint";

/**
 * The engine this page's own address implies.
 *
 * `gear serve --web` serves the page and the socket on ONE port, so when the
 * fragment carries only a token the server is wherever the page came from. That
 * is what lets a printed LAN URL be a token and nothing else.
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
 * Five sources, in the order that respects intent: the page the engine served
 * on loopback (it embedded the token it just minted), the URL FRAGMENT that a
 * LAN or remote link carries, a legacy `?server=&token=` query, a server the
 * user saved in this browser, and finally a build-time `GEAR_SERVE_URL`.
 *
 * The fragment, not the query, is where a remote link puts its token (P5.5). A
 * fragment is never sent to the server, so it cannot land in an access log, a
 * proxy log, or a `Referer` header on the way somewhere else — and a bearer
 * token that grants remote code execution has no business in any of those. It
 * is read once and removed from the address bar.
 *
 * The saved endpoint is what makes the page survive a server restart: the token
 * changes on every start, so a reconnect that only had the old one would loop
 * forever. On loopback the page simply reloads itself and the server hands it a
 * fresh embedded token; see `reconnect()`.
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

/**
 * Whether this page can recover a restarted server by reloading itself.
 *
 * `gear serve --web` mints a NEW token on every start, so a page holding the
 * old one can reconnect forever and never be let in. On loopback the recovery
 * is trivial and correct: ask the server for the page again and it embeds the
 * current token. Off-loopback the token came from a link the person pasted, and
 * a reload would lose it — so those pages reconnect with what they have and say
 * so if the server refuses.
 */
export function canReloadForToken(source: ServeEndpoint["source"] | null): boolean {
  return source === "embedded";
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
  readonly label = "no engine";
  async call(): Promise<null> {
    return null;
  }
  answer(): void {}
  close(): void {}
}

// ─── Selection ───

/**
 * The transport the page is currently on.
 *
 * A module-level handle, not a context, because `useSession` needs it from
 * outside the engine hook and threading a provider through for one call would
 * be ceremony. There is exactly one engine connection per tab.
 */
let active: EngineTransport | null = null;
export function activeTransport(): EngineTransport | null {
  return active;
}

/** The endpoint the live transport was opened with, for reconnect decisions. */
let activeEndpoint: ServeEndpoint | null = null;
export function activeEndpointSource(): ServeEndpoint["source"] | null {
  return activeEndpoint?.source ?? null;
}

export async function openTransport(handlers: TransportHandlers): Promise<EngineTransport> {
  const server = configuredServer();
  if (server) {
    active = await WsTransport.open(server, handlers);
    activeEndpoint = server;
    return active;
  }
  active = new NullTransport();
  activeEndpoint = null;
  return active;
}
