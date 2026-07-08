// ─── Bracketed-paste collapsing ───
// Large / multi-line pastes are folded into a compact `[Pasted text #N +K lines]` chip in the
// composer; the body is held aside and expanded back in on submit. This keeps the single-line
// composer single-line (a pasted newline would spill the box across rows and desync the pinned
// region's cursor math) and avoids re-rendering megabytes of text on every keystroke.

export const PASTE_START = "\x1b[200~"; // bracketed-paste begin marker
export const PASTE_END = "\x1b[201~"; // bracketed-paste end marker

/** Pastes at/under this size (and free of newlines) drop in inline; larger ones collapse to a chip. */
export const PASTE_INLINE_MAX = 240;

// One matcher, two uses. Kept beside pasteChip() so the emitted chip and the expander never drift.
const CHIP_RE = /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g;
const CHIP_ID_RE = /\[Pasted text #(\d+)\b/g;

/** Should this paste collapse to a chip (vs. drop in inline)? */
export function shouldCollapse(content: string, max = PASTE_INLINE_MAX): boolean {
  return content.includes("\n") || content.length > max;
}

/** The composer chip for a collapsed paste — the exact text expandPastes() looks for. */
export function pasteChip(id: number, content: string): string {
  return content.includes("\n")
    ? `[Pasted text #${id} +${content.split("\n").length} lines]`
    : `[Pasted text #${id} +${content.length} chars]`;
}

/** Swap every `[Pasted text #N …]` chip back to its stored body (unknown ids are left as-is). */
export function expandPastes(s: string, bodies: Map<number, string>): string {
  if (bodies.size === 0) return s;
  return s.replace(CHIP_RE, (m, n) => {
    const body = bodies.get(Number(n));
    return body != null ? body : m;
  });
}

/** The paste ids still referenced by a composer string — for GC of consumed/edited-away bodies. */
export function livePasteIds(s: string): Set<number> {
  const live = new Set<number>();
  for (const m of s.matchAll(CHIP_ID_RE)) live.add(Number(m[1]));
  return live;
}

/** A run of ordinary key bytes (feed through the key parser) or one completed paste body. */
export type PasteSegment = { type: "keys"; data: string } | { type: "paste"; content: string };

/**
 * Splits a stream of stdin chunks into ordinary key runs and completed paste bodies, tracking a
 * paste that spans several chunks. Bracketed-paste content is carved out as substrings — never
 * decoded key-by-key — so a multi-megabyte paste costs one string append, not one allocation per
 * character (the O(n²) accumulation that froze the composer on a large paste).
 */
export class PasteScanner {
  private inPaste = false;
  private buf = "";

  /** Feed one raw stdin chunk; returns the segments it completed (a trailing open paste is buffered). */
  push(chunk: string): PasteSegment[] {
    const out: PasteSegment[] = [];
    let rest = chunk;
    for (;;) {
      if (this.inPaste) {
        const end = rest.indexOf(PASTE_END);
        if (end < 0) {
          this.buf += rest; // paste continues into a later chunk
          return out;
        }
        this.buf += rest.slice(0, end);
        out.push({ type: "paste", content: this.buf });
        this.buf = "";
        this.inPaste = false;
        rest = rest.slice(end + PASTE_END.length);
        continue;
      }
      const start = rest.indexOf(PASTE_START);
      if (start < 0) {
        if (rest) out.push({ type: "keys", data: rest });
        return out;
      }
      if (start > 0) out.push({ type: "keys", data: rest.slice(0, start) });
      this.inPaste = true;
      rest = rest.slice(start + PASTE_START.length);
    }
  }

  /** True while a bracketed paste is still open (its end marker hasn't arrived yet). */
  get active(): boolean {
    return this.inPaste;
  }
}
