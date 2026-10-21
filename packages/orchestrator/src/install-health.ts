// ─── What `rune doctor` says about the install itself (R7.6) ───
//
// R7 of docs/program/rune-reliability-plan-20261014.md: an install should be
// checkable without running a task. Whether the binaries' signatures hold
// (macOS kills a binary whose signature broke, silently, with exit 137),
// whether there is a build to roll back to, how much the old builds weigh,
// and whether the session database is intact.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** One install's kept builds: `rune.backup-<ts>`, `rune-compiled.backup-<ts>`, … */
export interface OldBuild {
  /** The install's timestamp, from the file names. */
  stamp: string;
  files: string[];
  bytes: number;
}

/**
 * The timestamped builds `scripts/install.sh` keeps in `bin`, newest first,
 * grouped per install. The plain `.backup` files — what `rune upgrade
 * --rollback` swaps with — are not among them.
 */
export function listOldBuilds(binDir: string): OldBuild[] {
  const byStamp = new Map<string, OldBuild>();
  let names: string[];
  try {
    names = readdirSync(binDir);
  } catch {
    return [];
  }
  for (const name of names) {
    const m = /\.backup-(\d+)$/.exec(name);
    if (!m) continue;
    const stamp = m[1]!;
    const path = join(binDir, name);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      continue;
    }
    const build = byStamp.get(stamp) ?? { stamp, files: [], bytes: 0 };
    build.files.push(path);
    build.bytes += bytes;
    byStamp.set(stamp, build);
  }
  return [...byStamp.values()].sort((a, b) => Number(b.stamp) - Number(a.stamp));
}

/** Which old builds a prune keeping the newest `keep` would remove. */
export function planBuildPrune(
  builds: OldBuild[],
  keep: number,
): { keep: OldBuild[]; remove: OldBuild[]; bytes: number } {
  const kept = builds.slice(0, keep);
  const remove = builds.slice(keep);
  return { keep: kept, remove, bytes: remove.reduce((n, b) => n + b.bytes, 0) };
}

/** Delete the planned builds; the files that could not be removed. */
export function applyBuildPrune(remove: OldBuild[]): string[] {
  const failed: string[] = [];
  for (const build of remove) {
    for (const file of build.files) {
      try {
        // install.sh marks what it installs immutable on macOS.
        if (process.platform === "darwin") spawnSync("chflags", ["nouchg", file]);
        unlinkSync(file);
      } catch {
        failed.push(file);
      }
    }
  }
  return failed;
}

/**
 * Whether a binary's code signature holds, on macOS; null elsewhere. A copy
 * over an installed binary breaks it and the kernel kills it at launch with
 * no message, so this is checked rather than assumed.
 */
export function verifySignature(
  path: string,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawnSync = spawnSync,
): { ok: boolean; detail: string } | null {
  if (platform !== "darwin") return null;
  const r = run("codesign", ["--verify", "--strict", path], { encoding: "utf8" });
  if (r.error) return { ok: false, detail: `codesign could not run: ${r.error.message}` };
  const detail =
    String(r.stderr ?? "")
      .trim()
      .split("\n")[0] ?? "";
  return { ok: r.status === 0, detail: r.status === 0 ? "valid" : detail || `exit ${r.status}` };
}

/** `PRAGMA quick_check` on the session database: "ok", or what it found. */
export function sessionDbCheck(path: string): string {
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query("PRAGMA quick_check").all() as Array<Record<string, string>>;
    const found = rows.map((r) => Object.values(r)[0]).filter((v) => v && v !== "ok");
    return found.length === 0 ? "ok" : found.slice(0, 3).join("; ");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db?.close();
  }
}
