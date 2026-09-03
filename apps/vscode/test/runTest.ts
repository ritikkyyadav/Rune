// ─── The half that runs OUTSIDE VS Code ───
//
// P10.6's first proof: the extension stops being "packaged but never loaded".
// `@vscode/test-electron` downloads a real VS Code, launches it with the
// extension in development mode, and runs `test/suite/index.ts` inside the
// extension host. Until this file existed, `apps/vscode` typechecked, bundled,
// packaged, and had unit tests for its pure functions — and nobody had ever
// seen it load. It could not have loaded: the page it frames had no listener
// for the messages it posts, so "Send selection to Gear" sent a selection into
// a window that ignored it, and no test on either side would have said so.
//
// This launcher owns everything the editor is not:
//
//   1. a fake OpenAI-compatible model, so the turn is deterministic and free
//   2. a real `gear serve --web` — the engine, the supervisor, the protocol,
//      the bundle — with a temp GEAR_HOME the editor is pointed at
//   3. a real workspace with a real file to select in
//   4. the SDK, watching that same server for the session the WEBVIEW starts
//
// Point 4 is why the proof is split in two. The webview's iframe is
// cross-origin to the extension host, so its DOM is opaque from inside VS Code;
// asserting "the selection arrived" there could only ever assert that a
// `postMessage` was issued. Watching the engine instead asserts what actually
// matters — a session started and the turn ran — and the two halves meet at a
// marker file.
//
// Locally it runs if the VS Code download succeeds and SKIPS with a printed
// reason if the network refuses it, because a proof that cannot be run on a
// laptop stops being run.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

import { GearClient } from "../../../packages/sdk/src/index";

const extensionRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repoRoot = resolve(extensionRoot, "../..");
const CLI = join(repoRoot, "packages", "orchestrator", "src", "bin", "gear-cli.ts");

/**
 * The VS Code build under test, pinned.
 *
 * "stable" would mean CI silently changes editors under the proof once a month
 * and a red run could be a VS Code release rather than a Gear change. Moving it
 * is a commit.
 */
const VSCODE_VERSION = "1.135.0";

/** Where downloads land. Gitignored; cached in CI by `.github/workflows/ci.yml`. */
const CACHE_PATH = join(repoRoot, ".vscode-test");

/** What the selection message must contain for the launcher to recognise it. */
const SELECTION_MARKER = "src/total.ts:2-3";
/** What the fake model answers, so the transcript can be identified. */
const MODEL_REPLY = "the selection reached the engine";

/**
 * How long to wait for the webview to reach the engine.
 *
 * Generous, because the page has to load a 340 kB bundle inside a webview
 * inside an Electron the runner just downloaded. Lowered while iterating on the
 * harness itself; the editor half waits a little longer than this so the
 * launcher is always the one that reports the reason.
 */
const WATCH_MS = Number(process.env.GEAR_VSCODE_WATCH_MS ?? 170_000);

const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Skip, loudly and with the reason, rather than failing on the environment. */
function skip(reason: string): never {
  say("");
  say(`  SKIPPED — ${reason}`);
  say("  This proof needs a VS Code download and a built web bundle; CI has both.");
  process.exit(0);
}

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

/**
 * The path `@vscode/test-electron` returns, or the one that exists beside it.
 *
 * On macOS the library hardcodes `Visual Studio Code.app/Contents/MacOS/Electron`
 * (`out/util.js` `downloadDirToExecutablePath`). Released builds name that
 * binary `Code`, so the returned path does not exist and the launch fails with
 * a bare ENOENT from `posix_spawn` that says nothing about why. Linux — which
 * is what CI runs — is `<dir>/code` and unaffected.
 */
function existingExecutable(path: string): string {
  if (existsSync(path)) return path;
  const sibling = join(dirname(path), "Code");
  if (existsSync(sibling)) return sibling;
  throw new Error(`no VS Code executable at ${path} (nor at ${sibling})`);
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

// ─── What the launcher watches for ───

interface Observation {
  sessionId: string;
  userTurn: string;
  reply: string;
}

/**
 * Watch the server the editor is pointed at until the WEBVIEW runs a turn.
 *
 * Polled through `list_sessions` + `subscribe` rather than driven off live
 * events, because the session does not exist when this starts — the page
 * creates it when the posted selection arrives — and because a mock turn can be
 * over before a subscription is open. `subscribe` reads the SETTLED history out
 * of the session store: the user turn the webview sent, and the assistant's
 * reply as one block. Nothing here is a stream this test had to catch in time.
 */
async function watchForTurn(
  url: string,
  token: string,
  signal: { done: boolean },
): Promise<Observation> {
  const client = await GearClient.connect({ url, token });
  const seen = new Set<string>();

  try {
    const deadline = Date.now() + WATCH_MS;
    let sawSelection: string | null = null;
    while (Date.now() < deadline && !signal.done) {
      for (const s of await client.call("list_sessions").catch(() => [])) {
        seen.add(s.id);
        const replay = await client.call("subscribe", { sessionId: s.id }).catch(() => null);
        const userTurn = replay?.userTurns.find((t) => t.text.includes(SELECTION_MARKER));
        if (!userTurn) continue;
        sawSelection = s.id;
        const reply = replay?.backfill.find(
          (f) => f.event.type === "text_delta" && f.event.text.includes(MODEL_REPLY),
        );
        if (reply && reply.event.type === "text_delta") {
          return { sessionId: s.id, userTurn: userTurn.text, reply: reply.event.text };
        }
      }
      await sleep(500);
    }
    throw new Error(
      sawSelection
        ? `session ${sawSelection} received the selection but its transcript never got the reply`
        : `no session carrying ${SELECTION_MARKER} appeared on ${url}; ` +
            `sessions seen: ${[...seen].join(", ") || "(none)"}`,
    );
  } finally {
    client.close();
  }
}

// ─── The run ───

async function main(): Promise<number> {
  const toolsBin =
    process.env.GEAR_TOOLS_BIN ??
    [
      join(repoRoot, "target", "release", "gear-tools"),
      join(repoRoot, "target", "debug", "gear-tools"),
    ].find((p) => existsSync(p));
  if (!toolsBin) skip("no gear-tools binary — run `cargo build --release -p gear-tools`");

  const bundle = join(repoRoot, "apps", "web", "dist", "index.html");
  if (!existsSync(bundle)) {
    skip("no web bundle — run `bun run --filter @gear/web build`");
  }

  // ── the download, first, because it is the thing that fails offline ──
  say(`  downloading VS Code ${VSCODE_VERSION} (cache: ${CACHE_PATH})…`);
  const { downloadAndUnzipVSCode } = (await import("@vscode/test-electron")) as {
    downloadAndUnzipVSCode: (o: Record<string, unknown>) => Promise<string>;
  };
  let vscodeExecutablePath: string;
  try {
    vscodeExecutablePath = await downloadAndUnzipVSCode({
      version: VSCODE_VERSION,
      cachePath: CACHE_PATH,
    });
  } catch (err) {
    skip(`VS Code ${VSCODE_VERSION} could not be downloaded: ${String(err)}`);
  }
  vscodeExecutablePath = existingExecutable(vscodeExecutablePath);
  say(`  vscode     ${vscodeExecutablePath}`);

  const dir = mkdtempSync(join(tmpdir(), "gear-vscode-"));
  const gearHome = join(dir, "home");
  const workspace = join(dir, "workspace");
  const proofDir = join(dir, "proof");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(gearHome, { recursive: true });
  mkdirSync(proofDir, { recursive: true });

  // The file the suite selects lines 2–3 of.
  writeFileSync(
    join(workspace, "src", "total.ts"),
    [
      "export function total(a: number, b: number): number {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
      "",
    ].join("\n"),
  );

  let model: ReturnType<typeof Bun.serve> | null = null;
  let server: ChildProcess | null = null;
  let serverLog = "";
  const signal = { done: false };

  try {
    model = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("not found", { status: 404 });
        }
        await req.text();
        return new Response(sseText(MODEL_REPLY), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    writeFileSync(
      join(gearHome, "model.json"),
      JSON.stringify({ provider: "custom", model: "fake-model" }),
    );
    writeFileSync(
      join(gearHome, "secrets.json"),
      JSON.stringify({
        custom: {
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: "fake-model",
          key: "fake-key-the-test-server-ignores",
        },
      }),
      { mode: 0o600 },
    );

    // ── the engine and the page, on one port, exactly as a person gets it ──
    const port = await freePort();
    server = spawn(
      "bun",
      [CLI, "serve", "--web", "--port", String(port), "--workspace", workspace],
      {
        cwd: workspace,
        env: {
          ...process.env,
          GEAR_HOME: gearHome,
          GEAR_WORKSPACE: workspace,
          GEAR_DB_PATH: join(dir, "gear.db"),
          GEAR_TOOLS_BIN: toolsBin,
          GEAR_ROUNDTRIP_TIMEOUT_MS: "120000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [server.stdout, server.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (c: string) => {
        serverLog += c;
      });
    }

    const servePath = join(gearHome, "serve.json");
    const up = Date.now() + 60_000;
    while (Date.now() < up && !existsSync(servePath)) await sleep(100);
    if (!existsSync(servePath)) {
      throw new Error(`gear serve never wrote ${servePath}\n${serverLog}`);
    }
    const cfg = JSON.parse(readFileSync(servePath, "utf8")) as { token: string; port: number };
    const url = `ws://127.0.0.1:${cfg.port}`;
    say(`  engine     ${url} (web bundle served on the same port)`);

    // ── both halves, at once ──
    //
    // The watch settles into a variable rather than being re-thrown: while VS
    // Code is running nothing is awaiting this promise, and a rejection with no
    // handler takes the whole process down before either half gets to say what
    // it saw.
    let watchError: unknown = null;
    const watching = watchForTurn(url, cfg.token, signal).then(
      (observed) => {
        writeFileSync(
          join(proofDir, "turn-observed"),
          `session ${observed.sessionId} · ${observed.userTurn.split("\n")[0]}`,
        );
        return observed;
      },
      (err: unknown) => {
        // Tell the editor half rather than letting it wait out its own clock:
        // a failure that reports in ten seconds is a failure someone reads.
        writeFileSync(join(proofDir, "turn-failed"), String(err));
        watchError = err;
        return null;
      },
    );

    say(`  launching VS Code with the extension in development mode…`);
    const exitCode = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: extensionRoot,
      extensionTestsPath: join(extensionRoot, "out", "test", "suite", "index.js"),
      extensionTestsEnv: {
        GEAR_HOME: gearHome,
        GEAR_VSCODE_PROOF_DIR: proofDir,
        // The extension spawns `gear` only if it cannot find a server; it will
        // find this one. Point it at the source CLI anyway so a failure to find
        // it is a clear error rather than "gear: not found".
        GEAR_TOOLS_BIN: toolsBin,
      },
      launchArgs: [
        workspace,
        // A clean editor: no user extensions, no inherited settings, no
        // "welcome" walkthrough stealing focus from the panel.
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-gpu",
        "--no-sandbox",
        "--user-data-dir",
        join(dir, "user-data"),
        "--extensions-dir",
        join(dir, "extensions"),
      ],
    }).catch((err: unknown) => {
      const log = existsSync(join(proofDir, "suite.log"))
        ? readFileSync(join(proofDir, "suite.log"), "utf8")
        : "(the suite wrote no log)";
      throw new Error(`the extension host failed: ${String(err)}\n\n--- suite ---\n${log}`);
    });

    signal.done = true;
    const observed = await watching;
    if (!observed) throw watchError;

    say("");
    say(readFileSync(join(proofDir, "suite.log"), "utf8").trimEnd());
    say("");
    say(`  PASS  a real VS Code loaded the extension, framed \`gear serve --web\`,`);
    say(`        and "Send selection to Gear" started session ${observed.sessionId}.`);
    say(`        user turn  ${observed.userTurn.split("\n")[0]}`);
    say(`        reply      ${observed.reply.trim()}`);
    return exitCode;
  } catch (err) {
    // Everything either half saw, before the temp directory goes. A failure
    // here is a five-process failure and "it timed out" is not a bug report.
    const log = join(proofDir, "suite.log");
    say("");
    say("  --- the editor half ---");
    say(existsSync(log) ? readFileSync(log, "utf8").trimEnd() : "  (the suite wrote no log)");
    say("  --- gear serve ---");
    say(serverLog.trimEnd() || "  (nothing)");
    throw err;
  } finally {
    signal.done = true;
    if (server) {
      server.kill("SIGTERM");
      const hard = setTimeout(() => server?.kill("SIGKILL"), 10_000);
      await new Promise<void>((r) => {
        if (server?.exitCode !== null) return r();
        server?.once("exit", () => r());
      });
      clearTimeout(hard);
    }
    model?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    say("");
    say(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
