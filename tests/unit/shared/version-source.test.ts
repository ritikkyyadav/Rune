// ─── One version source, and the manifests that must agree with it ───
//
// `scripts/version.sh` is the only thing that decides what a build reports, and
// its fallback is `packages/orchestrator/package.json`. That is the whole
// design: a binary cannot disagree with the tag beside it, because nothing else
// knows the version.
//
// The design has one seam it cannot close by itself. The workspace has eight
// package manifests and a Cargo workspace, and if one of them is left behind at
// a bump then `@rune/shared@0.3.0` ships inside a binary reporting 0.4.0 — the
// exact four-places drift the one-source change was made to end, just moved one
// level down. Nothing tested it: `plugins-install.test.ts` asserts the shape of
// `RUNE_VERSION` and `ui-glyphs.test.ts` deliberately refuses to pin a literal.
//
// So this file pins the AGREEMENT, never a literal. It reads the version out of
// the one source and requires every manifest to match it. A bump stays a
// one-line edit per file and a miss is a red test, not a shipped mismatch.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

/** The version `scripts/version.sh` falls back to: the CLI's own manifest. */
const SOURCE_MANIFEST = join(repoRoot, "packages", "orchestrator", "package.json");

/** Every workspace manifest that carries a version of its own. */
const MANIFESTS = [
  "packages/orchestrator/package.json",
  "packages/llm-gateway/package.json",
  "packages/protocol/package.json",
  "packages/sdk/package.json",
  "packages/shared/package.json",
  "packages/telemetry/package.json",
  "packages/tool-registry/package.json",
  "tests/eval/package.json",
];

function manifestVersion(relOrAbs: string): string | undefined {
  const path = isAbsolute(relOrAbs) ? relOrAbs : join(repoRoot, relOrAbs);
  const pkg = JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
  return pkg.version;
}

const SOURCE = manifestVersion(SOURCE_MANIFEST)!;

describe("the one version source", () => {
  test("the source manifest carries a plain semver", () => {
    expect(SOURCE).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test.each(MANIFESTS)("%s agrees with it", (rel) => {
    expect({ file: rel, version: manifestVersion(rel) }).toEqual({ file: rel, version: SOURCE });
  });

  test("the Cargo workspace agrees with it", () => {
    // The crates all inherit `version.workspace = true`, so one line in the
    // root manifest is the whole Rust side.
    const cargo = readFileSync(join(repoRoot, "Cargo.toml"), "utf-8");
    const m = cargo.match(/^\s*version\s*=\s*"([^"]+)"/m);
    expect(m?.[1]).toBe(SOURCE);
  });

  test("no crate pins a version of its own instead of inheriting it", () => {
    for (const crate of ["rune-tools", "rune-index", "rune-sandbox"]) {
      const path = join(repoRoot, "crates", crate, "Cargo.toml");
      if (!existsSync(path)) continue;
      const body = readFileSync(path, "utf-8");
      expect({ crate, inherits: /^\s*version\.workspace\s*=\s*true/m.test(body) }).toEqual({
        crate,
        inherits: true,
      });
    }
  });

  test("scripts/version.sh reports the source manifest's version", async () => {
    // With no tag at HEAD and no RUNE_VERSION override, the script returns
    // `<manifest semver>-dev+<sha>`. That is the contract every build path —
    // install.sh, build-release.sh, ci.yml, release.yml — depends on.
    const p = Bun.spawn(["bash", join(repoRoot, "scripts", "version.sh")], {
      cwd: repoRoot,
      env: { ...process.env, RUNE_VERSION: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(code).toBe(0);
    expect(out.trim()).toStartWith(SOURCE);
  });

  test("an explicit RUNE_VERSION wins, with or without the leading v", async () => {
    for (const [given, want] of [
      ["9.9.9", "9.9.9"],
      ["v9.9.9", "9.9.9"],
    ]) {
      const p = Bun.spawn(["bash", join(repoRoot, "scripts", "version.sh")], {
        cwd: repoRoot,
        env: { ...process.env, RUNE_VERSION: given },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(out.trim()).toBe(want);
    }
  });
});
