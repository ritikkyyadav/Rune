// ─── The installers and the release must name the same files ───
//
// A release is four programs agreeing on a string: `scripts/targets.sh` decides
// the platform list, `release.yml` builds and uploads to it, `web-install.sh`
// and `install.ps1` download from it. When they disagree the failure is silent
// and total — the release page looks complete and `curl | bash` cannot find a
// thing.
//
// This has already happened once. The Gear → Rune rename moved the installers
// to `rune-*` while every published release up to v0.3.1 carries `gear-*`, so
// the one-line install has been broken since 2026-09-05 and will stay broken
// until a release is cut under the new names. Nothing in the repository would
// have caught the reverse mistake either.
//
// So this pins the agreement across all four files, by reading them.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf-8");

const TARGETS = read("scripts/targets.sh");
const WEB_INSTALL = read("scripts/web-install.sh");
const PS_INSTALL = read("scripts/install.ps1");
const RELEASE = read(".github/workflows/release.yml");
const BUILD = read("scripts/build-release.sh");

/** `bun-darwin-arm64:darwin-arm64` → `darwin-arm64`. */
function targetSuffixes(): string[] {
  const block = TARGETS.match(/RUNE_TARGETS=\(([\s\S]*?)\)/)?.[1] ?? "";
  return [...block.matchAll(/"[^":]+:([^"]+)"/g)].map((m) => m[1]!);
}

function toolsAssets(): string[] {
  const block = TARGETS.match(/RUNE_TOOLS_ASSETS=\(([\s\S]*?)\)/)?.[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("scripts/targets.sh is the one platform list", () => {
  test("it names five platforms, CLI and tools alike", () => {
    expect(targetSuffixes().sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "windows-x64.exe",
    ]);
    expect(toolsAssets().sort()).toEqual(targetSuffixes().sort());
  });

  test("build-release.sh and release.yml read it rather than restating it", () => {
    expect(BUILD).toContain("scripts/targets.sh");
    expect(BUILD).toContain('outfile="$OUT/rune-$suffix"');
    expect(RELEASE).toContain(". scripts/targets.sh");
    // The completeness gate: every suffix must have both assets in dist/.
    expect(RELEASE).toContain('f="dist/rune-${pair##*:}"');
    expect(RELEASE).toContain('f="dist/rune-tools-$suffix"');
  });
});

describe("the installers ask for the names the release publishes", () => {
  test("web-install.sh derives rune-<os>-<arch> and rune-tools-<os>-<arch>", () => {
    expect(WEB_INSTALL).toContain('asset="rune-${os}-${arch}"');
    expect(WEB_INSTALL).toContain('tools_asset="rune-tools-${os}-${arch}"');
  });

  test("every POSIX suffix in the target list is one web-install.sh can build", () => {
    // The installer composes `<os>-<arch>` from `uname`; the cases it maps have
    // to cover the whole list, or a platform ships with no way to install it.
    const oses = [...WEB_INSTALL.matchAll(/^\s*(Darwin|Linux>?)\)\s*os="(\w+)"/gm)].map(
      (m) => m[2]!,
    );
    const arches = [...WEB_INSTALL.matchAll(/\)\s*arch="(\w+)"/g)].map((m) => m[1]!);
    for (const suffix of targetSuffixes()) {
      if (suffix.endsWith(".exe")) continue; // PowerShell's job
      const [os, arch] = suffix.split("-");
      expect({ suffix, os: oses.includes(os!), arch: arches.includes(arch!) }).toEqual({
        suffix,
        os: true,
        arch: true,
      });
    }
  });

  test("install.ps1 asks for the exact Windows suffix the list carries", () => {
    const windows = targetSuffixes().find((s) => s.startsWith("windows-"))!;
    expect(PS_INSTALL).toContain(`$asset      = 'rune-${windows}'`);
    expect(PS_INSTALL).toContain(`$toolsAsset = 'rune-tools-${windows}'`);
    expect(RELEASE).toContain(`-p "rune-${windows}"`);
  });

  test("both installers verify against SHA256SUMS before installing anything", () => {
    expect(WEB_INSTALL).toContain("SHA256SUMS");
    expect(PS_INSTALL).toContain("SHA256SUMS");
    expect(RELEASE).toContain("sha256sum rune-* > SHA256SUMS");
  });
});

describe("no asset path still carries the previous name", () => {
  test("nothing downloads or uploads a gear-* asset", () => {
    for (const [name, body] of [
      ["scripts/web-install.sh", WEB_INSTALL],
      ["scripts/install.ps1", PS_INSTALL],
      ["scripts/build-release.sh", BUILD],
      ["scripts/targets.sh", TARGETS],
      [".github/workflows/release.yml", RELEASE],
    ] as const) {
      // `gear-compiled` and friends appear in web-install.sh's cleanup loop on
      // purpose — it deletes the old binaries. An ASSET name is the thing that
      // must not survive: `rune-tools-<suffix>` never reads as `gear-...`.
      const offenders = [...body.matchAll(/gear-(darwin|linux|windows|tools)[\w.-]*/g)]
        .map((m) => m[0])
        .filter((s) => !/^gear-tools$/.test(s));
      expect({ file: name, offenders }).toEqual({ file: name, offenders: [] });
    }
  });

  test("the installer tells the user to run `rune`", () => {
    // It said `gear` for three days after the rename — the last line of the
    // install, naming a command that does not exist.
    expect(WEB_INSTALL).toContain('say "Then run: $(c 1 rune)"');
    expect(WEB_INSTALL).not.toMatch(/Then run: \$\(c 1 gear\)/);
  });
});
