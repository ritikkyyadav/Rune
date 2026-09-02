// ─── The entry: `gear` opens the app ───
//
// Typing `gear` starts the engine as a local server if one is not already
// running and opens a browser tab on it. That tab is the product. The terminal
// console is still there and still good — it is what SSH and CI want — but it
// is now something you ask for (`gear --console`, `gear tui`) rather than the
// only thing you can get.
//
// Three properties this file exists to hold:
//
//   It EXITS. The server is spawned detached and the launcher returns your
//   prompt. A launcher that parks in the foreground turns every tab into a
//   terminal you cannot close, which is the opposite of the point.
//
//   The port is STABLE per user. `~/.gear/serve.json` records the last port and
//   it is reused whenever it is free, so the bookmark a person made yesterday
//   still works. If something else took it, a free port is chosen and recorded
//   rather than failing.
//
//   It never opens a browser it should not. No TTY (a pipe, a cron, a CI step)
//   or `GEAR_NO_BROWSER=1` prints the URL and stops. That is the difference
//   between a convenience and a program that hijacks your desktop.

import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { adoptLegacyEnv, getGearHome, migrateLegacyHome } from "@gear/shared";

import { readServeConfig, serveConfigPath, type ServeConfig } from "./serve-cli";
import { engineRoot } from "./web-cli";

/**
 * The port the app lives on when nothing says otherwise.
 *
 * Not 4762 (`gear serve`'s default, which an editor extension or a script may
 * already own) and not 8765 (Claude Science's, which people run beside this).
 */
export const DEFAULT_WEB_PORT = 7788;

// ─── Is anything there? ───

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an HTTP server answers on this port.
 *
 * An HTTP request rather than a bare TCP connect, because "something is
 * listening" is not the question — `gear serve` answers a plain GET with a 426
 * (expected a websocket upgrade) and `gear serve --web` answers with the page,
 * and ANY response proves an HTTP server is there. A TCP connect would also
 * succeed against a Postgres that happened to take the port.
 */
export async function portAnswering(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 1_500,
): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    return true;
  } catch {
    return false;
  }
}

/** Whether we could bind this port right now. */
export function portFree(port: number, hostname = "127.0.0.1"): Promise<boolean> {
  try {
    const probe = Bun.listen({ hostname, port, socket: { data() {} } });
    probe.stop(true);
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/** A port the OS handed us, so the spawn cannot lose a race with itself. */
export function freePort(hostname = "127.0.0.1"): Promise<number> {
  const probe = Bun.listen({ hostname, port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error("no free port");
  return Promise.resolve(port);
}

export interface LiveServer {
  config: ServeConfig;
  url: string;
  page: string;
}

/**
 * The page URL, token in the FRAGMENT.
 *
 * A fragment is never sent to the server, so a token in one cannot land in an
 * access log, a proxy log or a `Referer` on the way anywhere. On loopback the
 * server also embeds the current token in the page it serves, and the page
 * prefers the embedded one — which is what makes a stale bookmark harmless
 * rather than a login failure.
 */
export function pageUrl(port: number, token: string, host = "127.0.0.1"): string {
  return `http://${host}:${port}/#token=${token}`;
}

/**
 * The server this user already has, if it is genuinely up.
 *
 * Three conditions, and all three are needed: a config with a token, a pid the
 * OS still knows about, and a port that answers. A stale `serve.json` left by a
 * killed process passes the first two on its own.
 */
export async function liveServer(): Promise<LiveServer | null> {
  const config = readServeConfig();
  if (!config || !config.token || !config.port) return null;
  if (!processAlive(config.pid)) return null;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  if (!(await portAnswering(config.port, host))) return null;
  return {
    config,
    url: `ws://${host}:${config.port}`,
    page: pageUrl(config.port, config.token, host),
  };
}

// ─── Opening a browser ───

/** The command each platform uses to hand a URL to the default browser. */
export function platformOpener(platform: NodeJS.Platform = process.platform): {
  cmd: string;
  args: string[];
} {
  if (platform === "darwin") return { cmd: "open", args: [] };
  if (platform === "win32") {
    // `start` is a cmd.exe builtin, not a program. The empty string is the
    // window title `start` would otherwise take the URL for.
    return { cmd: "cmd", args: ["/c", "start", ""] };
  }
  return { cmd: "xdg-open", args: [] };
}

/**
 * Whether to actually open something.
 *
 * `GEAR_NO_BROWSER=1` is the explicit off switch; the absence of a TTY is the
 * implicit one, and it is the one that matters — a CI step, a cron job or
 * `gear | tee` must not try to raise a window on a machine that may not have
 * one. `--no-browser` maps here too, so the flag `gear login` already uses
 * means the same thing on the entry.
 */
export function shouldOpenBrowser(opts: {
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  noBrowser?: boolean;
}): boolean {
  if (opts.noBrowser) return false;
  const env = opts.env ?? process.env;
  const flag = env.GEAR_NO_BROWSER;
  if (flag && flag !== "0" && flag.toLowerCase() !== "false") return false;
  return opts.isTty !== false;
}

function openBrowser(url: string): void {
  const { cmd, args } = platformOpener();
  try {
    const child = Bun.spawn([cmd, ...args, url], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
  } catch {
    /* no opener on this box: the URL is already printed, which is the fallback */
  }
}

// ─── Starting one ───

/** Where the spawned server's own output goes, so a failed start is diagnosable. */
export function serveLogPath(): string {
  return join(getGearHome(), "serve.log");
}

/**
 * Start `gear serve --web` detached and wait until it says it is listening.
 *
 * Detached with its own stdio: the launcher exits, and the server keeps running
 * with a session halfway through editing files rather than dying with the shell
 * that started it. Readiness is the config file — `serve()` writes it after the
 * bind succeeds — matched on a NEWER `createdAt` than whatever was there, so a
 * stale file from a previous run cannot be mistaken for this one.
 */
export async function startServer(opts: {
  port: number;
  workspace: string;
  timeoutMs?: number;
}): Promise<LiveServer | null> {
  const before = readServeConfig();
  const beforeStamp = before?.createdAt ?? "";
  const root = engineRoot();
  const cli = join(root, "packages", "orchestrator", "src", "bin", "gear-cli.ts");

  // A packaged install runs the compiled binary and has no source checkout;
  // a source checkout runs this file through Bun. `process.execPath` is the
  // right answer in both cases — it is `gear` in one and `bun` in the other.
  const compiled = !cli.endsWith(".ts") || !(await Bun.file(cli).exists());
  const argv = compiled
    ? ["serve", "--web", "--port", String(opts.port), "--workspace", opts.workspace]
    : [cli, "serve", "--web", "--port", String(opts.port), "--workspace", opts.workspace];

  mkdirSync(getGearHome(), { recursive: true });
  const log = openSync(serveLogPath(), "a");
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: opts.workspace,
    stdin: "ignore",
    stdout: log,
    stderr: log,
    env: { ...process.env },
  });
  // Our exit must not take the engine down: a turn halfway through editing
  // files has nothing to do with the shell that happened to launch it.
  child.unref();

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    const cfg = readServeConfig();
    if (cfg && cfg.createdAt > beforeStamp && cfg.port && processAlive(cfg.pid)) {
      const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
      if (await portAnswering(cfg.port, host)) {
        return { config: cfg, url: `ws://${host}:${cfg.port}`, page: pageUrl(cfg.port, cfg.token) };
      }
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/**
 * The port to ask for.
 *
 * The one recorded last time, so a bookmark keeps working, unless something
 * else has it — in which case a free port, recorded for next time, beats
 * refusing to start.
 */
export async function choosePort(recorded: number | undefined): Promise<number> {
  const preferred = recorded && recorded > 0 ? recorded : DEFAULT_WEB_PORT;
  if (await portFree(preferred)) return preferred;
  return freePort();
}

// ─── The command ───

export interface OpenResult {
  code: number;
  page: string | null;
  started: boolean;
  opened: boolean;
}

/**
 * `gear` and `gear open`: make sure a server is up, print the URL, open a tab.
 *
 * Reusing a running server is the default and not a special case: one engine
 * hosts every session, so a second `gear` in a second terminal joins the one
 * already there instead of racing it for the port. When that server is serving
 * a different folder the line says so, because silently attaching to the wrong
 * workspace is the papercut this would otherwise ship with.
 */
export async function runOpen(
  values: Record<string, unknown> = {},
  opts: { isTty?: boolean } = {},
): Promise<OpenResult> {
  adoptLegacyEnv();
  migrateLegacyHome();
  const workspace = typeof values.workspace === "string" ? values.workspace : process.cwd();
  const isTty = opts.isTty ?? Boolean(process.stdout.isTTY);

  let live = await liveServer();
  let started = false;
  if (!live) {
    const recorded = readServeConfig();
    const port = await choosePort(recorded?.port);
    process.stdout.write(`Gear — starting the engine on 127.0.0.1:${port}\n`);
    live = await startServer({ port, workspace });
    started = true;
    if (!live) {
      process.stderr.write(
        `  the engine did not come up within 20s — see ${serveLogPath()}\n` +
          `  or run it in the foreground: gear web --port ${port}\n`,
      );
      return { code: 1, page: null, started: false, opened: false };
    }
  }

  const served = live.config.workspace;
  process.stdout.write(`${live.page}\n`);
  if (!started)
    process.stdout.write(`  reusing the engine already running (pid ${live.config.pid})\n`);
  if (served && served !== workspace) {
    // Not a warning and not a failure: one server, many sessions, and this is
    // the honest sentence about which folder its tools will run in.
    process.stdout.write(
      `  this engine is serving ${served} — for ${workspace}, stop it and run \`gear\` there,\n` +
        `  or \`gear web --workspace ${workspace} --port 0\` for a second one\n`,
    );
  }

  const noBrowser = values["no-browser"] === true;
  const open = shouldOpenBrowser({ isTty, noBrowser });
  if (open) openBrowser(live.page);
  else {
    const why = [
      noBrowser ? "--no-browser" : null,
      shouldOpenBrowser({ isTty: true, noBrowser: false }) ? null : "GEAR_NO_BROWSER",
      isTty ? null : "no tty",
    ].filter(Boolean);
    process.stdout.write(`  not opening a browser (${why.join(", ")})\n`);
  }
  return { code: 0, page: live.page, started, opened: open };
}

/**
 * Whether this invocation wants the terminal console rather than the app.
 *
 * Pure, and pinned by tests, because it is the one decision that can annoy
 * every existing user at once. The rule: the app is what a BARE `gear` means.
 * A subcommand, a prompt, a session to resume, a stream to emit or any flag
 * that only shapes a terminal is a person asking for the console, and gets it.
 */
export function wantsConsole(
  values: Record<string, unknown>,
  positionals: readonly string[],
): boolean {
  if (positionals.length > 0) return true;
  if (values.console === true || values.tui === true || values.classic === true) return true;
  if (values.inline === true || values.fullscreen === true || values.pristine === true) return true;
  if (typeof values.print === "string") return true;
  if (typeof values.resume === "string") return true;
  if (values.new === true || values.list === true || values["stream-json"] === true) return true;
  return false;
}

export { serveConfigPath };
