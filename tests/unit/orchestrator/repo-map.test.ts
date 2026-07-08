/**
 * Repo map: a compact, deterministic tree of tracked files for the system
 * prompt. Git-only (fast + respects .gitignore for free), hard-capped, and
 * silent ("") whenever it can't be both cheap and accurate.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderRepoMap } from "../../../packages/orchestrator/src/prompts";

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function makeRepo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "repo-map-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "T"]);
  for (const f of files) {
    const p = join(root, f);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "x\n");
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
  return root;
}

describe("renderRepoMap", () => {
  test("lists tracked files grouped by directory", () => {
    const root = makeRepo(["README.md", "src/index.ts", "src/util/helper.ts", "docs/guide.md"]);
    const map = renderRepoMap(root);
    expect(map).toContain("# Repository map");
    expect(map).toContain("README.md");
    expect(map).toContain("index.ts");
    expect(map).toContain("helper.ts");
    expect(map).toContain("Tracked files (4)");
  });

  test("ignored files never appear (git ls-files respects .gitignore)", () => {
    const root = makeRepo(["src/app.ts", ".gitignore"]);
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/bundle.js"), "x\n");
    const map = renderRepoMap(root);
    expect(map).toContain("app.ts");
    expect(map).not.toContain("bundle.js");
  });

  test("elides oversized directories instead of flooding", () => {
    const files = Array.from({ length: 30 }, (_, i) => `pkg/f${String(i).padStart(2, "0")}.ts`);
    const root = makeRepo(files);
    const map = renderRepoMap(root);
    expect(map).toContain("… +18 more"); // 30 files, 12 shown
    expect(map).not.toContain("f29.ts");
  });

  test("non-git directory yields empty string", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-git-"));
    expect(renderRepoMap(dir)).toBe("");
  });

  test("deterministic across calls (cache-stability)", () => {
    const root = makeRepo(["a.ts", "b/c.ts", "b/d.ts"]);
    expect(renderRepoMap(root)).toBe(renderRepoMap(root));
  });
});
