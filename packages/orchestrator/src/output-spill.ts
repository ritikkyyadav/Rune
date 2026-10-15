// ─── Long output, kept whole (R5.2) ───
//
// A tool result over the transcript cap keeps its head and tail, and until
// R5.2 of docs/program/rune-reliability-plan-20261014.md the middle was simply
// gone: the model was told to re-run the command narrower. For a test suite
// that takes four minutes, that is four more minutes to see one stack trace.
// Now the whole output is saved, and the elision marker says where, so the
// model reads the middle with `read_file` instead of running anything again.
//
// Where: `<workspace>/.rune/outputs/`. Inside the workspace because
// `read_file` refuses paths outside it; under `.rune` because the search tools
// skip dot-directories, so a saved log never turns up in the agent's own
// greps; and with a `.gitignore` of `*` beside the files, so `git status`
// stays clean. Only the newest are kept.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Saved outputs kept per workspace; older ones are deleted as new ones arrive. */
export const SPILL_KEEP = 50;

const IGNORE =
  "# Rune keeps long tool output here so it can be read back in pieces. Never tracked.\n*\n";

/**
 * Save `text` as `<dir>/<name>.txt` and return its path relative to
 * `workspaceRoot` (what `read_file` takes), or null when it could not be
 * written — a read-only workspace keeps the old head-and-tail behaviour.
 */
export function spillOutput(
  workspaceRoot: string,
  dir: string,
  name: string,
  text: string,
): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, IGNORE);
    const safe = name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120) || "output";
    const path = join(dir, `${safe}.txt`);
    writeFileSync(path, text);
    pruneSpills(dir, SPILL_KEEP);
    return relative(workspaceRoot, path) || path;
  } catch {
    return null;
  }
}

/** Delete all but the newest `keep` saved outputs in `dir`. */
export function pruneSpills(dir: string, keep: number): void {
  let files: Array<{ path: string; mtime: number }>;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => {
        const path = join(dir, f);
        return { path, mtime: statSync(path).mtimeMs };
      });
  } catch {
    return;
  }
  if (files.length <= keep) return;
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(keep)) {
    try {
      unlinkSync(f.path);
    } catch {
      // A file that cannot be removed now is removed by a later prune.
    }
  }
}
