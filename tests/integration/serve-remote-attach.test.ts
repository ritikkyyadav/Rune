/**
 * `rune serve --host` and `rune attach ws://…`, as two processes.
 *
 * Phase 5 tested this by hand: start a server, attach a terminal from
 * somewhere else, watch a turn. A thing verified by hand once is a thing that
 * works on the day it was written.
 *
 * `engine-serve.test.ts` already drives the server through an in-process
 * client, so what is NEW here is the second process — the real `rune attach`
 * CLI, resolving its own token, opening its own socket through `@rune/sdk`,
 * rendering a turn to its own stdout. That is the path a person takes to reach
 * an engine in another room, and it has its own failure modes: the token
 * resolution order, the argv shape, and the fact that a remote console has to
 * stop for a permission the same way the terminal does.
 *
 * The door is tested from the same two processes, because a remote link is
 * exactly where a bad token and a stray Origin arrive:
 *
 *   - a wrong token, given to the real CLI, exits non-zero and says so;
 *   - a browser Origin that is not on the allowlist gets a 403 before the
 *     upgrade, even holding the right token.
 *
 * Everything is real except the model.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "rune-cli.ts");
const RUST_BIN =
  process.env.RUNE_TOOLS_BIN ??
  [
    join(repoRoot, "target", "release", "rune-tools"),
    join(repoRoot, "target", "debug", "rune-tools"),
    join(process.env.HOME ?? "", ".rune", "bin", "rune-tools"),
  ].find((p) => existsSync(p)) ??
  "";
const HAS_RUST_BIN = RUST_BIN !== "" && existsSync(RUST_BIN);

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

/** SIGTERM and wait — the supervisor stops its engine hosts in that handler. */
async function stop(proc: ReturnType<typeof Bun.spawn> | null, graceMs = 10_000): Promise<void> {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const hard = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, graceMs);
  await proc.exited.catch(() => {});
  clearTimeout(hard);
}

describe("rune serve --host + rune attach ws:// (two processes, a real engine)", () => {
  let dir: string;
  let runeHome: string;
  let model: ReturnType<typeof Bun.serve> | null = null;
  let server: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-attach-"));
    runeHome = join(dir, "home");
    mkdirSync(runeHome, { recursive: true });
  });

  afterEach(async () => {
    await stop(server);
    server = null;
    model?.stop(true);
    model = null;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A server bound explicitly to 127.0.0.1, the way `--host` binds one.
   *
   * `--host 127.0.0.1` rather than the default is the point: it is the flag a
   * person reaches for when the engine is not where they are sitting, and the
   * loopback form is the one a test can bind without opening a port to the
   * network the test happens to be running on.
   */
  async function start(script: string[]): Promise<{ port: number; token: string }> {
    let turn = 0;
    model = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.text();
        return new Response(script[Math.min(turn++, script.length - 1)]!, {
          headers: { "content-type": "text/event-stream" },
        });
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

    const port = await freePort();
    server = Bun.spawn(
      ["bun", CLI, "serve", "--host", "127.0.0.1", "--port", String(port), "--workspace", dir],
      {
        env: {
          ...process.env,
          RUNE_HOME: runeHome,
          RUNE_WORKSPACE: dir,
          RUNE_DB_PATH: join(dir, "rune.db"),
          RUNE_TOOLS_BIN: RUST_BIN,
          RUNE_ROUNDTRIP_TIMEOUT_MS: "120000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const tokenPath = join(runeHome, "serve.json");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !existsSync(tokenPath)) await sleep(100);
    if (!existsSync(tokenPath)) throw new Error("rune serve never wrote its token file");
    const cfg = JSON.parse(readFileSync(tokenPath, "utf8")) as {
      token: string;
      port: number;
      host: string;
    };
    // The server records what it bound, and a remote attach is only meaningful
    // against a server that bound where it said it did.
    expect(cfg.host).toBe("127.0.0.1");
    return { port: cfg.port, token: cfg.token };
  }

  /**
   * `rune attach ws://…` in its own process, with its own HOME.
   *
   * A separate `RUNE_HOME` is what makes this a remote attach rather than a
   * local one: the CLI must take the token it was given, not find one lying
   * about on this machine.
   */
  function attach(
    port: number,
    args: string[],
    env: Record<string, string> = {},
  ): ReturnType<typeof Bun.spawn> {
    return Bun.spawn(["bun", CLI, "attach", `ws://127.0.0.1:${port}`, ...args], {
      cwd: dir,
      env: {
        ...process.env,
        RUNE_HOME: join(dir, "elsewhere"),
        RUNE_TOOLS_BIN: RUST_BIN,
        NO_COLOR: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  }

  test.skipIf(!HAS_RUST_BIN)(
    "a second process attaches, runs a turn, and sees the events",
    async () => {
      const { port, token } = await start([
        sseToolCall("call_bash", "bash", { command: "echo hello-from-the-other-room" }),
        sseText("done — the shell answered"),
      ]);

      // The token by ENVIRONMENT, which is the form the docs recommend: a token
      // on the command line lands in shell history.
      const client = attach(port, ["--prompt", "check the shell works"], {
        RUNE_SERVE_TOKEN: token,
      });
      const out = await new Response(client.stdout).text();
      const err = await new Response(client.stderr).text();
      const code = await client.exited;

      expect(code, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);

      // ── it attached, and said where the token came from ──
      expect(out).toContain("attached");
      expect(out).toContain(`ws://127.0.0.1:${port}`);
      expect(out).toContain("RUNE_SERVE_TOKEN");
      // Never the token itself. This output is what a person pastes into a bug
      // report, and the token is remote code execution.
      expect(out).not.toContain(token);

      // ── the turn's events reached the other process ──
      expect(out).toContain("bash");
      expect(out).toContain("the shell answered");
      expect(out).toContain("turn complete");

      // ── the permission stopped HERE, and this terminal is not a person ──
      //
      // stdin is not a TTY, so `ask` answers "" and the handler denies. That is
      // the same rule the host applies unattended, and it is why the tool
      // failed rather than running: a remote console with nobody at it must not
      // read silence as consent.
      expect(out).toContain("allow?");
      expect(out).toContain("failed");
    },
    240_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a wrong token is refused, and the CLI says which knob to turn",
    async () => {
      const { port } = await start([sseText("ok")]);

      const client = attach(port, ["--prompt", "hello"], {
        // Well-formed and wrong. The server's comparison is constant-time, so
        // this cannot be walked one byte at a time either.
        RUNE_SERVE_TOKEN: "x".repeat(43),
      });
      const out = await new Response(client.stdout).text();
      const code = await client.exited;

      expect(code).toBe(1);
      expect(out).toContain("could not attach");
      expect(out).toContain("check the token and the Origin allowlist");
      expect(out).not.toContain("attached ws://");
    },
    120_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "no token at all is refused before a socket is opened",
    async () => {
      const { port } = await start([sseText("ok")]);
      // A HOME with no serve.json in it: nothing to fall back to, and the
      // fallback is loopback-only by design anyway — a token minted for this
      // machine's own server is not a credential for someone else's.
      const client = attach(port, ["--prompt", "hello"]);
      const out = await new Response(client.stdout).text();
      const code = await client.exited;

      expect(code).toBe(1);
      expect(out).toContain(`no token for ws://127.0.0.1:${port}`);
      expect(out).toContain("RUNE_SERVE_TOKEN");
    },
    120_000,
  );

  test.skipIf(!HAS_RUST_BIN)(
    "a browser Origin off the allowlist is refused even with the right token",
    async () => {
      const { port, token } = await start([sseText("ok")]);
      // The SDK and the CLI send no Origin — browsers always do, so its absence
      // cannot be forged from a page. The allowlist exists for the browser
      // case, so the browser case is what this drives: a raw upgrade request
      // with an Origin header on it.
      const upgrade = (origin: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}`, {
          headers: {
            origin,
            authorization: `Bearer ${token}`,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        });

      expect((await upgrade("https://evil.example.com")).status).toBe(403);
      // A subdomain of an allowed host is a different host.
      expect((await upgrade("http://localhost.evil.example.com")).status).toBe(403);
      // …and the origin a page served by this very server would send is fine:
      // it gets past the Origin gate to the token check, not a 403.
      expect((await upgrade(`http://127.0.0.1:${port}`)).status).not.toBe(403);
    },
    120_000,
  );
});
