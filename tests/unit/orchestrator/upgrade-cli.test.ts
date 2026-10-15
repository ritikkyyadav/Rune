/**
 * `rune upgrade` — the update story, with GitHub replaced by a function.
 *
 * Two properties matter more than any feature here:
 *
 *   1. Nothing is ever applied without the user asking. `--check` reports and
 *      returns; the daily startup check produces one line of text and cannot
 *      reach the filesystem's install directory at all.
 *   2. Nothing is promoted unverified. A byte that does not match the
 *      release's own SHA256SUMS must leave the installed binary untouched —
 *      that is the difference between an updater and a supply-chain hole.
 *
 * So the tests drive a fake release endpoint and a real temp install dir, and
 * assert on what is on disk afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  DOWNLOAD_ATTEMPTS,
  assetSuffix,
  cachedUpdateNag,
  cliTarget,
  retireSourceBuildRecord,
  compareVersions,
  parseChecksums,
  refreshUpdateCheck,
  runUpgrade,
  type LatestRelease,
  type UpgradeEnv,
} from "../../../packages/orchestrator/src/bin/upgrade-cli";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rune-upgrade-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A release endpoint made of strings. `bad` corrupts one asset's bytes. */
function fakeRelease(opts: {
  tag: string;
  suffix: string;
  cli?: string;
  tools?: string;
  omitSums?: boolean;
  corruptCli?: boolean;
}) {
  const cli = opts.cli ?? `#!cli ${opts.tag}`;
  const tools = opts.tools ?? `#!tools ${opts.tag}`;
  const cliName = `rune-${opts.suffix}`;
  const toolsName = `rune-tools-${opts.suffix}`;
  const sums = `${sha256(cli)}  ${cliName}\n${sha256(tools)}  ${toolsName}\n`;
  const body: LatestRelease = {
    tag_name: opts.tag,
    assets: [
      { name: cliName, browser_download_url: `https://x/${cliName}` },
      { name: toolsName, browser_download_url: `https://x/${toolsName}` },
      ...(opts.omitSums
        ? []
        : [{ name: "SHA256SUMS", browser_download_url: "https://x/SHA256SUMS" }]),
    ],
  };
  const served: Record<string, string> = {
    [`https://x/${cliName}`]: opts.corruptCli ? `${cli} TAMPERED` : cli,
    [`https://x/${toolsName}`]: tools,
    "https://x/SHA256SUMS": sums,
  };
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const payload = served[url];
    if (payload === undefined) return new Response("nope", { status: 404 });
    return new Response(payload, { status: 200 });
  };
  return { fetcher, calls, cli, tools, cliName, toolsName };
}

function env(over: Partial<UpgradeEnv> & { installDir: string; statePath: string }): UpgradeEnv {
  return {
    fetch: async () => new Response("", { status: 500 }),
    version: "0.3.0",
    repo: "owner/repo",
    platform: "linux",
    arch: "x64",
    now: () => 1_000_000,
    log: () => {},
    checkEnabled: true,
    ...over,
  };
}

describe("compareVersions", () => {
  test("orders releases, and a prerelease loses to its own release", () => {
    expect(compareVersions("0.4.0", "0.3.0")).toBe(1);
    expect(compareVersions("0.3.0", "0.4.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("v0.3.1", "0.3.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    // The whole point for this repo: a dev build is behind the release.
    expect(compareVersions("0.3.0-dev+abc1234", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0", "0.3.0-dev+abc1234")).toBe(1);
    expect(compareVersions("0.3.0-dev+a", "0.3.0-dev+b")).toBe(0);
  });
});

describe("assetSuffix", () => {
  test("names the asset this machine can actually run", () => {
    expect(assetSuffix("darwin", "arm64")).toBe("darwin-arm64");
    expect(assetSuffix("darwin", "x64")).toBe("darwin-x64");
    expect(assetSuffix("linux", "arm64")).toBe("linux-arm64");
    expect(assetSuffix("win32", "x64")).toBe("windows-x64.exe");
    // No release build exists for these; upgrade must say so, not guess.
    expect(assetSuffix("win32", "arm64")).toBeNull();
    expect(assetSuffix("freebsd", "x64")).toBeNull();
  });
});

describe("parseChecksums", () => {
  test("reads both sha256sum and shasum -a 256 output", () => {
    const hex = "a".repeat(64);
    const parsed = parseChecksums(`${hex}  rune-linux-x64\n${hex} *rune-tools-linux-x64\n\n`);
    expect(parsed["rune-linux-x64"]).toBe(hex);
    expect(parsed["rune-tools-linux-x64"]).toBe(hex);
  });
});

describe("rune upgrade", () => {
  test("--check reports the newer release and installs nothing", async () => {
    const dir = tempDir();
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    const lines: string[] = [];
    const code = await runUpgrade(
      ["--check"],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        fetch: r.fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Rune v0.4.0 is available");
    expect(lines.join("\n")).toContain("rune upgrade");
    expect(existsSync(join(dir, "bin"))).toBe(false);
    // Only the release metadata was fetched — no asset download at all.
    expect(r.calls.every((u) => u.includes("api.github.com"))).toBe(true);
  });

  test("up to date says so and exits 0", async () => {
    const dir = tempDir();
    const r = fakeRelease({ tag: "v0.3.0", suffix: "linux-x64" });
    const lines: string[] = [];
    const code = await runUpgrade(
      [],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        fetch: r.fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("up to date");
  });

  test("downloads, verifies and promotes atomically, keeping one backup", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), "OLD CLI");
    writeFileSync(join(bin, "rune-tools"), "OLD TOOLS");
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });

    const code = await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(bin, "rune"), "utf8")).toBe(r.cli);
    expect(readFileSync(join(bin, "rune-tools"), "utf8")).toBe(r.tools);
    // Recoverable: the previous build is still there.
    expect(readFileSync(join(bin, "rune.backup"), "utf8")).toBe("OLD CLI");
    expect(readFileSync(join(bin, "rune-tools.backup"), "utf8")).toBe("OLD TOOLS");
    // Nothing half-written is left behind.
    expect(existsSync(join(bin, "rune.new"))).toBe(false);
  });

  test("a source install keeps its wrapper: rune-compiled is what gets replaced", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), '#!/bin/sh\nexec rune-compiled "$@"\n');
    writeFileSync(join(bin, "rune-compiled"), "OLD BINARY");
    expect(cliTarget(bin)).toBe(join(bin, "rune-compiled"));

    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(readFileSync(join(bin, "rune-compiled"), "utf8")).toBe(r.cli);
    // The wrapper, which carries the env loading, is untouched.
    expect(readFileSync(join(bin, "rune"), "utf8")).toContain("exec rune-compiled");
  });

  test("a source install's build record goes with the build it described", async () => {
    // The launcher reads `rune-compiled.meta` on every start and warns when the
    // checkout it names has moved on. Left beside a release binary, it told the
    // user to rebuild what they had just upgraded.
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), '#!/bin/sh\nexec rune-compiled "$@"\n');
    writeFileSync(join(bin, "rune-compiled"), "OLD BINARY");
    const record = "RUNE_SOURCE_ROOT=/src\nRUNE_SOURCE_COMMIT=abc123\n";
    writeFileSync(join(bin, "rune-compiled.meta"), record);
    // An older record already moved aside is replaced, not an obstacle.
    writeFileSync(join(bin, "rune-compiled.meta.backup"), "AN EARLIER RECORD");

    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    const code = await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(code).toBe(0);
    expect(existsSync(join(bin, "rune-compiled.meta"))).toBe(false);
    // Kept, like the binary it described: rolling back can restore both.
    expect(readFileSync(join(bin, "rune-compiled.meta.backup"), "utf8")).toBe(record);
    expect(readFileSync(join(bin, "rune-compiled.backup"), "utf8")).toBe("OLD BINARY");
  });

  test("a release install has no build record, and nothing is invented for it", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), "OLD CLI");
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    const code = await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(code).toBe(0);
    expect(retireSourceBuildRecord(bin)).toBe(false);
    expect(readdirSync(bin).filter((name) => name.includes("meta"))).toEqual([]);
  });

  test("a checksum mismatch installs NOTHING and leaves the old binary in place", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), "OLD CLI");
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64", corruptCli: true });
    const lines: string[] = [];

    const code = await runUpgrade(
      [],
      env({
        installDir: bin,
        statePath: join(dir, "state.json"),
        fetch: r.fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Checksum mismatch");
    expect(readFileSync(join(bin, "rune"), "utf8")).toBe("OLD CLI");
    expect(existsSync(join(bin, "rune.backup"))).toBe(false);
  });

  test("a release with no SHA256SUMS is refused rather than trusted", async () => {
    const dir = tempDir();
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64", omitSums: true });
    const lines: string[] = [];
    const code = await runUpgrade(
      [],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        fetch: r.fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Refusing to install unverified binaries");
    expect(existsSync(join(dir, "bin"))).toBe(false);
  });

  test("a platform with no release build is told so, not guessed at", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const code = await runUpgrade(
      [],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        platform: "win32",
        arch: "arm64",
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("does not have a release build");
  });

  test("an unreachable GitHub is an error message, not a crash", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const code = await runUpgrade(
      [],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        fetch: async () => {
          throw new Error("getaddrinfo ENOTFOUND api.github.com");
        },
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("Could not reach GitHub");
  });
});

describe("the daily check", () => {
  test("nags from cache only — never a network call at startup", () => {
    const dir = tempDir();
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({ lastCheckedAt: 1, latest: "0.9.0" }));
    const line = cachedUpdateNag(
      env({ installDir: join(dir, "bin"), statePath, version: "0.3.0" }),
    );
    expect(line).toContain("Rune v0.9.0 is available");
    expect(line).toContain("you have v0.3.0");
    expect(line).toContain("rune upgrade");
  });

  test("says nothing when the cache is empty, stale-but-equal, or older", () => {
    const dir = tempDir();
    const statePath = join(dir, "state.json");
    const base = { installDir: join(dir, "bin"), statePath, version: "0.3.0" };
    expect(cachedUpdateNag(env(base))).toBeNull();
    writeFileSync(statePath, JSON.stringify({ lastCheckedAt: 1, latest: "0.3.0" }));
    expect(cachedUpdateNag(env(base))).toBeNull();
    writeFileSync(statePath, JSON.stringify({ lastCheckedAt: 1, latest: "0.2.0" }));
    expect(cachedUpdateNag(env(base))).toBeNull();
  });

  test("refreshes at most once a day", async () => {
    const dir = tempDir();
    const statePath = join(dir, "state.json");
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    const base = { installDir: join(dir, "bin"), statePath, fetch: r.fetcher };

    await refreshUpdateCheck(env({ ...base, now: () => 1_000_000 }));
    expect(r.calls.length).toBe(1);
    expect(JSON.parse(readFileSync(statePath, "utf8")).latest).toBe("0.4.0");

    // Inside the window: no second request.
    await refreshUpdateCheck(env({ ...base, now: () => 1_000_000 + CHECK_INTERVAL_MS - 1 }));
    expect(r.calls.length).toBe(1);

    // Past it: ask again.
    await refreshUpdateCheck(env({ ...base, now: () => 1_000_000 + CHECK_INTERVAL_MS + 1 }));
    expect(r.calls.length).toBe(2);
  });

  test("[update] check = false stops the background look entirely", async () => {
    const dir = tempDir();
    const statePath = join(dir, "state.json");
    // A cache that WOULD nag.
    writeFileSync(statePath, JSON.stringify({ lastCheckedAt: 1, latest: "9.9.9" }));
    const r = fakeRelease({ tag: "v9.9.9", suffix: "linux-x64" });
    const off = env({
      installDir: join(dir, "bin"),
      statePath,
      fetch: r.fetcher,
      checkEnabled: false,
    });
    expect(cachedUpdateNag(off)).toBeNull();
    await refreshUpdateCheck(off);
    expect(r.calls.length).toBe(0);

    // The switch governs the background only: typing the command still works.
    const lines: string[] = [];
    const code = await runUpgrade(["--check"], { ...off, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("Rune v9.9.9 is available");
  });

  test("being offline is silent and still records the attempt", async () => {
    const dir = tempDir();
    const statePath = join(dir, "state.json");
    await refreshUpdateCheck(
      env({
        installDir: join(dir, "bin"),
        statePath,
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.lastCheckedAt).toBe(1_000_000);
    expect(state.latest).toBeUndefined();
    expect(cachedUpdateNag(env({ installDir: join(dir, "bin"), statePath }))).toBeNull();
  });
});

// ─── The immutable flag a source install leaves behind ───
//
// scripts/install.sh sets macOS's `uchg` on what it installs; a rename over
// such a file is EPERM. The web installer hit it on the founder's machine on
// 2026-09-16, and `rune upgrade` promotes with the same rename.
import { spawnSync as spawnSyncForFlag } from "node:child_process";
import {
  mkdtempSync as mkdtempForFlag,
  renameSync as renameForFlag,
  writeFileSync as writeForFlag,
} from "node:fs";
import { tmpdir as tmpdirForFlag } from "node:os";
import { join as joinForFlag } from "node:path";
import { clearImmutable } from "../../../packages/orchestrator/src/bin/upgrade-cli";

describe("clearImmutable", () => {
  const darwin = process.platform === "darwin";
  test.skipIf(!darwin)("a uchg file can be renamed over once the flag is cleared", () => {
    const dir = mkdtempForFlag(joinForFlag(tmpdirForFlag(), "rune-uchg-"));
    const target = joinForFlag(dir, "rune");
    const staged = joinForFlag(dir, "rune.new");
    writeForFlag(target, "old");
    writeForFlag(staged, "new");
    expect(spawnSyncForFlag("chflags", ["uchg", target]).status).toBe(0);
    expect(() => renameForFlag(staged, target)).toThrow();
    clearImmutable(target);
    expect(() => renameForFlag(staged, target)).not.toThrow();
    // Leave nothing immutable behind in the temp dir.
    spawnSyncForFlag("chflags", ["nouchg", target]);
  });

  test("a missing file or a non-Darwin host is nothing to clear", () => {
    expect(() => clearImmutable("/nonexistent/rune")).not.toThrow();
    expect(() => clearImmutable("/etc/hosts", "linux")).not.toThrow();
  });
});

/**
 * R7 of docs/program/rune-reliability-plan-20261014.md. On 15 October
 * `rune upgrade` failed twice with ECONNRESET on a Mac waking for seconds at a
 * time: one fetch into memory, and a dropped connection ended it.
 */
describe("a download that survives a dropped connection", () => {
  const SUFFIX = "linux-x64";
  const CLI = "C".repeat(5_000);
  const TOOLS = "T".repeat(3_000);
  const sums = `${sha256(CLI)}  rune-${SUFFIX}\n${sha256(TOOLS)}  rune-tools-${SUFFIX}\n`;
  const release: LatestRelease = {
    tag_name: "v0.4.0",
    assets: [
      { name: `rune-${SUFFIX}`, browser_download_url: "https://x/cli" },
      { name: `rune-tools-${SUFFIX}`, browser_download_url: "https://x/tools" },
      { name: "SHA256SUMS", browser_download_url: "https://x/SHA256SUMS" },
    ],
  };

  /**
   * A stream that delivers `upTo` characters, then fails like a dropped
   * socket on the next read. (Erroring in `start` would discard the queued
   * chunk — nothing would have arrived.)
   */
  const cutAfter = (text: string, upTo: number) => {
    let pulls = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(text.slice(0, upTo)));
          else
            controller.error(
              new Error("ECONNRESET: The socket connection was closed unexpectedly"),
            );
        },
      }),
      { status: 200 },
    );
  };

  function server(cliResponses: Array<(range: string | null) => Response>) {
    const ranges: Array<string | null> = [];
    let cliCalls = 0;
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("api.github.com")) return new Response(JSON.stringify(release));
      if (url === "https://x/SHA256SUMS") return new Response(sums);
      if (url === "https://x/tools") return new Response(TOOLS);
      const range = new Headers(init?.headers).get("Range");
      ranges.push(range);
      const next = cliResponses[Math.min(cliCalls++, cliResponses.length - 1)]!;
      return next(range);
    };
    return { fetcher, ranges, calls: () => cliCalls };
  }

  function upgradeEnv(fetcher: UpgradeEnv["fetch"], lines: string[]) {
    const dir = tempDir();
    return {
      dir,
      env: env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "state.json"),
        fetch: fetcher,
        log: (l) => lines.push(l),
        sleep: async () => {},
      }),
    };
  }

  test("a cut transfer resumes from the bytes it already has", async () => {
    const s = server([
      () => cutAfter(CLI, 2_000),
      (range) => new Response(CLI.slice(Number(range!.match(/bytes=(\d+)-/)![1])), { status: 206 }),
    ]);
    const lines: string[] = [];
    const { dir, env: e } = upgradeEnv(s.fetcher, lines);
    expect(await runUpgrade([], e)).toBe(0);
    expect(s.ranges).toEqual([null, "bytes=2000-"]);
    expect(readFileSync(join(dir, "bin", "rune"), "utf8")).toBe(CLI);
    expect(lines.join("\n")).toContain("resuming");
    expect(lines.join("\n")).toContain("checksums verified");
  });

  test("a server that will not resume sends it again, and that is fine", async () => {
    const s = server([() => cutAfter(CLI, 1_000), () => new Response(CLI, { status: 200 })]);
    const { dir, env: e } = upgradeEnv(s.fetcher, []);
    expect(await runUpgrade([], e)).toBe(0);
    expect(readFileSync(join(dir, "bin", "rune"), "utf8")).toBe(CLI);
  });

  test("a missing file is not asked for again", async () => {
    const s = server([() => new Response("nope", { status: 404 })]);
    const lines: string[] = [];
    const { dir, env: e } = upgradeEnv(s.fetcher, lines);
    expect(await runUpgrade([], e)).toBe(1);
    expect(s.calls()).toBe(1);
    expect(existsSync(join(dir, "bin", "rune"))).toBe(false);
  });

  test("a connection that never holds gives up, and installs nothing", async () => {
    const s = server([() => cutAfter(CLI, 10)]);
    const lines: string[] = [];
    const { dir, env: e } = upgradeEnv(s.fetcher, lines);
    expect(await runUpgrade([], e)).toBe(1);
    expect(s.calls()).toBe(DOWNLOAD_ATTEMPTS);
    expect(lines.join("\n")).toContain("Download failed");
    expect(existsSync(join(dir, "bin", "rune"))).toBe(false);
  });
});

describe("rune upgrade --rollback, --to, --channel", () => {
  test("--rollback swaps with the backup, and again swaps back", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), "new cli");
    writeFileSync(join(bin, "rune.backup"), "old cli");
    writeFileSync(join(bin, "rune-tools"), "new tools");
    writeFileSync(join(bin, "rune-tools.backup"), "old tools");
    const e = env({ installDir: bin, statePath: join(dir, "s.json") });

    expect(await runUpgrade(["--rollback"], e)).toBe(0);
    expect(readFileSync(join(bin, "rune"), "utf8")).toBe("old cli");
    expect(readFileSync(join(bin, "rune-tools"), "utf8")).toBe("old tools");
    expect(readFileSync(join(bin, "rune.backup"), "utf8")).toBe("new cli");

    expect(await runUpgrade(["--rollback"], e)).toBe(0);
    expect(readFileSync(join(bin, "rune"), "utf8")).toBe("new cli");
    expect(readdirSync(bin).some((f) => f.endsWith(".rollback"))).toBe(false);
  });

  test("--rollback with nothing kept says so", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "rune"), "cli");
    const lines: string[] = [];
    expect(
      await runUpgrade(
        ["--rollback"],
        env({ installDir: bin, statePath: join(dir, "s"), log: (l) => lines.push(l) }),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("Nothing to roll back to");
  });

  function releases(list: Array<{ tag: string; at: string; prerelease?: boolean }>) {
    const body = (tag: string, prerelease = false, at = ""): LatestRelease => {
      const suffix = "linux-x64";
      const cli = `#!cli ${tag}`;
      const tools = `#!tools ${tag}`;
      return {
        tag_name: tag,
        prerelease,
        published_at: at,
        assets: [
          { name: `rune-${suffix}`, browser_download_url: `https://x/${tag}/cli` },
          { name: `rune-tools-${suffix}`, browser_download_url: `https://x/${tag}/tools` },
          { name: "SHA256SUMS", browser_download_url: `https://x/${tag}/sums` },
        ],
      };
    };
    const asked: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      asked.push(url);
      if (url.endsWith("/releases?per_page=30")) {
        return new Response(JSON.stringify(list.map((r) => body(r.tag, r.prerelease, r.at))));
      }
      const tagged = url.match(/\/releases\/tags\/(.+)$/);
      if (tagged) {
        const found = list.find((r) => r.tag === decodeURIComponent(tagged[1]!));
        return found
          ? new Response(JSON.stringify(body(found.tag, found.prerelease, found.at)))
          : new Response("{}", { status: 404 });
      }
      const asset = url.match(/^https:\/\/x\/(v[^/]+)\/(cli|tools|sums)$/);
      if (asset) {
        const [, tag, kind] = asset;
        const cli = `#!cli ${tag}`;
        const tools = `#!tools ${tag}`;
        if (kind === "cli") return new Response(cli);
        if (kind === "tools") return new Response(tools);
        return new Response(
          `${sha256(cli)}  rune-linux-x64\n${sha256(tools)}  rune-tools-linux-x64\n`,
        );
      }
      return new Response("nope", { status: 404 });
    };
    return { fetcher, asked };
  }

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-10-15T00:00:00Z");
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

  test("--to installs that release, even an older one", async () => {
    const dir = tempDir();
    const r = releases([{ tag: "v0.3.5", at: ago(20) }]);
    const lines: string[] = [];
    const code = await runUpgrade(
      ["--to", "0.3.5"],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "s"),
        version: "0.4.0",
        fetch: r.fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "bin", "rune"), "utf8")).toBe("#!cli v0.3.5");
    expect(lines.join("\n")).toContain("older than the v0.4.0 you have");
  });

  test("--to a release that does not exist says so", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const code = await runUpgrade(
      ["--to=9.9.9"],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "s"),
        fetch: releases([]).fetcher,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("No release v9.9.9");
  });

  test("--channel stable takes the newest release out for a week, never a fresh one", async () => {
    const dir = tempDir();
    const r = releases([
      { tag: "v0.6.0", at: ago(2) },
      { tag: "v0.5.0", at: ago(9) },
      { tag: "v0.5.5", at: ago(10), prerelease: true },
      { tag: "v0.4.5", at: ago(30) },
    ]);
    const code = await runUpgrade(
      ["--channel", "stable"],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "s"),
        fetch: r.fetcher,
        now: () => NOW,
      }),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, "bin", "rune"), "utf8")).toBe("#!cli v0.5.0");
  });

  test("--channel stable with nothing a week old installs nothing", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const code = await runUpgrade(
      ["--channel=stable"],
      env({
        installDir: join(dir, "bin"),
        statePath: join(dir, "s"),
        fetch: releases([{ tag: "v0.6.0", at: ago(1) }]).fetcher,
        now: () => NOW,
        log: (l) => lines.push(l),
      }),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("out for seven days");
    expect(existsSync(join(dir, "bin", "rune"))).toBe(false);
  });

  test("an unknown channel is refused", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    expect(
      await runUpgrade(
        ["--channel", "nightly"],
        env({ installDir: join(dir, "bin"), statePath: join(dir, "s"), log: (l) => lines.push(l) }),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("latest or stable");
  });
});
