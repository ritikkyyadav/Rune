// ─── Finding, or starting, the engine ───
//
// Nothing in this file imports `vscode`. That is the whole design of the
// extension: the decisions — which server to talk to, whether to start one,
// what to put in the webview, what the status bar says — are ordinary
// TypeScript with unit tests, and `extension.ts` is a thin shell that wires
// them to the editor's API. An extension whose logic lives inside `vscode`
// callbacks can only be tested by launching VS Code.
//
// The order of preference is the one that respects intent: a server the user
// configured, then one already running on this machine, then one we start.
// Starting a second engine beside one somebody is already watching is worse
// than any connection error.

export interface ServeEndpoint {
  /** `http://127.0.0.1:7788` — the page, and the socket, on one port. */
  pageUrl: string;
  token: string;
  source: "configured" | "running" | "spawned";
}

export interface ServeConfigFile {
  token?: string;
  port?: number;
  host?: string;
}

/** `~/.gear/serve.json`, as an already-parsed object (or null). */
export function endpointFromConfigFile(cfg: ServeConfigFile | null): ServeEndpoint | null {
  if (!cfg?.token || !cfg.port) return null;
  // A server bound to 0.0.0.0 is still reached over loopback from here, and
  // `http://0.0.0.0:port` is not a URL anything should be handed.
  const host =
    cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : (cfg.host ?? "127.0.0.1");
  return { pageUrl: `http://${host}:${cfg.port}`, token: cfg.token, source: "running" };
}

/**
 * A `gear.serverUrl` setting, with its token.
 *
 * The token is deliberately NOT read from the setting: VS Code settings sync to
 * other machines and get committed in `.vscode/settings.json`, and a bearer
 * token that grants remote code execution has no business in either. It comes
 * from `gear.serverToken` in SecretStorage, or from the local serve file when
 * the URL is this machine's own.
 */
export function endpointFromSetting(
  url: string | undefined,
  token: string | undefined,
  local: ServeEndpoint | null,
): ServeEndpoint | null {
  if (!url) return null;
  const normalized = url.replace(/\/+$/, "");
  if (token) return { pageUrl: normalized, token, source: "configured" };
  if (local && isLoopback(normalized)) {
    return { pageUrl: normalized, token: local.token, source: "configured" };
  }
  return null;
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
  } catch {
    return false;
  }
}

/**
 * The command that starts an engine for this workspace.
 *
 * `--web` because the extension hosts the PAGE, not just the socket: the UI in
 * the webview is Gear's own client, trace rail included, which is the only
 * reason a thin extension is worth having rather than a chat box.
 */
export function spawnCommand(gearPath: string, workspace: string, port: number): string[] {
  return [gearPath, "serve", "--web", "--port", String(port), "--workspace", workspace];
}

/**
 * Whether a line of `gear serve` output means it is up.
 *
 * Watching stdout rather than polling the port: a port that accepts a
 * connection before the host pool is ready gives a webview a 500 on first
 * load, and "it worked the second time" is the worst kind of bug report.
 */
export function listeningPort(line: string): number | null {
  const m = /listening\s+wss?:\/\/[^:]+:(\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}
