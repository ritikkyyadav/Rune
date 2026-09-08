// ─── A compact unified diff, in TypeScript ───
//
// `edit_file` gets its diff from the Rust rune-tools binary; `multi_edit` and
// `apply_patch` run in TypeScript and had the before/after text in hand but
// emitted no diff, so the transcript rendered them as a bare `edit foo.ts` with
// no red or green. This builds the same `@@`/`+`/`-` unified diff those rows
// need, from the two strings, so every edit tool shows what it changed.
//
// Line-level LCS with a few lines of context around each change — the shape the
// UI's parseDiff already reads. Pure and dependency-free.

const CONTEXT = 3;
// LCS is O(old × new) in time and memory. A pathological pair (a generated
// bundle rewritten wholesale) would allocate gigabytes, and the diff would be
// unreadable anyway, so above this many lines on either side the diff degrades
// to one hunk that replaces the whole file. The renderer caps the rows it shows
// regardless.
const LCS_LINE_CAP = 4000;

type Op = { kind: "eq" | "del" | "ins"; oldLine?: string; newLine?: string };

/** Longest common subsequence of two line arrays, as a walkable op list. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]. One extra row/col of zeros.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const below = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? below[j + 1]! + 1 : Math.max(below[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", oldLine: a[i], newLine: b[j] });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "del", oldLine: a[i] });
      i++;
    } else {
      ops.push({ kind: "ins", newLine: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", oldLine: a[i++] });
  while (j < m) ops.push({ kind: "ins", newLine: b[j++] });
  return ops;
}

interface HunkLine {
  sign: " " | "+" | "-";
  text: string;
}

/**
 * A unified diff of two strings, headed `--- a/<path>` / `+++ b/<path>` so the
 * UI's parseDiff (which skips those two lines) and any `git apply` reader both
 * accept it. Returns "" when the content is identical.
 */
/** A text as the lines a diff reasons about: the terminator of the last line
 *  is not a line of its own, and an empty file has no lines at all. */
function toLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

export function unifiedDiff(oldText: string, newText: string, path: string): string {
  if (oldText === newText) return "";
  const a = toLines(oldText);
  const b = toLines(newText);

  // Only the final newline differs: every line is equal, so the ops would be
  // all-context and the diff empty. Show the last line as changed instead --
  // git's "\ No newline at end of file" is the same fact, and parseDiff has no
  // row for it.
  if (a.length === b.length && a.every((line, i) => line === b[i])) {
    const n = a.length;
    if (n === 0) return "";
    return `--- a/${path}\n+++ b/${path}\n@@ -${n},1 +${n},1 @@\n-${a[n - 1]}\n+${b[n - 1]}`;
  }

  if (a.length > LCS_LINE_CAP || b.length > LCS_LINE_CAP) {
    // Whole-file replacement — one hunk, no LCS. Rare and deliberately coarse.
    const head = `--- a/${path}\n+++ b/${path}\n@@ -1,${a.length} +1,${b.length} @@`;
    const body = [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
    return `${head}\n${body}`;
  }

  const ops = lcsOps(a, b);

  // Group ops into hunks: a run of changes plus up to CONTEXT equal lines on
  // each side. Equal runs longer than 2×CONTEXT split one hunk from the next.
  const hunks: { oldStart: number; newStart: number; lines: HunkLine[] }[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: { oldStart: number; newStart: number; lines: HunkLine[] } | null = null;
  let trailingEq = 0;

  const flush = () => {
    if (current) {
      // Trim context beyond CONTEXT at the tail of the hunk.
      while (trailingEq > CONTEXT) {
        current.lines.pop();
        trailingEq--;
      }
      hunks.push(current);
      current = null;
      trailingEq = 0;
    }
  };

  // A sliding window of the most recent equal lines, to serve as leading context.
  const recentEq: HunkLine[] = [];

  for (const op of ops) {
    if (op.kind === "eq") {
      const line: HunkLine = { sign: " ", text: op.oldLine ?? "" };
      if (current) {
        current.lines.push(line);
        trailingEq++;
        // Two full context gaps in a row: close the hunk.
        if (trailingEq > 2 * CONTEXT) flush();
      } else {
        recentEq.push(line);
        if (recentEq.length > CONTEXT) recentEq.shift();
      }
      oldLine++;
      newLine++;
    } else {
      if (!current) {
        // Open a hunk, seeded with the recent equal lines as leading context.
        const lead = recentEq.slice();
        current = {
          oldStart: oldLine - lead.length,
          newStart: newLine - lead.length,
          lines: [...lead],
        };
        recentEq.length = 0;
      }
      trailingEq = 0;
      if (op.kind === "del") {
        current.lines.push({ sign: "-", text: op.oldLine ?? "" });
        oldLine++;
      } else {
        current.lines.push({ sign: "+", text: op.newLine ?? "" });
        newLine++;
      }
    }
  }
  flush();

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hunks) {
    const oldCount = h.lines.filter((l) => l.sign !== "+").length;
    const newCount = h.lines.filter((l) => l.sign !== "-").length;
    out.push(`@@ -${h.oldStart},${oldCount} +${h.newStart},${newCount} @@`);
    for (const l of h.lines) out.push(`${l.sign}${l.text}`);
  }
  return out.join("\n");
}
