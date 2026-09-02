// ─── gear web — the same client, in a browser ───
//
// The desktop and the web client are ONE React bundle (`apps/desktop`). What
// differs is the transport: inside Tauri it drives the sidecar it spawned; in a
// browser it drives `gear serve` over a WebSocket. So `gear web` is not a second
// application — it is `gear serve` that also hands out the page, on the same
// port, with the token it just minted already in it.
//
// One port matters. A page on 7788 opening a socket on 4762 is a cross-origin
// request the allowlist would have to be widened for, and widening a security
// allowlist to accommodate your own layout is how these things stop protecting
// anything.
//
// What this gets you that the app does not: Linux, a phone on the LAN
// (`--host`), and a machine you are not sitting at.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { adoptLegacyEnv, migrateLegacyHome } from "@gear/shared";

import { engineRoot } from "./desktop-cli";
import { serve } from "./serve-cli";

/** Where the built client is, and whether it is there. */
export function webDistDir(root = engineRoot()): string {
  return join(root, "apps", "desktop", "dist");
}

export function webBundleBuilt(root = engineRoot()): boolean {
  return existsSync(join(webDistDir(root), "index.html"));
}

/**
 * Build the client if it has never been built.
 *
 * A checkout that has just been cloned has no `dist/`, and telling a person to
 * run a second command before the first one works is a worse answer than
 * spending twelve seconds. It is announced, not silent.
 */
async function ensureBundle(root: string): Promise<boolean> {
  if (webBundleBuilt(root)) return true;
  const app = join(root, "apps", "desktop");
  if (!existsSync(join(app, "package.json"))) {
    console.error(`  no web client at ${app}`);
    return false;
  }
  console.log("  building the web client (first run)…");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: app,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await build.exited;
  if (code !== 0 || !webBundleBuilt(root)) {
    console.error(`  the web client failed to build (exit ${code})`);
    return false;
  }
  return true;
}

export async function runWeb(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<number> {
  adoptLegacyEnv();
  migrateLegacyHome();

  const root = engineRoot();
  console.log("gear web");
  if (!(await ensureBundle(root))) return 1;

  const port = Number(values.port ?? 0) || 7788;
  const bindAll = values.host === "0.0.0.0" || values.host === true || values.host === "all";
  const host = bindAll ? "0.0.0.0" : typeof values.host === "string" ? values.host : "127.0.0.1";
  const workspace =
    typeof values.workspace === "string" ? values.workspace : (positionals[0] ?? process.cwd());

  // The page is served from this server, so its own origin has to be on the
  // allowlist. A LAN bind means the browser's Origin is the LAN address, which
  // the loopback defaults do not cover.
  const origins = [
    `http://127.0.0.1`,
    `http://localhost`,
    ...(bindAll || host !== "127.0.0.1" ? [`http://${host}`] : []),
    ...(typeof values.origin === "string" ? [values.origin] : []),
  ];

  const running = await serve({
    port,
    host,
    workspace,
    allowRemoteSettings: values["allow-remote-settings"] === true,
    origins,
    web: { dist: webDistDir(root) },
  });

  if (values.open === true) {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
      Bun.spawn([opener, `http://127.0.0.1:${running.port}`], {
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
    } catch {
      /* no browser to open: the URL is already printed */
    }
  }

  // `serve()` returns as soon as it is listening, so park here or the process
  // exits with a token file on disk and nothing behind it.
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      running.stop();
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  return 0;
}
