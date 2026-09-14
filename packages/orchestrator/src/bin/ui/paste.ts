// --- Bracketed-paste collapsing ---
// Large / multi-line pastes are folded into a compact `[Pasted text #N +K lines]` chip in the
// composer; the body is held aside and expanded back in on submit. The composer wraps now, so
// the reason is no longer that a newline would spill the box -- it is that a 40,000-line paste
// is not a thing anyone wants to scroll through in a 40-cell field, and re-rendering megabytes
// on every keystroke is not a thing anyone wants to wait for. The chip gets a row of its own
// (see pasteChipSpans) so the shape of the message is still visible.

export const PASTE_START = "\x1b[200~"; // bracketed-paste begin marker
export const PASTE_END = "\x1b[201~"; // bracketed-paste end marker

/** Pastes at/under this size (and free of newlines) drop in inline; larger ones collapse to a chip. */
export const PASTE_INLINE_MAX = 240;

// One matcher, three uses. Kept beside pasteChip() so the emitted chip and the expander never drift.
const CHIP_HEAD = "[Pasted text #";
const CHIP_RE = /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g;
const CHIP_ID_RE = /\[Pasted text #(\d+)\b/g;

/** Should this paste collapse to a chip (vs. drop in inline)? */
export function shouldCollapse(content: string, max = PASTE_INLINE_MAX): boolean {
  return content.includes("\n") || content.length > max;
}

/** The composer chip for a collapsed paste -- the exact text expandPastes() looks for. */
export function pasteChip(id: number, content: string): string {
  return content.includes("\n")
    ? `[Pasted text #${id} +${content.split("\n").length} lines]`
    : `[Pasted text #${id} +${content.length} chars]`;
}

/** Swap every `[Pasted text #N ...]` chip back to its stored body (unknown ids are left as-is). */
export function expandPastes(s: string, bodies: Map<number, string>): string {
  if (bodies.size === 0) return s;
  return s.replace(CHIP_RE, (m, n) => {
    const body = bodies.get(Number(n));
    return body != null ? body : m;
  });
}

/** Where each `[Pasted text #N ...]` chip sits in a composer string.
 *
 * The third use of the one matcher. The composer gives a chip a row of its own
 * -- collapsing a 38-line paste is right, but burying the chip mid-sentence
 * hides the SHAPE of the message being sent -- and to do that the renderer has
 * to know exactly which characters are chip and which are prose. Deriving that
 * from a second regex is how the chip and its expander drift apart. */
export function pasteChipSpans(s: string): Array<{ start: number; end: number }> {
  // Called on every keystroke by the composer's wrap. `includes` on a literal
  // is a memchr; the regex is a scan with backtracking state, and almost no
  // draft has a chip in it. Cheap guard, and the literal stays in this file
  // with the matcher it guards.
  if (!s.includes(CHIP_HEAD)) return [];
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of s.matchAll(CHIP_RE)) {
    if (m.index == null) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** The paste ids still referenced by a composer string -- for GC of consumed/edited-away bodies. */
export function livePasteIds(s: string): Set<number> {
  const live = new Set<number>();
  for (const m of s.matchAll(CHIP_ID_RE)) live.add(Number(m[1]));
  return live;
}

/** A run of ordinary key bytes (feed through the key parser) or one completed paste body. */
export type PasteSegment = { type: "keys"; data: string } | { type: "paste"; content: string };

/**
 * Splits a stream of stdin chunks into ordinary key runs and completed paste bodies, tracking a
 * paste that spans several chunks. Bracketed-paste content is carved out as substrings -- never
 * decoded key-by-key -- so a multi-megabyte paste costs one string append, not one allocation per
 * character (the O(n2) accumulation that froze the composer on a large paste).
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
        // Terminals deliver pasted line breaks as CR (xterm behavior Warp and
        // others follow), so a multi-line paste arrives with \r and not one
        // \n. Everything downstream splits on \n only — the model's prompt,
        // the mission file, the flow renderer — so a 40KB spec pasted in Warp
        // reached the model as ONE line (observed: 2,381 CRs, zero LFs).
        // Normalize at the single choke point every paste passes through.
        out.push({ type: "paste", content: this.buf.replace(/\r\n?/g, "\n") });
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
