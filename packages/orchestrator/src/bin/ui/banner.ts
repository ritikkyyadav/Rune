// --- Rune identity header ---
// The masthead: who, where, which build. Three fields, one row.
//
//   G E A R   ~/Project/Alan · worktree fix/stream                v0.3.0
//   ═══════─────────────────────────────────────────────────────────────
//
// This file answers WHERE -- the whole directory coordinate, plus the branch
// when the checkout is a linked git worktree rather than the main one -- and
// hands it to flow.header(), which sets the type. Still no artwork: the name is
// set as a mark, not drawn as one.
//
// What is deliberately absent: the dirty-file count, the MCP count and
// `sandbox off`. The status line above the composer carries the live ones, and
// a fact stated twice on one screen is a fact you stop reading -- while this
// row, being committed scrollback under --inline, held the stale copy.

import * as os from "os";
import { execFile, execFileSync } from "child_process";
import { bold, text, brand } from "./theme";
import { glyph } from "./glyphs";
import { header as flowHeader } from "./flow";
import { PRODUCT_NAME } from "./brand";

/** Explicit text presentation. Never use the coloured emoji rune. */
export const RUNE_MARK = glyph("phase");

/** The supplied Rune mark has exactly nine teeth. */
export const RUNE_TOOTH_COUNT = 9;

/** Retained so callers that referenced the old raster still type-check; the
 *  header no longer draws it. */
export const RUNE_AVATAR_LINES = ["", "", "", ""] as const;

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface BannerOptions {
  version: string;
  /** Absolute workspace root. Shortened to `~/...` here, never reduced to its
   *  last segment. */
  workspace: string;
  /** Branch override, mostly for tests -- resolved from git when absent, and
   *  printed only when the checkout is a linked worktree. */
  branch?: string;
  /** Everything below is accepted so existing call sites keep type-checking;
   *  none of it reaches the row. The model and the gear change mid-session and
   *  live on the status line, which redraws; the counts and the sandbox state
   *  are on that same line and were duplicated here. */
  model?: string;
  modelLabel?: string;
  provider?: string;
  effort?: string;
  sessionId?: string;
  scope?: string;
  caution?: string;
  dirtyFiles?: number;
  sandbox?: boolean;
  mcpServers?: number;
  recentSessions?: unknown[];
}

interface CachedFact<T> {
  value: T;
  at: number;
  refreshing?: boolean;
}

const branchCache = new Map<string, CachedFact<string>>();
const worktreeCache = new Map<string, CachedFact<boolean>>();

/** Test hook: the header caches are process-global; tests reset them. */
export function __resetBannerCachesForTest(): void {
  branchCache.clear();
  worktreeCache.clear();
}

/** Test hook: force every cached entry stale so the next render refreshes. */
export const __bannerCachesForTest = {
  age(): void {
    for (const entry of branchCache.values()) entry.at = 0;
    for (const entry of worktreeCache.values()) entry.at = 0;
  },
};

/**
 * Git fact with a never-blocking steady state. The FIRST resolve per
 * workspace is synchronous so the first frame is right; every render after
 * that returns the cached value instantly, and a value older than `ttlMs`
 * kicks one background refresh. The header renders every frame -- a
 * synchronous `git status` on that path froze the UI for up to 400ms every
 * two seconds on large repos.
 */
function cachedGitFact<T>(
  cache: Map<string, CachedFact<T>>,
  workspace: string,
  ttlMs: number,
  args: string[],
  parse: (out: string) => T,
  empty: T,
): T {
  const now = Date.now();
  const hit = cache.get(workspace);
  if (hit) {
    if (now - hit.at >= ttlMs && !hit.refreshing) {
      hit.refreshing = true;
      execFile(
        "git",
        ["-C", workspace, ...args],
        { encoding: "utf8", timeout: 2000 },
        (error, stdout) => {
          cache.set(workspace, {
            value: error ? empty : parse(stdout ?? ""),
            at: Date.now(),
          });
        },
      );
    }
    return hit.value;
  }
  let value = empty;
  try {
    value = parse(
      execFileSync("git", ["-C", workspace, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 400,
      }),
    );
  } catch {
    value = empty;
  }
  cache.set(workspace, { value, at: now });
  return value;
}

/** Current branch, refreshed in the background every few seconds -- switching
 *  branches mid-session must reach the header without a restart. */
function workspaceBranch(workspace: string): string {
  return cachedGitFact(
    branchCache,
    workspace,
    5_000,
    ["branch", "--show-current"],
    (out) => out.trim(),
    "",
  );
}

/**
 * Is this checkout a LINKED worktree rather than the main one?
 *
 * `git rev-parse --git-dir --git-common-dir` prints one line per flag. In the
 * main checkout the two agree; inside a linked worktree the first is
 * `<common>/worktrees/<name>` and the second is `<common>`, so a string
 * comparison answers it without parsing a path or shelling out twice.
 *
 * Long TTL because this cannot change under a running session -- the workspace
 * root is fixed at launch. It still goes through the same non-blocking cache as
 * the branch so that the first frame is right and no later frame pays for it.
 */
function workspaceIsLinkedWorktree(workspace: string): boolean {
  return cachedGitFact(
    worktreeCache,
    workspace,
    60_000,
    ["rev-parse", "--git-dir", "--git-common-dir"],
    (out) => {
      const [dir, common] = out.trim().split("\n");
      return Boolean(dir && common && dir.trim() !== common.trim());
    },
    false,
  );
}

/** Compact lockup, still used by a few one-line notices. */
export function wordmark(): string {
  return `${brand(RUNE_MARK)} ${bold(text(PRODUCT_NAME))}`;
}

export function renderBanner(opts: BannerOptions): string {
  // The branch is resolved only when it has something to say. In the main
  // checkout it names a fact the row does not print, and a `git branch` per
  // frame to reach it -- even a cached one -- is work done for nothing.
  const worktree = workspaceIsLinkedWorktree(opts.workspace)
    ? (opts.branch ?? workspaceBranch(opts.workspace)) || ""
    : "";

  return flowHeader({
    name: PRODUCT_NAME,
    version: opts.version,
    workspace: shortPath(opts.workspace),
    // A detached worktree still says it is a worktree. That is the half of the
    // sentence that matters; the branch is the qualifier.
    worktree: workspaceIsLinkedWorktree(opts.workspace) ? worktree || "detached" : undefined,
  });
}
