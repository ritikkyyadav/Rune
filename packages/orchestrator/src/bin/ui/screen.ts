// ─── Inline-viewport bottom region ───
// Manages a pinned block (the composer) at the bottom of the terminal while
// transcript content scrolls into the normal scrollback above it — the same model
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

  constructor(write: Writer = (s) => process.stdout.write(s)) {
    this.write = write;
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
  render(lines: string[], caretRow = lines.length - 1, caretCol = 0): void {
    let s = HIDE;
    if (this.mounted) s += this.toTop() + CLEAR_BELOW;
    s += this.place(lines, caretRow, caretCol) + SHOW;
    this.write(s);
    this.rows = lines.length;
    this.caretRow = caretRow;
    this.mounted = true;
  }

  /** Emit transcript text above the block (scrolls into history), then redraw. */
  printAbove(text: string, lines: string[], caretRow = lines.length - 1, caretCol = 0): void {
    let s = HIDE;
    if (this.mounted) s += this.toTop() + CLEAR_BELOW;
    s += text.endsWith("\n") ? text : text + "\n";
    this.write(s);
    this.mounted = false; // old block is gone; draw a fresh one at the new bottom
    this.render(lines, caretRow, caretCol);
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
