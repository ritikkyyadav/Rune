// ─── The yardstick, and the lock on it ───
//
// An A/B is only evidence if the thing doing the measuring did not move. The
// eval suite is that thing. A loop that could edit `tests/eval/**` and then
// promote on the result would be grading its own exam — and the edit does not
// have to be malicious: adding a task, loosening a `verify`, re-baselining
// after a bad run all change what "a win" means.
//
// So promotions are keyed to a digest of the suite. `rune evolve promote`
// refuses when the current digest differs from the one a human last blessed,
// and the ledger records the digest each measurement ran under, so an old
// entry can never be replayed against a changed yardstick.
//
// Re-baselining is deliberately a HUMAN act (`rune evolve yardstick --bless`).
// That is the whole mechanism: the loop can measure itself against a fixed
// ruler, and it cannot pick up the ruler.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { getRuneHome } from "@rune/shared";

/** Run outputs, not the yardstick: these churn on every run by design. */
const IGNORED_DIRS = new Set(["results", "node_modules"]);

/**
 * Where the eval suite lives, relative to a repository root. Exported so the
 * invariants test and the pre-commit guard name the same directory this does.
 */
export const YARDSTICK_DIR = join("tests", "eval");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(entry)) continue;
      walkFiles(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

/**
 * Walk up from a starting directory to the repository root — the nearest
 * ancestor that has both `package.json` and `tests/eval`. Returns null when
 * there is none, which is the normal case for an installed binary running
 * outside a checkout.
 */
export function findRepoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, YARDSTICK_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Twelve hex characters over every file under `tests/eval/**` (minus run
 * outputs), path and content both. Null when the suite is not present — an
 * installed binary outside a checkout has no yardstick to lock, and null must
 * read as "unknown", never as a hash that happens to match.
 */
export function yardstickHash(repoRoot: string): string | null {
  const root = join(repoRoot, YARDSTICK_DIR);
  if (!existsSync(root)) return null;
  const h = createHash("sha256");
  let files: string[];
  try {
    files = walkFiles(root);
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  for (const file of files) {
    // POSIX-normalised so the digest is the same on Windows.
    h.update(relative(repoRoot, file).split(sep).join("/"));
    h.update("\0");
    try {
      h.update(readFileSync(file));
    } catch {
      h.update("<unreadable>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

/** The digest for the checkout containing `from`, or null outside one. */
export function currentYardstick(from: string = process.cwd()): {
  repoRoot: string | null;
  hash: string | null;
} {
  const repoRoot = findRepoRoot(from);
  return { repoRoot, hash: repoRoot ? yardstickHash(repoRoot) : null };
}

// ─── What a human has blessed ───

export const BLESSED_FILE = "evolve-yardstick.json";

export interface BlessedYardstick {
  hash: string;
  at: string;
  /** The repository the blessing was made from — for the message, not the check. */
  repoRoot?: string;
}

export function blessedPath(home: string = getRuneHome()): string {
  return join(home, BLESSED_FILE);
}

/** The digest a human last blessed, or null if never. */
export function readBlessed(home: string = getRuneHome()): BlessedYardstick | null {
  try {
    const raw = readFileSync(blessedPath(home), "utf8");
    const parsed = JSON.parse(raw) as BlessedYardstick;
    return typeof parsed?.hash === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record a blessing. Deliberately has no automatic caller: a machine that can
 * bless its own yardstick has no yardstick.
 */
export function writeBlessed(
  hash: string,
  repoRoot: string | null,
  home: string = getRuneHome(),
): BlessedYardstick {
  const entry: BlessedYardstick = {
    hash,
    at: new Date().toISOString(),
    ...(repoRoot ? { repoRoot } : {}),
  };
  const path = blessedPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  return entry;
}
