// ─── `rune serve --check` — the served engine, proved by the artifact itself ───
//
// Every gate before P10.9a ran Rune from source with `bun`, and the defect that
// broke the installed binary was invisible from there by construction: a
// source run spawns `bun engine-host.ts` from a directory that exists, while a
// compiled binary has to spawn ITSELF as `rune engine-host`. The founder
// installed the binary and the first session never started.
//
// So this check exists to be run BY the compiled binary, and it asserts the
// three things a program driving `rune serve` — `rune attach ws://`, the SDK,
// a CI step — actually needs:
//
//   1. the server comes up and mints a token;
//   2. a session starts over the WebSocket and a prompt completes
//      (`turn_complete`) against a mock provider that needs no credential —
//      which can only happen if an engine host actually spawned;
//   3. shutting down leaves no host behind.
//
// Everything is the shipping code except the model. The provider is `custom`,
// the user-defined OpenAI-compatible endpoint whose base URL comes from
// `secrets.json` — the one seam that lets a spawned host, which builds its own
// Engine from config rather than from a constructor, be pointed at a server
// this process owns.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROTOCOL_VERSION, encodeFrame, rpcRequest, toResult, toStream } from "@rune/protocol";
import { getRuneHome } from "@rune/shared";

import { currentContext, hostSpawnLabel, isCompiled } from "./host-spawn";
import { serve } from "./serve-cli";

// ─── The fake model ───

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "check-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

// ─── A minimal protocol client, so the check needs no test harness ───

class CheckClient {
  private readonly frames: Array<{ stream: string; payload: Record<string, unknown> }> = [];
  private readonly pending = new Map<number, (r: { ok: boolean; value: unknown }) => void>();
  private nextId = 1;
  private constructor(private readonly ws: WebSocket) {}

  static open(url: string, token: string): Promise<CheckClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [`rune.bearer.${token}`]);
      const client = new CheckClient(ws);
      const timer = setTimeout(() => reject(new Error("the websocket never opened")), 20_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(client);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("the websocket was refused"));
      };
      ws.onmessage = (ev) => client.onData(String(ev.data));
    });
  }

  private onData(data: string): void {
    for (const raw of data.split("\n")) {
      if (!raw.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      const stream = toStream(frame);
      if (stream) {
        this.frames.push({
          stream: stream.stream,
          payload: (stream.payload ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const result = toResult(frame);
      if (!result || typeof result.id !== "number") continue;
      const settle = this.pending.get(result.id);
      if (!settle) continue;
      this.pending.delete(result.id);
      settle(
        result.ok ? { ok: true, value: result.result } : { ok: false, value: result.error.message },
      );
    }
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.value);
        else reject(new Error(String(r.value)));
      });
      this.ws.send(encodeFrame(rpcRequest(id, method, params)));
    });
  }

  async waitFor(
    match: (f: { stream: string; payload: Record<string, unknown> }) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.frames.some(match)) return;
      if (Date.now() > deadline) {
        const seen = [...new Set(this.frames.map((f) => f.stream))].join(", ") || "(nothing)";
        throw new Error(`timed out after ${timeoutMs}ms; the server sent: ${seen}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ─── The check ───

interface HostRecord {
  key: string;
  pid: number;
}

/** The hosts this server currently owns, from the registry it writes. */
function registeredHosts(): HostRecord[] {
  try {
    const raw = readFileSync(join(getRuneHome(), "run", "serve-hosts.json"), "utf8");
    const parsed = JSON.parse(raw) as HostRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Which of these pids are still alive. Exported for the unit test. */
export function stillAlive(pids: number[], alive: (pid: number) => boolean): number[] {
  return pids.filter(alive);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runServeCheck(values: Record<string, unknown>): Promise<number> {
  const started = Date.now();
  const ctx = currentContext(import.meta.dir);
  const step = (text: string): void => console.log(`  · ${text}`);
  const pass = (text: string): void => console.log(`  ✓ ${text}`);

  console.log("rune serve --check");
  console.log(`  binary     ${process.execPath}`);
  console.log(`  mode       ${isCompiled(ctx) ? "compiled" : "source"}`);
  console.log(`  hosts      ${hostSpawnLabel(ctx)}`);

  // ── an isolated home, so a check never touches real sessions ──
  const dir = mkdtempSync(join(tmpdir(), "rune-serve-check-"));
  const runeHome = join(dir, "home");
  const workspace = join(dir, "workspace");
  mkdirSync(runeHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# check\n");

  // Set BEFORE anything resolves a path: `getRuneHome()` is memoized on the
  // env, and the spawned hosts inherit this process's environment, which is
  // how they end up in the same throwaway home.
  process.env.RUNE_HOME = runeHome;
  process.env.RUNE_WORKSPACE = workspace;
  process.env.RUNE_DB_PATH = join(dir, "rune.db");

  let model: ReturnType<typeof Bun.serve> | null = null;
  let running: { stop: () => Promise<void> | void; port: number } | null = null;
  let client: CheckClient | null = null;
  let hostPids: number[] = [];

  try {
    // ── 2. a model that needs no credential ──
    model = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.text();
        return new Response(sseText("check-ok"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    writeFileSync(
      join(runeHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "check-model" }),
    );
    writeFileSync(
      join(runeHome, "secrets.json"),
      JSON.stringify({
        custom: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: "check-model",
          key: "a-key-the-check-server-ignores",
        },
      }),
      { mode: 0o600 },
    );

    // ── 3. the server ──
    const port = Number(values.port ?? 0) || 0;
    running = await serve({
      port,
      host: "127.0.0.1",
      workspace,
      // The check owns what it starts: the point of step 6 is that nothing
      // survives it.
      keepHosts: false,
    });
    pass(`listening on 127.0.0.1:${running.port}`);

    const token = (
      JSON.parse(readFileSync(join(runeHome, "serve.json"), "utf8")) as { token: string }
    ).token;

    // ── 5. one session, one turn, over the WebSocket ──
    step("opening a session over the websocket");
    client = await CheckClient.open(`ws://127.0.0.1:${running.port}`, token);
    const hello = (await client.call("hello", { client: "serve-check" })) as {
      protocolVersion: string;
    };
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`protocol ${hello.protocolVersion}, expected ${PROTOCOL_VERSION}`);
    }
    const sessionId = (await client.call("create_session")) as string;
    await client.call("chat_start", { sessionId, message: "say check-ok" });
    // This is where a broken host spawn shows up: the frame never arrives
    // because there is no engine behind the socket.
    await client.waitFor(
      (f) =>
        f.stream === "chat_event" &&
        (f.payload as { event?: { type?: string } }).event?.type === "turn_complete",
      120_000,
    );
    hostPids = registeredHosts().map((h) => h.pid);
    if (hostPids.length === 0) throw new Error("the turn completed but no host was registered");
    pass(`turn_complete on session ${sessionId.slice(0, 8)} (host pid ${hostPids.join(", ")})`);

    // ── 6. shutdown leaves nothing behind ──
    step("shutting down");
    client.close();
    client = null;
    await running.stop();
    running = null;
    // The host drains its round-trips on SIGTERM, so give it the moment its
    // handler needs before calling it a leak.
    for (let i = 0; i < 40 && stillAlive(hostPids, pidAlive).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const leaked = stillAlive(hostPids, pidAlive);
    if (leaked.length > 0)
      throw new Error(`${leaked.length} host(s) left running: ${leaked.join(", ")}`);
    const stillRegistered = registeredHosts();
    if (stillRegistered.length > 0) {
      throw new Error(`${stillRegistered.length} host(s) still in the registry`);
    }
    pass("zero leaked hosts");

    console.log(`  ✓ the binary hosts a session (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return 0;
  } catch (error) {
    console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    client?.close();
    if (running) {
      try {
        await running.stop();
      } catch {
        /* already down */
      }
    }
    model?.stop(true);
    // Never leave a host behind because the check itself failed.
    for (const pid of stillAlive(hostPids, pidAlive)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    removeCheckDir(dir);
  }
}

/**
 * Remove the check's scratch directory without ever failing the check.
 *
 * On Windows a host that was just told to exit still holds its working
 * directory for a moment, and `rmSync` answers EBUSY — which turned a check
 * that had printed "✓ the binary hosts a session" into exit code 1 on the
 * v0.4.0 release runner. Retry briefly; if it still will not go, say so and
 * leave it: a leftover temp directory is not a failed session.
 */
function removeCheckDir(dir: string): void {
  if (!existsSync(dir)) return;
  const started = Date.now();
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || Date.now() - started > 5_000) {
        console.error(`  · could not remove ${dir} (${code ?? "unknown"}); leaving it`);
        return;
      }
      Bun.sleepSync(100);
    }
  }
}
