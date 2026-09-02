// --- Inline-viewport bottom region ---
// Manages a pinned block (the composer) at the bottom of the terminal while
// transcript content scrolls into the normal scrollback above it -- the same model
// Codex/Claude Code use. We never take the alternate screen, so scrollback and
// copy/paste keep working.
//
// Contract: callers pass lines already bounded to the terminal width (no auto-wrap),
// plus the caret's (row,col) within the block. All cursor math is relative, so the
// block survives terminal scrolling.

type Writer = (s: string) => void;

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR_BELOW = "\x1b[0J"; // clear from cursor to end of screen

export class BottomRegion {
  private write: Writer;
  private rows = 0; // line count of the current block
  private caretRow = 0; // caret's row within the block (0-based from top)
  private mounted = false;
  private bgFill = ""; // optional SGR bg so clears repaint in the active theme, not the terminal's

  constructor(write: Writer = (s) => process.stdout.write(s)) {
    this.write = write;
  }

  /** Set an SGR background sequence so `\x1b[0J` clears fill with the theme bg (not the
   *  terminal's), keeping redraws seamless on terminals that ignore OSC 11 (e.g. Warp). */
  setBgFill(seq: string): void {
    this.bgFill = seq;
  }

  /**
   * Last-resort height clamp. All of this class's cursor math is *relative* (`toTop()` walks up
   * `caretRow` rows), which silently breaks the moment the block is taller than the viewport: drawing
   * it scrolls the terminal, the top rows slide into scrollback, and the next `toTop()` can no longer
   * reach the true top -- so the old block is never cleared and successive frames interleave (the
   * "garbled composer" failure seen under heavy streaming). Guaranteeing the block always fits within
   * `rows-1` keeps that invariant intact. Callers should already trim to fit; this just makes it
   * impossible to violate. Keeps the tail (composer + status) -- the rows the user is actually using.
   */
  private fit(lines: string[], caretRow: number): { lines: string[]; caretRow: number } {
    const rows = process.stdout.rows || 0;
    if (rows < 2) return { lines, caretRow }; // unknown/absurd size -- trust the caller
    const max = rows - 1; // leave one row so a full-height block never triggers a scroll
    if (lines.length <= max) return { lines, caretRow };
    const drop = lines.length - max;
    return { lines: lines.slice(drop), caretRow: Math.max(0, caretRow - drop) };
  }

  /** Sequence to move the cursor from its parked caret cell to the block's top-left. */
  private toTop(): string {
    return (this.caretRow > 0 ? `\x1b[${this.caretRow}A` : "") + "\r";
  }

  private place(lines: string[], caretRow: number, caretCol: number): string {
    let s = lines.join("\r\n");
    const lastRow = lines.length - 1;
    if (lastRow > caretRow) s += `\x1b[${lastRow - caretRow}A`;
    else if (lastRow < caretRow) s += `\x1b[${caretRow - lastRow}B`;
    s += "\r";
    if (caretCol > 0) s += `\x1b[${caretCol}C`;
    return s;
  }

  /** Draw or redraw the pinned block in place. */
  /**
   * `ownCursor` leaves the hardware cursor hidden because the caller has
   * painted its own caret into the block. Asking the terminal to colour its
   * cursor (OSC 12) turned out to be a request terminals may simply refuse, so
   * the caret is drawn as a cell instead — and two carets on one row is worse
   * than either alone. The cursor is still PLACED, so the terminal's own idea
   * of where input goes stays correct for anything reading it.
   */
  render(lines: string[], caretRow = lines.length - 1, caretCol = 0, ownCursor = false): void {
    ({ lines, caretRow } = this.fit(lines, caretRow));
    // Synchronized output (DEC 2026): the clear-below and the redraw land as
    // one frame on terminals that understand the mode, so the block never
    // shows blank between the two. Unknown modes are ignored by the rest.
    let s = "\x1b[?2026h" + HIDE;
    if (this.mounted) s += this.toTop() + this.bgFill + CLEAR_BELOW;
    s += this.place(lines, caretRow, caretCol) + (ownCursor ? "" : SHOW) + "\x1b[?2026l";
    this.write(s);
    this.rows = lines.length;
    this.caretRow = caretRow;
    this.mounted = true;
  }

  /** Emit transcript text above the block (scrolls into history), then redraw. */
  printAbove(
    text: string,
    lines: string[],
    caretRow = lines.length - 1,
    caretCol = 0,
    ownCursor = false,
  ): void {
    let s = HIDE;
    if (this.mounted) s += this.toTop() + this.bgFill + CLEAR_BELOW;
    s += text.endsWith("\n") ? text : text + "\n";
    this.write(s);
    this.mounted = false; // old block is gone; draw a fresh one at the new bottom
    this.render(lines, caretRow, caretCol, ownCursor);
  }

  /** Remove the block (on exit), leaving the transcript intact. */
  clear(): void {
    if (!this.mounted) return;
    this.write(this.toTop() + CLEAR_BELOW + SHOW);
    this.mounted = false;
    this.rows = 0;
    this.caretRow = 0;
  }

  get lineCount(): number {
    return this.rows;
  }
}

// --- What is deliberately NOT here ---
// A full-screen compositor used to live below this line: it took the alternate
// screen (ESC[?1049h) and repainted the whole viewport each frame, with a
// three-tier differential renderer and a hardware region scroll, so it could
// paint a theme background edge-to-edge.
//
// It is gone, and nothing may bring it back. Taking the alternate screen means
// signing up to be correct about every cell of the terminal forever — through
// resize, reflow, tmux reattach, a scroll wheel, and an ssh link that drops for
// nine seconds. It also means owning every cell you did NOT fill, which is why
// an empty session rendered as a viewport of painted nothing.
//
// The trade it asked for was: native scrollback, native momentum scrolling,
// ⌘F, mouse selection, and pipeability — in exchange for a background colour
// the design forbids setting in the first place.
//
// BottomRegion above is the whole surface. History is committed once and is
// the terminal's; only the last N rows are ours, redrawn with relative cursor
// moves. Because history is immutable there are no history bugs, and because
// the live region is a handful of rows the cursor arithmetic is small enough
// to be provably right — which ui-screen.test.ts proves.
