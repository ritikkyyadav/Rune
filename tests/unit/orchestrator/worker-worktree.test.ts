import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateWorkerId,
  createWorkerWorktree,
  mergeWorkerWorktree,
  reapWorkerWorktrees,
  removeWorkerWorktree,
  runWorktreeChecks,
  saveWorkerChanges,
  restoreWorkerChanges,
} from "../../../packages/orchestrator/src/worker-worktree";

/**
 * P6B.1 / P6B.2 — a worker gets a filesystem, and it verifies its own slice.
 *
 * These tests build real git repositories. The behaviour under test is git
 * behaviour, and a mock would assert my beliefs about git rather than git.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rune-wt-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  // Windows git defaults to `core.autocrlf=true`, which rewrites "\n" to
  // "\r\n" on checkout and breaks byte-exact assertions on identical content.
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.eol", "lf"]);
  writeFileSync(join(dir, "README.md"), "# base\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "base.ts"), "export const base = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}

describe("P6B.1 — the worktree is seeded from the working tree, not from HEAD", () => {
  test("the lead's uncommitted work is visible to the worker", () => {
    const repo = makeRepo();
    // The lead writes an interface and does NOT commit it. This is the whole
    // reason `git worktree add … HEAD` was not good enough: a worker that
    // cannot see the interface the lead just wrote will re-invent it.
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\nexport type Api = {};\n");

    const wt = createWorkerWorktree(repo, "w1");
    expect(wt).not.toBeNull();
    expect(wt!.seededFromWorkingTree).toBe(true);
    const seen = readFileSync(join(wt!.path, "src", "base.ts"), "utf8");
    expect(seen).toContain("export type Api");
    removeWorkerWorktree(repo, wt!, false);
  });

  test("a clean tree still produces a worktree", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w2");
    expect(wt).not.toBeNull();
    expect(existsSync(join(wt!.path, "README.md"))).toBe(true);
    removeWorkerWorktree(repo, wt!, false);
  });

  test("a non-repository yields null rather than throwing", () => {
    // Losing delegation entirely because a directory is not a git repository
    // would be far worse than losing isolation.
    const dir = mkdtempSync(join(tmpdir(), "rune-nonrepo-"));
    dirs.push(dir);
    expect(createWorkerWorktree(dir, "w3")).toBeNull();
  });

  test("two workers get separate filesystems", () => {
    const repo = makeRepo();
    const a = createWorkerWorktree(repo, "w1")!;
    const b = createWorkerWorktree(repo, "w2")!;
    expect(a.path).not.toBe(b.path);
    writeFileSync(join(a.path, "src", "a.ts"), "a");
    // The collision that kept workers from having a shell cannot happen here.
    expect(existsSync(join(b.path, "src", "a.ts"))).toBe(false);
    removeWorkerWorktree(repo, a, false);
    removeWorkerWorktree(repo, b, false);
  });
});

describe("P6B.1 — merge back on the owned paths only", () => {
  test("the worker's files land in the lead's tree", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    mkdirSync(join(wt.path, "src"), { recursive: true });
    writeFileSync(join(wt.path, "src", "feature.ts"), "export const feature = true;\n");

    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "add the feature");
    expect(merge.merged).toBe(true);
    expect(merge.conflicts).toEqual([]);
    expect(merge.manifest).toEqual(["src/feature.ts"]);
    expect(readFileSync(join(repo, "src", "feature.ts"), "utf8")).toContain("feature = true");
    removeWorkerWorktree(repo, wt, false);
  });

  test("files outside the owned set are not taken", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "owned\n");
    writeFileSync(join(wt.path, "src", "stowaway.ts"), "not owned\n");

    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "add the feature");
    expect(merge.manifest).toEqual(["src/feature.ts"]);
    // Ownership governs which paths may move; the worktree only governs where
    // they were written.
    expect(existsSync(join(repo, "src", "stowaway.ts"))).toBe(false);
    removeWorkerWorktree(repo, wt, false);
  });

  test("nothing written is a clean, empty merge rather than a failure", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    const merge = mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "did nothing");
    expect(merge.merged).toBe(true);
    expect(merge.manifest).toEqual([]);
    removeWorkerWorktree(repo, wt, false);
  });

  test("merged files are not left staged in the lead's tree", () => {
    // A surprise staged set makes the lead's own auto-commit refuse, to
    // protect work it thinks the user staged.
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
    removeWorkerWorktree(repo, wt, false);
  });
});

describe("P6B.1 — teardown", () => {
  test("the checkout goes and the branch survives when asked", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");

    removeWorkerWorktree(repo, wt, true);
    expect(existsSync(wt.path)).toBe(false);
    // The branch is the only copy of a failed worker's build.
    expect(git(repo, ["branch", "--list", wt.branch])).toContain("rune/worker-w1");
  });

  test("the branch goes too when the work landed", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "w1")!;
    writeFileSync(join(wt.path, "src", "feature.ts"), "x\n");
    mergeWorkerWorktree(repo, wt, ["src/feature.ts"], "s");
    removeWorkerWorktree(repo, wt, false);
    expect(git(repo, ["branch", "--list", wt.branch])).toBe("");
  });
});

/**
 * POSIX-only: `runWorktreeChecks` runs each check through
 * `spawnSync("/bin/sh", ["-c", command])` (worker-worktree.ts:248) and the
 * fixtures are `sh` one-liners (`true`, `false`). Rune has no Windows shell
 * contract yet — nothing decides whether a check command means cmd.exe,
 * PowerShell or Git Bash — so there is no Windows behaviour to assert here,
 * only a decision to make. Logged in docs/program/backlog.md.
 *
 * The worktree half of this file (P6B.1) is pure git and DOES run on Windows.
 */
/**
 * The checks run through `rune-tools` (a real Seatbelt/bwrap-contained shell),
 * so this half needs the native binary: `RUNE_TOOLS_BINARY`, or the cargo debug
 * build next to the repo. The `ts-lint` CI job builds neither and used to fail
 * these two tests with "OS isolation unavailable"; the packaged and Rust jobs
 * are where the binary exists, and they run this contract for real.
 */
const TOOLS_BINARY =
  process.env.RUNE_TOOLS_BINARY ?? join(import.meta.dir, "../../../target/debug/rune-tools");
const HAVE_TOOLS = existsSync(TOOLS_BINARY);

describe.skipIf(process.platform === "win32" || !HAVE_TOOLS)(
  "P6B.2 — the worker runs the project's checks in its own tree",
  () => {
    test("a passing check reports passed", async () => {
      const repo = makeRepo();
      const wt = createWorkerWorktree(repo, "w1")!;
      const res = await runWorktreeChecks(wt.path, ["true"], 10_000);
      expect(res.outcome).toBe("passed");
      expect(res.failures).toEqual([]);
      removeWorkerWorktree(repo, wt, false);
    });

    test("a failing check reports failed and names the command", async () => {
      const repo = makeRepo();
      const wt = createWorkerWorktree(repo, "w1")!;
      const res = await runWorktreeChecks(wt.path, ["echo boom >&2; exit 3"], 10_000);
      expect(res.outcome).toBe("failed");
      expect(res.failures[0]).toContain("exit 3");
      expect(res.failures[0]).toContain("boom");
      removeWorkerWorktree(repo, wt, false);
    });

    test("no configured checks is not_run, never a silent pass", async () => {
      // The difference between "checks passed" and "no checks exist" is the
      // difference between a report and a claim.
      const repo = makeRepo();
      const wt = createWorkerWorktree(repo, "w1")!;
      expect((await runWorktreeChecks(wt.path, [], 10_000)).outcome).toBe("not_run");
      removeWorkerWorktree(repo, wt, false);
    });

    test("checks run in the worktree, not in the lead's tree", async () => {
      const repo = makeRepo();
      const wt = createWorkerWorktree(repo, "w1")!;
      writeFileSync(join(wt.path, "marker.txt"), "in the worktree\n");
      const res = await runWorktreeChecks(wt.path, ["test -f marker.txt"], 10_000);
      expect(res.outcome).toBe("passed");
      expect(existsSync(join(repo, "marker.txt"))).toBe(false);
      removeWorkerWorktree(repo, wt, false);
    });
  },
);

describe("complete worker snapshots and integration", () => {
  test("new source and installed dependencies are available and independent", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.rune/\n");
    writeFileSync(join(repo, "src", "new-api.ts"), "export const version = 2;\n");
    mkdirSync(join(repo, "node_modules", "fixture-dependency"), { recursive: true });
    writeFileSync(
      join(repo, "node_modules", "fixture-dependency", "index.js"),
      "module.exports = 42;\n",
    );
    const wt = createWorkerWorktree(repo, "new-source")!;
    expect(readFileSync(join(wt.path, "src", "new-api.ts"), "utf8")).toContain("version = 2");
    const dependency = join("node_modules", "fixture-dependency", "index.js");
    expect(readFileSync(join(wt.path, dependency), "utf8")).toContain("42");
    writeFileSync(join(wt.path, dependency), "changed in worker");
    expect(readFileSync(join(repo, dependency), "utf8")).toContain("42");
    const merged = mergeWorkerWorktree(repo, wt, ["src/new-api.ts"], "no edits");
    expect(merged.manifest).toEqual([]);
    removeWorkerWorktree(repo, wt, false);
  });

  test("a dirty dispatch snapshot merges correctly and preserves the lead's index", () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "src", "base.ts"), "export const base = 2;\n");
    git(repo, ["add", "src/base.ts"]);
    const indexBefore = git(repo, ["diff", "--cached"]);
    const wt = createWorkerWorktree(repo, "dirty")!;
    writeFileSync(join(wt.path, "src", "base.ts"), "export const base = 3;\n");
    expect(mergeWorkerWorktree(repo, wt, ["src/base.ts"], "improve").merged).toBe(true);
    expect(readFileSync(join(repo, "src", "base.ts"), "utf8")).toContain("base = 3");
    expect(git(repo, ["diff", "--cached"])).toBe(indexBefore);
    removeWorkerWorktree(repo, wt, false);
  });

  test("a concurrent lead edit refuses the entire integration", () => {
    const repo = makeRepo(),
      wt = createWorkerWorktree(repo, "conflict")!;
    writeFileSync(join(wt.path, "src", "base.ts"), "worker");
    writeFileSync(join(wt.path, "src", "new.ts"), "worker feature");
    writeFileSync(join(repo, "src", "base.ts"), "user");
    const result = mergeWorkerWorktree(repo, wt, ["src/base.ts", "src/new.ts"], "changes");
    expect(result.conflicts).toEqual(["src/base.ts"]);
    expect(result.manifest).toEqual([]);
    expect(existsSync(join(repo, "src", "new.ts"))).toBe(false);
    expect(readFileSync(join(repo, "src", "base.ts"), "utf8")).toBe("user");
    removeWorkerWorktree(repo, wt, true);
  });

  test("a worker can delete an owned file", () => {
    const repo = makeRepo(),
      wt = createWorkerWorktree(repo, "delete")!;
    rmSync(join(wt.path, "src", "base.ts"));
    expect(mergeWorkerWorktree(repo, wt, ["src/base.ts"], "remove").merged).toBe(true);
    expect(existsSync(join(repo, "src", "base.ts"))).toBe(false);
    removeWorkerWorktree(repo, wt, false);
  });

  test("failed work cannot be discarded by keeping only an empty branch", () => {
    const repo = makeRepo(),
      wt = createWorkerWorktree(repo, "failed")!;
    writeFileSync(join(wt.path, "src", "base.ts"), "unfinished implementation");
    expect(() => removeWorkerWorktree(repo, wt, true)).toThrow("uncommitted work");
    expect(existsSync(join(wt.path, "src", "base.ts"))).toBe(true);
  });

  test("missing isolation never executes a post-build check", async () => {
    const repo = makeRepo();
    const result = await runWorktreeChecks(
      repo,
      ["touch escaped-check"],
      1000,
      "/missing/native-tool",
    );
    expect(result.outcome).toBe("failed");
    expect(existsSync(join(repo, "escaped-check"))).toBe(false);
  });
});

test("a follow-up restores retained changes and can merge without repeating the edit", () => {
  const repo = makeRepo();
  const first = createWorkerWorktree(repo, "failed-first")!;
  writeFileSync(join(first.path, "src/base.ts"), "export const base = 7;\n");
  // A missing second owned file must not suppress staging the first file.
  saveWorkerChanges(first, ["src/base.ts", "src/never-created.ts"], "partial work");
  const previous = { branch: first.branch, baseCommit: first.baseCommit! };
  removeWorkerWorktree(repo, first, true);
  expect(readFileSync(join(repo, "src/base.ts"), "utf8")).not.toContain("7");
  const next = createWorkerWorktree(repo, "follow-up")!;
  expect(restoreWorkerChanges(next, previous, ["src/base.ts"])).toEqual(["src/base.ts"]);
  expect(readFileSync(join(next.path, "src/base.ts"), "utf8")).toContain("7");
  expect(mergeWorkerWorktree(repo, next, ["src/base.ts"], "verified retained work").merged).toBe(
    true,
  );
  expect(readFileSync(join(repo, "src/base.ts"), "utf8")).toContain("7");
  removeWorkerWorktree(repo, next, false);
});

import { WorkerIsolationError } from "../../../packages/orchestrator/src/worker-worktree";
import { WorkerSnapshotError } from "../../../packages/orchestrator/src/worker-snapshot";

test("a checkout that cannot be created is an isolation error; a partial snapshot is a snapshot error; neither leaves debris", () => {
  const blocked = makeRepo();
  writeFileSync(join(blocked, ".rune"), "not a directory");
  expect(() => createWorkerWorktree(blocked, "blocked")).toThrow(WorkerIsolationError);

  const partial = makeRepo();
  symlinkSync("/etc/hosts", join(partial, "escape"));
  expect(() => createWorkerWorktree(partial, "partial")).toThrow(WorkerSnapshotError);
  expect(git(partial, ["worktree", "list"])).not.toContain("partial");
  expect(git(partial, ["branch", "--list", "rune/worker-partial"])).toBe("");
});

test("a worktree reports what its provisioning cost", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.rune/\n");
  writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  const wt = createWorkerWorktree(repo, "stats")!;
  expect(wt.provisioning).toMatchObject({ untrackedFiles: 2, provisioned: ["node_modules"] });
  expect(wt.provisioning!.untrackedBytes).toBeGreaterThan(0);
  expect(wt.provisioning!.snapshotMs).toBeGreaterThanOrEqual(0);
  expect(wt.provisioning!.provisionMs).toBeGreaterThanOrEqual(0);
  removeWorkerWorktree(repo, wt, false);
});

/**
 * G13 — worker ids survive a restart, and the checkouts of dead workers do not.
 *
 * `let workerSeq = 0` reset on every process start, so after a crash the next
 * dispatch was `w1` again while `.rune/worktrees/w1` and `rune/worker-w1` both
 * still existed. `createWorkerWorktree` threw, `worker.ts` caught it, and the
 * worker silently degraded to a shell-less shared-tree run — permanently, for
 * every later worker in that repository, until somebody deleted the branch by
 * hand. The branch is the one thing that must never be deleted.
 */
describe("G13 — durable worker identity", () => {
  test("ids are keyed to the session and advance within it", () => {
    const repo = makeRepo();
    expect(allocateWorkerId(repo, "0198f3ab-1111-7000-8000-aaaaaaaaaaaa")).toBe("w0198f3ab-1");
    expect(allocateWorkerId(repo, "0198f3ab-1111-7000-8000-aaaaaaaaaaaa")).toBe("w0198f3ab-2");
    // A different session never collides with the first, even at counter 1.
    expect(allocateWorkerId(repo, "0198ffff-2222-7000-8000-bbbbbbbbbbbb")).toBe("w0198ffff-1");
  });

  test("a restarted process resumes the counter instead of returning to w1", () => {
    const repo = makeRepo();
    const session = "0198aaaa-3333-7000-8000-cccccccccccc";
    expect(allocateWorkerId(repo, session)).toBe("w0198aaaa-1");
    expect(allocateWorkerId(repo, session)).toBe("w0198aaaa-2");

    // A genuinely fresh process — the module-level counter starts at zero in it,
    // so anything but w0198aaaa-3 means the ledger was not read.
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const {allocateWorkerId} = await import(${JSON.stringify(
          join(import.meta.dir, "../../../packages/orchestrator/src/worker-worktree.ts"),
        )});` +
          `console.log(allocateWorkerId(${JSON.stringify(repo)}, ${JSON.stringify(session)}))`,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect((child.stdout ?? "").trim()).toBe("w0198aaaa-3");
  });

  test("after a restart the new id does not collide with the retained branch", () => {
    const repo = makeRepo();
    const session = "0198bbbb-4444-7000-8000-dddddddddddd";
    const first = allocateWorkerId(repo, session);
    const wt = createWorkerWorktree(repo, first, { sessionId: session })!;
    // The worker failed: its checkout goes, its branch is kept — the shape that
    // used to poison every later dispatch.
    writeFileSync(join(wt.path, "src", "base.ts"), "export const base = 2;\n");
    saveWorkerChanges(wt, ["src/base.ts"], "half a build");
    removeWorkerWorktree(repo, wt, true);
    expect(git(repo, ["branch", "--list", wt.branch])).toContain(wt.branch);

    const second = allocateWorkerId(repo, session);
    expect(second).not.toBe(first);
    // Before this the second dispatch threw WorkerIsolationError here.
    const again = createWorkerWorktree(repo, second, { sessionId: session })!;
    expect(again.path).not.toBe(wt.path);
    removeWorkerWorktree(repo, again, false);
  });
});

describe("G13 — the startup reaper", () => {
  test("a dead worker's uncommitted work is committed to its branch, then the checkout goes", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "wdead-1", { sessionId: "s", pid: 999_999 })!;
    // Killed mid-build: the edit exists only in the checkout.
    writeFileSync(join(wt.path, "src", "base.ts"), "export const base = 99;\n");
    writeFileSync(join(wt.path, "src", "new.ts"), "export const added = true;\n");

    const report = reapWorkerWorktrees(repo, { pidAlive: () => false });

    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ outcome: "reaped", committed: true, branch: wt.branch });
    // The checkout is gone and git no longer lists it.
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"])).not.toContain(wt.path);
    // The branch survives — and it now holds the work that was only on disk.
    expect(git(repo, ["branch", "--list", wt.branch])).toContain(wt.branch);
    expect(git(repo, ["show", `${wt.branch}:src/base.ts`])).toContain("base = 99");
    expect(git(repo, ["show", `${wt.branch}:src/new.ts`])).toContain("added = true");
  });

  test("a live worker's checkout is never touched", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "walive-1", { sessionId: "s" })!;
    writeFileSync(join(wt.path, "src", "base.ts"), "export const base = 3;\n");
    expect(reapWorkerWorktrees(repo, { pidAlive: () => true })).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    expect(readFileSync(join(wt.path, "src", "base.ts"), "utf8")).toContain("base = 3");
    removeWorkerWorktree(repo, wt, false);
  });

  test("a checkout it cannot attribute is left alone", () => {
    const repo = makeRepo();
    // A detached RUN worktree, or one made by an older Rune: no owner record,
    // so it is nobody's to declare dead.
    const wt = createWorkerWorktree(repo, "worphan-1")!;
    rmSync(join(repo, ".rune", "worktrees", ".workers", "worphan-1.owner.json"), { force: true });
    expect(reapWorkerWorktrees(repo, { pidAlive: () => false })).toEqual([]);
    expect(existsSync(wt.path)).toBe(true);
    removeWorkerWorktree(repo, wt, false);
  });

  test("when the work cannot be committed the directory stays and the reaper says why", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "wstuck-1", { sessionId: "s", pid: 999_999 })!;
    writeFileSync(join(wt.path, "src", "base.ts"), "export const base = 7;\n");
    // A linked worktree keeps its git dir in the parent repo; making it
    // read-only is the cheapest deterministic way to fail the commit.
    const gitDir = join(repo, ".git", "worktrees", "wstuck-1");
    chmodSync(gitDir, 0o555);
    try {
      const report = reapWorkerWorktrees(repo, { pidAlive: () => false });
      expect(report).toHaveLength(1);
      expect(report[0]!.outcome).toBe("kept");
      expect(report[0]!.reason).toBeTruthy();
      // The HARD RULE: uncommitted work is never destroyed to tidy a directory.
      expect(existsSync(wt.path)).toBe(true);
      expect(readFileSync(join(wt.path, "src", "base.ts"), "utf8")).toContain("base = 7");
      expect(git(repo, ["branch", "--list", wt.branch])).toContain(wt.branch);
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  test("a clean dead checkout is removed without a recovery commit, branch kept", () => {
    const repo = makeRepo();
    const wt = createWorkerWorktree(repo, "wclean-1", { sessionId: "s", pid: 999_999 })!;
    const before = git(repo, ["rev-parse", wt.branch]);
    const report = reapWorkerWorktrees(repo, { pidAlive: () => false });
    expect(report[0]).toMatchObject({ outcome: "reaped", committed: false });
    expect(existsSync(wt.path)).toBe(false);
    // Nothing was invented on the branch, and nothing was deleted from it.
    expect(git(repo, ["rev-parse", wt.branch])).toBe(before);
  });

  test("a workspace that is not a git repository is not an error", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-wt-plain-"));
    dirs.push(dir);
    expect(reapWorkerWorktrees(dir, { pidAlive: () => false })).toEqual([]);
  });
});
