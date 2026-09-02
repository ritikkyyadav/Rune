/**
 * The supervisor's idle host reaper (P10.0).
 *
 * `gear serve`, `gear web` and `gear acp` all run one `engine-host` process per
 * session. Until this landed, nothing ever stopped one: the idle window was
 * thirty minutes and the shutdown path deliberately let every host live, so
 * hosts only ever accumulated. 183 idle engines were counted on the developer's
 * machine in a single day, and they made unrelated integration tests time out
 * at sixty seconds.
 *
 * The rule has three ways to spare a host — a client is watching it, a request
 * is in flight, or it was touched inside the window — and getting any of them
 * wrong kills a session mid-edit. So the clock is fake and the hosts are fake,
 * and what is under test is the real `HostPool`, not a copy of its policy.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_IDLE_HOST_SECS,
  HostPool,
  type PooledClient,
  reapableKeys,
} from "../../../packages/orchestrator/src/bin/serve-cli";

// The pool writes its registry under GEAR_HOME even when the hosts are fake.
// Point that somewhere disposable rather than at the developer's real one.
const home = mkdtempSync(join(tmpdir(), "gear-reaper-home-"));
const priorHome = process.env.GEAR_HOME;
const realKill = process.kill.bind(process);
const signalled: Array<{ pid: number; signal: string | number }> = [];

/**
 * Pids this file invents live in one band; every other signal falls through.
 * A unit test that actually SIGTERMed pid 4200 on the host machine would be a
 * very exciting way to fail.
 */
beforeAll(() => {
  process.env.GEAR_HOME = home;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid >= 4200 && pid < 5000) {
      signalled.push({ pid, signal: signal ?? "SIGTERM" });
      // `processAlive` probes with signal 0; report these as already gone so
      // `shutdownAll` never waits out its grace period.
      if (signal === 0) throw new Error("no such process");
      return true;
    }
    return realKill(pid, signal as never);
  }) as typeof process.kill;
});

afterAll(() => {
  process.kill = realKill;
  if (priorHome === undefined) delete process.env.GEAR_HOME;
  else process.env.GEAR_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
});

// ─── A host that is a promise, not a process ───

class FakeClient implements PooledClient {
  isClosed = false;
  closed = 0;
  streamHandler: ((frame: { stream: string; payload: unknown }) => void) | null = null;
  /** Resolve/reject hooks for the request currently in flight. */
  private settle: ((v: unknown) => void) | null = null;

  close(): void {
    this.closed++;
    this.isClosed = true;
  }

  request(): Promise<unknown> {
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  finish(value: unknown = "ok"): void {
    this.settle?.(value);
    this.settle = null;
  }

  onStream(handler: (frame: { stream: string; payload: unknown }) => void): void {
    this.streamHandler = handler;
  }
}

/** Spin the real event loop until a condition holds (the clock stays fake). */
async function until(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error("condition never became true");
}

/** A pool whose hosts are objects and whose clock is a variable. */
let nextPid = 4200;
function fakePool(opts: { idleMs?: number; hasClient?: (key: string) => boolean } = {}): {
  pool: HostPool;
  clients: Map<string, FakeClient>;
  advance: (ms: number) => void;
  killed: () => Array<{ pid: number; signal: string | number }>;
} {
  let clock = 1_000_000;
  const clients = new Map<string, FakeClient>();
  const mine = new Set<number>();

  const pool = new HostPool({
    workspace: join(home, "workspace"),
    onStream: () => {},
    idleMs: opts.idleMs,
    hasClient: opts.hasClient,
    now: () => clock,
    spawnHost: async (key) => {
      const client = new FakeClient();
      clients.set(key, client);
      const pid = nextPid++;
      mine.add(pid);
      return { pid, client };
    },
  });

  return {
    pool,
    clients,
    advance: (ms: number) => {
      clock += ms;
    },
    killed: () => signalled.filter((s) => mine.has(s.pid)),
  };
}

// ─── The policy, on its own ───

describe("reapableKeys — the whole rule, as a function", () => {
  const host = (over: Partial<{ key: string; lastUsedAt: number; inFlight: number }> = {}) => ({
    key: "s1",
    socket: "/run/s1.sock",
    pid: 1,
    client: new FakeClient(),
    lastUsedAt: 0,
    inFlight: 0,
    ...over,
  });

  test("an untouched host past the window is reapable", () => {
    expect(reapableKeys([host()], { now: 600_001, maxIdleMs: 600_000 })).toEqual(["s1"]);
  });

  test("one millisecond short of the window is spared; exactly on it is not", () => {
    expect(reapableKeys([host()], { now: 599_999, maxIdleMs: 600_000 })).toEqual([]);
    expect(reapableKeys([host()], { now: 600_000, maxIdleMs: 600_000 })).toEqual(["s1"]);
  });

  test("a request in flight spares a host however long it has been quiet", () => {
    // The case that matters: `chat_start` is one request that can run for a
    // quarter of an hour with nothing else routed to the host.
    const running = host({ inFlight: 1, lastUsedAt: 0 });
    expect(reapableKeys([running], { now: 60 * 60_000, maxIdleMs: 600_000 })).toEqual([]);
  });

  test("a watching client spares a host", () => {
    expect(
      reapableKeys([host()], {
        now: 600_001,
        maxIdleMs: 600_000,
        hasClient: (k) => k === "s1",
      }),
    ).toEqual([]);
  });

  test("it reaps only what qualifies, and names it", () => {
    const hosts = [
      host({ key: "idle", lastUsedAt: 0 }),
      host({ key: "busy", lastUsedAt: 0, inFlight: 2 }),
      host({ key: "watched", lastUsedAt: 0 }),
      host({ key: "fresh", lastUsedAt: 600_000 }),
    ];
    expect(
      reapableKeys(hosts, {
        now: 700_000,
        maxIdleMs: 600_000,
        hasClient: (k) => k === "watched",
      }),
    ).toEqual(["idle"]);
  });

  test("the default window is ten minutes", () => {
    expect(DEFAULT_IDLE_HOST_SECS).toBe(600);
  });
});

// ─── The pool, driving that rule ───

describe("HostPool.reapIdle on a fake clock", () => {
  test("a host acquired and abandoned is stopped once the window passes", async () => {
    const { pool, clients, advance, killed } = fakePool({ idleMs: 600_000 });
    await pool.acquire("s1");
    expect(pool.size).toBe(1);

    advance(599_000);
    expect(pool.reapIdle()).toBe(0);
    expect(pool.size).toBe(1);

    advance(2_000);
    expect(pool.reapIdle()).toBe(1);
    expect(pool.size).toBe(0);
    // Stopped, not merely forgotten: the client is closed AND the process is
    // signalled. Forgetting alone is exactly the leak this replaced.
    expect(clients.get("s1")!.closed).toBe(1);
    expect(killed().some((s) => s.signal === "SIGTERM")).toBe(true);
  });

  test("acquiring again resets the window", async () => {
    const { pool, advance } = fakePool({ idleMs: 600_000 });
    await pool.acquire("s1");
    advance(590_000);
    await pool.acquire("s1");
    advance(590_000);
    expect(pool.reapIdle()).toBe(0);
    advance(20_000);
    expect(pool.reapIdle()).toBe(1);
  });

  test("a turn in flight is never reaped, and is reapable once it answers", async () => {
    const { pool, clients, advance } = fakePool({ idleMs: 600_000 });
    const inFlight = pool.request("s1", "chat_start", { message: "go" });
    // Let `acquire` settle so the host exists before the clock jumps.
    await until(() => pool.snapshot()[0]?.inFlight === 1);
    expect(pool.size).toBe(1);
    expect(pool.snapshot()[0]!.inFlight).toBe(1);

    advance(60 * 60_000);
    expect(pool.reapIdle()).toBe(0);

    clients.get("s1")!.finish("done");
    await inFlight;
    expect(pool.snapshot()[0]!.inFlight).toBe(0);
    // The answer counts as activity, so the window starts from now.
    expect(pool.reapIdle()).toBe(0);
    advance(600_001);
    expect(pool.reapIdle()).toBe(1);
  });

  test("a stream frame keeps a silent host alive", async () => {
    const { pool, clients, advance } = fakePool({ idleMs: 600_000 });
    await pool.acquire("s1");
    advance(590_000);
    // The host is streaming turn events at us — it is working, not parked.
    clients.get("s1")!.streamHandler!({ stream: "chat_event", payload: {} });
    advance(590_000);
    expect(pool.reapIdle()).toBe(0);
    advance(20_000);
    expect(pool.reapIdle()).toBe(1);
  });

  test("a connected client keeps its host forever", async () => {
    const watched = new Set<string>(["s1"]);
    const { pool, advance } = fakePool({ idleMs: 600_000, hasClient: (k) => watched.has(k) });
    await pool.acquire("s1");
    advance(24 * 60 * 60_000);
    expect(pool.reapIdle()).toBe(0);
    watched.delete("s1");
    expect(pool.reapIdle()).toBe(1);
  });

  test("shutdownAll stops every host and empties the pool", async () => {
    const { pool, clients, killed } = fakePool();
    await pool.acquire("a");
    await pool.acquire("b");
    await pool.acquire("control");
    expect(pool.size).toBe(3);

    expect(await pool.shutdownAll(0)).toBe(3);
    expect(pool.size).toBe(0);
    for (const client of clients.values()) expect(client.closed).toBe(1);
    expect(killed().filter((s) => s.signal === "SIGTERM").length).toBe(3);
  });

  test("detachAll leaves the processes alone — the --keep-hosts contract", async () => {
    const { pool, clients, killed } = fakePool();
    await pool.acquire("a");
    await pool.acquire("b");

    const sockets = pool.detachAll();
    expect(sockets.length).toBe(2);
    expect(pool.size).toBe(0);
    // Clients closed (we let go of the wire), processes untouched (they keep
    // editing files).
    for (const client of clients.values()) expect(client.closed).toBe(1);
    expect(killed().length).toBe(0);
  });
});
