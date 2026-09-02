/**
 * `gear upgrade` — the update story, with GitHub replaced by a function.
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  assetSuffix,
  cachedUpdateNag,
  cliTarget,
  compareVersions,
  parseChecksums,
  refreshUpdateCheck,
  runUpgrade,
  type LatestRelease,
  type UpgradeEnv,
} from "../../../packages/orchestrator/src/bin/upgrade-cli";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gear-upgrade-"));
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
  const cliName = `gear-${opts.suffix}`;
  const toolsName = `gear-tools-${opts.suffix}`;
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
    const parsed = parseChecksums(`${hex}  gear-linux-x64\n${hex} *gear-tools-linux-x64\n\n`);
    expect(parsed["gear-linux-x64"]).toBe(hex);
    expect(parsed["gear-tools-linux-x64"]).toBe(hex);
  });
});

describe("gear upgrade", () => {
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
    expect(lines.join("\n")).toContain("Gear v0.4.0 is available");
    expect(lines.join("\n")).toContain("gear upgrade");
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
    writeFileSync(join(bin, "gear"), "OLD CLI");
    writeFileSync(join(bin, "gear-tools"), "OLD TOOLS");
    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });

    const code = await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(code).toBe(0);
    expect(readFileSync(join(bin, "gear"), "utf8")).toBe(r.cli);
    expect(readFileSync(join(bin, "gear-tools"), "utf8")).toBe(r.tools);
    // Recoverable: the previous build is still there.
    expect(readFileSync(join(bin, "gear.backup"), "utf8")).toBe("OLD CLI");
    expect(readFileSync(join(bin, "gear-tools.backup"), "utf8")).toBe("OLD TOOLS");
    // Nothing half-written is left behind.
    expect(existsSync(join(bin, "gear.new"))).toBe(false);
  });

  test("a source install keeps its wrapper: gear-compiled is what gets replaced", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gear"), "#!/bin/sh\nexec gear-compiled \"$@\"\n");
    writeFileSync(join(bin, "gear-compiled"), "OLD BINARY");
    expect(cliTarget(bin)).toBe(join(bin, "gear-compiled"));

    const r = fakeRelease({ tag: "v0.4.0", suffix: "linux-x64" });
    await runUpgrade(
      [],
      env({ installDir: bin, statePath: join(dir, "state.json"), fetch: r.fetcher }),
    );
    expect(readFileSync(join(bin, "gear-compiled"), "utf8")).toBe(r.cli);
    // The wrapper, which carries the env loading, is untouched.
    expect(readFileSync(join(bin, "gear"), "utf8")).toContain("exec gear-compiled");
  });

  test("a checksum mismatch installs NOTHING and leaves the old binary in place", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gear"), "OLD CLI");
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
    expect(readFileSync(join(bin, "gear"), "utf8")).toBe("OLD CLI");
    expect(existsSync(join(bin, "gear.backup"))).toBe(false);
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
    expect(line).toContain("Gear v0.9.0 is available");
    expect(line).toContain("you have v0.3.0");
    expect(line).toContain("gear upgrade");
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
    expect(lines.join("\n")).toContain("Gear v9.9.9 is available");
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
