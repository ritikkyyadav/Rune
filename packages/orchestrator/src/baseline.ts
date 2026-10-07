// ─── The tree a run started from ───
//
// "Before the task" has one meaning in this codebase, and this file is it: the
// workspace exactly as the run found it — HEAD, plus every change the person
// had not committed, plus every untracked file git does not ignore. Not HEAD
// (their work in progress is part of what the run was handed), and not
// `HEAD~1`.
//
// Two things are built on it. The verifier asks whether a failing test was
// already failing there, so a run is not told to repair a suite it did not
// break. The parent check asks whether a test that passes now failed there, so
// a rung is not awarded for a test that was green all along. Both need the same
// tree, and a second definition of "before" is how they would come to disagree.
//
// The snapshot is a git TREE OBJECT, written through a throwaway index:
//
//   GIT_INDEX_FILE=<tmp> git read-tree HEAD
//   GIT_INDEX_FILE=<tmp> git add -u               # tracked changes, deletions
//   GIT_INDEX_FILE=<tmp> git update-index --add   # untracked, un-ignored
//   GIT_INDEX_FILE=<tmp> git write-tree
//
// The person's index, working tree, stash and refs are never touched — there
// is no `git stash`, no commit, no checkout. What is left behind is some
// unreferenced objects that `git gc` collects.
//
// Running a check against it needs more than the source: a checkout with no
// `node_modules` fails every test for a reason that says nothing about the
// code. So the snapshot is materialised as SOURCE FROM THE TREE plus THE
// ENVIRONMENT AS IT IS NOW — every path git ignores, cloned copy-on-write. The
// two runs then differ by the source alone, which is the comparison. And the
// environment is trusted only if the run did not change it: a rebuilt
// artifact in the "baseline" would be the run's own code wearing the old
// tree's name.

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isManagedCommitSubject } from "./git-undo";

/** A workspace as a run found it. */
export interface TaskBaseline {
  /** The repository's top level. */
  repoRoot: string;
  /** The workspace root's path inside the repository; "" when they are one. */
  prefix: string;
  /** HEAD when the snapshot was taken. */
  head: string;
  /** The tree object: HEAD + tracked changes + untracked, un-ignored files. */
  tree: string;
  /** When it was taken, epoch ms. */
  capturedAt: number;
  /**
   * Untracked files left out of the tree for their size. They are cloned from
   * disk when the baseline is materialised — if they have not changed since.
   */
  omitted: string[];
}

/** Untracked files above this are not hashed into the object store. */
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
/** File systems that keep times to the second, or two, exist. */
const CLOCK_SLACK_MS = 2_000;

function git(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {},
): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...opts.env },
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
  } catch {
    return null;
  }
}

const nulList = (text: string | null): string[] => (text ?? "").split("\0").filter(Boolean);

/**
 * Repositories this cannot snapshot faithfully. A submodule's content is not
 * in the superproject's tree, and an LFS filter turns `git add` into a write
 * to somewhere else. Both are answered "no baseline", never a partial one.
 */
function unsupported(repoRoot: string): boolean {
  if (existsSync(join(repoRoot, ".gitmodules"))) return true;
  try {
    return /\bfilter=lfs\b/.test(readFileSync(join(repoRoot, ".gitattributes"), "utf8"));
  } catch {
    return false;
  }
}

interface TreeSnapshot {
  repoRoot: string;
  prefix: string;
  head: string;
  tree: string;
  omitted: string[];
}

/** The workspace as it stands, as a tree object. `null` when it cannot be. */
function snapshotTree(workspaceRoot: string): TreeSnapshot | null {
  const repoRoot = git(workspaceRoot, ["rev-parse", "--show-toplevel"])?.trim();
  const head = git(workspaceRoot, ["rev-parse", "HEAD"])?.trim();
  const rawPrefix = git(workspaceRoot, ["rev-parse", "--show-prefix"]);
  if (!repoRoot || !head || rawPrefix === null) return null;
  if (unsupported(repoRoot)) return null;

  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), "rune-index-"));
    const index = join(scratch, "index");
    const env = { GIT_INDEX_FILE: index };
    // Start from a COPY of the person's index when there is one: it carries
    // the stat cache, so only files that actually changed are re-hashed. A
    // bare `read-tree HEAD` has none and re-reads every tracked file. If git
    // will not work from the copy (a split index, say), fall back to that.
    const seeded = (): boolean => {
      const live = git(repoRoot, ["rev-parse", "--git-path", "index"])?.trim();
      if (!live) return false;
      try {
        const source = isAbsolute(live) ? live : join(repoRoot, live);
        copyFileSync(source, index);
        // The copy must keep the original's AGE. Git trusts a cached stat only
        // for entries older than the index file itself; an entry as new as the
        // index is "racily clean" and gets its content re-read. A copy is
        // newer than everything in it, so that protection would be switched
        // off — and a file rewritten at the same size, in the same second it
        // was last indexed, would be reported unchanged. Floored, so the copy
        // is never a moment YOUNGER than the original.
        const { atimeMs, mtimeMs } = statSync(source);
        utimesSync(index, Math.floor(atimeMs) / 1000, Math.floor(mtimeMs) / 1000);
      } catch {
        return false;
      }
      // Tracked files: what changed, and what was removed.
      return git(repoRoot, ["add", "-u", "--", "."], { env }) !== null;
    };
    if (!seeded()) {
      rmSync(index, { force: true });
      if (git(repoRoot, ["read-tree", head], { env }) === null) return null;
      if (git(repoRoot, ["add", "-u", "--", "."], { env }) === null) return null;
    }
    // Untracked and not ignored, one by one, so a large one can be left out
    // rather than hashed into the person's object store on every run.
    const others = git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
    if (others === null) return null;
    const add: string[] = [];
    const omitted: string[] = [];
    for (const path of nulList(others)) {
      // A trailing slash is an embedded repository; its content is not ours.
      if (path.endsWith("/")) continue;
      let st: import("node:fs").Stats;
      try {
        st = lstatSync(join(repoRoot, path));
      } catch {
        continue;
      }
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      if (st.isFile() && st.size > MAX_UNTRACKED_BYTES) omitted.push(path);
      else add.push(path);
    }
    if (add.length > 0) {
      const staged = git(repoRoot, ["update-index", "--add", "-z", "--stdin"], {
        env,
        input: `${add.join("\0")}\0`,
      });
      if (staged === null) return null;
    }
    const tree = git(repoRoot, ["write-tree"], { env })?.trim();
    if (!tree) return null;
    return { repoRoot, prefix: rawPrefix.trim().replace(/\/$/, ""), head, tree, omitted };
  } catch {
    return null;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Snapshot the workspace as it is right now. Call it before the run's first
 * change. `null` means there is no baseline — not a repository, no commit yet,
 * a layout this cannot represent — and every caller reads that as "unknown".
 */
export function captureBaseline(workspaceRoot: string): TaskBaseline | null {
  const capturedAt = Date.now();
  const snap = snapshotTree(workspaceRoot);
  return snap ? { ...snap, capturedAt } : null;
}

/**
 * Whether the baseline still describes where this run started.
 *
 * It does while HEAD has not moved, or has moved only by Rune's own
 * auto-commits. Any other commit landing — a pull, a rebase, the person
 * committing — means "since the baseline" is no longer "by this run".
 */
export function baselineIsCurrent(
  baseline: TaskBaseline,
): { ok: true } | { ok: false; why: string } {
  const head = git(baseline.repoRoot, ["rev-parse", "HEAD"])?.trim();
  if (!head) return { ok: false, why: "the repository's HEAD could not be read" };
  if (head === baseline.head) return { ok: true };
  const between = git(baseline.repoRoot, [
    "log",
    "--pretty=%s",
    "--ancestry-path",
    `${baseline.head}..${head}`,
  ]);
  const isAncestor =
    git(baseline.repoRoot, ["merge-base", "--is-ancestor", baseline.head, head]) !== null;
  const subjects = (between ?? "").split("\n").filter(Boolean);
  if (isAncestor && subjects.length > 0 && subjects.every(isManagedCommitSubject)) {
    return { ok: true };
  }
  return { ok: false, why: "the branch moved since the run began" };
}

function changedOnDiskSince(path: string, sinceMs: number): boolean {
  try {
    const st = lstatSync(path);
    return Math.max(st.mtimeMs, st.ctimeMs) >= sinceMs - CLOCK_SLACK_MS;
  } catch {
    return true; // gone: it cannot be dated, so it counts
  }
}

/**
 * Repository-relative paths that differ between the baseline and the tree as
 * it is now — what the run (or anyone) changed since it began. Both sides of a
 * rename; deletions included. `null` when the tree cannot be read now.
 */
export function changedSinceBaseline(baseline: TaskBaseline): string[] | null {
  const now = snapshotTree(join(baseline.repoRoot, baseline.prefix));
  if (!now) return null;
  const diff = git(baseline.repoRoot, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    baseline.tree,
    now.tree,
  ]);
  if (diff === null) return null;
  const out = new Set(nulList(diff));
  // Files kept out of both trees for their size are compared on disk.
  for (const path of new Set([...baseline.omitted, ...now.omitted])) {
    const wasThere = baseline.omitted.includes(path);
    if (!wasThere || changedOnDiskSince(join(baseline.repoRoot, path), baseline.capturedAt)) {
      out.add(path);
    }
  }
  return [...out];
}

// ─── Materialising it ───

/**
 * Ignored paths that are some tool's own state, not the project's build
 * environment. Never cloned, and never read as environment drift.
 */
const TOOL_STATE = new Set([
  ".git",
  ".claude",
  ".codex",
  ".cursor",
  ".idea",
  ".vscode",
  ".playwright-mcp",
  ".rune",
  ".gear",
  ".alan",
  ".DS_Store",
]);

/**
 * Caches a check run writes as it goes. A new entry here during the run does
 * not mean the environment changed, so these are cloned but not held against
 * the baseline.
 */
const VOLATILE = new Set([
  ".cache",
  ".turbo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".eslintcache",
  ".vite",
  "coverage",
  ".nyc_output",
  ".DS_Store",
]);

const isToolState = (path: string): boolean =>
  path.split("/").some((segment) => TOOL_STATE.has(segment));
const isVolatile = (path: string): boolean =>
  path.split("/").some((segment) => VOLATILE.has(segment) || segment.endsWith(".tsbuildinfo"));

/**
 * The first path under `abs` that changed since `sinceMs`, outside the
 * volatile caches. `null` when nothing did; `""` when the walk ran out of
 * budget before it could say — which is read as "something may have".
 */
function firstDrift(
  abs: string,
  rel: string,
  sinceMs: number,
  budget: { n: number },
): string | null {
  if (isVolatile(rel)) return null;
  let st: import("node:fs").Stats;
  try {
    st = lstatSync(abs);
  } catch {
    return rel;
  }
  if (budget.n-- <= 0) return "";
  if (!st.isDirectory()) {
    return Math.max(st.mtimeMs, st.ctimeMs) >= sinceMs - CLOCK_SLACK_MS ? rel : null;
  }
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return rel;
  }
  for (const name of names) {
    const hit = firstDrift(join(abs, name), `${rel.replace(/\/$/, "")}/${name}`, sinceMs, budget);
    if (hit !== null) return hit;
  }
  return null;
}

/** Copy-on-write where the file system offers it; a plain copy where not. */
function cloneArgs(src: string, dst: string): string[] | null {
  if (process.platform === "darwin") return ["cp", "-cR", src, dst];
  if (process.platform === "linux") return ["cp", "-a", "--reflink=auto", src, dst];
  return null;
}

function run(argv: string[], signal: AbortSignal | undefined, deadline: number): Promise<boolean> {
  return new Promise((done) => {
    const left = deadline - Date.now();
    if (left <= 0 || signal?.aborted) return done(false);
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore" });
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, left);
    signal?.addEventListener("abort", stop, { once: true });
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      done(ok);
    };
    // The same narrowing `worker-verification.ts` uses: this package's types
    // do not expose the emitter half of `ChildProcess`.
    const events = child as unknown as {
      on(event: "error", callback: (error: Error) => void): void;
      on(event: "close", callback: (code: number | null) => void): void;
    };
    events.on("error", () => finish(false));
    events.on("close", (code) => finish(code === 0));
  });
}

/** Directories still on disk, removed when the process exits. */
const liveTrees = new Set<string>();
let exitSweepInstalled = false;

export interface MaterialisedBaseline {
  /** The baseline workspace root — where a check is run. */
  cwd: string;
  /** Remove it. Idempotent, and safe to call from a `finally`. */
  dispose(): void;
}

/**
 * Lay the baseline out on disk, with today's environment around it.
 *
 * Returns `{ unavailable }` rather than a partial tree whenever it cannot be
 * faithful: the environment changed during the run, a dependency link points
 * back into the working tree, the clone ran out of time, the run was
 * cancelled. A caller reads that as "unknown", never as a baseline.
 */
export async function materialiseBaseline(
  baseline: TaskBaseline,
  opts: { signal?: AbortSignal; budgetMs?: number } = {},
): Promise<MaterialisedBaseline | { unavailable: string }> {
  const { repoRoot } = baseline;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const cancelled = () => opts.signal?.aborted === true;

  // What git ignores is the environment. Whole directories come back as one
  // entry (`node_modules/`), which is also the unit they are cloned in.
  const ignored = git(repoRoot, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
  ]);
  if (ignored === null) return { unavailable: "the repository could not be listed" };
  const environment = [...nulList(ignored).filter((p) => !isToolState(p)), ...baseline.omitted];

  // Before anything is copied: did the run change the environment? If it
  // rebuilt an artifact or installed a dependency, "the baseline environment"
  // no longer exists and no comparison can be made against it.
  const budget = { n: 400_000 };
  for (const path of environment) {
    const drift = firstDrift(join(repoRoot, path), path, baseline.capturedAt, budget);
    if (drift === "") return { unavailable: "the environment is too large to check for changes" };
    if (drift !== null) {
      return { unavailable: `the environment changed during the run (${drift})` };
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "rune-baseline-"));
  liveTrees.add(dir);
  if (!exitSweepInstalled) {
    exitSweepInstalled = true;
    process.on("exit", () => {
      for (const d of liveTrees) rmSync(d, { recursive: true, force: true });
    });
  }
  const dispose = (): void => {
    if (!liveTrees.delete(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  };
  const giveUp = (why: string): { unavailable: string } => {
    dispose();
    return { unavailable: why };
  };

  try {
    const tree = join(dir, "tree");
    mkdirSync(tree);
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    if (
      git(repoRoot, ["read-tree", baseline.tree], { env }) === null ||
      git(repoRoot, ["checkout-index", "-a", "-f", `--prefix=${tree}/`], {
        env,
        timeoutMs: 60_000,
      }) === null
    ) {
      return giveUp("the baseline tree could not be checked out");
    }

    for (const path of environment) {
      if (cancelled()) return giveUp("cancelled");
      const src = join(repoRoot, path.replace(/\/$/, ""));
      const dst = join(tree, path.replace(/\/$/, ""));
      const argv = cloneArgs(src, dst);
      if (!argv) return giveUp("this platform has no way to clone the environment");
      mkdirSync(dirname(dst), { recursive: true });
      // A file the tree already put there (force-added inside an ignored
      // directory) is replaced by the clone of the directory around it.
      rmSync(dst, { recursive: true, force: true });
      if (!(await run(argv, opts.signal, deadline))) {
        return giveUp(
          cancelled() ? "cancelled" : `the environment could not be cloned in time (${path})`,
        );
      }
    }

    // A dependency directory whose links point back INTO the working tree
    // would hand the baseline run the run's own code.
    const escaping = firstEscapingLink(tree, repoRoot);
    if (escaping) return giveUp(`a dependency link points into the working tree (${escaping})`);

    return { cwd: join(tree, baseline.prefix), dispose };
  } catch (err) {
    return giveUp(`could not build the baseline: ${err instanceof Error ? err.message : err}`);
  }
}

/** A symlink in a cloned `node_modules` (two levels deep) that resolves into `repoRoot`. */
function firstEscapingLink(tree: string, repoRoot: string): string | null {
  // Compared by REAL path: on macOS a temp directory is `/var/…` to whoever
  // made the link and `/private/var/…` to git, and a link is the same link
  // under either name.
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path); // dangling — it leads nowhere, so not into the tree
    }
  };
  const top = real(repoRoot);
  const inside = (target: string): boolean => {
    const abs = real(target);
    return abs === top || abs.startsWith(`${top}/`);
  };
  const scan = (dir: string, depth: number): string | null => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(path);
        } catch {
          continue;
        }
        if (inside(isAbsolute(target) ? target : resolve(dir, target)))
          return path.slice(tree.length + 1);
      } else if (e.isDirectory() && depth > 0) {
        const hit = scan(path, depth - 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const roots: string[] = [];
  const find = (dir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules") roots.push(join(dir, e.name));
      else if (depth > 0 && !e.name.startsWith(".")) find(join(dir, e.name), depth - 1);
    }
  };
  find(tree, 3);
  for (const root of roots) {
    const hit = scan(root, 1);
    if (hit) return hit;
  }
  return null;
}
