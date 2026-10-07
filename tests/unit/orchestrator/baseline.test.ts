/**
 * V4a — the tree a run started from.
 *
 * `baseline.ts` is the one definition of "before the task": HEAD, plus the
 * person's uncommitted work, plus their untracked files. These tests hold it
 * to the three things that make it safe to build on:
 *
 *   1. it is the tree AS FOUND — dirty work included, ignored files not
 *   2. taking it changes nothing the person can see: not the index, not the
 *      working tree, not the stash, not a ref
 *   3. laid out on disk it is the old source with today's environment, and it
 *      says "unavailable" rather than hand back something else
 *
 * Real git, real files, no network, no model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  baselineIsCurrent,
  captureBaseline,
  changedSinceBaseline,
  materialiseBaseline,
  type MaterialisedBaseline,
  type TaskBaseline,
} from "../../../packages/orchestrator/src/baseline";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

const read = (root: string, name: string): string => readFileSync(join(root, name), "utf8");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

// Everything a test made is removed after it, pass or fail: a failed
// assertion must not leave a repository or a cloned tree behind.
const made: string[] = [];
const open: MaterialisedBaseline[] = [];
afterEach(() => {
  for (const m of open.splice(0)) m.dispose();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "rune-baseline-test-"));
  made.push(root);
  return root;
}

/** A committed project with an ignored dependency tree and an ignored `.env`. */
function repo(): string {
  const root = scratch();
  put(root, {
    ".gitignore": "node_modules/\n.env\ndist/\n.claude/\n",
    "package.json": '{"name":"app"}\n',
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 1;\n",
    "src/gone.ts": "export const gone = 1;\n",
    "node_modules/dep/index.js": "module.exports = 'dep@1';\n",
    ".env": "KEY=one\n",
    ".claude/state.json": "{}\n",
  });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/**
 * A baseline whose clock says every file on disk predates it. The fixtures
 * above were written milliseconds ago, inside the slack a coarse file system
 * needs, so without this every environment file would read as "changed during
 * the run". The two tests that are ABOUT that clock do not use it.
 */
function settled(baseline: TaskBaseline): TaskBaseline {
  return { ...baseline, capturedAt: Date.now() + 10_000 };
}

async function laidOut(baseline: TaskBaseline): Promise<MaterialisedBaseline> {
  const out = await materialiseBaseline(baseline);
  if ("unavailable" in out) throw new Error(`unavailable: ${out.unavailable}`);
  open.push(out);
  return out;
}

/** For the tests that expect `unavailable`: if one is handed a tree, it is still removed. */
async function attempt(...args: Parameters<typeof materialiseBaseline>) {
  const out = await materialiseBaseline(...args);
  if (!("unavailable" in out)) open.push(out);
  return out;
}

describe("captureBaseline — the tree as found", () => {
  test("includes the person's uncommitted and untracked work, and nothing git ignores", async () => {
    const root = repo();
    writeFileSync(join(root, "src/a.ts"), "export const a = 2; // their WIP\n");
    unlinkSync(join(root, "src/gone.ts"));
    put(root, { "notes/todo.md": "their untracked note\n" });

    const baseline = captureBaseline(root)!;
    expect(baseline.head).toBe(git(root, "rev-parse", "HEAD").trim());
    const files = git(root, "ls-tree", "-r", "--name-only", baseline.tree).split("\n");
    expect(files).toContain("notes/todo.md");
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("src/gone.ts");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files).not.toContain(".env");
    // The WIP content, not HEAD's.
    expect(git(root, "show", `${baseline.tree}:src/a.ts`)).toContain("their WIP");
  });

  test("changes nothing the person can see: index, working tree, stash, refs", () => {
    const root = repo();
    writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
    put(root, { "staged.ts": "export const s = 1;\n", "untracked.ts": "export const u = 1;\n" });
    git(root, "add", "staged.ts");
    const before = {
      status: git(root, "status", "--porcelain=v1"),
      index: sha(join(root, ".git/index")),
      head: git(root, "rev-parse", "HEAD"),
      refs: git(root, "for-each-ref"),
      stash: git(root, "stash", "list"),
      wip: read(root, "src/a.ts"),
    };
    expect(captureBaseline(root)).not.toBeNull();
    expect(git(root, "status", "--porcelain=v1")).toBe(before.status);
    expect(sha(join(root, ".git/index"))).toBe(before.index);
    expect(git(root, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(root, "for-each-ref")).toBe(before.refs);
    expect(git(root, "stash", "list")).toBe(before.stash);
    expect(read(root, "src/a.ts")).toBe(before.wip);
  });

  test("a clean tree's baseline is HEAD's own tree", () => {
    const root = repo();
    expect(captureBaseline(root)!.tree).toBe(git(root, "rev-parse", "HEAD^{tree}").trim());
  });

  test("a workspace below the repository root records where it sits", () => {
    const root = repo();
    put(root, { "apps/web/x.ts": "export const x = 1;\n" });
    const baseline = captureBaseline(join(root, "apps/web"))!;
    expect(baseline.prefix).toBe("apps/web");
    expect(git(root, "ls-tree", "-r", "--name-only", baseline.tree)).toContain("apps/web/x.ts");
  });

  test("an untracked file too large to hash is left out of the tree, and named", () => {
    const root = repo();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 7));
    const baseline = captureBaseline(root)!;
    expect(baseline.omitted).toEqual(["big.bin"]);
    expect(git(root, "ls-tree", "-r", "--name-only", baseline.tree)).not.toContain("big.bin");
  });

  test("no repository, no commit, submodules, or an LFS filter: there is no baseline", () => {
    const bare = scratch();
    expect(captureBaseline(bare)).toBeNull();
    git(bare, "init", "-q");
    expect(captureBaseline(bare)).toBeNull();

    const sub = repo();
    put(sub, { ".gitmodules": '[submodule "x"]\n\tpath = x\n\turl = ./x\n' });
    expect(captureBaseline(sub)).toBeNull();

    const lfs = repo();
    put(lfs, { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" });
    expect(captureBaseline(lfs)).toBeNull();
  });
});

describe("changedSinceBaseline — what moved since the run began", () => {
  test("nothing, when nothing did — the person's earlier WIP is not a change", () => {
    const root = repo();
    writeFileSync(join(root, "src/a.ts"), "export const a = 2; // WIP before the run\n");
    const baseline = captureBaseline(root)!;
    expect(changedSinceBaseline(baseline)).toEqual([]);
  });

  test("an edit, a new file, a deletion, and both sides of a rename", () => {
    const root = repo();
    const baseline = captureBaseline(root)!;
    writeFileSync(join(root, "src/a.ts"), "export const a = 3;\n");
    put(root, { "src/new.ts": "export const n = 1;\n" });
    unlinkSync(join(root, "src/gone.ts"));
    renameSync(join(root, "src/b.ts"), join(root, "src/b2.ts"));
    expect(changedSinceBaseline(baseline)!.sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/b2.ts",
      "src/gone.ts",
      "src/new.ts",
    ]);
  });

  // Found by the full suite, under load: the snapshot's index is a COPY of the
  // person's, a copy is newer than every entry in it, and git only re-reads the
  // content of entries as new as the index. So a same-size rewrite made in the
  // second the file was last indexed was reported unchanged — whenever the copy
  // happened to be made one second later.
  test("a same-size edit made in the second the file was last indexed is still seen", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 6; attempt++) {
      // Begin just after a second boundary, so the commit and the edit share one.
      await sleep(1000 - (Date.now() % 1000) + 10);
      const second = Math.floor(Date.now() / 1000);
      const root = repo();
      const baseline = captureBaseline(root)!;
      // `a = 1` → `a = 3`: one byte for one byte, so size cannot give it away.
      writeFileSync(join(root, "src/a.ts"), "export const a = 3;\n");
      if (Math.floor(Date.now() / 1000) !== second) continue; // crossed into the next; again
      // The next snapshot is taken in a LATER second than the edit.
      await sleep(1100);
      expect(changedSinceBaseline(baseline)).toEqual(["src/a.ts"]);
      return;
    }
    throw new Error("could not land a commit and an edit inside one second");
  }, 20_000);

  test("a change inside an ignored directory is not a source change", () => {
    const root = repo();
    const baseline = captureBaseline(root)!;
    writeFileSync(join(root, "node_modules/dep/index.js"), "module.exports = 'dep@2';\n");
    expect(changedSinceBaseline(baseline)).toEqual([]);
  });
});

describe("baselineIsCurrent — a baseline goes stale when the branch moves", () => {
  test("HEAD unmoved: current", () => {
    const root = repo();
    expect(baselineIsCurrent(captureBaseline(root)!)).toEqual({ ok: true });
  });

  test("the person commits during the run: stale", () => {
    const root = repo();
    const baseline = captureBaseline(root)!;
    put(root, { "src/c.ts": "export const c = 1;\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "feat: mine");
    const verdict = baselineIsCurrent(baseline);
    expect(verdict.ok).toBe(false);
  });

  test("Rune's own auto-commit on top: still current", () => {
    const root = repo();
    const baseline = captureBaseline(root)!;
    put(root, { "src/c.ts": "export const c = 1;\n" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "rune: add c");
    expect(baselineIsCurrent(baseline)).toEqual({ ok: true });
  });

  test("a different branch checked out: stale", () => {
    const root = repo();
    const baseline = captureBaseline(root)!;
    git(root, "checkout", "-q", "--orphan", "other");
    git(root, "commit", "-q", "--allow-empty", "-m", "rune: unrelated root");
    expect(baselineIsCurrent(baseline).ok).toBe(false);
  });
});

describe("materialiseBaseline — old source, today's environment", () => {
  test("the source is the baseline's; the run's later edits are not in it", async () => {
    const root = repo();
    writeFileSync(join(root, "src/a.ts"), "export const a = 2; // their WIP\n");
    const baseline = settled(captureBaseline(root)!);
    // The run changes things.
    writeFileSync(join(root, "src/a.ts"), "export const a = 99; // the run's edit\n");
    put(root, { "src/added-by-run.ts": "export const z = 1;\n" });
    unlinkSync(join(root, "src/b.ts"));

    const out = await laidOut(baseline);
    expect(read(out.cwd, "src/a.ts")).toContain("their WIP");
    expect(read(out.cwd, "src/b.ts")).toContain("export const b = 1");
    expect(existsSync(join(out.cwd, "src/added-by-run.ts"))).toBe(false);
    // …and the working tree is exactly as the run left it.
    expect(read(root, "src/a.ts")).toContain("the run's edit");
    expect(existsSync(join(root, "src/b.ts"))).toBe(false);
    out.dispose();
  });

  test("the environment git ignores comes along; another tool's state does not", async () => {
    const root = repo();
    const out = await laidOut(settled(captureBaseline(root)!));
    expect(read(out.cwd, "node_modules/dep/index.js")).toContain("dep@1");
    expect(read(out.cwd, ".env")).toBe("KEY=one\n");
    expect(existsSync(join(out.cwd, ".claude"))).toBe(false);
    expect(existsSync(join(out.cwd, ".git"))).toBe(false);
    out.dispose();
  });

  test("writing into the baseline's environment does not write into the person's", async () => {
    const root = repo();
    const out = await laidOut(settled(captureBaseline(root)!));
    writeFileSync(join(out.cwd, "node_modules/dep/index.js"), "module.exports = 'scribbled';\n");
    mkdirSync(join(out.cwd, "node_modules/.cache"), { recursive: true });
    writeFileSync(join(out.cwd, "node_modules/.cache/x"), "cache\n");
    expect(read(root, "node_modules/dep/index.js")).toContain("dep@1");
    expect(existsSync(join(root, "node_modules/.cache"))).toBe(false);
    out.dispose();
  });

  test("a workspace below the repository root is laid out at the same depth", async () => {
    const root = repo();
    put(root, { "apps/web/x.ts": "export const x = 1;\n" });
    const out = await laidOut(settled(captureBaseline(join(root, "apps/web"))!));
    expect(out.cwd.endsWith("/apps/web")).toBe(true);
    expect(read(out.cwd, "x.ts")).toContain("export const x");
    // The root's dependencies are where a runner would look for them.
    expect(read(join(out.cwd, "../.."), "node_modules/dep/index.js")).toContain("dep@1");
    out.dispose();
  });

  test("a large untracked file left out of the tree is still there, if it has not changed", async () => {
    const root = repo();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 7));
    const out = await laidOut(settled(captureBaseline(root)!));
    expect(sha(join(out.cwd, "big.bin"))).toBe(sha(join(root, "big.bin")));
    out.dispose();
  });

  test("dispose removes it, twice is fine, and nothing is left behind", async () => {
    const root = repo();
    const out = await laidOut(settled(captureBaseline(root)!));
    const holder = dirname(dirname(out.cwd.replace(/\/tree$/, "/tree/x")));
    expect(existsSync(out.cwd)).toBe(true);
    out.dispose();
    out.dispose();
    expect(existsSync(out.cwd)).toBe(false);
    expect(existsSync(holder)).toBe(false);
  });
});

describe("materialiseBaseline — when it cannot be faithful it says so", () => {
  const leftovers = (): string[] =>
    readdirSync(tmpdir()).filter(
      (name) => name.startsWith("rune-baseline-") && !name.includes("test"),
    );

  test("the run changed the environment: unavailable, and nothing is left on disk", async () => {
    const root = repo();
    // Let the fixture age past the clock's slack, so only a change made after
    // the baseline can count.
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const baseline = captureBaseline(root)!;
    const before = leftovers();
    writeFileSync(join(root, "node_modules/dep/index.js"), "module.exports = 'dep@2';\n");
    const out = await attempt(baseline);
    expect("unavailable" in out && out.unavailable).toContain("environment changed during the run");
    expect("unavailable" in out && out.unavailable).toContain("node_modules/dep/index.js");
    expect(leftovers()).toEqual(before);
  }, 15_000);

  test("…but a cache a check run writes into is not the environment changing", async () => {
    const root = repo();
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const baseline = captureBaseline(root)!;
    put(root, {
      "node_modules/.cache/vite/deps.json": "{}\n",
      "node_modules/dep/__pycache__/x.pyc": "x",
    });
    const out = await attempt(baseline);
    expect("unavailable" in out).toBe(false);
    if (!("unavailable" in out)) out.dispose();
  }, 15_000);

  test("a large untracked file the run rewrote: unavailable", async () => {
    const root = repo();
    writeFileSync(join(root, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 7));
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const baseline = captureBaseline(root)!;
    writeFileSync(join(root, "big.bin"), Buffer.alloc(6 * 1024 * 1024, 9));
    const out = await attempt(baseline);
    expect("unavailable" in out && out.unavailable).toContain("big.bin");
    // And it is reported as a change, too.
    expect(changedSinceBaseline(baseline)).toContain("big.bin");
  }, 15_000);

  test("a dependency link that points back into the working tree: unavailable", async () => {
    const root = repo();
    // An ABSOLUTE link into the repository — a baseline run through it would
    // execute the run's own source.
    symlinkSync(join(root, "src"), join(root, "node_modules/linked-src"));
    const out = await attempt(settled(captureBaseline(root)!));
    expect("unavailable" in out && out.unavailable).toContain("points into the working tree");
  });

  test("a relative workspace link stays inside the baseline, and is fine", async () => {
    const root = repo();
    symlinkSync("../src", join(root, "node_modules/workspace-pkg"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 2; // before the run\n");
    const baseline = settled(captureBaseline(root)!);
    writeFileSync(join(root, "src/a.ts"), "export const a = 99; // the run's edit\n");
    const out = await laidOut(baseline);
    // Through the link, the baseline's source — not the run's.
    expect(read(out.cwd, "node_modules/workspace-pkg/a.ts")).toContain("before the run");
    out.dispose();
  });

  test("cancelled before it starts: unavailable, nothing left on disk", async () => {
    const root = repo();
    const before = leftovers();
    const ac = new AbortController();
    ac.abort();
    const out = await attempt(settled(captureBaseline(root)!), { signal: ac.signal });
    expect("unavailable" in out && out.unavailable).toBe("cancelled");
    expect(leftovers()).toEqual(before);
  });

  test("out of time: unavailable, nothing left on disk", async () => {
    const root = repo();
    const before = leftovers();
    const out = await attempt(settled(captureBaseline(root)!), { budgetMs: 0 });
    expect("unavailable" in out).toBe(true);
    expect(leftovers()).toEqual(before);
  });
});
