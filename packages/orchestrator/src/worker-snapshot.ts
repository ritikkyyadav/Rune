import { spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The snapshot would be PARTIAL — too many files, too many bytes, a special
 * file, a link that leaves the project. A worker built on a partial snapshot
 * edits stale code and reports it as done, so this is refused outright and
 * never falls back; the message carries the remedy. Distinct from a checkout
 * that cannot be CREATED at all (see WorkerIsolationError), where the shared
 * tree — which has every file — is the honest fallback.
 */
export class WorkerSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerSnapshotError";
  }
}

/** Refuse a partial source snapshot rather than quietly handing a worker stale code. */
export function copyUntrackedSource(
  root: string,
  target: string,
  stats: { bytes: number } = { bytes: 0 },
): string[] {
  const list = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (list.status !== 0)
    throw new WorkerSnapshotError("Could not enumerate the working source for the worker.");
  const paths = list.stdout
    .split("\0")
    .filter(Boolean)
    .filter(
      (p) =>
        !p
          .split(/[\\/]/)
          .some((part) =>
            [".git", ".rune", ".gear", ".alan", "node_modules", ".venv"].includes(part),
          ),
    );
  let bytes = 0;
  if (paths.length > 10_000)
    throw new WorkerSnapshotError(
      "Worker source snapshot exceeds 10,000 untracked files; ignore generated output first.",
    );
  for (const path of paths) {
    const source = join(root, path),
      destination = join(target, path);
    const stat = lstatSync(source);
    bytes += stat.size;
    stats.bytes = bytes;
    if (bytes > 100 * 1024 * 1024)
      throw new WorkerSnapshotError(
        "Worker source snapshot exceeds 100 MiB; ignore generated output first.",
      );
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new WorkerSnapshotError(`Cannot snapshot special file: ${path}`);
    mkdirSync(dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(source);
      const resolved = resolve(dirname(source), link);
      const rel = relative(root, resolved);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
        throw new WorkerSnapshotError(`Worker source link leaves the project: ${path}`);
      // Absolute links inside the project must point into the new snapshot.
      symlinkSync(isAbsolute(link) ? join(target, rel) : link, destination);
    } else {
      copyFileSync(source, destination, constants.COPYFILE_FICLONE);
    }
  }
  return paths;
}

/**
 * Reuse installed environments as independent copies. Reflinks are cheap on
 * APFS and supporting Linux filesystems; the portable fallback copies bytes.
 * Relative workspace links retain their relationship to the worker's source.
 * No hard links or links to the lead's mutable dependency tree are introduced.
 */
export function provisionWorkerDependencies(root: string, target: string): string[] {
  const provisioned: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 8) return;
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (
        [".git", ".rune", ".gear", ".alan", "target", "dist", "build", ".next"].includes(entry.name)
      )
        continue;
      const path = join(rel, entry.name);
      if (["node_modules", ".venv"].includes(entry.name)) {
        if (!entry.isDirectory())
          throw new Error(`Installed environment must be a real directory to isolate it: ${path}`);
        const source = join(root, path),
          destination = join(target, path);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(source, destination, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          verbatimSymlinks: true,
        });
        remapLinks(destination, root, target);
        provisioned.push(path);
      } else if (entry.isDirectory() && existsSync(join(target, path))) walk(path, depth + 1);
    }
  };
  walk("", 0);
  return provisioned;
}

function remapLinks(directory: string, root: string, target: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) remapLinks(path, root, target);
    else if (entry.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (!isAbsolute(link)) continue;
      const rel = relative(root, link);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
      // cpSync's force option replaces the symlink without dereferencing it.
      const source = join(root, relative(target, path));
      const replacement = join(target, rel);
      if (source === replacement) continue;
      // unlink is intentionally local to the freshly created worker tree.
      unlinkSync(path);
      symlinkSync(replacement, path);
    }
  }
}

/** Host-side integration must not write through a symlinked parent directory. */
export function checkedWorkerPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error(`Path leaves workspace: ${path}`);
  let parent = dirname(absolute);
  while (!existsSync(parent)) parent = dirname(parent);
  const actual = relative(realpathSync(root), realpathSync(parent));
  if (actual === ".." || actual.startsWith("../") || isAbsolute(actual))
    throw new Error(`Parent link leaves workspace: ${path}`);
  return absolute;
}
