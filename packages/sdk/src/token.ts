// ─── Finding the token, without asking the user to paste it ───
//
// `rune serve` mints a fresh bearer token per start into `~/.rune/serve.json`
// at 0600. A local script has no reason to make a person copy it out of a file
// and into an environment variable — that is a step whose only reliable
// outcome is the token ending up in a shell history.
//
// A browser cannot read a file, and this is a no-op there by design.

export interface ServeToken {
  token: string;
  url: string;
  port: number;
  host: string;
}

/**
 * Read the running server's token and URL from `~/.rune/serve.json`.
 *
 * Returns null when there is no file, when it is unreadable, or when there is
 * no filesystem at all (a browser). A caller supplies the token by hand in
 * exactly those cases.
 */
export async function readServeToken(path?: string): Promise<ServeToken | null> {
  try {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const home = process.env.RUNE_HOME ?? nodePath.join(os.homedir(), ".rune");
    const file = path ?? nodePath.join(home, "serve.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
      token?: string;
      port?: number;
      host?: string;
    };
    if (typeof raw.token !== "string" || !raw.token) return null;
    const port = Number(raw.port ?? 4762);
    const host = String(raw.host ?? "127.0.0.1");
    // A server bound to 0.0.0.0 is still reached over loopback from here, and
    // `ws://0.0.0.0:port` is not a URL a client should be handed.
    const dialHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return { token: raw.token, port, host, url: `ws://${dialHost}:${port}` };
  } catch {
    return null;
  }
}
