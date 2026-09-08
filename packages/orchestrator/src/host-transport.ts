// ─── How a session host is REACHED, on each platform ───
//
// `rune serve`, `rune detach` and `rune acp` all spawn `engine-host --socket
// <path>` and then dial that path. Until P13.2 the dialling was one line —
// `Bun.connect({ unix: path })` — written on a Mac and never once exercised on
// Windows, where a unix domain socket path is not a thing you can bind. The
// v0.4.0 release gate found it the only way it could be found: the packaged
// Windows binary passed install, `--version`, `doctor`, `tools-smoke` and a
// real headless prompt, and then `rune serve --check` sat for twenty seconds
// and printed `✗ Failed to connect` — Bun's error for a socket that never
// came up.
//
// So the address stops being "a unix socket path" and becomes "a RENDEZVOUS
// PATH", which every caller still passes around as one string:
//
//   POSIX    the path IS the unix socket. Unchanged, byte for byte.
//   Windows  the host listens on 127.0.0.1 with an ephemeral port and writes
//            that path as a small JSON file naming the port and a per-host
//            token; the client reads it and dials TCP.
//
// Keeping one string is deliberate. The serve pool, the detach registry,
// `rune attach`, `rune serve --status` and the shutdown unlink all record,
// list and delete a "socket" — and none of them has to learn what a transport
// is, because on both platforms the thing they hold is a path that exists
// while the host does and is removed when it goes.
//
// ─── What replaces the file mode ───
//
// A unix socket is protected by the filesystem: it is created under the user's
// own `~/.rune/run`, and another local user cannot connect to it. A loopback
// TCP port has no such thing — ANY process on the machine, under any user, can
// connect to 127.0.0.1:<port>. So the port is not the secret and is not
// treated as one: the host mints 32 random bytes per host, writes them into
// the 0600 rendezvous file, and refuses every connection whose first line is
// not that token. An unauthenticated peer gets no `ready` frame, no status, no
// engine — just a closed socket.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";

import { isWellFormedToken, timingSafeEqual } from "@rune/protocol";

/** The two ways a client can reach a host. */
export type HostTransport = "unix" | "tcp";

/** What a Windows rendezvous file says. */
export interface TcpEndpoint {
  transport: "tcp";
  host: string;
  port: number;
  token: string;
}

/** Where to dial, once the rendezvous path has been resolved. */
export type HostTarget =
  { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number; token: string };

/**
 * The env var that forces a transport, whatever the platform says.
 *
 * Not a knob for users — a way for a POSIX machine to RUN the Windows
 * transport. The reason this defect reached a release is that the Windows path
 * existed only on Windows, so nothing a developer or a Linux runner could do
 * would exercise it; with this, `rune serve --check` on any platform proves
 * both transports, and the Windows-only part left untested shrinks to "does
 * Bun bind a loopback port on Windows", which every other test already
 * answers.
 */
export const TRANSPORT_ENV = "RUNE_HOST_TRANSPORT";

/**
 * Which transport to use.
 *
 * A function of the platform string rather than a module constant so the unit
 * tests can ask about win32 from a Mac — the whole reason this defect reached
 * a release was that nothing on the developer's machine could pose the
 * question.
 */
export function hostTransportFor(
  platform: NodeJS.Platform | string = process.platform,
  env: Record<string, string | undefined> = process.env,
): HostTransport {
  const forced = (env[TRANSPORT_ENV] ?? "").trim().toLowerCase();
  if (forced === "tcp" || forced === "unix") return forced;
  return platform === "win32" ? "tcp" : "unix";
}

/** 32 random bytes, base64url — the same shape `rune serve`'s door key has. */
export function mintHostToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** The rendezvous file's contents. Trailing newline so a `cat` reads sanely. */
export function encodeEndpoint(ep: Omit<TcpEndpoint, "transport">): string {
  return JSON.stringify({ transport: "tcp", ...ep }) + "\n";
}

/**
 * Read a rendezvous file back, or `null` if it is not one.
 *
 * Null for every kind of not-yet and not-valid: absent, half-written by a host
 * that is still booting, truncated, or holding a token that could not have
 * been minted. The callers all treat null as "retry" rather than "fail",
 * which is exactly right — a host that has not written its port yet is a host
 * that is still starting.
 */
export function parseEndpoint(text: string): TcpEndpoint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.transport !== "tcp") return null;
  const host = typeof rec.host === "string" && rec.host ? rec.host : null;
  const port = typeof rec.port === "number" ? rec.port : null;
  if (!host || !isLoopbackHost(host)) return null;
  if (port === null || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!isWellFormedToken(rec.token)) return null;
  return { transport: "tcp", host, port, token: rec.token };
}

/**
 * Is this an address on this machine?
 *
 * Belt to the braces of binding 127.0.0.1: a rendezvous file is a file, and a
 * file can be edited. Nothing should ever dial a host at an address that is
 * not loopback because a JSON file said so.
 */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Write the rendezvous file, readable only by its owner. */
export function writeEndpointFile(path: string, ep: Omit<TcpEndpoint, "transport">): void {
  writeFileSync(path, encodeEndpoint(ep), { mode: 0o600 });
  try {
    // `writeFileSync`'s mode applies only when it CREATES the file; a leftover
    // from a crashed host would keep the old one.
    chmodSync(path, 0o600);
  } catch {
    /* Windows has no mode bits worth the name — the token is the guard. */
  }
}

/** Read the rendezvous file, or null if there is not (yet) a valid one. */
export function readEndpointFile(path: string): TcpEndpoint | null {
  try {
    return parseEndpoint(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where to dial for a host, given the rendezvous path it was spawned with.
 *
 * Throws on Windows when the file is not there yet, because every caller
 * dialling a host is already inside a retry loop that treats a throw as "not
 * up yet" — which is what a missing rendezvous file means.
 */
export function resolveHostTarget(
  path: string,
  transport: HostTransport = hostTransportFor(),
): HostTarget {
  if (transport === "unix") return { kind: "unix", path };
  const ep = readEndpointFile(path);
  if (!ep) throw new Error(`no host endpoint at ${path} yet`);
  return { kind: "tcp", host: ep.host, port: ep.port, token: ep.token };
}

// ─── The handshake ───

/** The method name a client's first line carries on a TCP host. */
export const HOST_AUTH_METHOD = "host_auth";

/** The first line a TCP client sends. A notification: nothing answers it. */
export function authFrame(token: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: HOST_AUTH_METHOD, params: { token } }) + "\n";
}

/** The token in an auth line, or null if the line is not one. */
export function readAuthToken(line: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.method !== HOST_AUTH_METHOD) return null;
  const params = rec.params;
  if (!params || typeof params !== "object") return null;
  const token = (params as Record<string, unknown>).token;
  return typeof token === "string" ? token : null;
}

/**
 * Does this first line authenticate against the host's token?
 *
 * Constant-time, and false for everything that is not an auth line at all —
 * so a client that opens a TCP host and starts issuing commands without
 * authenticating is refused rather than served.
 */
export function authorizes(line: string, token: string): boolean {
  const supplied = readAuthToken(line);
  if (supplied === null) return false;
  return timingSafeEqual(supplied, token);
}

/**
 * How long an unauthenticated TCP connection may stay open.
 *
 * A peer that connects and says nothing holds a socket and a buffer forever
 * otherwise. Ten seconds is far past any real client's first write and far
 * short of a resource problem.
 */
export const AUTH_GRACE_MS = 10_000;
