// ─── `gear serve --check` — the product, proved by the artifact itself ───
//
// Every gate before P10.9a ran Gear from source with `bun`. Both defects that
// broke the installed product were invisible from there by construction: a
// source run finds `apps/web/dist` on disk, and a source run spawns
// `bun engine-host.ts` from a directory that exists. The founder installed the
// binary, opened the URL, and read `unauthorized`.
//
// So this check exists to be run BY the compiled binary, and it asserts the
// four things a person doing the first thing they do actually needs:
//
//   1. there is a client to serve, and `GET /` answers 200 with the page and
//      the token already in it;
//   2. the assets that page references are served too — index.html alone
//      proves a map with one entry in it;
//   3. a session starts over the WebSocket and a prompt completes
//      (`turn_complete`) against a mock provider that needs no credential —
//      which can only happen if an engine host actually spawned;
//   4. shutting down leaves no host behind.
//
// Everything is the shipping code except the model. The provider is `custom`,
// the user-defined OpenAI-compatible endpoint whose base URL comes from
// `secrets.json` — the one seam that lets a spawned host, which builds its own
// Engine from config rather than from a constructor, be pointed at a server
// this process owns.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROTOCOL_VERSION, encodeFrame, rpcRequest, toResult, toStream } from "@gear/protocol";
import { getGearHome } from "@gear/shared";

import { referencedAssets, resolveWebBundle } from "../web-embed";
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
      const ws = new WebSocket(url, [`gear.bearer.${token}`]);
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
    const raw = readFileSync(join(getGearHome(), "run", "serve-hosts.json"), "utf8");
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

  console.log("gear serve --check");
  console.log(`  binary     ${process.execPath}`);
  console.log(`  mode       ${isCompiled(ctx) ? "compiled" : "source"}`);
  console.log(`  hosts      ${hostSpawnLabel(ctx)}`);

  // ── an isolated home, so a check never touches real sessions ──
  const dir = mkdtempSync(join(tmpdir(), "gear-serve-check-"));
  const gearHome = join(dir, "home");
  const workspace = join(dir, "workspace");
  mkdirSync(gearHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# check\n");

  // Set BEFORE anything resolves a path: `getGearHome()` is memoized on the
  // env, and the spawned hosts inherit this process's environment, which is
  // how they end up in the same throwaway home.
  process.env.GEAR_HOME = gearHome;
  process.env.GEAR_WORKSPACE = workspace;
  process.env.GEAR_DB_PATH = join(dir, "gear.db");

  let model: ReturnType<typeof Bun.serve> | null = null;
  let running: { stop: () => Promise<void> | void; port: number } | null = null;
  let client: CheckClient | null = null;
  let hostPids: number[] = [];

  try {
    // ── 1. the bundle ──
    const { sourceDistDir } = await import("./web-cli");
    const bundle = await resolveWebBundle(sourceDistDir());
    if (!bundle) {
      console.error(
        "  ✗ no web client: this build has neither an on-disk dist nor an embedded one",
      );
      console.error("    build it before compiling:  bun run --filter @gear/web build");
      console.error("    then:                       bun scripts/gen-web-embed.ts");
      return 1;
    }
    pass(`bundle: ${bundle.label} (${bundle.source})`);

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
      join(gearHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "check-model" }),
    );
    writeFileSync(
      join(gearHome, "secrets.json"),
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
      web: bundle,
      // The check owns what it starts: the point of step 6 is that nothing
      // survives it.
      keepHosts: false,
    });
    pass(`listening on 127.0.0.1:${running.port}`);

    const token = (
      JSON.parse(readFileSync(join(gearHome, "serve.json"), "utf8")) as { token: string }
    ).token;

    // ── 4. the page, with the token already in it ──
    step("GET /");
    const page = await fetch(`http://127.0.0.1:${running.port}/`);
    if (page.status !== 200) {
      throw new Error(`GET / answered ${page.status} ${await page.text()}`);
    }
    const html = await page.text();
    if (!html.includes("window.__GEAR_SERVE__")) {
      throw new Error("GET / returned a page with no embedded endpoint");
    }
    if (!html.includes(token)) {
      throw new Error("GET / returned a page with no embedded token");
    }
    pass(`GET / → 200, ${html.length} bytes, endpoint and token embedded`);

    // The assets, because a bundle that serves only index.html is a blank page
    // with a 404 in the console.
    const assets = referencedAssets(html);
    if (assets.length === 0)
      throw new Error("the page references no assets — is it the real build?");
    for (const asset of assets) {
      const res = await fetch(`http://127.0.0.1:${running.port}${asset}`);
      if (res.status !== 200) throw new Error(`GET ${asset} answered ${res.status}`);
      const bytes = (await res.arrayBuffer()).byteLength;
      if (bytes === 0) throw new Error(`GET ${asset} answered 200 with an empty body`);
    }
    pass(`${assets.length} referenced asset(s) → 200`);

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

    console.log(
      `  ✓ the binary serves the product (${((Date.now() - started) / 1000).toFixed(1)}s)`,
    );
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
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}
