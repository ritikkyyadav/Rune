// ─── The Windows host transport, run on whatever machine this is ───
//
// `engine-host --socket <path>` binds a unix domain socket on POSIX and, since
// P13.2, a loopback TCP port on Windows — with the rendezvous path holding the
// port and a per-host token instead of a socket. That Windows half shipped
// untested in v0.4.0 for exactly one reason: it could only be run on Windows,
// and the release job was the first thing that ever did.
//
// `RUNE_HOST_TRANSPORT=tcp` closes that. These tests run the Windows transport
// end to end — a real host process, a real port, a real handshake — on Linux
// and macOS CI, so what is left untested off Windows is only whether Bun binds
// a loopback port there, which every other test in the suite already answers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostClient } from "../../packages/orchestrator/src/host-client";
import {
  type TcpEndpoint,
  authFrame,
  mintHostToken,
  readEndpointFile,
} from "../../packages/orchestrator/src/host-transport";

const HOST_SCRIPT = join(import.meta.dir, "../../packages/orchestrator/src/bin/engine-host.ts");
const RUST_RELEASE = join(import.meta.dir, "../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/rune-tools");
const RUST_BIN = process.env.RUNE_TOOLS_BIN
  ? process.env.RUNE_TOOLS_BIN
  : existsSync(RUST_RELEASE)
    ? RUST_RELEASE
    : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);
const POSIX = process.platform !== "win32";

/** Wait for the host to publish a COMPLETE rendezvous file. */
async function waitForEndpoint(path: string, timeoutMs = 15_000): Promise<TcpEndpoint> {
  const start = Date.now();
  for (;;) {
    const ep = readEndpointFile(path);
    if (ep) return ep;
    if (Date.now() - start > timeoutMs) throw new Error(`no endpoint at ${path} in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Speak to a TCP host by hand, so the handshake can be got WRONG on purpose.
 *
 * Returns every line the host sent before it hung up (or before the deadline),
 * which for a refused connection is none — that is the assertion.
 */
async function rawExchange(ep: TcpEndpoint, firstLine: string, waitMs = 1_500): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    let buffer = "";
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(lines);
    };
    const timer = setTimeout(finish, waitMs);
    Bun.connect({
      hostname: ep.host,
      port: ep.port,
      socket: {
        open(socket) {
          socket.write(firstLine);
        },
        data(_socket, chunk) {
          buffer += chunk.toString();
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const p of parts) if (p.trim()) lines.push(p);
        },
        close: finish,
        error: finish,
        connectError: finish,
      },
    }).catch(finish);
  });
}

describe("engine-host over loopback TCP (the Windows transport)", () => {
  let dir: string;
  let host: ReturnType<typeof Bun.spawn> | null = null;
  let previousTransport: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-host-tcp-"));
    // HostClient resolves the transport from THIS process's environment, so
    // the client half has to be pointed at TCP too.
    previousTransport = process.env.RUNE_HOST_TRANSPORT;
    process.env.RUNE_HOST_TRANSPORT = "tcp";
  });

  afterEach(async () => {
    host?.kill();
    await host?.exited.catch(() => {});
    host = null;
    if (previousTransport === undefined) delete process.env.RUNE_HOST_TRANSPORT;
    else process.env.RUNE_HOST_TRANSPORT = previousTransport;
    rmSync(dir, { recursive: true, force: true });
  });

  function spawnHost(socketPath: string): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(["bun", HOST_SCRIPT, "--socket", socketPath], {
      env: {
        ...process.env,
        RUNE_HOST_TRANSPORT: "tcp",
        RUNE_WORKSPACE: dir,
        RUNE_DB_PATH: join(dir, "rune.db"),
        RUNE_TOOLS_BIN: RUST_BIN,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
  }

  test.skipIf(!HAS_RUST_BIN)(
    "publishes a loopback port and a token, owner-readable only",
    async () => {
      const rendezvous = join(dir, "host.sock");
      host = spawnHost(rendezvous);
      const ep = await waitForEndpoint(rendezvous);

      expect(ep.transport).toBe("tcp");
      expect(ep.host).toBe("127.0.0.1");
      expect(ep.port).toBeGreaterThan(0);
      // The port is not the secret — this is.
      expect(ep.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
      // What replaces the unix socket's file permissions on the file that
      // carries the token.
      if (POSIX) expect(statSync(rendezvous).mode & 0o777).toBe(0o600);
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "serves a session over TCP exactly as it does over a unix socket",
    async () => {
      const rendezvous = join(dir, "host.sock");
      host = spawnHost(rendezvous);
      await waitForEndpoint(rendezvous);

      const a = await HostClient.connect(rendezvous, 15_000);
      const sessionId = (await a.request("create_session")) as string;
      expect(typeof sessionId).toBe("string");
      a.close(); // a killed terminal, with no goodbye

      await new Promise((r) => setTimeout(r, 150));

      // The point of socket mode survives the change of transport: the host
      // outlives its client, and the next client finds the same state.
      const b = await HostClient.connect(rendezvous, 15_000);
      const sessions = (await b.request("list_sessions")) as Array<{ id: string }>;
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
      expect(((await b.request("get_status")) as { state: string }).state).toBe("connected");
      b.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "refuses a wrong token, and says nothing at all while refusing",
    async () => {
      const rendezvous = join(dir, "host.sock");
      host = spawnHost(rendezvous);
      const ep = await waitForEndpoint(rendezvous);

      // Any local process can reach a loopback port; the token is the only
      // thing standing between it and the engine. A refused peer gets no
      // `ready`, no status, nothing it could learn from.
      expect(await rawExchange(ep, authFrame(mintHostToken()))).toEqual([]);

      // And the host is unharmed by the attempt.
      const c = await HostClient.connect(rendezvous, 15_000);
      expect(((await c.request("get_status")) as { state: string }).state).toBe("connected");
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "refuses a client that skips the handshake and just issues a command",
    async () => {
      const rendezvous = join(dir, "host.sock");
      host = spawnHost(rendezvous);
      const ep = await waitForEndpoint(rendezvous);

      const command =
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_status", params: {} }) + "\n";
      expect(await rawExchange(ep, command)).toEqual([]);
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a second host refuses a rendezvous a live host owns, and takes over a stale one",
    async () => {
      const rendezvous = join(dir, "host.sock");
      host = spawnHost(rendezvous);
      await waitForEndpoint(rendezvous);
      const probe = await HostClient.connect(rendezvous, 15_000);
      probe.close();

      const second = spawnHost(rendezvous);
      expect(await second.exited).toBe(1);

      // The original is unharmed…
      const still = await HostClient.connect(rendezvous, 15_000);
      expect(((await still.request("get_status")) as { state: string }).state).toBe("connected");
      still.close();

      // …and once it is gone, its file is a stale one the next host may claim.
      // SIGKILL, not SIGTERM: the clean shutdown removes the rendezvous file,
      // and the case worth testing is the one where nothing did.
      const stale = readEndpointFile(rendezvous);
      host.kill("SIGKILL");
      await host.exited.catch(() => {});
      expect(existsSync(rendezvous)).toBe(true);

      host = spawnHost(rendezvous);
      // Wait for the file to become the NEW host's — a new host mints a new
      // token, so a changed token is the takeover, not merely a file existing.
      const deadline = Date.now() + 15_000;
      let fresh = stale;
      while (Date.now() < deadline && fresh?.token === stale?.token) {
        await new Promise((r) => setTimeout(r, 100));
        fresh = readEndpointFile(rendezvous);
      }
      expect(fresh?.token).not.toBe(stale?.token);
      const c = await HostClient.connect(rendezvous, 15_000);
      expect(((await c.request("get_status")) as { state: string }).state).toBe("connected");
      c.close();
    },
    45_000,
  );
});
