// ─── `rune upgrade` — staying current without ever being surprised ───
//
// Rune had no update story at all. A user who installed once stayed on that
// build forever unless they happened to re-run the installer, and the only
// staleness nag that existed compared a compiled binary against a source tree
// — useless to anyone who installed from a release, which is everyone the
// product is for.
//
// Two rules shape this file:
//
//   1. NEVER auto-apply. A coding agent that silently replaces its own binary
//      is a supply-chain event waiting to happen, and the one thing a user
//      must be able to say about the gear on their machine is "I put it
//      there". The daily check produces one line of text. Replacing anything
//      requires the user to type `rune upgrade`.
//   2. Verify before promoting. The download is checked against the release's
//      own SHA256SUMS before it is allowed anywhere near the install
//      directory, and promotion is the same stage-then-move dance
//      scripts/install.sh does — write the new bytes beside the old ones, back
//      the old ones up, then `rename` (atomic within a filesystem), so a
//      crash mid-upgrade leaves a working rune rather than half of one.
//
// The install directory is the launcher's own: `~/.rune/bin`, holding `rune`
// (a shell wrapper, from a source install) or the binary itself (from a
// release install), plus `rune-tools`. Upgrade replaces `rune-compiled` when a
// wrapper is present and `rune` otherwise, so a source install keeps its
// wrapper and a release install keeps its shape.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runeHomePath, loadConfig } from "@rune/shared";
import { PRODUCT_VERSION } from "./ui/brand";

// ─── The release surface ───

export const DEFAULT_UPDATE_REPO = "ritikkyyadav/Rune";

/** How long a "no newer release" answer is trusted before we ask again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface LatestRelease {
  tag_name: string;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

/** Injected in tests; the real one is `fetch`. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface UpgradeEnv {
  fetch: Fetcher;
  /** Where `rune` and `rune-tools` live. Default `~/.rune/bin`. */
  installDir: string;
  /** Where the daily check stamps itself. Default `~/.rune/update-check.json`. */
  statePath: string;
  version: string;
  repo: string;
  platform: NodeJS.Platform;
  arch: string;
  now: () => number;
  log: (line: string) => void;
  /**
   * The `[update] check = false` kill switch, resolved. It governs ONLY the
   * background look at GitHub and the nag it feeds — `rune upgrade`, typed by
   * a person, always works.
   */
  checkEnabled: boolean;
}

export function defaultEnv(overrides: Partial<UpgradeEnv> = {}): UpgradeEnv {
  const cfg = safeConfig();
  return {
    fetch: (url, init) => fetch(url, init),
    installDir: runeHomePath("bin"),
    statePath: runeHomePath("update-check.json"),
    version: PRODUCT_VERSION,
    repo: cfg.repo,
    platform: process.platform,
    arch: process.arch,
    now: () => Date.now(),
    log: (line) => console.log(line),
    checkEnabled: cfg.check,
    ...overrides,
  };
}

function safeConfig(): { check: boolean; repo: string } {
  try {
    const cfg = loadConfig() as { update?: { check?: boolean; repo?: string } };
    return {
      check: cfg.update?.check !== false,
      repo: cfg.update?.repo || DEFAULT_UPDATE_REPO,
    };
  } catch {
    // A malformed config must not stop the CLI from starting.
    return { check: true, repo: DEFAULT_UPDATE_REPO };
  }
}

// ─── Versions ───

/**
 * Compare two semver-ish strings. Enough for "is the release newer than me",
 * not a semver library: numeric core compared field by field, and a build that
 * carries a prerelease/dev suffix loses to the same core without one
 * (`0.3.0-dev+abc` < `0.3.0`), which is exactly what a dev build should do.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/, "");
    const core = clean.split(/[-+]/)[0] ?? "";
    return {
      nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      // Anything after the numeric core (`-dev`, `+sha`, `-rc.1`) is a
      // prerelease of it, and therefore older than the release itself.
      pre: clean.length > core.length,
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  // A prerelease of the same core is older than the release.
  return pa.pre ? -1 : 1;
}

/** The asset suffix for this OS/arch, in the release's naming vocabulary. */
export function assetSuffix(platform: NodeJS.Platform, arch: string): string | null {
  const a = arch === "arm64" || arch === "aarch64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!a) return null;
  if (platform === "darwin") return `darwin-${a}`;
  if (platform === "linux") return `linux-${a}`;
  if (platform === "win32") return a === "x64" ? "windows-x64.exe" : null;
  return null;
}

// ─── The daily check ───

interface CheckState {
  lastCheckedAt?: number;
  latest?: string;
}

function readState(path: string): CheckState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CheckState;
  } catch {
    return {};
  }
}

function writeState(path: string, state: CheckState): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    // A check that cannot record itself simply asks again tomorrow.
  }
}

export async function fetchLatest(env: UpgradeEnv): Promise<LatestRelease | null> {
  const url = `https://api.github.com/repos/${env.repo}/releases/latest`;
  const res = await env.fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `rune/${env.version}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as LatestRelease;
  if (!body || typeof body.tag_name !== "string") return null;
  return body;
}

/**
 * The startup nag, read from cache only — synchronous, no network, no await.
 *
 * Startup must never wait on GitHub. So the nag is printed from what the LAST
 * refresh learned, and the refresh runs detached afterwards for the next
 * start. Worst case a user hears about a release one session late, which is
 * the correct thing to trade for a CLI that always opens instantly.
 *
 * Returns the line, or null. It never writes to the terminal itself: the one
 * thing worse than no update story is one that scribbles over a TUI frame.
 */
export function cachedUpdateNag(env: UpgradeEnv = defaultEnv()): string | null {
  if (!env.checkEnabled) return null;
  const state = readState(env.statePath);
  if (!state.latest) return null;
  if (compareVersions(state.latest, env.version) <= 0) return null;
  return nagLine(state.latest, env.version);
}

/**
 * Refresh the cached answer if the day's window has elapsed. Fire and forget:
 * it prints nothing, throws nothing, and being offline is not an event.
 */
export async function refreshUpdateCheck(env: UpgradeEnv = defaultEnv()): Promise<void> {
  try {
    if (!env.checkEnabled) return;
    const state = readState(env.statePath);
    const now = env.now();
    if (state.lastCheckedAt && now - state.lastCheckedAt < CHECK_INTERVAL_MS) return;
    let latest: LatestRelease | null = null;
    try {
      latest = await fetchLatest(env);
    } catch {
      // Offline is not an error worth a word on screen.
    }
    writeState(env.statePath, {
      lastCheckedAt: now,
      ...(latest ? { latest: latest.tag_name.replace(/^v/, "") } : {}),
    });
  } catch {
    // A background check must never be able to affect the session.
  }
}

/**
 * Check and report in one call — what a test drives, and what the refresh
 * plus the nag amount to together.
 */
export async function checkForUpdateLine(env: UpgradeEnv = defaultEnv()): Promise<string | null> {
  await refreshUpdateCheck(env);
  return cachedUpdateNag(env);
}

function nagLine(version: string, current: string): string {
  return `Rune v${version} is available (you have v${current}) — run \`rune upgrade\` to install it.`;
}

// ─── Download, verify, promote ───

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Parse a `SHA256SUMS` body into `{ filename: hex }`. */
export function parseChecksums(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    out[m[2]!.trim()] = m[1]!.toLowerCase();
  }
  return out;
}

async function download(env: UpgradeEnv, url: string): Promise<Uint8Array> {
  const res = await env.fetch(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": `rune/${env.version}` },
  });
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Stage, then promote — the same shape scripts/install.sh uses.
 *
 * Every replacement byte is written to `<target>.new` first and only then
 * moved into place, after the previous file is copied to `<target>.backup`.
 * `renameSync` within one directory is atomic on every filesystem Rune
 * targets, so there is no instant at which `rune` is a partial file.
 */
function promote(target: string, bytes: Uint8Array, keepBackup: boolean): void {
  const staged = `${target}.new`;
  writeFileSync(staged, bytes);
  chmodSync(staged, 0o755);
  if (keepBackup && existsSync(target)) {
    const backup = `${target}.backup`;
    try {
      rmSync(backup, { force: true });
    } catch {
      // A backup we cannot clear is replaced by copyFileSync below anyway.
    }
    copyFileSync(target, backup);
  }
  renameSync(staged, target);
}

export interface UpgradeResult {
  code: number;
  /** The version now installed, when something was installed. */
  installed?: string;
}

/**
 * Which file the new CLI replaces.
 *
 * A source install writes a shell wrapper at `rune` that execs
 * `rune-compiled`; a release install puts the binary at `rune` directly.
 * Replacing the wrapper would strip the env loading it does, so when a
 * `rune-compiled` exists that is what gets replaced.
 */
export function cliTarget(installDir: string): string {
  const compiled = join(installDir, "rune-compiled");
  return existsSync(compiled) ? compiled : join(installDir, "rune");
}

export async function runUpgrade(
  argv: string[],
  envOverrides: Partial<UpgradeEnv> = {},
): Promise<number> {
  const env = defaultEnv(envOverrides);
  const checkOnly = argv.includes("--check");
  const { log } = env;

  const suffix = assetSuffix(env.platform, env.arch);
  if (!suffix) {
    log(`  rune upgrade does not have a release build for ${env.platform}/${env.arch}.`);
    log(`  Install from source: https://github.com/${env.repo}`);
    return 1;
  }

  let latest: LatestRelease | null;
  try {
    latest = await fetchLatest(env);
  } catch (err) {
    log(`  Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!latest) {
    log(`  No published release found for ${env.repo}.`);
    return 1;
  }

  const version = latest.tag_name.replace(/^v/, "");
  const cmp = compareVersions(version, env.version);
  if (cmp <= 0) {
    log(`  up to date — Rune v${env.version} (latest release: v${version})`);
    return 0;
  }

  log(`  Rune v${version} is available. You have v${env.version}.`);
  if (checkOnly) {
    log(`  Run \`rune upgrade\` to install it.`);
    return 0;
  }

  // ── The three assets an upgrade needs ──
  const cliName = `rune-${suffix}`;
  const toolsName = `rune-tools-${suffix}`;
  const byName = new Map(latest.assets?.map((a) => [a.name, a.browser_download_url]) ?? []);
  const sumsUrl = byName.get("SHA256SUMS");
  if (!sumsUrl) {
    log(`  Release v${version} has no SHA256SUMS. Refusing to install unverified binaries.`);
    return 1;
  }
  const cliUrl = byName.get(cliName);
  const toolsUrl = byName.get(toolsName);
  if (!cliUrl) {
    log(`  Release v${version} has no ${cliName}. Nothing to install for this platform.`);
    return 1;
  }

  let sums: Record<string, string>;
  let cliBytes: Uint8Array;
  let toolsBytes: Uint8Array | null = null;
  try {
    sums = parseChecksums(new TextDecoder().decode(await download(env, sumsUrl)));
    log(`  downloading ${cliName}`);
    cliBytes = await download(env, cliUrl);
    if (toolsUrl) {
      log(`  downloading ${toolsName}`);
      toolsBytes = await download(env, toolsUrl);
    }
  } catch (err) {
    log(`  Download failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // ── Verify BEFORE anything touches the install directory ──
  const cliExpected = sums[cliName];
  if (!cliExpected) {
    log(`  SHA256SUMS does not list ${cliName}. Refusing to install.`);
    return 1;
  }
  const cliActual = sha256(cliBytes);
  if (cliActual !== cliExpected) {
    log(`  Checksum mismatch for ${cliName}.`);
    log(`    expected ${cliExpected}`);
    log(`    got      ${cliActual}`);
    log(`  Nothing was installed.`);
    return 1;
  }
  if (toolsBytes) {
    const expected = sums[toolsName];
    const actual = sha256(toolsBytes);
    if (!expected || expected !== actual) {
      log(`  Checksum mismatch for ${toolsName}. Nothing was installed.`);
      return 1;
    }
  }
  log(`  checksums verified`);

  // ── Promote ──
  try {
    mkdirSync(env.installDir, { recursive: true });
    promote(cliTarget(env.installDir), cliBytes, true);
    if (toolsBytes) promote(join(env.installDir, "rune-tools"), toolsBytes, true);
  } catch (err) {
    log(`  Install failed: ${err instanceof Error ? err.message : String(err)}`);
    log(`  The previous binary is untouched (or restorable from its .backup).`);
    return 1;
  }

  // The daily check should not immediately re-nag about what we just installed.
  writeState(env.statePath, { lastCheckedAt: env.now(), latest: version });

  log(`  Installed Rune v${version} → ${env.installDir}`);
  log(`  The previous build is kept beside it as .backup.`);
  return 0;
}

/** For `rune doctor`: is there a backup to roll back to, and how old is it? */
export function backupInfo(installDir: string): { path: string; mtimeMs: number } | null {
  const path = `${cliTarget(installDir)}.backup`;
  try {
    return { path, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}
