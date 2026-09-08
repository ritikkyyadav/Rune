import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  cpSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  WorkerSnapshotError,
  checkedWorkerPath,
  copyUntrackedSource,
  provisionWorkerDependencies,
} from "./worker-snapshot";
import { runContainedCheck } from "./worker-verification";

import { isGitRepo } from "./worktree";

/**
 * A filesystem of its own, per worker.
 *
 * Ownership claims split *paths* within one tree. That was enough to stop two
 * workers writing the same file and not nearly enough to give them a shell: two
 * parallel `npm run build`s in one checkout collide on `node_modules`, on
 * `dist/`, on lockfiles and on every other unowned artifact a build touches.
 * That is why `WORKER_TOOLS` had no `bash`, and why a worker's output had never
 * been compiled or run by anything before the lead read it.
 *
 * A worktree fixes the collision at the layer where it actually happens. The
 * two mechanisms compose rather than compete: **ownership governs which paths a
 * worker may touch; the worktree governs which filesystem it touches them in.**
 *
 * ## Branching from a dirty tree
 *
 * `git worktree add … HEAD` branches from the last commit, which for this
 * harness is close to useless: the lead's uncommitted work is the context the
 * worker was dispatched to build on. A worker that cannot see the interface the
 * lead just wrote will re-invent it.
 *
 * So the worktree is seeded from the *working tree*, not from HEAD: create the
 * checkout at HEAD, then apply the lead's uncommitted diff into it. This is
 * done with `git diff` piped to `git apply`, deliberately NOT with `git stash`
 * — a stash is repository-global state shared with every other worktree and
 * every other Rune session on the machine, so a stash/pop pair here would be a
 * race with anything else running, and a crash between the two would strand the
 * user's work in a stash entry they never made.
 */

export interface WorkerWorktree {
  path: string;
  branch: string;
  /** True when the lead's uncommitted work was carried in. */
  seededFromWorkingTree: boolean;
  /** Immutable snapshot before this worker changes anything. */
  baseCommit?: string;
  provisioned?: string[];
  /** What building this filesystem cost. */
  provisioning?: WorkerProvisioning;
}

/**
 * What building the worker's filesystem cost — measured, because "reflinks
 * are cheap" is a claim about APFS and the fallback is a byte copy of
 * node_modules per worker on everything else.
 */
export interface WorkerProvisioning {
  untrackedFiles: number;
  untrackedBytes: number;
  /** Tracked diff, untracked copy and the snapshot commit. */
  snapshotMs: number;
  /** Installed environments (node_modules, .venv) reflinked or copied. */
  provisionMs: number;
  provisioned: string[];
}

/**
 * The isolated checkout could not be CREATED — storage, `git worktree add`,
 * the branch, the tracked diff. Nothing partial was handed over, so the
 * shared tree, which has every file, is a safe fallback for the caller.
 * Contrast WorkerSnapshotError, which must never fall back.
 */
export class WorkerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerIsolationError";
  }
}

export interface MergeOutcome {
  merged: boolean;
  /** Paths git could not merge cleanly. Reported as a typed field, never as prose. */
  conflicts: string[];
  /** Files the worker actually changed, from `git diff --stat` against the base. */
  manifest: string[];
  /** Kept when the merge did not happen, so the work can be inspected. */
  branch: string;
  reason?: string;
}

const WORKTREE_DIR = join(".rune", "worktrees");

function git(
  cwd: string,
  args: string[],
  opts: { input?: string; timeout?: number; raw?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: opts.raw ? (res.stdout ?? "") : (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

/**
 * Create a worker's worktree, seeded from the lead's working tree.
 *
 * Returns null when the workspace is not a git repository at all. Otherwise
 * it either returns a COMPLETE checkout or throws one of two things, and the
 * distinction is the caller's policy:
 *
 *   · WorkerIsolationError — the checkout could not be created (storage, the
 *     worktree, the branch, the tracked diff). Nothing partial exists, so the
 *     shared tree is an honest fallback: it has every file. Losing delegation
 *     because `git worktree` failed would be far worse than losing isolation.
 *   · WorkerSnapshotError — the checkout exists but the snapshot would be
 *     partial (too many files, too many bytes, a special file, a link that
 *     leaves the project). This never falls back: a worker on stale code
 *     reports stale work as done. The message carries the remedy.
 *
 * Either way the half-made checkout and its branch are removed before the
 * throw.
 */
export function createWorkerWorktree(repoRoot: string, workerId: string): WorkerWorktree | null {
  if (!isGitRepo(repoRoot)) return null;
  const id = safeId(workerId);
  const base = join(repoRoot, WORKTREE_DIR);
  try {
    mkdirSync(base, { recursive: true });
  } catch (error) {
    throw new WorkerIsolationError(`Cannot create isolated worker storage: ${String(error)}`);
  }
  const path = join(base, id);
  if (existsSync(path)) throw new WorkerIsolationError(`Worker checkout already exists: ${path}`);
  const branch = `rune/worker-${id}`;

  // A retained branch may be the only copy of a failed worker. Never delete it.
  if (git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).ok)
    throw new WorkerIsolationError(
      `Worker branch already exists: ${branch}; resume or inspect it before reusing this ID.`,
    );
  const add = git(repoRoot, ["worktree", "add", "--detach", path, "HEAD"]);
  if (!add.ok) throw new WorkerIsolationError(`Cannot create worker checkout: ${add.stderr}`);
  const checkout = git(path, ["checkout", "-b", branch]);
  if (!checkout.ok) {
    git(repoRoot, ["worktree", "remove", "--force", path]);
    throw new WorkerIsolationError(`Cannot create worker branch: ${checkout.stderr}`);
  }

  try {
    const snapshotStarted = performance.now();
    const diff = git(repoRoot, ["diff", "HEAD", "--binary"], { raw: true });
    if (!diff.ok) throw new WorkerIsolationError(`Cannot snapshot tracked work: ${diff.stderr}`);
    if (diff.stdout) {
      const applied = git(path, ["apply", "--allow-empty", "-"], { input: diff.stdout });
      if (!applied.ok)
        throw new WorkerIsolationError(`Worker source snapshot failed: ${applied.stderr}`);
    }
    const untrackedStats = { bytes: 0 };
    const untracked = copyUntrackedSource(repoRoot, path, untrackedStats);
    const added = git(path, ["add", "-A"]);
    if (!added.ok) throw new WorkerIsolationError(`Cannot stage worker snapshot: ${added.stderr}`);
    if (!git(path, ["diff", "--cached", "--quiet"]).ok) {
      const seeded = git(path, [
        "-c",
        "user.name=Rune",
        "-c",
        "user.email=rune@localhost",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--no-verify",
        "-qm",
        "rune: working source snapshot",
      ]);
      if (!seeded.ok)
        throw new WorkerIsolationError(`Cannot save worker snapshot: ${seeded.stderr}`);
    }
    const baseCommit = git(path, ["rev-parse", "HEAD"]).stdout;
    const snapshotMs = Math.round(performance.now() - snapshotStarted);
    const provisionStarted = performance.now();
    const provisioned = provisionWorkerDependencies(repoRoot, path);
    const provisionMs = Math.round(performance.now() - provisionStarted);
    return {
      path,
      branch,
      baseCommit,
      provisioned,
      seededFromWorkingTree: !!diff.stdout || untracked.length > 0,
      provisioning: {
        untrackedFiles: untracked.length,
        untrackedBytes: untrackedStats.bytes,
        snapshotMs,
        provisionMs,
        provisioned,
      },
    };
  } catch (error) {
    git(repoRoot, ["worktree", "remove", "--force", path]);
    git(repoRoot, ["branch", "-D", branch]);
    if (error instanceof WorkerSnapshotError || error instanceof WorkerIsolationError) throw error;
    throw new WorkerIsolationError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Commit the worker's owned paths in its worktree, then merge them back into
 * the lead's tree.
 *
 * Merge-back is deliberately narrow: only the paths the worker owned are taken.
 * A 3-way merge of the whole branch would also re-apply the lead's own seeded
 * diff, which is already present in the lead's tree — so the base for the file
 * extraction is the worktree branch and the target is the working tree, one
 * owned path at a time.
 */
export function saveWorkerChanges(wt: WorkerWorktree, ownedPaths: string[], summary: string): void {
  for (const path of ownedPaths) checkedWorkerPath(wt.path, path.replace(/\/$/, ""));
  // A declared file may never have been created. One missing path must not
  // stop Git from preserving all the other edited files.
  for (const path of ownedPaths) {
    const tracked = git(wt.path, ["ls-files", "--", path]).stdout;
    if (!tracked && !existsSync(join(wt.path, path))) continue;
    const staged = git(wt.path, ["add", "-A", "--", path]);
    if (!staged.ok) throw new Error(`Cannot preserve ${path}: ${staged.stderr}`);
  }
  if (git(wt.path, ["diff", "--cached", "--quiet"]).ok) return;
  const result = git(wt.path, [
    "-c",
    "user.name=Rune",
    "-c",
    "user.email=rune@localhost",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--no-verify",
    "-qm",
    `rune(worker): ${summary.replace(/\s+/g, " ").slice(0, 64)}`,
  ]);
  if (!result.ok) throw new Error(`Could not preserve worker changes: ${result.stderr}`);
}

/** Reapply a failed child's owned changes onto the new dispatch snapshot.
 * git apply validates the complete patch before changing files. A conflict
 * leaves the parent and original retained branch intact. */
export function restoreWorkerChanges(
  wt: WorkerWorktree,
  previous: { branch: string; baseCommit: string },
  ownedPaths: string[],
): string[] {
  const diff = git(
    wt.path,
    ["diff", previous.baseCommit, previous.branch, "--binary", "--", ...ownedPaths],
    { raw: true },
  );
  if (!diff.ok) throw new Error(`Retained worker branch is unavailable: ${diff.stderr}`);
  if (!diff.stdout) return [];
  const check = git(wt.path, ["apply", "--check", "-"], { input: diff.stdout });
  if (!check.ok)
    throw new Error(
      `Retained worker changes conflict with the current workspace. Inspect ${previous.branch}: ${check.stderr}`,
    );
  const applied = git(wt.path, ["apply", "-"], { input: diff.stdout });
  if (!applied.ok) throw new Error(`Cannot restore retained worker changes: ${applied.stderr}`);
  return git(
    wt.path,
    ["diff", "--name-only", "-z", previous.baseCommit, previous.branch, "--", ...ownedPaths],
    { raw: true },
  )
    .stdout.split("\0")
    .filter(Boolean);
}

export function mergeWorkerWorktree(
  repoRoot: string,
  wt: WorkerWorktree,
  ownedPaths: string[],
  summary: string,
): MergeOutcome {
  const conflicts: string[] = [];
  const base = wt.baseCommit ?? git(wt.path, ["rev-parse", "HEAD"]).stdout;
  try {
    saveWorkerChanges(wt, ownedPaths, summary);
  } catch (error) {
    return { merged: false, conflicts, manifest: [], branch: wt.branch, reason: String(error) };
  }
  const diff = git(wt.path, ["diff", "--name-only", "-z", base, "HEAD", "--", ...ownedPaths], {
    raw: true,
  });
  if (!diff.ok)
    return { merged: false, conflicts, manifest: [], branch: wt.branch, reason: diff.stderr };
  const paths = diff.stdout.split("\0").filter(Boolean);
  const manifest: string[] = [];
  // Check the whole merge before touching the lead: a conflict does not leave
  // half an API integrated. Compare against the dispatch snapshot, including
  // untracked source, rather than against the repository's old HEAD.
  for (const path of paths) {
    try {
      checkedWorkerPath(repoRoot, path);
      checkedWorkerPath(wt.path, path);
      const tree = git(wt.path, ["ls-tree", base, "--", path]).stdout;
      const match = /^(\d+) blob ([a-f0-9]+)\t/.exec(tree);
      const lead = join(repoRoot, path);
      let current: string | null = null;
      try {
        const stat = lstatSync(lead);
        const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(lead)) : readFileSync(lead);
        const hash = spawnSync("git", ["hash-object", "--stdin"], {
          cwd: repoRoot,
          input: bytes,
          encoding: "utf8",
        });
        const mode = stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644";
        current = `${mode}:${hash.stdout.trim()}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current !== (match ? `${match[1]}:${match[2]}` : null)) conflicts.push(path);
    } catch {
      conflicts.push(path);
    }
  }
  if (conflicts.length) return { merged: false, conflicts, manifest, branch: wt.branch };
  for (const path of paths) {
    const source = join(wt.path, path),
      destination = join(repoRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    rmSync(destination, { force: true });
    if (
      existsSync(source) ||
      (() => {
        try {
          return lstatSync(source).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    )
      cpSync(source, destination, { verbatimSymlinks: true });
    manifest.push(path);
  }
  // Filesystem integration leaves the user's existing Git index untouched.
  return { merged: true, conflicts, manifest, branch: wt.branch };
}

/**
 * Remove the checkout. The BRANCH survives on purpose: it is the only copy of
 * a failed worker's work, and `rune/worker-<id>` is where a person looks when
 * checks failed or a merge conflicted.
 */
export function removeWorkerWorktree(
  repoRoot: string,
  wt: WorkerWorktree,
  keepBranch: boolean,
): void {
  if (keepBranch && git(wt.path, ["status", "--porcelain"]).stdout)
    throw new Error(`Worker checkout retained because it still has uncommitted work: ${wt.path}`);
  git(repoRoot, ["worktree", "remove", "--force", wt.path]);
  if (!keepBranch) git(repoRoot, ["branch", "-D", wt.branch]);
}

/**
 * Run the project's checks inside the worker's worktree, before merge.
 *
 * The command list comes from the caller (`[verify] commands`, or detection).
 * Network is off and the cwd is the worktree, so a check cannot reach the
 * lead's tree or the internet — a "check" that installs dependencies from the
 * network is not a check, it is a second build.
 */
export async function runWorktreeChecks(
  worktreePath: string,
  commands: string[],
  timeoutMs: number,
  binaryPath = process.env.RUNE_TOOLS_BINARY ??
    resolve(import.meta.dir, "../../../target/debug/rune-tools"),
  signal?: AbortSignal,
): Promise<{ outcome: "passed" | "failed" | "not_run"; failures: string[] }> {
  if (!commands.length) return { outcome: "not_run", failures: [] };
  const failures: string[] = [];
  // Build caches live outside the tree by default — Go's build cache, pip's
  // wheel cache, npm's — and the sandbox will not let a check write there, so
  // an offline `go build` failed on permissions before it failed on code.
  // Point them into the worktree: writable, and thrown away with it. Cargo
  // already builds into <cwd>/target.
  const cacheRoot = join(worktreePath, ".rune", "cache");
  const env = {
    GOCACHE: join(cacheRoot, "go-build"),
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    npm_config_cache: join(cacheRoot, "npm"),
    CARGO_TARGET_DIR: join(worktreePath, "target"),
  };
  for (const command of commands) {
    const result = await runContainedCheck(
      binaryPath,
      worktreePath,
      command,
      timeoutMs,
      signal,
      env,
    );
    if (!result.passed) failures.push(`${command} → ${result.detail}`);
    if (signal?.aborted) break;
  }
  return { outcome: failures.length ? "failed" : "passed", failures };
}
