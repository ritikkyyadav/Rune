import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostClient } from "../../packages/orchestrator/src/host-client";

const HOST_SCRIPT = join(import.meta.dir, "../../packages/orchestrator/src/bin/engine-host.ts");
const RUST_RELEASE = join(import.meta.dir, "../../target/release/gear-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/gear-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

// P6 acceptance mechanics: the host process outlives its clients. A client
// that dies (terminal killed) leaves the engine running; the next client
// attaches to the same socket and the same session store.

async function waitForSocket(path: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`socket never appeared at ${path}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("engine-host --socket (detach/attach transport)", () => {
  let dir: string;
  let host: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gear-host-"));
  });

  afterEach(async () => {
    host?.kill();
    await host?.exited.catch(() => {});
    host = null;
    rmSync(dir, { recursive: true, force: true });
  });

  function spawnHost(socketPath: string): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(["bun", HOST_SCRIPT, "--socket", socketPath], {
      env: {
        ...process.env,
        GEAR_WORKSPACE: dir,
        GEAR_DB_PATH: join(dir, "gear.db"),
        GEAR_TOOLS_BIN: RUST_BIN,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
  }

  test.skipIf(!HAS_RUST_BIN)(
    "host survives a dead client; the next client attaches to the same state",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);

      // Client A: create a session, then die abruptly (terminal killed).
      const a = await HostClient.connect(sock);
      const readyA = new Promise<void>((resolve) => {
        a.onStream((f) => {
          if (f.stream === "ready") resolve();
        });
      });
      await readyA;
      const sessionId = (await a.request("create_session")) as string;
      expect(typeof sessionId).toBe("string");
      a.close(); // no goodbye, no shutdown — exactly what a killed terminal does

      // Give the host a beat to notice the disconnect.
      await new Promise((r) => setTimeout(r, 150));

      // Client B: the host is still there, and so is the session.
      const b = await HostClient.connect(sock);
      const sessions = (await b.request("list_sessions")) as Array<{ id: string }>;
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);
      const status = (await b.request("get_status")) as { state: string };
      expect(status.state).toBe("connected");
      b.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a second host refuses a socket a live host owns",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const probe = await HostClient.connect(sock); // ensure it's actually serving
      probe.close();

      const second = spawnHost(sock);
      const code = await second.exited;
      expect(code).toBe(1);

      // The original host is unharmed.
      const still = await HostClient.connect(sock);
      expect(((await still.request("get_status")) as { state: string }).state).toBe("connected");
      still.close();
    },
    30_000,
  );
});
