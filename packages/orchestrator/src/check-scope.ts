// ─── Whose check is it, and what does a passing suite cover? ───
//
// `done` refuses while anything the run saw fail is still red (A3). On the
// dogfood re-run of 2026-10-22 every end-of-turn check passed on Rune's own
// source and the request check found 13 of 13 asks, and `done` was still
// refused, by what the agent saw while investigating: a test file red inside
// its sandbox, then the same file run in a copy of the repository it built to
// show the failure predated its change. The founder's call: count only real
// failures. Two of the three rules are here; the third (`test` and `[` are not
// checks) is in verification-command.ts.

import { spawnSync } from "node:child_process";
import path, { isAbsolute, resolve } from "node:path";
import { bunTestRun } from "./verification-command";

/** `$PWD` and `${PWD}` at the start of a place, read as the workspace root. */
const PWD = /^\$(?:PWD|\{PWD\})(?=\/|$)/;

/** The path functions `workspacePlace` uses: Node's own, or `path.win32` in a test. */
type PathLib = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "sep">;

/**
 * A place a check names, as a workspace-relative path with forward slashes;
 * `..`-prefixed when it lies outside. Null when it cannot be read: any other
 * variable, or `~`.
 *
 * On Windows a place on another drive has no relative form, and `relative`
 * hands back the absolute path (`D:\tmp\copy\…` against a workspace on C:).
 * It is outside the workspace all the same (CI, 2026-10-22: the runner's
 * checkout is on D: and its temp folder on C:).
 */
export function workspacePlace(
  root: string,
  cwd: string,
  text: string,
  p: PathLib = path,
): string | null {
  const expanded = text.replace(PWD, root);
  if (expanded.includes("$") || expanded.startsWith("~")) return null;
  const abs = p.isAbsolute(expanded) ? expanded : p.resolve(cwd, expanded);
  const rel = p.relative(root, abs);
  const slashed = rel.split(p.sep).join("/");
  if (p.isAbsolute(rel)) return `../${slashed.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "")}`;
  return slashed;
}

/** The first segment of a workspace-relative path: the top-level entry it is under. */
const topOf = (rel: string) => rel.split("/")[0] ?? "";

/** Whether git tracks anything at or under this workspace-relative path. */
function tracksAnything(root: string, rel: string): boolean | null {
  const r = spawnSync("git", ["-C", root, "ls-files", "--", rel], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
}

/**
 * Whether a path names a copy of something the project tracks: some tail of
 * it, two segments or more, is a tracked file or folder. A copy of the
 * repository mirrors the project's own paths (`.copy/tests/unit/a.test.ts`
 * holds `tests/unit/a.test.ts`); a new folder of new tests does not.
 */
function mirrorsTracked(root: string, segments: readonly string[]): boolean {
  for (let i = 1; i <= segments.length - 2; i++) {
    if (tracksAnything(root, segments.slice(i).join("/")) === true) return true;
  }
  return false;
}

/**
 * A `bun test` run against a copy of the project, not the project. Every file
 * or folder it ran must lie outside the workspace or under a top-level entry
 * git tracks nothing in, AND be a copy of something the project tracks (a tail
 * of its path is a tracked path). A new test file the run wrote under `tests/`
 * stays the project's, because git tracks `tests/`; a new folder of new tests
 * stays the project's, because it mirrors nothing. Anything that cannot be
 * read (no git, a variable) is the project's: the rule only ever takes a run
 * out, on evidence.
 */
export function ranInScratchCopy(command: string, workspaceRoot: string): boolean {
  const run = bunTestRun(command);
  if (!run || run.targets.length === 0) return false;
  let cwd = workspaceRoot;
  for (const cd of run.cds) {
    const rel = workspacePlace(workspaceRoot, cwd, cd);
    if (rel === null) return false;
    cwd = resolve(workspaceRoot, rel);
  }
  for (const target of run.targets) {
    const rel = workspacePlace(workspaceRoot, cwd, target);
    if (rel === null || rel === "" || rel === ".") return false;
    const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
    if (!rel.startsWith("..") && tracksAnything(workspaceRoot, topOf(rel)) !== false) return false;
    if (!mirrorsTracked(workspaceRoot, segments)) return false;
  }
  return true;
}

/**
 * Whether a red `bun test` run is covered by a suite that passed on the final
 * tree: it ran from the workspace root (no `cd`), named at least one file or
 * folder, and each lies within one of the suite's scopes (workspace-relative
 * prefixes; "" is the whole workspace). The suite is the stronger measurement:
 * it ran every one of those files, on the tree the run left, in the check's
 * own environment rather than the agent's sandbox.
 */
export function coveredBySuite(command: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return false;
  const run = bunTestRun(command);
  if (!run || run.cds.length > 0 || run.targets.length === 0) return false;
  // Workspace-relative, forward slashes, no leading `./` or trailing `/`.
  const norm = (p: string) =>
    p
      .replace(/\\/g, "/")
      .replace(/^(?:\.\/)+/, "")
      .replace(/\/+$/, "");
  const wanted = scopes.map(norm);
  return run.targets.every((target) => {
    // `$PWD/x` is the workspace's `x`. Any other variable, or an absolute
    // path, is not a place this can compare.
    const fromRoot = PWD.test(target);
    const rest = fromRoot ? target.replace(PWD, "").replace(/^\/+/, "") : target;
    if (rest.includes("$") || (!fromRoot && isAbsolute(rest))) return false;
    const t = norm(rest);
    if (t.startsWith("..")) return false;
    return wanted.some((s) => s === "" || t === s || t.startsWith(`${s}/`));
  });
}
