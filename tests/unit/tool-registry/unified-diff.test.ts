/**
 * The diff multi_edit and apply_patch return. edit_file gets its diff from the
 * Rust binary; these two ran in TypeScript with both texts in hand and emitted
 * none, so the transcript showed `edit foo.ts` with no red and no green -- 6 of
 * 10 edits in one session. The shape here is exactly what the UI's parseDiff
 * reads, so it is exercised against parseDiff, not against a string.
 */
import { describe, expect, test } from "bun:test";
import {
  diffOps,
  myersOps,
  unifiedDiff,
} from "../../../packages/tool-registry/src/tools/unified-diff";
import { parseDiff } from "../../../packages/orchestrator/src/bin/ui/flow";

const lines = (...xs: string[]) => xs.join("\n") + "\n";

describe("unifiedDiff", () => {
  test("identical text is no diff at all", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x.ts")).toBe("");
  });

  test("a one-line change carries three lines of context each side, numbered from the file", () => {
    const before = lines("a", "b", "c", "d", "e", "f", "g", "h");
    const after = lines("a", "b", "c", "D", "e", "f", "g", "h");
    const diff = unifiedDiff(before, after, "x.ts");
    expect(diff.startsWith("--- a/x.ts\n+++ b/x.ts\n@@ -1,7 +1,7 @@")).toBe(true);
    const parsed = parseDiff(diff);
    expect(parsed).toMatchObject({ added: 1, removed: 1, hunks: 1 });
    expect(parsed.rows.map((r) => `${r.kind}:${r.line ?? ""}:${r.text}`)).toEqual([
      "context:1:a",
      "context:2:b",
      "context:3:c",
      "remove:4:d",
      "add:4:D",
      "context:5:e",
      "context:6:f",
      "context:7:g",
    ]);
  });

  test("changes far apart become separate hunks whose headers match their bodies", () => {
    const before = lines(...Array.from({ length: 30 }, (_, i) => `l${i}`));
    const after = before.replace("l2\n", "L2\n").replace("l25\n", "L25\n");
    const diff = unifiedDiff(before, after, "y.ts");
    const headers = [...diff.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/gm)];
    expect(headers).toHaveLength(2);
    const bodies = diff.split(/^@@.*$/m).slice(1);
    bodies.forEach((body, i) => {
      const rows = body.split("\n").filter((l) => l.length > 0);
      expect(rows.filter((l) => l[0] !== "+").length).toBe(Number(headers[i]![2]));
      expect(rows.filter((l) => l[0] !== "-").length).toBe(Number(headers[i]![4]));
    });
    expect(parseDiff(diff).hunks).toBe(2);
  });

  test("a deletion is all removals; a file's final newline is never a phantom line", () => {
    expect(parseDiff(unifiedDiff("one\ntwo\n", "", "gone.ts"))).toMatchObject({
      added: 0,
      removed: 2,
    });
    // Same lines, different terminator: the last line is shown as changed,
    // which is the fact git states as "\ No newline at end of file".
    expect(parseDiff(unifiedDiff("one\ntwo", "one\ntwo\n", "eol.ts"))).toMatchObject({
      added: 1,
      removed: 1,
    });
    // And a terminated file's one-line change is one line, not two.
    const one = unifiedDiff("a\nb\n", "a\nB\n", "x.ts");
    expect(one).toContain("@@ -1,2 +1,2 @@");
    expect(parseDiff(one).rows.map((r) => r.kind)).toEqual(["context", "remove", "add"]);
  });

  test("past the line cap a small change is still a small hunk, with no O(n²) table", () => {
    // 2026-10-22: above 4,000 lines every diff was a whole-file rewrite, so a
    // 9-line edit to agent-loop.ts (7,802 lines) read as 15,005 changed lines.
    const big = Array.from({ length: 4001 }, (_, i) => `line ${i}`).join("\n");
    const t0 = performance.now();
    const diff = unifiedDiff(big, big + "\nextra", "big.ts");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(diff.split("\n")[2]).toBe("@@ -3999,3 +3999,4 @@");
    expect(parseDiff(diff)).toMatchObject({ added: 1, removed: 0, hunks: 1 });
  });

  test("a few lines changed in an 8,000-line file: their hunks only, numbered from the file", () => {
    const before = Array.from({ length: 7802 }, (_, i) => `const line${i} = ${i};`);
    const after = [...before];
    after[3600] = "const line3600 = 'changed';";
    after.splice(3655, 0, "// a new line", "// and another");
    const diff = unifiedDiff(before.join("\n"), after.join("\n"), "agent-loop.ts");
    expect(diff.length).toBeLessThan(1500);
    expect(parseDiff(diff)).toMatchObject({ added: 3, removed: 1, hunks: 2 });
    expect(diff).toContain("@@ -3598,7 +3598,7 @@");
  });

  test("changes at both ends of a 10,000-line file: two hunks, found by Myers' walk", () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `row ${i}`);
    const after = [...before];
    after[5] = "row five, edited";
    after[9_990] = "row 9990, edited";
    const t0 = performance.now();
    const diff = unifiedDiff(before.join("\n"), after.join("\n"), "engine.ts");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(parseDiff(diff)).toMatchObject({ added: 2, removed: 2, hunks: 2 });
  });

  test("a wholesale rewrite of a long file is still one whole-file hunk", () => {
    const before = Array.from({ length: 4500 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 4500 }, (_, i) => `new ${i}`).join("\n");
    const diff = unifiedDiff(before, after, "bundle.js");
    expect(diff.split("\n")[2]).toBe("@@ -1,4500 +1,4500 @@");
    expect(parseDiff(diff).hunks).toBe(1);
  });

  test("a three-thousand-line file diffs in well under a second", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l1500", "L1500");
    const t0 = performance.now();
    const diff = unifiedDiff(before, after, "p.ts");
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(parseDiff(diff)).toMatchObject({ added: 1, removed: 1, hunks: 1 });
  });
});

/** Applies an edit script to `a`, checking every line it claims to keep or drop. */
function apply(a: readonly string[], ops: NonNullable<ReturnType<typeof diffOps>>): string[] {
  const out: string[] = [];
  let i = 0;
  for (const op of ops) {
    if (op.kind === "ins") {
      out.push(op.newLine!);
      continue;
    }
    expect(a[i]).toBe(op.oldLine!);
    if (op.kind === "eq") out.push(a[i]!);
    i++;
  }
  expect(i).toBe(a.length);
  return out;
}
const changes = (ops: NonNullable<ReturnType<typeof diffOps>>) =>
  ops.filter((o) => o.kind !== "eq").length;

describe("Myers' walk agrees with the LCS table", () => {
  // A small seeded generator: the same cases on every run, on every machine.
  let seed = 20261022;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const text = (len: number) => Array.from({ length: len }, () => "abcde"[rand(5)]!);

  test("on 400 random pairs: both reproduce the new text, with the same number of changes", () => {
    for (let t = 0; t < 400; t++) {
      const a = text(rand(30));
      const b = rand(3) === 0 ? text(rand(30)) : a.map((c) => (rand(6) === 0 ? "z" : c));
      const myers = myersOps(a, b, 10_000)!;
      const table = diffOps(a, b)!; // small: the LCS table
      expect(apply(a, myers)).toEqual(b);
      expect(apply(a, table)).toEqual(b);
      // Both are shortest edit scripts: n + m - 2·LCS changes.
      expect(changes(myers)).toBe(changes(table));
    }
  });

  test("past its bound it says so instead of running on", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(myersOps(a, b, 99)).toBeNull();
    expect(myersOps(a, b, 100)).not.toBeNull();
  });
});
