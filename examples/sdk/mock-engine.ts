// ─── A Rune you can run an example against, with no API key ───
//
// Both examples in this directory need three things: a `rune serve` to talk
// to, a model that answers deterministically, and a workspace it is allowed to
// touch. An example that needs a paid provider and a running server before it
// prints anything is not an example — it is a README with extra steps.
//
// So this stands the whole stack up in a temp directory: a fake
// OpenAI-compatible endpoint playing the model, a real `rune serve` in front of
// a real engine, and a real permission broker. Everything the SDK talks to is
// the shipping code; only the model is fake, which is the point — the round
// trips have to be genuine or the example teaches nothing.
//
// If you already have a server running (`rune serve`), both examples find it
// through `runningServer()` and drive that instead. That is the real usage;
// this is the one that works on a fresh clone with no key and no server.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "rune-cli.ts");

// ─── The fake model ───

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

/** One assistant turn that is only text. */
export const says = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

/** One assistant turn that calls a tool. */
export const calls = (id: string, name: string, args: Record<string, unknown>): string =>
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

// ─── The stack ───

export interface MockRune {
  /** What `RuneClient.connect` wants. */
  url: string;
  token: string;
  /** The directory the agent may touch. */
  workspace: string;
  /** The session database, so `rune audit` can be pointed at this run. */
  dbPath: string;
  runeHome: string;
  /** Run `rune <args>` against this stack and return its stdout. */
  rune(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

function toolsBinary(): string | null {
  if (process.env.RUNE_TOOLS_BIN && existsSync(process.env.RUNE_TOOLS_BIN)) {
    return process.env.RUNE_TOOLS_BIN;
  }
  for (const p of [
    join(repoRoot, "target", "release", "rune-tools"),
    join(repoRoot, "target", "debug", "rune-tools"),
    join(process.env.HOME ?? "", ".rune", "bin", "rune-tools"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

/**
 * Stand up a fake model and a real `rune serve` in front of it.
 *
 * `script` is one entry per model turn; the last entry repeats, so a run that
 * takes an extra turn does not hang waiting for a completion that never comes.
 */
export async function startMockRune(script: string[]): Promise<MockRune> {
  const bin = toolsBinary();
  if (!bin) {
    throw new Error(
      "rune-tools is not built — run `cargo build --release -p rune-tools` or set RUNE_TOOLS_BIN",
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "rune-example-"));
  const runeHome = join(dir, "home");
  const workspace = join(dir, "workspace");
  const dbPath = join(dir, "rune.db");
  mkdirSync(runeHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  let turn = 0;
  const model = Bun.serve({
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

  // `lmstudio` is the local, key-less, OpenAI-compatible preset whose base URL
  // `secrets.json` can override — which is what lets a spawned engine host,
  // building its own Engine from config, be pointed at a server we own.
  writeFileSync(
    join(runeHome, "model.json"),
    JSON.stringify({ provider: "lmstudio", model: "fake-model" }),
  );
  writeFileSync(
    join(runeHome, "secrets.json"),
    JSON.stringify({ endpoints: { lmstudio: `http://127.0.0.1:${model.port}/v1` } }),
    { mode: 0o600 },
  );

  const env = {
    ...process.env,
    RUNE_HOME: runeHome,
    RUNE_WORKSPACE: workspace,
    RUNE_DB_PATH: dbPath,
    RUNE_TOOLS_BIN: bin,
    // An example that stalls ten minutes on an unanswered round-trip teaches
    // the wrong lesson about what the timeout is for.
    RUNE_ROUNDTRIP_TIMEOUT_MS: "60000",
  };

  const port = await freePort();
  const server = Bun.spawn(
    ["bun", CLI, "serve", "--port", String(port), "--workspace", workspace],
    {
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const tokenPath = join(runeHome, "serve.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(tokenPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!existsSync(tokenPath)) {
    server.kill();
    model.stop(true);
    rmSync(dir, { recursive: true, force: true });
    throw new Error("rune serve never came up");
  }
  const cfg = JSON.parse(readFileSync(tokenPath, "utf8")) as { token: string; port: number };

  return {
    url: `ws://127.0.0.1:${cfg.port}`,
    token: cfg.token,
    workspace,
    dbPath,
    runeHome,
    async rune(args) {
      const p = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code: await p.exited, stdout, stderr };
    },
    async stop() {
      server.kill();
      await server.exited.catch(() => {});
      model.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * `~/.rune/serve.json`, when a real server is actually answering.
 *
 * The file outlives the process that wrote it — a `rune serve` you stopped
 * yesterday leaves a token file behind — so the port is PROBED before the
 * examples trust it. Without that, a stale file turns "the example works on a
 * fresh clone" into a connection error whose cause is nowhere on screen.
 */
export async function runningServer(): Promise<{ url: string; token: string } | null> {
  let token: string;
  let host: string;
  let port: number;
  try {
    const home = process.env.RUNE_HOME ?? join(process.env.HOME ?? "", ".rune");
    const raw = JSON.parse(readFileSync(join(home, "serve.json"), "utf8")) as {
      token?: string;
      port?: number;
      host?: string;
    };
    if (!raw.token) return null;
    token = raw.token;
    port = raw.port ?? 4762;
    host = raw.host === "0.0.0.0" || raw.host === "::" ? "127.0.0.1" : (raw.host ?? "127.0.0.1");
  } catch {
    return null;
  }

  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return null;
  } catch {
    return null; // nothing listening: the token file is stale
  }
  return { url: `ws://${host}:${port}`, token };
}
