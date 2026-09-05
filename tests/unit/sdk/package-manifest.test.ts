/**
 * The manifest that decides whether `npm i @rune/sdk` works.
 *
 * Everything here is a mistake that only shows up on somebody else's machine,
 * after install, as a resolution error with no obvious cause: a `private` flag
 * that silently blocks publish, an `exports` path outside `files`, a workspace
 * dependency that cannot be installed from a registry. None of it is caught by
 * typecheck, the test suite, or a local run, because locally the workspace
 * resolves everything for you.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sdkRoot = join(import.meta.dir, "../../../packages/sdk");
const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  main: string;
  types: string;
  files: string[];
  exports: Record<string, { types?: string; default?: string } | string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts: Record<string, string>;
};

describe("@rune/sdk is publishable", () => {
  test("is not marked private", () => {
    // `private: true` makes `npm publish` refuse. It was set while the package
    // was a workspace seed; leaving it set is how a "published" SDK stays
    // unpublished without anyone noticing.
    expect(manifest.private).toBeUndefined();
  });

  test("ships dist and the README, and nothing else", () => {
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(existsSync(join(sdkRoot, "README.md"))).toBe(true);
  });

  test("every exported path is inside what gets packed", () => {
    const targets: string[] = [];
    for (const entry of Object.values(manifest.exports)) {
      if (typeof entry === "string") targets.push(entry);
      else targets.push(...Object.values(entry).filter((v): v is string => typeof v === "string"));
    }
    targets.push(manifest.main, manifest.types);
    for (const t of targets) {
      const rel = t.replace(/^\.\//, "");
      // `package.json` is always packed; everything else must be under dist.
      expect(rel === "package.json" || rel.startsWith("dist/")).toBe(true);
    }
  });

  test("declares no runtime dependency a registry cannot resolve", () => {
    // `@rune/protocol` is a private workspace package. It is VENDORED into
    // dist by the build; if it ever appears as a runtime dependency again,
    // every install fails on a 404 that says nothing useful.
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name.startsWith("@rune/")).toBe(false);
    }
  });

  test("builds before it packs", () => {
    // Without `prepack`, `npm publish` from a clean checkout ships whatever
    // stale dist happened to be on disk — or an empty tarball.
    expect(manifest.scripts.prepack).toContain("build");
  });
});
