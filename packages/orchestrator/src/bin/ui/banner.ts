// ─── Gear identity header ───
// Four lines and no logo. A rule with the name set into it, where you are, what
// this agent is allowed to do to your machine, and a closing rule. That is the
// whole header — a mark would only tell you something the window title already
// says, and a terminal that opens with artwork has spent its first screen on
// itself instead of on your work.
//
//   ──── gear 0.3.0 ─────────────────────────────────────────────
//     alan · gear/phase-0-stabilize · 3 files changed
//     claude-opus-5 · 1st gear — every action asks first
//   ─────────────────────────────────────────────────────────────

import * as os from "os";
import { execFileSync } from "child_process";
import { bold, text, brand } from "./theme";
import { header as flowHeader } from "./flow";
import { PRODUCT_NAME } from "./brand";

/** Explicit text presentation. Never use the coloured emoji gear. */
export const GEAR_MARK = "⚙︎";

/** The supplied Gear mark has exactly nine teeth. */
export const GEAR_TOOTH_COUNT = 9;

/** Retained so callers that referenced the old raster still type-check; the
 *  header no longer draws it. */
export const GEAR_AVATAR_LINES = ["", "", "", ""] as const;

function shortPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** The folder you are actually in — the last segment, which is the part you
 *  recognise. The full path is one `pwd` away and does not belong in a header. */
function folderName(p: string): string {
  const parts = shortPath(p).split("/").filter(Boolean);
  return parts.at(-1) ?? shortPath(p);
}

export interface BannerOptions {
  /** Model id (shown when no display label is known). */
  model: string;
  /** Human model label from the provider preset ("Gemini 2.5 Flash"). */
  modelLabel?: string;
  provider?: string;
  /** Reasoning effort passed to providers with an effort dial ("high"). */
  effort?: string;
  version: string;
  workspace: string;
  branch?: string;
  sessionId?: string;
  /** What proceeds without asking, in the gear's own words. */
  scope?: string;
  /** The guardrail clause after the em dash — what still asks. */
  caution?: string;
  /** Uncommitted files in the tree, when the workspace is a git repo. */
  dirtyFiles?: number;
  /** OS command sandbox state. A removed guardrail is stated, never implied. */
  sandbox?: boolean;
  /** Connected MCP servers. */
  mcpServers?: number;
  /** Kept for call-site back-compat; unused by the header. */
  recentSessions?: unknown[];
}

const branchCache = new Map<string, string>();

/** Resolve once per workspace. Header rendering happens every frame. */
function workspaceBranch(workspace: string): string {
  const cached = branchCache.get(workspace);
  if (cached != null) return cached;
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", workspace, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 400,
    }).trim();
  } catch {
    branch = "";
  }
  branchCache.set(workspace, branch);
  return branch;
}

const dirtyCache = new Map<string, { count: number; at: number }>();

/** Uncommitted files, refreshed at most twice a second. The header states the
 *  shape of the tree you are about to change; a stale count would be worse
 *  than none, and a `git status` per frame would be worse than both. */
function workspaceDirty(workspace: string): number {
  const cached = dirtyCache.get(workspace);
  if (cached && Date.now() - cached.at < 2000) return cached.count;
  let count = 0;
  try {
    const out = execFileSync("git", ["-C", workspace, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 400,
    });
    count = out.split("\n").filter((row) => row.trim()).length;
  } catch {
    count = 0;
  }
  dirtyCache.set(workspace, { count, at: Date.now() });
  return count;
}

/** Compact lockup, still used by a few one-line notices. */
export function wordmark(): string {
  return `${brand(GEAR_MARK)} ${bold(text(PRODUCT_NAME))}`;
}

/**
 * Environment facts that belong on the state line rather than in a badge: how
 * dirty the tree is, whether the sandbox is off, and how many MCP servers are
 * attached. Only the sandbox is ever loud, because only the sandbox is a
 * guardrail you can remove.
 */
export function bannerBadges(opts: Pick<BannerOptions, "sandbox" | "mcpServers">): string[] {
  const badges: string[] = [];
  if (opts.sandbox === false) badges.push("sandbox off");
  if (opts.mcpServers && opts.mcpServers > 0) {
    badges.push(`mcp ${opts.mcpServers}`);
  }
  return badges;
}

export function renderBanner(opts: BannerOptions): string {
  const branch = opts.branch ?? workspaceBranch(opts.workspace);
  const dirty = opts.dirtyFiles ?? (branch ? workspaceDirty(opts.workspace) : 0);
  const state = [
    dirty > 0 ? `${dirty} file${dirty === 1 ? "" : "s"} changed` : "",
    ...bannerBadges(opts),
  ]
    .filter(Boolean)
    .join(" · ");

  return flowHeader({
    name: PRODUCT_NAME.toLowerCase(),
    version: opts.version,
    workspace: folderName(opts.workspace),
    branch: branch || undefined,
    state: state || undefined,
    model: [opts.modelLabel || opts.model, opts.effort ? `${opts.effort} effort` : ""]
      .filter(Boolean)
      .join(" · "),
    scope: opts.scope,
    caution: opts.caution,
  });
}
