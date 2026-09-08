/**
 * The diff multi_edit and apply_patch return. edit_file gets its diff from the
 * Rust binary; these two ran in TypeScript with both texts in hand and emitted
 * none, so the transcript showed `edit foo.ts` with no red and no green -- 6 of
 * 10 edits in one session. The shape here is exactly what the UI's parseDiff
 * reads, so it is exercised against parseDiff, not against a string.
 */
import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../../../packages/tool-registry/src/tools/unified-diff";
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

  test("past the line cap the diff degrades to one whole-file hunk instead of an O(n²) table", () => {
    const big = Array.from({ length: 4001 }, (_, i) => `line ${i}`).join("\n");
    const diff = unifiedDiff(big, big + "\nextra", "big.ts");
    expect(diff.split("\n")[2]).toBe("@@ -1,4001 +1,4002 @@");
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
