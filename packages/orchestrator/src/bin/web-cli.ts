// ─── gear web — the product, in a browser ───
//
// Gear's interface is ONE React bundle (`apps/web`) reached over ONE transport,
// a WebSocket to the engine. `gear web` is not a second application and no
// longer a second-best one either: it is `gear serve` that also hands out the
// page, on the same port, with the token it just minted already in it. Phase 9
// made this the product surface and deleted the native shell that used to sit
// in front of the same bundle.
//
// One port matters. A page on 7788 opening a socket on 4762 is a cross-origin
// request the allowlist would have to be widened for, and widening a security
// allowlist to accommodate your own layout is how these things stop protecting
// anything.
//
// What one URL gets you: Linux, Windows and macOS running the same bytes, a
// phone on the LAN (`--host`), and a machine you are not sitting at.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { adoptLegacyEnv, migrateLegacyHome } from "@gear/shared";

import { type WebBundle, resolveWebBundle } from "../web-embed";
import { isBunfsPath } from "./host-spawn";
import { lanAddresses, serve } from "./serve-cli";

/**
 * The repo root, from this file: bin → src → orchestrator → packages → root.
 *
 * Meaningful ONLY in a source checkout. Inside a `bun build --compile` binary
 * this file lives in a virtual filesystem, so the resolve lands somewhere that
 * does not exist (`/$bunfs/…`) or, if Bun recorded the build machine's paths,
 * on a directory belonging to whoever compiled it. Callers must go through
 * `sourceDistDir()`, which returns null in that case, instead of joining onto
 * this and hoping.
 */
export function engineRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
}

/** Where the built client is in a source checkout. */
export function webDistDir(root = engineRoot()): string {
  return join(root, "apps", "web", "dist");
}

/**
 * The on-disk `apps/web/dist` to prefer, or null when there is no source tree.
 *
 * The null is the whole point: a compiled binary must not compute a path from
 * a virtual root, fail to find it, and then report "the web client is not
 * built" about a bundle it is carrying inside itself.
 */
export function sourceDistDir(root = engineRoot()): string | null {
  if (isBunfsPath(root)) return null;
  const dist = webDistDir(root);
  return existsSync(join(dist, "index.html")) ? dist : null;
}

export function webBundleBuilt(root = engineRoot()): boolean {
  return sourceDistDir(root) !== null;
}

/**
 * The bundle to serve: the checkout's `dist/` if it has one, the embedded copy
 * otherwise, and — only in a checkout — a build if neither exists yet.
 *
 * A freshly cloned repo has no `dist/`, and telling a person to run a second
 * command before the first one works is a worse answer than spending twelve
 * seconds. It is announced, not silent. A compiled binary never takes that
 * branch: it has no `apps/web` to build and no need of one.
 */
async function ensureBundle(root: string): Promise<WebBundle | null> {
  const found = await resolveWebBundle(sourceDistDir(root));
  if (found) return found;

  const app = join(root, "apps", "web");
  if (isBunfsPath(root) || !existsSync(join(app, "package.json"))) {
    console.error(`  no web client: this build embeds none and there is no source at ${app}`);
    console.error(
      `  reinstall from a checkout that ran \`bun run --filter @gear/web build\` first`,
    );
    return null;
  }
  console.log("  building the web client (first run)…");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: app,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await build.exited;
  const built = code === 0 ? await resolveWebBundle(sourceDistDir(root)) : null;
  if (!built) console.error(`  the web client failed to build (exit ${code})`);
  return built;
}

export async function runWeb(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<number> {
  adoptLegacyEnv();
  migrateLegacyHome();

  const root = engineRoot();
  console.log("gear web");
  const bundle = await ensureBundle(root);
  if (!bundle) return 1;

  const port = Number(values.port ?? 0) || 7788;
  const bindAll = values.host === "0.0.0.0" || values.host === true || values.host === "all";
  const host = bindAll ? "0.0.0.0" : typeof values.host === "string" ? values.host : "127.0.0.1";
  const workspace =
    typeof values.workspace === "string" ? values.workspace : (positionals[0] ?? process.cwd());

  // The page is served from this server, so its own origin has to be on the
  // allowlist. A LAN bind means the browser's Origin is the LAN address, which
  // the loopback defaults do not cover — and for `--host 0.0.0.0` the Origin
  // is never `http://0.0.0.0`, it is whichever interface the phone reached, so
  // listing the bind address alone loads the page and then refuses its socket
  // with a 403 that reads as a bug in the app.
  const origins = [
    `http://127.0.0.1`,
    `http://localhost`,
    ...(bindAll ? lanAddresses().map((a) => `http://${a}`) : []),
    ...(!bindAll && host !== "127.0.0.1" ? [`http://${host}`] : []),
    ...(typeof values.origin === "string" ? [values.origin] : []),
  ];

  const running = await serve({
    port,
    host,
    workspace,
    allowRemoteSettings: values["allow-remote-settings"] === true,
    origins,
    web: bundle,
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
      // `stop()` now stops the session hosts too (P10.0), which is async.
      void Promise.resolve(running.stop()).then(() => resolve());
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  return 0;
}
