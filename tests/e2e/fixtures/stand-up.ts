// ─── Standing up a real Gear, with a fake model in front of it ───
//
// Everything in the smoke is the shipping code except the model: the engine,
// the permission broker, the session store, the protocol, the server and the
// bundle are all real. A local OpenAI-compatible endpoint plays the model, so
// the tool call that opens the permission card happens on cue instead of
// whenever a real provider feels like it.
//
// The seam that makes this possible is `secrets.custom`: the user-defined
// OpenAI-compatible endpoint, whose base URL, model and key all come from
// `secrets.json`. That is how a spawned engine host — which builds its own
// Engine from config and secrets rather than from a constructor — gets pointed
// at a server this test owns. It was the `lmstudio` preset until P8.6 removed
// that provider (decision D5); `custom` is the migration path the removal
// names, and the only remaining OpenAI-shaped provider a test can own.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Playwright transpiles this to CommonJS, so `__dirname` is the portable
// choice here and `import.meta.url` is a syntax error.
export const REPO_ROOT = join(__dirname, "../../..");
const CLI = join(REPO_ROOT, "packages/orchestrator/src/bin/gear-cli.ts");

// ─── The fake model's wire format ───

const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
  `data: ${JSON.stringify({
    id: "cmpl-1",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

export const sseText = (text: string): string =>
  chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";

export const sseToolCall = (id: string, name: string, args: Record<string, unknown>): string =>
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

// ─── Where the native tools are ───

export function toolsBinary(): string | null {
  const candidates = [
    process.env.GEAR_TOOLS_BIN,
    join(REPO_ROOT, "target/release/gear-tools"),
    join(REPO_ROOT, "target/debug/gear-tools"),
    join(process.env.HOME ?? "", ".gear/bin/gear-tools"),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface Stand {
  /** The page URL, token included when the bind is not loopback. */
  pageUrl: string;
  workspace: string;
  gearHome: string;
  /** Everything the fake model was asked, in order — for asserting the turn. */
  requests: unknown[];
  /**
   * Rewind the script to its first entry.
   *
   * The script is consumed in order and its last entry repeats, so a second
   * test sharing one stand gets only that last entry — a passing first run and
   * a mystifying second. Standing the whole thing up again costs a minute per
   * test; rewinding costs nothing and is the same engine, which is the point.
   */
  reset(): void;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Start the fake model and `gear web` against it.
 *
 * `script` is one SSE body per model invocation, in order; the last entry
 * repeats if the agent takes more turns than the script has.
 */
export async function standUp(
  script: string[],
  opts: { configToml?: string } = {},
): Promise<Stand> {
  const tools = toolsBinary();
  if (!tools) throw new Error("gear-tools is not built — cargo build --release -p gear-tools");

  const dir = mkdtempSync(join(tmpdir(), "gear-web-e2e-"));
  const gearHome = join(dir, "home");
  const workspace = join(dir, "workspace");
  mkdirSync(gearHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# smoke\n\nA repository with one file in it.\n");

  // A REAL git repository, because the review tab's whole job is answering
  // "what is different from HEAD" and a directory git has never seen can only
  // exercise the empty state. One commit, then one uncommitted edit, so the
  // panel has a file to show and a file to revert.
  const git = (...args: string[]): void => {
    spawnSync("git", args, { cwd: workspace, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "smoke");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  writeFileSync(
    join(workspace, "README.md"),
    "# smoke\n\nA repository with one file in it.\nAnd one uncommitted line.\n",
  );

  const requests: unknown[] = [];
  let turn = 0;
  const model: Server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push(body);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(script[Math.min(turn++, script.length - 1)]);
    });
  });
  const modelPort = await freePort();
  await new Promise<void>((r) => model.listen(modelPort, "127.0.0.1", r));

  writeFileSync(
    join(gearHome, "model.json"),
    JSON.stringify({ provider: "custom", model: "fake-model" }),
  );
  writeFileSync(
    join(gearHome, "secrets.json"),
    JSON.stringify({
      custom: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "fake-model",
        key: "fake-key-the-test-server-ignores",
      },
    }),
    { mode: 0o600 },
  );
  if (opts.configToml) writeFileSync(join(gearHome, "config.toml"), opts.configToml);

  const port = await freePort();
  const server: ChildProcess = spawn(
    "bun",
    [CLI, "web", "--port", String(port), "--workspace", workspace],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        GEAR_HOME: gearHome,
        GEAR_WORKSPACE: workspace,
        GEAR_DB_PATH: join(dir, "gear.db"),
        GEAR_TOOLS_BIN: tools,
        // A person answering a card in a browser is slower than a unit test.
        GEAR_ROUNDTRIP_TIMEOUT_MS: "150000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  server.stdout?.on("data", (c) => (log += String(c)));
  server.stderr?.on("data", (c) => (log += String(c)));

  const tokenPath = join(gearHome, "serve.json");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !existsSync(tokenPath)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!existsSync(tokenPath)) {
    server.kill();
    model.close();
    throw new Error(`gear web never wrote its token file. Output:\n${log}`);
  }
  const cfg = JSON.parse(readFileSync(tokenPath, "utf8")) as { port: number };

  return {
    pageUrl: `http://127.0.0.1:${cfg.port}/`,
    workspace,
    gearHome,
    requests,
    reset() {
      turn = 0;
      requests.length = 0;
    },
    async stop() {
      server.kill();
      await new Promise((r) => setTimeout(r, 250));
      await new Promise<void>((r) => model.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
