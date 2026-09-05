import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostClient } from "../../packages/orchestrator/src/host-client";
import { HOST_COMMANDS, PROTOCOL_VERSION } from "../../packages/protocol/src/index";

const HOST_SCRIPT = join(import.meta.dir, "../../packages/orchestrator/src/bin/engine-host.ts");
const RUST_RELEASE = join(import.meta.dir, "../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/rune-tools");
// An installed binary counts. Without this the whole file skipped on any
// machine that had run the installer but not `cargo build`, which is every
// machine that only ever consumed a release.
const RUST_BIN = process.env.RUNE_TOOLS_BIN
  ? process.env.RUNE_TOOLS_BIN
  : existsSync(RUST_RELEASE)
    ? RUST_RELEASE
    : RUST_DEBUG;
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
    dir = mkdtempSync(join(tmpdir(), "rune-host-"));
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
        RUNE_WORKSPACE: dir,
        RUNE_DB_PATH: join(dir, "rune.db"),
        RUNE_TOOLS_BIN: RUST_BIN,
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

  // ─── P2.2: the protocol surface a non-terminal client needs ───

  test.skipIf(!HAS_RUST_BIN)(
    "hello reports the protocol version and every command this build serves",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);

      const hello = await c.call("hello", { client: "integration-test" });
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
      // The manifest is the contract. A command the protocol declares and the
      // host does not serve would be a runtime "unknown command" a client only
      // discovered in production.
      expect([...hello.commands].sort()).toEqual([...HOST_COMMANDS].sort());
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "every round-trip command is reachable and refuses a stale request id",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);

      // Nothing is pending, so every answer is stale rather than an error. The
      // point is that all four commands EXIST: before P2.2 only permission did,
      // and ask_user answered "No interactive user is available" off-terminal.
      expect(await c.call("respond_permission", { requestId: "nope", decision: "deny" })).toEqual({
        stale: true,
      });
      expect(await c.call("respond_question", { requestId: "nope", answer: "x" })).toEqual({
        stale: true,
      });
      expect(
        await c.call("respond_brief", { requestId: "nope", decision: { accepted: true } }),
      ).toEqual({ stale: true });
      expect(await c.call("respond_research_plan", { requestId: "nope", approved: true })).toEqual({
        stale: true,
      });
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "an invented permission decision is refused at the door",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);

      // The one validation that must not be lenient: a client must not be able
      // to answer a permission gate with an approval kind the engine does not
      // have. Strict inbound validation is what makes that impossible.
      await expect(
        c.request("respond_permission", { requestId: "x", decision: "allow_forever" }),
      ).rejects.toThrow(/allow_once/);
      // And an unknown command is methodNotFound, not a mysterious 500.
      await expect(c.request("rm_rf", {})).rejects.toThrow(/unknown command/);
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "held steps are addressable by id, and an unknown id is refused not run",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);
      const sessionId = await c.call("create_session");

      // A turn that held nothing has an empty ledger — not an error.
      expect(await c.call("list_held_steps", { sessionId })).toEqual([]);

      // The safety property: a client names an ID. It cannot hand the host a
      // payload to run, which is what keeps raw unredacted arguments off the
      // wire and "run exactly this" exact.
      const result = await c.call("run_held_step", { sessionId, stepId: "held-999" });
      expect(result.ran).toBe(false);
      expect(result.refusal).toMatch(/no held step/);

      expect(await c.call("dismiss_held_steps", { sessionId })).toEqual({ dismissed: 0 });
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "subscribe returns settled state, not a keystroke replay",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);
      const sessionId = await c.call("create_session");

      const sub = await c.call("subscribe", { sessionId });
      expect(sub.sessionId).toBe(sessionId);
      // The flag a client is expected to SAY. `text_delta` is never persisted,
      // so a reconnect gets the assistant's text as one settled block; telling
      // the client so is the difference between state and a stream it could
      // mis-assemble into a sentence that never existed.
      expect(sub.settled).toBe(true);
      expect(sub.running).toBe(false);
      expect(Array.isArray(sub.backfill)).toBe(true);
      expect(Array.isArray(sub.userTurns)).toBe(true);
      expect(Array.isArray(sub.live)).toBe(true);
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "abort and interject name a session instead of guessing",
    async () => {
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);
      const c = await HostClient.connect(sock);
      const sessionId = await c.call("create_session");

      // Nothing is running. Both answer honestly rather than pretending.
      expect(await c.call("abort_chat", { sessionId })).toEqual({ aborted: false });
      expect(await c.call("interject_chat", { sessionId, text: "steer" })).toEqual({
        accepted: false,
      });
      c.close();
    },
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "the legacy sidecar envelope still answers, in its own dialect",
    async () => {
      // A desktop binary already in someone's Applications folder speaks
      // `{id,cmd,args}` and expects `{id,ok,result}`. A host that answered
      // JSON-RPC to it would strand every shipped client.
      const sock = join(dir, "host.sock");
      host = spawnHost(sock);
      await waitForSocket(sock);

      const frames: Record<string, unknown>[] = [];
      const socket = await Bun.connect({
        unix: sock,
        socket: {
          data(_s, chunk) {
            for (const line of chunk.toString().split("\n")) {
              if (line.trim()) frames.push(JSON.parse(line));
            }
          },
          error() {},
        },
      });
      socket.write(JSON.stringify({ id: 42, cmd: "get_status", args: {} }) + "\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !frames.some((f) => f.id === 42)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const answer = frames.find((f) => f.id === 42) as
        { id: number; ok: boolean; result: { state: string } } | undefined;
      expect(answer).toBeDefined();
      expect(answer!.ok).toBe(true);
      expect(answer!.result.state).toBe("connected");
      // …and no `jsonrpc` key on the reply to a legacy request.
      expect((answer as Record<string, unknown>).jsonrpc).toBeUndefined();
      socket.end();
    },
    30_000,
  );
});
