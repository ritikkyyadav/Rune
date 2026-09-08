// ─── The transport a host is reached on, decided once and asserted here ───
//
// The defect this covers shipped in v0.4.0 and could not be seen from a Mac:
// `rune serve` dialled its session hosts over a unix domain socket on every
// platform, and Windows cannot bind one. The Windows release job installed the
// binary, ran `--version`, `doctor`, `tools-smoke` and a real prompt, then sat
// for twenty seconds on `rune serve --check` and printed `✗ Failed to connect`.
//
// So the choice is a pure function of the platform string, and these tests ask
// it the Windows question from wherever they happen to run.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTH_GRACE_MS,
  TRANSPORT_ENV,
  authFrame,
  authorizes,
  encodeEndpoint,
  hostTransportFor,
  isLoopbackHost,
  mintHostToken,
  parseEndpoint,
  readAuthToken,
  readEndpointFile,
  resolveHostTarget,
  writeEndpointFile,
} from "../../../packages/orchestrator/src/host-transport";
import {
  hostStartFailure,
  readLogTail,
  tailLines,
} from "../../../packages/orchestrator/src/bin/host-spawn";

const POSIX = process.platform !== "win32";
const NO_ENV: Record<string, string | undefined> = {};

describe("hostTransportFor", () => {
  test("Windows gets TCP; every unix-alike keeps the unix socket", () => {
    expect(hostTransportFor("win32", NO_ENV)).toBe("tcp");
    expect(hostTransportFor("darwin", NO_ENV)).toBe("unix");
    expect(hostTransportFor("linux", NO_ENV)).toBe("unix");
    expect(hostTransportFor("freebsd", NO_ENV)).toBe("unix");
  });

  test("the env override runs the Windows transport on a POSIX machine", () => {
    // The point of the override: without it the Windows path is reachable
    // only from Windows, which is how it shipped broken.
    expect(hostTransportFor("darwin", { [TRANSPORT_ENV]: "tcp" })).toBe("tcp");
    expect(hostTransportFor("darwin", { [TRANSPORT_ENV]: " TCP " })).toBe("tcp");
    expect(hostTransportFor("win32", { [TRANSPORT_ENV]: "unix" })).toBe("unix");
  });

  test("junk in the override is ignored rather than obeyed", () => {
    expect(hostTransportFor("darwin", { [TRANSPORT_ENV]: "pipes-please" })).toBe("unix");
    expect(hostTransportFor("win32", { [TRANSPORT_ENV]: "" })).toBe("tcp");
  });
});

describe("the rendezvous file", () => {
  const good = { host: "127.0.0.1", port: 51_234, token: mintHostToken() };

  test("round-trips", () => {
    const parsed = parseEndpoint(encodeEndpoint(good));
    expect(parsed).toEqual({ transport: "tcp", ...good });
  });

  test("a half-written or absent file parses as 'not yet', not as an error", () => {
    // Every caller is inside a retry loop; null means the host is still
    // booting, which must not look the same as a corrupt install.
    expect(parseEndpoint("")).toBeNull();
    expect(parseEndpoint('{"transport":"tcp","host":"127.0.0.1","po')).toBeNull();
    expect(parseEndpoint("null")).toBeNull();
    expect(parseEndpoint("[]")).toBeNull();
  });

  test("refuses an endpoint that is not a loopback TCP host", () => {
    expect(parseEndpoint(JSON.stringify({ ...good, transport: "unix" }))).toBeNull();
    // A file can be edited. Nothing dials off-machine because JSON said so.
    expect(parseEndpoint(encodeEndpoint({ ...good, host: "10.0.0.5" }))).toBeNull();
    expect(parseEndpoint(encodeEndpoint({ ...good, host: "0.0.0.0" }))).toBeNull();
  });

  test("refuses a port or a token that could not have been minted", () => {
    expect(parseEndpoint(encodeEndpoint({ ...good, port: 0 }))).toBeNull();
    expect(parseEndpoint(encodeEndpoint({ ...good, port: 70_000 }))).toBeNull();
    expect(parseEndpoint(encodeEndpoint({ ...good, port: 1.5 }))).toBeNull();
    expect(parseEndpoint(encodeEndpoint({ ...good, token: "short" }))).toBeNull();
    expect(parseEndpoint(encodeEndpoint({ ...good, token: "not a token at all!!" }))).toBeNull();
  });

  test("isLoopbackHost knows the three spellings and nothing else", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
  });

  test("is written owner-only, because the token in it IS the door", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-endpoint-"));
    try {
      const path = join(dir, "host.sock");
      writeEndpointFile(path, good);
      expect(readEndpointFile(path)).toEqual({ transport: "tcp", ...good });
      if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);

      // A leftover from a crashed host must not keep its old, laxer mode.
      writeFileSync(path, "stale", { mode: 0o644 });
      writeEndpointFile(path, good);
      if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readEndpointFile is null for a path that is not there", () => {
    expect(readEndpointFile(join(tmpdir(), "rune-nothing-here-9d3f.sock"))).toBeNull();
  });
});

describe("resolveHostTarget", () => {
  test("on unix the rendezvous path IS the socket", () => {
    expect(resolveHostTarget("/tmp/a.sock", "unix")).toEqual({ kind: "unix", path: "/tmp/a.sock" });
  });

  test("on tcp it reads the port and token out of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-endpoint-"));
    try {
      const path = join(dir, "host.sock");
      const ep = { host: "127.0.0.1", port: 49_999, token: mintHostToken() };
      writeEndpointFile(path, ep);
      expect(resolveHostTarget(path, "tcp")).toEqual({ kind: "tcp", ...ep });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on tcp a missing file throws, which every caller reads as 'not up yet'", () => {
    expect(() => resolveHostTarget(join(tmpdir(), "rune-absent-4a1.sock"), "tcp")).toThrow(
      /no host endpoint/,
    );
  });
});

describe("the TCP handshake", () => {
  const token = mintHostToken();

  test("a client's first line carries the token and nothing else", () => {
    expect(readAuthToken(authFrame(token))).toBe(token);
    expect(authorizes(authFrame(token), token)).toBe(true);
  });

  test("a wrong token is refused", () => {
    expect(authorizes(authFrame(mintHostToken()), token)).toBe(false);
    expect(authorizes(authFrame(token.slice(0, -1)), token)).toBe(false);
  });

  test("skipping the handshake is refused, however valid the command is", () => {
    // The whole protection: a local process that can reach the port must not
    // be able to drive the engine by simply starting to talk.
    const command = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_status", params: {} });
    expect(readAuthToken(command)).toBeNull();
    expect(authorizes(command, token)).toBe(false);
    expect(authorizes("", token)).toBe(false);
    expect(authorizes("not json", token)).toBe(false);
    expect(authorizes(JSON.stringify({ method: "host_auth" }), token)).toBe(false);
    expect(authorizes(JSON.stringify({ method: "host_auth", params: {} }), token)).toBe(false);
  });

  test("an unauthenticated connection is not allowed to sit there forever", () => {
    expect(AUTH_GRACE_MS).toBeGreaterThan(0);
    expect(AUTH_GRACE_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("what a failed host start says", () => {
  test("names the host, whether it is still alive, and what it printed", () => {
    const msg = hostStartFailure({
      address: "C:\\Users\\r\\.rune\\run\\serve-control-x.sock",
      pid: 4242,
      alive: false,
      reason: "Failed to connect",
      log: ["engine-host: booting", "SqliteError: database is locked"],
    });
    expect(msg).toContain("4242");
    expect(msg).toContain("exited before answering");
    expect(msg).toContain("Failed to connect");
    expect(msg).toContain("SqliteError: database is locked");
  });

  test("a host that is STILL RUNNING is a different investigation, and says so", () => {
    const msg = hostStartFailure({
      address: "/tmp/a.sock",
      pid: 7,
      alive: true,
      reason: "timed out",
      log: [],
    });
    expect(msg).toContain("still running");
    expect(msg).toContain("the host log is empty");
  });

  test("tailLines keeps the last lines and drops the blank ones", () => {
    expect(tailLines("a\n\nb\r\nc\n", 2)).toEqual(["b", "c"]);
    expect(tailLines("", 5)).toEqual([]);
    expect(readLogTail(join(tmpdir(), "rune-no-log-8c2.log"))).toEqual([]);
  });
});
