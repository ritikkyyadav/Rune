/**
 * The review workspace's git half (P3.5).
 *
 * These run against a REAL git repository in a temp directory, because the
 * thing worth testing is not the string formatting — it is that "revert this
 * file" reverts exactly that file, that a path pointing out of the workspace is
 * refused, and that an untracked file's revert is a delete and is known to be
 * one before anyone clicks it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { revertPaths, workspaceDiff } from "../../../packages/orchestrator/src/git-undo";

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rune-review-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  // Windows git defaults to `core.autocrlf=true`: a file committed with "\n"
  // is checked back out with "\r\n", and every byte-exact assertion here fails
  // on content that is otherwise identical. The fixture owns its line endings.
  git("config", "core.autocrlf", "false");
  git("config", "core.eol", "lf");
  writeFileSync(join(root, "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(root, "edited.ts"), "export const value = 1;\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "deep.ts"), "export const deep = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("what changed", () => {
  test("a clean tree reports no files, and says so rather than erroring", () => {
    const d = workspaceDiff(root);
    expect(d.repo).toBe(true);
    expect(d.files).toEqual([]);
    expect(d.patch).toBe("");
  });

  test("edits, additions and deletions all appear, with counts", () => {
    writeFileSync(join(root, "edited.ts"), "export const value = 2;\nexport const extra = 3;\n");
    writeFileSync(join(root, "brand-new.ts"), "export const isNew = true;\n");
    rmSync(join(root, "kept.ts"));

    const d = workspaceDiff(root);
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));

    expect(byPath["edited.ts"]!.untracked).toBe(false);
    expect(byPath["edited.ts"]!.added).toBe(2);
    expect(byPath["edited.ts"]!.removed).toBe(1);
    expect(byPath["brand-new.ts"]!.untracked).toBe(true);
    expect(byPath["kept.ts"]!.status).toContain("D");
  });

  test("a directory that is not a repository is reported, not thrown", () => {
    const bare = mkdtempSync(join(tmpdir(), "rune-norepo-"));
    try {
      const d = workspaceDiff(bare);
      expect(d.repo).toBe(false);
      expect(d.reason).toContain("not a git repository");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("an enormous patch is truncated, and the truncation is visible", () => {
    writeFileSync(join(root, "edited.ts"), "x\n".repeat(20_000));
    const d = workspaceDiff(root, 2_000);
    expect(d.patch.length).toBeLessThan(2_200);
    expect(d.patch).toContain("diff truncated");
  });
});

describe("reverting exactly one file", () => {
  test("restores the named file and leaves every other change alone", () => {
    writeFileSync(join(root, "edited.ts"), "export const value = 99;\n");
    writeFileSync(join(root, "src", "deep.ts"), "export const deep = 99;\n");

    const result = revertPaths(root, ["edited.ts"]);
    expect(result).toEqual({ ok: true, reverted: ["edited.ts"] });
    expect(readFileSync(join(root, "edited.ts"), "utf8")).toBe("export const value = 1;\n");
    // The whole point: the OTHER edit is still there.
    expect(readFileSync(join(root, "src", "deep.ts"), "utf8")).toBe("export const deep = 99;\n");
  });

  test("reverting an untracked file deletes it — which is what revert means", () => {
    writeFileSync(join(root, "brand-new.ts"), "export const isNew = true;\n");
    expect(revertPaths(root, ["brand-new.ts"])).toEqual({
      ok: true,
      reverted: ["brand-new.ts"],
    });
    expect(existsSync(join(root, "brand-new.ts"))).toBe(false);
  });

  test("a path that climbs out of the workspace is refused before git sees it", () => {
    for (const bad of ["../outside.ts", "/etc/passwd", "src/../../escape.ts", "--force"]) {
      const r = revertPaths(root, [bad]);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toContain("refusing");
    }
  });

  test("an empty list is a refusal, not a no-op that reports success", () => {
    const r = revertPaths(root, []);
    expect(r.ok).toBe(false);
  });

  test("restores a deleted file", () => {
    rmSync(join(root, "kept.ts"));
    expect(revertPaths(root, ["kept.ts"]).ok).toBe(true);
    expect(readFileSync(join(root, "kept.ts"), "utf8")).toBe("export const kept = 1;\n");
  });
});
