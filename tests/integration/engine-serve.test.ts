/**
 * `rune serve`, driven the way a real client drives it.
 *
 * This is the acceptance test for Phase 2: a client that is NOT the terminal
 * runs a whole turn over a websocket — a turn that stops twice for a human —
 * answers both over the wire, and watches it complete. A second client
 * subscribes mid-turn and receives backfill plus live events.
 *
 * Everything is real except the model: a fake OpenAI-compatible endpoint plays
 * it, so the tool calls that force the round-trips are deterministic. The
 * server, the supervisor, the spawned engine host, the permission broker, the
 * session store and the protocol are all the shipping code.
 *
 * The door is tested too, because "no auth of any kind" was the finding this
 * phase answers: an unauthenticated socket is refused, and so is one opened
 * from an Origin that is not on the allowlist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  encodeFrame,
  rpcRequest,
  toResult,
  toStream,
} from "../../packages/protocol/src/index";
import { RuneClient } from "../../packages/sdk/src/index";

const CLI = join(import.meta.dir, "../../packages/orchestrator/src/bin/rune-cli.ts");
const RUST_RELEASE = join(import.meta.dir, "../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/rune-tools");
const RUST_BIN = process.env.RUNE_TOOLS_BIN
  ? process.env.RUNE_TOOLS_BIN
  : existsSync(RUST_RELEASE)
    ? RUST_RELEASE
    : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

// ─── The fake model ───

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

const sseToolCall = (id: string, name: string, args: Record<string, unknown>): string =>
  chunk(
    {
      role: "assistant",
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }],
    },
    null,
  ) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

// ─── A minimal protocol client over a websocket ───

interface Frame {
  stream: string;
  payload: Record<string, unknown>;
}

class WsClient {
  readonly streams: Frame[] = [];
  private readonly pending = new Map<number, (r: { ok: boolean; value: unknown }) => void>();
  private nextId = 1;
  private constructor(private readonly ws: WebSocket) {}

  static open(url: string, token: string, extraProtocols: string[] = []): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [`rune.bearer.${token}`, ...extraProtocols]);
      const client = new WsClient(ws);
      const timer = setTimeout(() => reject(new Error("websocket never opened")), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(client);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("websocket refused"));
      };
      ws.onmessage = (ev) => client.onLine(String(ev.data));
    });
  }

  private onLine(line: string): void {
    for (const raw of line.split("\n")) {
      if (!raw.trim()) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      const stream = toStream(frame);
      if (stream) {
        this.streams.push({
          stream: stream.stream,
          payload: (stream.payload ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const result = toResult(frame);
      if (result && typeof result.id === "number") {
        const settle = this.pending.get(result.id);
        if (!settle) continue;
        this.pending.delete(result.id);
        settle(
          result.ok
            ? { ok: true, value: result.result }
            : { ok: false, value: result.error.message },
        );
      }
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

  /**
   * Wait for the first stream frame matching a predicate.
   *
   * The interval is the resolution of every wait in this file, so it is the
   * one number that is added to each of them whether or not anything is slow.
   * 20ms is below the point where it shows up next to a real round-trip and
   * still far above the cost of a `find` over a handful of frames.
   */
  async waitFor(match: (f: Frame) => boolean, timeoutMs = 60_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.streams.find(match);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for a stream frame; saw: ${this.streams.map((f) => f.stream).join(", ") || "(none)"}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

/**
 * Stop a `rune serve` and everything it started.
 *
 * The supervisor stops its session hosts in its SIGTERM handler, so it needs
 * the signal AND the time to run the handler. SIGKILL is the backstop for a
 * wedged server, not the first move — killing it is precisely how the suite
 * used to strand its engines.
 */
export async function stopServe(
  proc: ReturnType<typeof Bun.spawn> | null,
  graceMs = 10_000,
): Promise<void> {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, graceMs);
  await proc.exited.catch(() => {});
  clearTimeout(timer);
}

describe("rune serve (websocket transport, real engine, fake model)", () => {
  let dir: string;
  let runeHome: string;
  let model: ReturnType<typeof Bun.serve> | null = null;
  let server: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-serve-"));
    runeHome = join(dir, "home");
    mkdirSync(runeHome, { recursive: true });
  });

  afterEach(async () => {
    // SIGTERM, not kill(9): the supervisor's handler is what stops the
    // per-session engine hosts (P10.0), and a killed supervisor leaves them
    // behind for the whole rest of the suite. `zz-no-leaked-hosts.test.ts` is
    // the assertion that this teardown actually works.
    await stopServe(server);
    server = null;
    model?.stop(true);
    model = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Start the fake model and `rune serve` against it.
   *
   * The provider is `custom` — the user-defined OpenAI-compatible endpoint,
   * configured entirely from `secrets.json`. That is what lets the spawned
   * engine host, which builds its own Engine from config and secrets rather
   * than a constructor, be pointed at a server this test owns.
   *
   * This was `lmstudio` until P8.6 removed that preset (program decision D5);
   * `custom` is the migration path the removal names, and it is the only
   * remaining OpenAI-compatible provider whose base URL a test can own. Its
   * key is required by the registry but never checked by the fake model.
   */
  async function start(
    script: string[],
    opts: { configToml?: string } = {},
  ): Promise<{ url: string; token: string }> {
    let turn = 0;
    model = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.text();
        const body = script[Math.min(turn++, script.length - 1)]!;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    writeFileSync(
      join(runeHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "fake-model" }),
    );
    writeFileSync(
      join(runeHome, "secrets.json"),
      JSON.stringify({
        custom: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: "fake-model",
          key: "fake-key-the-test-server-ignores",
        },
      }),
      { mode: 0o600 },
    );
    if (opts.configToml) writeFileSync(join(runeHome, "config.toml"), opts.configToml);

    const port = await freePort();
    server = Bun.spawn(["bun", CLI, "serve", "--port", String(port), "--workspace", dir], {
      env: {
        ...process.env,
        RUNE_HOME: runeHome,
        RUNE_WORKSPACE: dir,
        RUNE_DB_PATH: join(dir, "rune.db"),
        RUNE_TOOLS_BIN: RUST_BIN,
        // Keep the round-trips from timing out under a slow CI box while
        // still proving the mechanism exists.
        RUNE_ROUNDTRIP_TIMEOUT_MS: "120000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const tokenPath = join(runeHome, "serve.json");
    // The server writes this about 150ms after it is spawned, so a 100ms
    // interval was rounding every start-up in the file up by a tenth of a
    // second for nothing.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(tokenPath)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!existsSync(tokenPath)) throw new Error("rune serve never wrote its token file");
    const cfg = JSON.parse(readFileSync(tokenPath, "utf8")) as { token: string; port: number };
    return { url: `ws://127.0.0.1:${cfg.port}`, token: cfg.token };
  }

  test.skipIf(!HAS_RUST_BIN)(
    "a websocket client runs a turn that stops for a human, twice, and finishes",
    async () => {
      // The model asks a question, then asks to run a command, then answers.
      const { url, token } = await start([
        sseToolCall("call_ask", "ask_user", {
          question: "Which database should this use?",
          options: ["sqlite", "postgres"],
        }),
        sseToolCall("call_bash", "bash", { command: "echo hello-from-the-wire" }),
        sseText("done"),
      ]);

      const client = await WsClient.open(url, token);

      // ── the handshake ──
      const hello = (await client.call("hello", { client: "engine-serve.test" })) as {
        protocolVersion: string;
        commands: string[];
      };
      expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);

      const sessionId = (await client.call("create_session")) as string;
      expect(typeof sessionId).toBe("string");

      // ── the turn ──
      const ack = (await client.call("chat_start", {
        sessionId,
        message: "set up the database",
      })) as { sessionId: string };
      expect(typeof ack.sessionId).toBe("string");

      // 1. ask_user, over the wire. Before P2.2 this failed outright with
      //    "No interactive user is available" for every non-terminal client.
      const question = await client.waitFor((f) => f.stream === "question_request");
      const qPayload = question.payload as {
        requestId: string;
        question: { question: string; options: string[] };
      };
      expect(qPayload.question.question).toContain("database");
      expect(qPayload.question.options).toContain("postgres");
      await client.call("respond_question", { requestId: qPayload.requestId, answer: "postgres" });

      // 2. a permission gate, over the wire.
      const perm = await client.waitFor((f) => f.stream === "permission_request");
      const pPayload = perm.payload as {
        requestId: string;
        prompt: { toolName: string; argsSummary: string };
      };
      expect(pPayload.prompt.toolName).toBe("bash");
      expect(pPayload.prompt.argsSummary).toContain("hello-from-the-wire");

      // ── a SECOND client subscribes mid-turn ──
      // The reconnect story: settled history from the store, plus the host's
      // live ring so the tool call in flight is visible — not just whatever
      // last reached the database.
      const observer = await WsClient.open(url, token);
      const sub = (await observer.call("subscribe", { sessionId: ack.sessionId })) as {
        settled: boolean;
        running: boolean;
        backfill: Array<{ seq: number; event: { type: string } }>;
        userTurns: Array<{ seq: number; text: string }>;
        live: Array<{ type: string }>;
      };
      expect(sub.settled).toBe(true);
      expect(sub.running).toBe(true);
      expect(sub.userTurns.some((t) => t.text.includes("set up the database"))).toBe(true);
      // The ask_user call is settled history by now; the bash call is live.
      const seen = [...sub.backfill.map((f) => f.event.type), ...sub.live.map((e) => e.type)];
      expect(seen).toContain("tool_call_end");

      // Answering unblocks the run, and the observer sees it LIVE.
      await client.call("respond_permission", {
        requestId: pPayload.requestId,
        decision: "allow_once",
      });

      // 3. the turn completes, for both clients.
      const done = await client.waitFor(
        (f) =>
          f.stream === "chat_event" &&
          (f.payload as { event?: { type?: string } }).event?.type === "turn_complete",
      );
      expect(done).toBeDefined();
      await observer.waitFor(
        (f) =>
          f.stream === "chat_event" &&
          (f.payload as { event?: { type?: string } }).event?.type === "turn_complete",
        30_000,
      );

      client.close();
      observer.close();
    },
    180_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a deferral reaches the client as a held step it can list, run or dismiss",
    async () => {
      // 4th gear: Auto mode never asks mid-run. An outward, irreversible step
      // is CONTAINED and recorded, and the decision is put to the person when
      // the work is finished. Off the terminal that ledger was invisible — the
      // step simply did not happen with nothing on screen to say so.
      //
      // `npm publish` reaches the ledger MECHANICALLY: the containment broker
      // matches it and substitutes the dry run, so the held step's shape does
      // not depend on a model's judgment and cannot flake on one.
      //
      // The reviewer ceiling is set explicitly, and that is what makes this
      // test take four seconds instead of twenty. There is no reachable
      // reviewer in this fixture — the fake model plays the acting agent, not
      // the safety reviewer — so both reviewer attempts burn their whole
      // budget before the broker takes over. At the shipped 12 s default that
      // is fifteen seconds of a test waiting for something it has arranged
      // never to arrive, which is the entire runtime AND the reason this test
      // timed out four times on a loaded merge gate. Bounding it changes
      // nothing that is asserted below: the containment is the broker's, the
      // route is `dry-run-substitute` either way, and the assertion that the
      // reviewer was unavailable is made explicitly rather than by waiting.
      const { url, token } = await start(
        [
          sseToolCall("call_pub", "bash", { command: "npm publish --access public" }),
          sseText("published everything I could; the publish itself is on the ledger"),
        ],
        {
          configToml: '[permissions]\ngear = "auto"\n\n[permissions.autoMode]\ntimeoutMs = 1500\n',
        },
      );

      const client = await WsClient.open(url, token);
      const sessionId = (await client.call("create_session")) as string;
      const ack = (await client.call("chat_start", {
        sessionId,
        message: "ship the package",
      })) as { sessionId: string };

      // The turn runs to completion WITHOUT stopping to ask — that is the
      // whole design — and the held step arrives as its own stream.
      const held = await client.waitFor((f) => f.stream === "held_steps");
      const steps = (held.payload as { steps: Array<Record<string, unknown>> }).steps;
      expect(steps.length).toBeGreaterThan(0);
      const step = steps[0]!;
      expect(step.toolName).toBe("bash");
      expect(String(step.summary)).toContain("npm publish");
      expect(typeof step.id).toBe("string");
      // Both containment families land on this ledger, and the difference
      // matters to the reader: a `defer` left the step entirely undone, while
      // a `redirect` already ran a safe stand-in (`npm publish --dry-run`) so
      // only the real effect is outstanding. `substitute` names the stand-in.
      expect(["defer", "redirect"]).toContain(step.kind);
      if (step.kind === "redirect") expect(String(step.substitute ?? "")).not.toBe("");
      // Mechanical, and it says so. This is the assertion the shortened
      // reviewer ceiling is answerable to: the containment came from the
      // broker BECAUSE no independent reviewer answered, and the reason on the
      // ledger names that rather than leaving the reader to infer it.
      expect(String(step.route)).toBe("dry-run-substitute");
      expect(String(step.reason)).toMatch(/reviewer unavailable/i);
      // The raw arguments stay in-process: the wire carries a bounded,
      // secret-scrubbed summary and an id, never the payload itself.
      expect(step).not.toHaveProperty("args");

      // The ledger is queryable, and addressed by id.
      const listed = (await client.call("list_held_steps", {
        sessionId: ack.sessionId,
      })) as Array<{ id: string }>;
      expect(listed.map((s) => s.id)).toContain(step.id);

      // Declining is a real decision the engine is told about.
      const dismissed = (await client.call("dismiss_held_steps", {
        sessionId: ack.sessionId,
        stepIds: [step.id],
      })) as { dismissed: number };
      expect(dismissed.dismissed).toBe(1);
      expect(await client.call("list_held_steps", { sessionId: ack.sessionId })).toEqual([]);

      client.close();
    },
    // Measured at 4.2 s on this machine (was 16.7 s). 30 s is about 7× that —
    // room for a loaded gate without the 180 s ceiling that let a genuinely
    // wedged run hold the suite open for three minutes before saying so.
    30_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "an unauthenticated connection is refused",
    async () => {
      const { url } = await start([sseText("ok")]);
      // No token at all.
      await expect(WsClient.open(url, "")).rejects.toThrow();
      // A well-formed but wrong token. The comparison is constant-time, so
      // this cannot be walked one byte at a time either.
      await expect(WsClient.open(url, "x".repeat(43))).rejects.toThrow();
    },
    120_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "an Origin that is not on the allowlist is refused",
    async () => {
      const { url, token } = await start([sseText("ok")]);
      // Bun's client WebSocket does not send Origin, so drive the upgrade by
      // hand: this is the browser case, and the browser case is the one the
      // allowlist exists for.
      const httpUrl = url.replace("ws://", "http://");
      const evil = await fetch(httpUrl, {
        headers: {
          origin: "https://evil.example.com",
          authorization: `Bearer ${token}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      expect(evil.status).toBe(403);

      // …and a loopback origin, with the same token, gets past the door.
      const good = await fetch(httpUrl + "/health", {
        headers: { origin: "http://localhost:5173" },
      });
      expect(good.status).toBe(200);
    },
    120_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "@rune/sdk drives the same server — the README example, executed",
    async () => {
      // The SDK seed is only worth shipping if the example in its README runs.
      // This IS that example: connect, create a session, run a prompt, answer a
      // permission from a handler, watch the events go by.
      const { url, token } = await start([
        sseToolCall("call_bash", "bash", { command: "echo from-the-sdk" }),
        sseText("done"),
      ]);

      const events: string[] = [];
      const asked: string[] = [];
      const rune = await RuneClient.connect(
        { url, token },
        {
          onEvent: (event) => events.push(event.type),
          onPermission: async (prompt) => {
            asked.push(prompt.toolName);
            return { kind: "allow_once" };
          },
        },
      );

      const sessionId = await rune.createSession();
      await rune.run(sessionId, "say something with a shell");

      // The handler answered the gate, so the turn ran to completion without
      // anyone touching a frame by hand.
      expect(asked).toContain("bash");
      expect(events).toContain("tool_call_end");
      expect(events).toContain("turn_complete");

      // …and the typed command surface reaches the same host.
      const sessions = await rune.call("list_sessions");
      expect(sessions.some((s) => s.id === sessionId)).toBe(true);

      rune.close();
      expect(rune.isClosed).toBe(true);
    },
    180_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "rune serve --status reports the live server",
    async () => {
      await start([sseText("ok")]);
      const status = Bun.spawnSync(["bun", CLI, "serve", "--status"], {
        env: { ...process.env, RUNE_HOME: runeHome },
      });
      const out = status.stdout.toString();
      expect(out).toContain("rune serve");
      expect(out).toContain("remote settings refused");
      expect(out).toContain("listening");
    },
    120_000,
  );
});
