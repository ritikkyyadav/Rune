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
/**
 * Past this many changed lines a diff is not a reading aid, and one whole-file
 * hunk says it better. It bounds Myers' walk below: O((n+m)·d) time and O(d²)
 * memory.
 */
const MAX_EDIT_LINES = 2000;

type Op = { kind: "eq" | "del" | "ins"; oldLine?: string; newLine?: string };

/**
 * The edit script between two line arrays, or null when it is too costly to
 * find (the caller then shows one whole-file hunk).
 *
 * The common start and end are context by definition, so they come off first:
 * an edit in the middle of an 8,000-line file is a few lines of work, not 64
 * million cells. Before this, every edit to a file over the cap came out as a
 * whole-file rewrite (2026-10-22: a 9-line change to agent-loop.ts, 7,802
 * lines, was a 737,609-character diff), and the request check, which will not
 * read part of a change as the whole, skipped every such run. What is left
 * goes to the LCS table when it is small, and to Myers' walk when it is not.
 */
export function diffOps(a: readonly string[], b: readonly string[]): Op[] | null {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid =
    midA.length <= LCS_LINE_CAP && midB.length <= LCS_LINE_CAP
      ? lcsOps(midA, midB)
      : myersOps(midA, midB, MAX_EDIT_LINES);
  if (mid === null) return null;
  const eq = (line: string): Op => ({ kind: "eq", oldLine: line, newLine: line });
  return [...a.slice(0, pre).map(eq), ...mid, ...a.slice(a.length - suf).map(eq)];
}

/**
 * Myers' shortest edit script ("An O(ND) Difference Algorithm", 1986): for a
 * pair too long for the LCS table but with few changes between them. Each
 * round's diagonals are kept as a window of 2d+3 cells, so the trace is O(d²).
 * Null when the script would be longer than `maxD`.
 */
export function myersOps(a: readonly string[], b: readonly string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const off = n + m + 1;
  const v = new Int32Array(2 * off + 2);
  const trace: Int32Array[] = [];
  const limit = Math.min(n + m, maxD);
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    // Diagonals -d-1..d+1 as they stood before this round: all the walk back reads.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Walk back from (n, m) to (0, 0), one round at a time.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const w = trace[d]!;
    const at = (k: number) => w[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", oldLine: a[x - 1], newLine: b[y - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "ins", newLine: b[prevY] });
      else ops.push({ kind: "del", oldLine: a[prevX] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

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

  const ops = diffOps(a, b);
  if (ops === null) {
    // Whole-file replacement, one hunk: a change of more than MAX_EDIT_LINES
    // lines in a file too long for the LCS table. Rare and deliberately coarse.
    const head = `--- a/${path}\n+++ b/${path}\n@@ -1,${a.length} +1,${b.length} @@`;
    const body = [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n");
    return `${head}\n${body}`;
  }

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
