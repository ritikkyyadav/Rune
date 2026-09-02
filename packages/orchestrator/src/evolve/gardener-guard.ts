// ─── The gardener's write-deny, made mechanical ───
//
// `GARDENER_OFF_LIMITS` was enforced as TEXT IN A PROMPT: the brief told the run
// not to edit the doctrine, the permission broker, org policy or the secret
// stores, and that was the whole enforcement. A rule a model is asked to follow
// is not a boundary — it is a request, and the one thing a run editing its own
// harness must not be able to do is edit the part that decides what it may do.
//
// So the boundary moves into git. A gardener worktree gets a `pre-commit` hook
// that refuses any commit touching an off-limits path, and the hook is written
// by the code that starts the run rather than by the run itself.
//
// Two honest limits, stated rather than papered over:
//
//   · a hook can be bypassed with `--no-verify`, and a run with shell access
//     can delete the hook. This raises the cost of crossing the line from
//     "ignore a sentence" to "deliberately disable a guard", and it makes the
//     crossing VISIBLE — an audited bash call that removes a hook is a very
//     different artifact from a quiet edit. It is a boundary, not a sandbox.
//   · it protects the COMMIT, not the working tree. The gardener's contract is
//     that a person reviews the branch, so what has to be true is that the
//     branch cannot carry an off-limits change.
//
// The real containment is one layer down (the permission broker and the OS
// sandbox), and neither of those may import from here — the dependency-graph
// test in tests/unit/orchestrator/evolution-invariants.test.ts enforces that in
// the other direction.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GARDENER_OFF_LIMITS } from "../retro";

export const HOOK_MARKER = "gear:gardener-guard";

/**
 * The hook body. POSIX shell, no dependencies: it runs on a machine where the
 * only thing guaranteed is git itself.
 *
 * `git diff --cached --name-only` is the staged set, which is exactly the set
 * the commit would carry.
 */
export function renderPreCommitHook(offLimits: readonly string[] = GARDENER_OFF_LIMITS): string {
  return [
    "#!/bin/sh",
    `# ${HOOK_MARKER} — written by \`gear evolve gardener --run\`.`,
    "#",
    "# A gardener run fixes harness defects on its own branch. These paths decide",
    "# what any run is ALLOWED to do, so a run may not change them: the doctrine,",
    "# the permission broker, the safety layer, org policy and the secret stores.",
    "# They need a person.",
    "set -e",
    "",
    "blocked=''",
    "for path in $(git diff --cached --name-only); do",
    '  case "$path" in',
    ...offLimits.map((p) => `    ${p}) blocked="$blocked $path" ;;`),
    "  esac",
    "done",
    "",
    'if [ -n "$blocked" ]; then',
    '  echo "" >&2',
    '  echo "  refused: a gardener run may not commit changes to these paths:" >&2',
    '  for p in $blocked; do echo "    $p" >&2; done',
    '  echo "" >&2',
    '  echo "  They decide what a run is permitted to do, and a run that can edit them" >&2',
    '  echo "  is not contained by them. Unstage them and leave them to a person." >&2',
    '  echo "" >&2',
    "  exit 1",
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

export interface GuardInstall {
  path: string;
  installed: boolean;
  /** Set when a hook already existed and was left alone. */
  reason?: string;
}

/**
 * Install the guard into a worktree's hooks directory.
 *
 * A linked worktree's `.git` is a FILE pointing at `<repo>/.git/worktrees/<id>`,
 * and hooks are shared from the main `.git/hooks` — so the hook has to be
 * installed where git will look, which is resolved here rather than assumed.
 *
 * An existing hook that is not ours is never overwritten: clobbering a
 * developer's own pre-commit to install a guard would be its own small version
 * of the problem this file exists to prevent.
 */
export function installGardenerGuard(worktreePath: string, hooksDir?: string): GuardInstall {
  const dir = hooksDir ?? resolveHooksDir(worktreePath);
  const path = join(dir, "pre-commit");
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (!current.includes(HOOK_MARKER)) {
      return {
        path,
        installed: false,
        reason:
          "a pre-commit hook already exists and is not ours — refusing to overwrite a developer's own hook",
      };
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderPreCommitHook());
  try {
    chmodSync(path, 0o755);
  } catch {
    // A filesystem without exec bits (rare, but Windows shares exist). The
    // hook is on disk either way; git will report if it cannot run it.
  }
  return { path, installed: true };
}

/** Where git looks for hooks for this worktree. */
export function resolveHooksDir(worktreePath: string): string {
  const dotGit = join(worktreePath, ".git");
  if (existsSync(dotGit)) {
    try {
      const stat = readFileSync(dotGit, "utf8");
      const m = /^gitdir:\s*(.+)\s*$/m.exec(stat);
      if (m) {
        // <repo>/.git/worktrees/<id> → hooks live in <repo>/.git/hooks
        const gitdir = m[1]!.trim();
        const idx = gitdir.lastIndexOf(`${"/"}worktrees${"/"}`);
        if (idx !== -1) return join(gitdir.slice(0, idx), "hooks");
        return join(gitdir, "hooks");
      }
    } catch {
      // `.git` is a directory, not a file: an ordinary checkout.
    }
    return join(dotGit, "hooks");
  }
  return join(worktreePath, ".git", "hooks");
}

/** Would this hook refuse a commit staging these paths? Pure, for the test. */
export function wouldRefuse(
  stagedPaths: string[],
  offLimits: readonly string[] = GARDENER_OFF_LIMITS,
): string[] {
  const deny = new Set(offLimits);
  return stagedPaths.filter((p) => deny.has(p));
}
