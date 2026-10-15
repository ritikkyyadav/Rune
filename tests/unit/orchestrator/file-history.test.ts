/**
 * File checkpoints (R5.1 of docs/program/rune-reliability-plan-20261014.md):
 * before a turn's first write to a file, what it held is kept, so a rewind can
 * put the code back too.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileHistory,
  KEEP_TURNS,
  MAX_SNAPSHOT_BYTES,
} from "../../../packages/orchestrator/src/file-history";

const made: string[] = [];
function setup() {
  const ws = mkdtempSync(join(tmpdir(), "rune-fh-ws-"));
  const home = mkdtempSync(join(tmpdir(), "rune-fh-home-"));
  made.push(ws, home);
  return { ws, home, fh: new FileHistory(join(home, "file-history")) };
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("FileHistory", () => {
  test("a file that existed is put back as the turn found it", () => {
    const { ws, fh } = setup();
    const f = join(ws, "a.ts");
    writeFileSync(f, "original\n");
    fh.snapshot("s", 10, ws, "a.ts");
    writeFileSync(f, "changed by turn 10\n");
    const r = fh.restore("s", 10);
    expect(r.restored).toEqual([f]);
    expect(readFileSync(f, "utf8")).toBe("original\n");
  });

  test("a file the turn created is removed", () => {
    const { ws, fh } = setup();
    const f = join(ws, "new.ts");
    fh.snapshot("s", 10, ws, "new.ts");
    writeFileSync(f, "created\n");
    const r = fh.restore("s", 10);
    expect(r.deleted).toEqual([f]);
    expect(existsSync(f)).toBe(false);
  });

  test("only a turn's FIRST write is kept, so a rewind lands before the turn", () => {
    const { ws, fh } = setup();
    const f = join(ws, "a.ts");
    writeFileSync(f, "v0");
    fh.snapshot("s", 10, ws, f);
    writeFileSync(f, "v1");
    fh.snapshot("s", 10, ws, f); // the same turn writes again: ignored
    writeFileSync(f, "v2");
    fh.restore("s", 10);
    expect(readFileSync(f, "utf8")).toBe("v0");
    expect(fh.entries("s")).toHaveLength(1);
  });

  test("rewinding to a turn uses the earliest snapshot from that turn on", () => {
    const { ws, fh } = setup();
    const f = join(ws, "a.ts");
    writeFileSync(f, "before turn 10");
    fh.snapshot("s", 10, ws, f);
    writeFileSync(f, "after turn 10");
    fh.snapshot("s", 20, ws, f);
    writeFileSync(f, "after turn 20");
    fh.snapshot("s", 30, ws, f);
    writeFileSync(f, "after turn 30");

    fh.restore("s", 20);
    expect(readFileSync(f, "utf8")).toBe("after turn 10");
    fh.restore("s", 10);
    expect(readFileSync(f, "utf8")).toBe("before turn 10");
  });

  test("identical contents are stored once", () => {
    const { ws, home, fh } = setup();
    for (const name of ["a.ts", "b.ts"]) {
      writeFileSync(join(ws, name), "same bytes");
      fh.snapshot("s", 10, ws, name);
    }
    expect(readdirSync(join(home, "file-history", "s", "blobs"))).toHaveLength(1);
  });

  test("a file too large to keep is reported, not silently skipped", () => {
    const { ws, fh } = setup();
    const f = join(ws, "big.bin");
    writeFileSync(f, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
    fh.snapshot("s", 10, ws, f);
    writeFileSync(f, "small now");
    const r = fh.restore("s", 10);
    expect(r.restored).toEqual([]);
    expect(r.skipped[0]?.path).toBe(f);
    expect(r.skipped[0]?.reason).toContain("5 MB");
  });

  test("a conversation rewind forgets the snapshots of the turns it removed", () => {
    const { ws, fh } = setup();
    fh.snapshot("s", 10, ws, "a.ts");
    fh.snapshot("s", 20, ws, "b.ts");
    fh.forgetFrom("s", 20);
    expect(fh.entries("s").map((e) => e.turn)).toEqual([10]);
    // The seq is reused by the turn that replaces it: a write then is kept.
    fh.snapshot("s", 20, ws, "b.ts");
    expect(fh.entries("s").map((e) => e.turn)).toEqual([10, 20]);
  });

  test("files by turn, for the /rewind list", () => {
    const { ws, fh } = setup();
    fh.snapshot("s", 10, ws, "a.ts");
    fh.snapshot("s", 10, ws, "b.ts");
    fh.snapshot("s", 20, ws, "a.ts");
    const byTurn = fh.filesByTurn("s");
    expect(byTurn.get(10)).toEqual([join(ws, "a.ts"), join(ws, "b.ts")]);
    expect(byTurn.get(20)).toEqual([join(ws, "a.ts")]);
  });

  test("prune keeps the newest turns within the age limit, and the blobs they use", () => {
    const { ws, home, fh } = setup();
    for (let t = 1; t <= KEEP_TURNS + 5; t++) {
      writeFileSync(join(ws, `f${t}.ts`), `content ${t}`);
      fh.snapshot("s", t, ws, `f${t}.ts`);
    }
    fh.prune("s");
    const turns = fh.entries("s").map((e) => e.turn);
    expect(turns).toHaveLength(KEEP_TURNS);
    expect(Math.min(...turns)).toBe(6);
    expect(readdirSync(join(home, "file-history", "s", "blobs"))).toHaveLength(KEEP_TURNS);

    // Thirty-one days on, nothing is kept.
    fh.prune("s", Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(fh.entries("s")).toEqual([]);
    expect(readdirSync(join(home, "file-history", "s", "blobs"))).toEqual([]);
  });

  test("a snapshot that cannot be taken never throws", () => {
    const fh = new FileHistory("/dev/null/cannot-exist");
    expect(() => fh.snapshot("s", 1, "/tmp", "x.ts")).not.toThrow();
    expect(fh.restore("s", 1)).toEqual({ restored: [], deleted: [], skipped: [] });
  });
});
