// ─── Repository identity for the team bus ───
//
// All worktrees of one repository share a git COMMON dir — deriving the bus
// key from it means an instance working in `.rune/worktrees/run-x` and one in
// the main checkout still find each other. Outside git, the workspace path
// itself is the identity (two instances "in the same repo" then share it by
// definition).

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface RepoIdentity {
  /** Stable key shared by every instance working on this repository. */
  repoKey: string;
  /** Realpath of this instance's working tree. */
  workspace: string;
  /** Current branch, when the workspace is a git checkout. */
  branch?: string;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3_000 });
    if (res.status !== 0) return null;
    const out = (res.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Derive the bus identity for a workspace. Never throws. */
export function deriveRepoIdentity(workspaceRoot: string): RepoIdentity {
  const workspace = real(workspaceRoot);
  const commonDir = git(workspace, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return { repoKey: workspace, workspace };
  const absCommon = isAbsolute(commonDir) ? commonDir : resolve(workspace, commonDir);
  const branch = git(workspace, ["branch", "--show-current"]) ?? undefined;
  return { repoKey: real(absCommon), workspace, branch };
}
