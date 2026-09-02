// ─── gear desktop — the launcher the desktop never had ───
//
// `apps/desktop` has built green and been unlaunchable at the same time since
// August: `lib.rs` reads `~/.gear/desktop.json` to find the engine, and nothing
// in the repository ever wrote that file. A user who cloned the repo, built the
// app and double-clicked it got "Gear's local engine is not configured" and no
// way to configure it. This is the missing half.
//
// Three jobs, in the order they matter:
//
//   gear desktop          write the pointer, then open the app
//   gear desktop dev      write the pointer, then run the Vite preview
//   gear desktop --check   prove the whole chain works, headless, exit 0/1
//
// `--check` exists because the gate runs on a machine with no window server. It
// spawns the same sidecar the app spawns (or connects to `gear serve` when one
// is configured), completes the readiness handshake, asks for the command list,
// and exits. If that passes, the app's engine is reachable; what is left is a
// window, which CI cannot open and does not need to.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { PROTOCOL_VERSION, isCompatibleVersion, toStream } from "@gear/protocol";
import { getGearHome, migrateLegacyHome } from "@gear/shared";

// ─── Where things are ───

/** The repo root, from this file: bin → src → orchestrator → packages → root. */
export function engineRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
}

export function desktopPointerPath(): string {
  return join(getGearHome(), "desktop.json");
}

/** What `lib.rs` reads. `alanRoot` stays for a pre-rename binary in someone's Applications folder. */
export interface DesktopPointer {
  gearRoot: string;
  alanRoot: string;
  bun: string;
  toolsBin: string;
  writtenBy: string;
  writtenAt: string;
}

function resolveBun(): string {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.GEAR_BUN,
    process.execPath.endsWith("bun") ? process.execPath : undefined,
    home ? join(home, ".bun", "bin", "bun") : undefined,
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) if (existsSync(c)) return c;
  return "bun";
}

function resolveTools(root: string): string {
  const candidates = [
    process.env.GEAR_TOOLS_BIN,
    join(root, "target", "release", "gear-tools"),
    join(root, "target", "debug", "gear-tools"),
    join(getGearHome(), "bin", "gear-tools"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) if (existsSync(c)) return c;
  return "gear-tools";
}

/**
 * Write `~/.gear/desktop.json`.
 *
 * Idempotent and always rewritten: the pointer records absolute paths, and a
 * checkout that moved is exactly the case the stale file cannot survive.
 */
export function writeDesktopPointer(root = engineRoot()): {
  pointer: DesktopPointer;
  written: boolean;
  error?: string;
} {
  const pointer: DesktopPointer = {
    gearRoot: root,
    alanRoot: root,
    bun: resolveBun(),
    toolsBin: resolveTools(root),
    writtenBy: "gear desktop",
    writtenAt: new Date().toISOString(),
  };
  const path = desktopPointerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(pointer, null, 2) + "\n");
    return { pointer, written: true };
  } catch (err) {
    // A home that refuses the write (a sandbox, a locked profile) must say so
    // in one line. The app cannot start without this file, and a stack trace
    // does not tell anyone which file or why.
    return { pointer, written: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readDesktopPointer(): DesktopPointer | null {
  try {
    return JSON.parse(readFileSync(desktopPointerPath(), "utf8")) as DesktopPointer;
  } catch {
    return null;
  }
}

// ─── Finding an installed app ───

/**
 * A built bundle, in the order a person would expect it to win: an installed
 * app first, then this checkout's own build output.
 *
 * Returning null is not a failure — it means "no bundle yet", and the launcher
 * falls through to `tauri dev`, which is the honest thing to do in a checkout
 * that has never run `tauri build`.
 */
export function findBundle(
  root = engineRoot(),
): { kind: "macos" | "linux" | "windows"; path: string } | null {
  const home = process.env.HOME ?? "";
  const bundleDir = join(root, "apps", "desktop", "src-tauri", "target", "release", "bundle");
  const mac = [
    "/Applications/Gear.app",
    home ? join(home, "Applications", "Gear.app") : "",
    join(bundleDir, "macos", "Gear.app"),
  ].filter(Boolean);
  if (process.platform === "darwin") {
    for (const p of mac) if (existsSync(p)) return { kind: "macos", path: p };
  }
  if (process.platform === "linux") {
    const linux = [
      join(root, "apps", "desktop", "src-tauri", "target", "release", "gear-desktop"),
      "/usr/bin/gear-desktop",
      "/usr/local/bin/gear-desktop",
    ];
    for (const p of linux) if (existsSync(p)) return { kind: "linux", path: p };
  }
  if (process.platform === "win32") {
    const win = [
      join(root, "apps", "desktop", "src-tauri", "target", "release", "gear-desktop.exe"),
    ];
    for (const p of win) if (existsSync(p)) return { kind: "windows", path: p };
  }
  return null;
}

// ─── The headless proof (`--check`) ───

export interface CheckResult {
  ok: boolean;
  transport: "sidecar" | "serve";
  protocolVersion?: string;
  commands?: number;
  model?: string;
  provider?: string;
  error?: string;
  elapsedMs: number;
}

/**
 * Complete the readiness handshake against the sidecar over stdio.
 *
 * This is what the Rust bridge does, in TypeScript, minus the window: spawn
 * `engine-host.ts`, read line-delimited JSON, wait for the `ready` stream, then
 * call `hello` and check the protocol major. A desktop that passes this has
 * everything but a webview.
 */
async function checkSidecar(root: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  const script = join(root, "packages", "orchestrator", "src", "bin", "engine-host.ts");
  if (!existsSync(script)) {
    return {
      ok: false,
      transport: "sidecar",
      error: `engine host not found at ${script}`,
      elapsedMs: Date.now() - started,
    };
  }
  const bun = resolveBun();
  const child = Bun.spawn([bun, "run", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GEAR_ROOT: root,
      GEAR_TOOLS_BIN: resolveTools(root),
      GEAR_WORKSPACE: process.env.GEAR_WORKSPACE ?? process.cwd(),
    },
  });

  // The host writes its own diagnostics to stderr; keep the tail for the
  // failure message, because "no ready frame" without the reason is useless.
  let stderr = "";
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      stderr = (stderr + new TextDecoder().decode(chunk)).slice(-8_000);
    }
  })().catch(() => {});

  const tail = (): string =>
    stderr.trim() ? ` — host said: ${stderr.trim().split("\n").slice(-3).join(" / ")}` : "";

  const stop = (): void => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  const handshake = (async (): Promise<CheckResult> => {
    let ready: Record<string, unknown> | null = null;
    let buffered = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          continue; // host log noise on stdout is not a protocol frame
        }
        const stream = toStream(frame);
        if (stream?.stream === "ready") {
          ready = stream.payload as Record<string, unknown>;
          // The sidecar dialect: `{id, cmd, args}` in, `{id, ok, result}` back.
          child.stdin.write(
            JSON.stringify({
              id: 1,
              cmd: "hello",
              args: { protocolVersion: PROTOCOL_VERSION, client: "gear desktop --check" },
            }) + "\n",
          );
          child.stdin.flush();
          continue;
        }
        const obj = frame as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
        if (obj.id !== 1) continue;
        if (obj.ok !== true) {
          return {
            ok: false,
            transport: "sidecar",
            error: `hello refused: ${String(obj.error ?? "unknown")}`,
            elapsedMs: Date.now() - started,
          };
        }
        const hello = obj.result as { protocolVersion?: string; commands?: string[] };
        const compatible = isCompatibleVersion(hello.protocolVersion ?? "");
        return {
          ok: compatible,
          transport: "sidecar",
          protocolVersion: hello.protocolVersion,
          commands: hello.commands?.length,
          model: typeof ready?.model === "string" ? ready.model : undefined,
          provider: typeof ready?.provider === "string" ? ready.provider : undefined,
          error: compatible
            ? undefined
            : `protocol mismatch: this build speaks ${PROTOCOL_VERSION}, the host speaks ${hello.protocolVersion}`,
          elapsedMs: Date.now() - started,
        };
      }
    }
    return {
      ok: false,
      transport: "sidecar",
      error: `host closed its output before the handshake${tail()}`,
      elapsedMs: Date.now() - started,
    };
  })();

  const timeout = new Promise<CheckResult>((r) =>
    setTimeout(
      () =>
        r({
          ok: false,
          transport: "sidecar",
          error: `no ready frame in ${timeoutMs}ms${tail()}`,
          elapsedMs: Date.now() - started,
        }),
      timeoutMs,
    ),
  );

  const result = await Promise.race([handshake, timeout]);
  stop();
  return result;
}

/** Connect to a running `gear serve` instead of spawning a sidecar. */
async function checkServe(url: string, token: string, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  try {
    const { GearClient } = await import("@gear/sdk");
    const client = await GearClient.connect({ url, token, timeoutMs });
    const hello = await client.call("hello", {
      protocolVersion: PROTOCOL_VERSION,
      client: "gear desktop --check",
    });
    const status = await client.call("get_status", {});
    client.close();
    return {
      ok: true,
      transport: "serve",
      protocolVersion: hello.protocolVersion,
      commands: hello.commands.length,
      model: status.model,
      provider: status.provider,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      transport: "serve",
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}

/** The saved `gear serve` endpoint, if one is running and reachable. */
export function serveEndpoint(): { url: string; token: string } | null {
  const explicit = process.env.GEAR_SERVE_URL;
  const tokenEnv = process.env.GEAR_SERVE_TOKEN;
  let token = tokenEnv ?? "";
  let url = explicit ?? "";
  if (!token || !url) {
    try {
      const cfg = JSON.parse(readFileSync(join(getGearHome(), "serve.json"), "utf8")) as {
        token?: string;
        port?: number;
        host?: string;
      };
      if (!token && typeof cfg.token === "string") token = cfg.token;
      if (!url && cfg.port) {
        const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : (cfg.host ?? "127.0.0.1");
        url = `ws://${host}:${cfg.port}`;
      }
    } catch {
      /* no serve config: the sidecar is the transport */
    }
  }
  return url && token ? { url, token } : null;
}

export async function runDesktopCheck(
  opts: { timeoutMs?: number; json?: boolean } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const root = engineRoot();
  const { pointer, written, error: writeError } = writeDesktopPointer(root);

  const serve = process.env.GEAR_SERVE_URL ? serveEndpoint() : null;
  const result = serve
    ? await checkServe(serve.url, serve.token, timeoutMs)
    : await checkSidecar(root, timeoutMs);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ...result, pointer: desktopPointerPath(), pointerWritten: written },
        null,
        2,
      ),
    );
    return result.ok ? 0 : 1;
  }

  console.log(`gear desktop --check — protocol ${PROTOCOL_VERSION}`);
  console.log(
    `  pointer    ${desktopPointerPath()}${written ? "" : ` (NOT WRITTEN: ${writeError})`}`,
  );
  console.log(`  engine     ${pointer.gearRoot}`);
  console.log(`  bun        ${pointer.bun}`);
  console.log(`  tools      ${pointer.toolsBin}`);
  console.log(`  transport  ${result.transport}${serve ? ` (${serve.url})` : ""}`);
  if (result.ok) {
    console.log(
      `  handshake  ready → hello · ${result.commands ?? 0} commands · ${result.protocolVersion}`,
    );
    if (result.model) console.log(`  engine     ${result.provider}/${result.model}`);
    console.log(`  ok         ${result.elapsedMs}ms`);
    return 0;
  }
  console.error(`  FAILED     ${result.error ?? "unknown"}`);
  return 1;
}

// ─── Launching ───

function launchBundle(bundle: { kind: string; path: string }): number {
  if (bundle.kind === "macos") {
    const r = spawnSync("open", ["-a", bundle.path], { stdio: "inherit" });
    return r.status ?? 1;
  }
  const child = Bun.spawn([bundle.path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
  return 0;
}

/**
 * No bundle: run the app from source through the Tauri CLI.
 *
 * This is a developer path and says so. It is still the right fallback — a
 * checkout that has never been packaged is exactly where `gear desktop` is
 * most likely to be typed.
 */
function launchFromSource(root: string, mode: "app" | "dev"): number {
  const cwd = join(root, "apps", "desktop");
  if (!existsSync(join(cwd, "package.json"))) {
    console.error(`  no desktop app at ${cwd}`);
    return 1;
  }
  const args = mode === "dev" ? ["run", "dev"] : ["run", "tauri", "dev"];
  console.log(
    mode === "dev"
      ? "  starting the Vite preview (no engine; the demo turn runs through the real reducers)"
      : "  no packaged app found — running from source with `tauri dev`",
  );
  const r = spawnSync("bun", args, { cwd, stdio: "inherit", env: { ...process.env } });
  return r.status ?? 1;
}

// ─── Entry ───

export async function runDesktop(
  positionals: string[],
  values: Record<string, unknown>,
): Promise<number> {
  migrateLegacyHome();
  const sub = (positionals[0] ?? "").toLowerCase();

  if (values.check === true || sub === "check") {
    return runDesktopCheck({ json: values.json === true });
  }

  const root = engineRoot();
  const { pointer, written, error: writeError } = writeDesktopPointer(root);
  console.log(`gear desktop`);
  console.log(`  engine     ${pointer.gearRoot}`);
  console.log(`  pointer    ${desktopPointerPath()}`);
  if (!written) {
    // Without the pointer the app cannot find the engine, so this is fatal
    // rather than a warning: opening a window that says "not configured" is
    // worse than not opening one.
    console.error(`  cannot write the engine pointer: ${writeError}`);
    return 1;
  }
  if (pointer.toolsBin === "gear-tools") {
    console.log(
      `  note       gear-tools is not built — run \`cargo build --release -p gear-tools\``,
    );
  }

  if (sub === "dev") return launchFromSource(root, "dev");

  const bundle = findBundle(root);
  if (bundle) {
    console.log(`  app        ${bundle.path}`);
    return launchBundle(bundle);
  }
  return launchFromSource(root, "app");
}
