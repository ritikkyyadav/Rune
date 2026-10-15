// ─── File checkpoints (R5.1) ───
//
// `/rewind` rolled back the conversation and left the files as they were, so
// "go back three turns" meant three turns of edits still on disk and a model
// that no longer knew it had made them. R5.1 of
// docs/program/rune-reliability-plan-20261014.md: before a turn's first write
// to a file, keep what the file held — or that it did not exist — so a rewind
// can put the code back too.
//
// What is tracked is what Rune's own file tools write: write_file, edit_file,
// multi_edit, apply_patch, and the files a worker declares. A file a shell
// command changes is not, and the rewind says so rather than implying it.
//
// Layout, under Rune's home: `file-history/<session>/index.jsonl` holds one
// line per first write of a file in a turn, and `blobs/<sha256>` the contents,
// stored once however many turns kept the same bytes. A turn is the seq of the
// user message that started it — the same number `/rewind` lists turns by.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Distinct turns kept per session. */
export const KEEP_TURNS = 100;
/** How long a snapshot is kept. */
export const KEEP_DAYS = 30;
/** A file bigger than this is noted, not copied; a rewind reports it untouched. */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export interface FileSnapshot {
  /** The seq of the user message whose turn first wrote the file. */
  turn: number;
  /** Absolute path. */
  path: string;
  /** sha256 of what the file held, or null when it did not exist. */
  blob: string | null;
  /** True when the file was too large to keep; it cannot be restored. */
  tooLarge?: boolean;
  at: string;
}

export interface RestoreResult {
  /** Files written back to how they were. */
  restored: string[];
  /** Files the rewound turns created, now removed. */
  deleted: string[];
  /** Files that could not be put back, and why. */
  skipped: Array<{ path: string; reason: string }>;
}

export class FileHistory {
  /** First writes already kept, `session|turn|path`, so a turn copies a file once. */
  private readonly seen = new Set<string>();
  /** Sessions pruned since this process started. */
  private readonly pruned = new Set<string>();

  constructor(private readonly root: string) {}

  private dir(sessionId: string): string {
    return join(this.root, sessionId.replace(/[^A-Za-z0-9_-]+/g, "_"));
  }

  /**
   * Before turn `turn`'s first write to `path`: keep what the file holds now,
   * or that it does not exist. Later writes in the same turn change nothing.
   * Never throws — a snapshot that cannot be taken must not stop the write.
   */
  snapshot(sessionId: string, turn: number, workspaceRoot: string, path: string): void {
    const abs = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path);
    const key = `${sessionId}|${turn}|${abs}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    try {
      const dir = this.dir(sessionId);
      mkdirSync(join(dir, "blobs"), { recursive: true });
      if (!this.pruned.has(sessionId)) {
        this.pruned.add(sessionId);
        this.prune(sessionId);
      }
      let entry: FileSnapshot;
      if (!existsSync(abs)) {
        entry = { turn, path: abs, blob: null, at: new Date().toISOString() };
      } else if (statSync(abs).size > MAX_SNAPSHOT_BYTES) {
        entry = { turn, path: abs, blob: null, tooLarge: true, at: new Date().toISOString() };
      } else {
        const bytes = readFileSync(abs);
        const sha = createHash("sha256").update(bytes).digest("hex");
        const blob = join(dir, "blobs", sha);
        if (!existsSync(blob)) writeFileSync(blob, bytes);
        entry = { turn, path: abs, blob: sha, at: new Date().toISOString() };
      }
      appendFileSync(join(dir, "index.jsonl"), `${JSON.stringify(entry)}\n`);
    } catch {
      // A missing snapshot is reported by the rewind, not by the write.
    }
  }

  /** Every snapshot of a session, oldest first. */
  entries(sessionId: string): FileSnapshot[] {
    const index = join(this.dir(sessionId), "index.jsonl");
    if (!existsSync(index)) return [];
    const out: FileSnapshot[] = [];
    for (const line of readFileSync(index, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as FileSnapshot);
      } catch {
        // A torn last line from a crash is skipped, not fatal.
      }
    }
    return out;
  }

  /** Files each turn wrote first, by turn. */
  filesByTurn(sessionId: string): Map<number, string[]> {
    const byTurn = new Map<number, string[]>();
    for (const e of this.entries(sessionId)) {
      const list = byTurn.get(e.turn) ?? [];
      list.push(e.path);
      byTurn.set(e.turn, list);
    }
    return byTurn;
  }

  /**
   * Put every file the turns from `turn` on wrote back to how it was before
   * the first of them: its kept contents, or gone if it did not exist.
   */
  restore(sessionId: string, turn: number): RestoreResult {
    const result: RestoreResult = { restored: [], deleted: [], skipped: [] };
    const earliest = new Map<string, FileSnapshot>();
    for (const e of this.entries(sessionId)) {
      if (e.turn >= turn && !earliest.has(e.path)) earliest.set(e.path, e);
    }
    const dir = this.dir(sessionId);
    for (const [path, e] of earliest) {
      try {
        if (e.tooLarge) {
          result.skipped.push({ path, reason: "larger than the 5 MB a snapshot keeps" });
        } else if (e.blob === null) {
          if (existsSync(path)) {
            unlinkSync(path);
            result.deleted.push(path);
          }
        } else {
          const blob = join(dir, "blobs", e.blob);
          if (!existsSync(blob)) {
            result.skipped.push({ path, reason: "its snapshot is missing" });
            continue;
          }
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, readFileSync(blob));
          result.restored.push(path);
        }
      } catch (err) {
        result.skipped.push({ path, reason: (err as Error).message.split("\n")[0] ?? "error" });
      }
    }
    return result;
  }

  /**
   * Drop the snapshots of turns from `turn` on. A conversation rewind calls
   * this: those turns no longer exist, and their seqs are about to be reused
   * by the turns that replace them.
   */
  forgetFrom(sessionId: string, turn: number): void {
    this.rewrite(
      sessionId,
      this.entries(sessionId).filter((e) => e.turn < turn),
    );
    for (const key of [...this.seen]) {
      const [s, t] = key.split("|");
      if (s === sessionId && Number(t) >= turn) this.seen.delete(key);
    }
  }

  /**
   * Keep the newest `KEEP_TURNS` turns within `KEEP_DAYS`, and the blobs they
   * use. Runs once per session per process, on its first snapshot.
   */
  prune(sessionId: string, now = Date.now()): void {
    const all = this.entries(sessionId);
    if (all.length === 0) return;
    const turns = [...new Set(all.map((e) => e.turn))].sort((a, b) => b - a);
    const keepTurns = new Set(turns.slice(0, KEEP_TURNS));
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const kept = all.filter((e) => keepTurns.has(e.turn) && Date.parse(e.at) >= cutoff);
    if (kept.length !== all.length) this.rewrite(sessionId, kept);
  }

  private rewrite(sessionId: string, kept: FileSnapshot[]): void {
    const dir = this.dir(sessionId);
    if (!existsSync(dir)) return;
    try {
      writeFileSync(join(dir, "index.jsonl"), kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
      const used = new Set(kept.map((e) => e.blob).filter((b): b is string => !!b));
      const blobs = join(dir, "blobs");
      if (existsSync(blobs)) {
        for (const name of readdirSync(blobs)) {
          if (!used.has(name)) rmSync(join(blobs, name), { force: true });
        }
      }
    } catch {
      // Pruning is housekeeping; the next run tries again.
    }
  }
}
