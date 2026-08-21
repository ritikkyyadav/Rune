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
   * reach the true top — so the old block is never cleared and successive frames interleave (the
   * "garbled composer" failure seen under heavy streaming). Guaranteeing the block always fits within
   * `rows-1` keeps that invariant intact. Callers should already trim to fit; this just makes it
   * impossible to violate. Keeps the tail (composer + status) — the rows the user is actually using.
   */
  private fit(lines: string[], caretRow: number): { lines: string[]; caretRow: number } {
    const rows = process.stdout.rows || 0;
    if (rows < 2) return { lines, caretRow }; // unknown/absurd size — trust the caller
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
  render(lines: string[], caretRow = lines.length - 1, caretCol = 0): void {
    ({ lines, caretRow } = this.fit(lines, caretRow));
    let s = HIDE;
    if (this.mounted) s += this.toTop() + this.bgFill + CLEAR_BELOW;
    s += this.place(lines, caretRow, caretCol) + SHOW;
    this.write(s);
    this.rows = lines.length;
    this.caretRow = caretRow;
    this.mounted = true;
  }

  /** Emit transcript text above the block (scrolls into history), then redraw. */
  printAbove(text: string, lines: string[], caretRow = lines.length - 1, caretCol = 0): void {
    let s = HIDE;
    if (this.mounted) s += this.toTop() + this.bgFill + CLEAR_BELOW;
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

// ─── Full-screen compositor (alternate screen) ───
// For themed UIs we take the alternate screen and repaint the whole viewport each frame,
// so the background is painted edge-to-edge in the theme — the only way to get a cohesive
// full-window theme on terminals that ignore OSC 11 (Warp). Trades native scrollback for a
// self-managed scroll. Each `frame` is wrapped in synchronized-update markers so terminals
// that support it (Warp/iTerm/kitty) show no flicker; others ignore the markers harmlessly.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const HOME = "\x1b[H";
const BLOCK_CURSOR = "\x1b[2 q"; // DECSCUSR: steady block, as in the reference composer
const RESET_CURSOR = "\x1b[0 q";
const SCROLL_EXPOSED = "\x00"; // sentinel marking band rows freshly exposed by a region scroll

export class AltScreen {
  private write: Writer;
  private active = false;
  // Last painted frame + the width it was painted at, for differential redraws. `null` forces a
  // full repaint (the first frame, after a resize, or an explicit invalidate()).
  private prev: string[] | null = null;
  private prevCols = 0;

  constructor(write: Writer = (s) => process.stdout.write(s)) {
    this.write = write;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Drop the diff baseline so the next frame() repaints in full (call on resize). */
  invalidate(): void {
    this.prev = null;
  }

  enter(bgFill = ""): void {
    if (this.active) return;
    // Pre-paint the whole alt-screen in the theme bg so the first frame doesn't flash.
    this.write(ALT_ENTER + HIDE + BLOCK_CURSOR + bgFill + "\x1b[2J" + HOME);
    this.active = true;
    this.prev = null; // first frame after entering is always a full paint
  }

  exit(): void {
    if (!this.active) return;
    this.write(RESET_CURSOR + SHOW + ALT_EXIT);
    this.active = false;
  }

  /**
   * Paint one frame. `rows` are complete, already-styled lines that exactly fill the viewport
   * height (each bounded to the terminal width and ending in EL `\x1b[K`, so re-writing a single
   * row overwrites its old content and refills the right margin). Caret is placed at the 0-based
   * (row, col). Wrapped in a synchronized update so supporting terminals show no tearing.
   *
   * Three tiers, cheapest applicable one wins:
   *  1. Full repaint — first frame / row-count change / width change / invalidate().
   *  2. Region scroll — when `scroll` reports a clean vertical shift of the transcript band and the
   *     overlap actually matches, shift that band with the terminal's own hardware scroll (DECSTBM
   *     + SU/SD) and repaint only the freshly exposed lines. This is the key to fluid streaming AND
   *     scrolling: appending a line, or a wheel notch, shifts the whole window, so a naive per-row
   *     diff would rewrite every row — the region scroll turns that into "scroll N, paint N".
   *  3. Per-row diff — rewrite only the rows whose content changed.
   */
  frame(
    rows: string[],
    caretRow: number,
    caretCol: number,
    scroll?: { top: number; bottom: number; delta: number },
  ): void {
    if (!this.active) return;
    const cols = process.stdout.columns ?? 80;
    const place = `\x1b[${caretRow + 1};${caretCol + 1}H`;

    // Tier 1 — full repaint.
    if (this.prev === null || this.prev.length !== rows.length || this.prevCols !== cols) {
      let s = SYNC_BEGIN + HIDE + HOME;
      for (let i = 0; i < rows.length; i++) {
        s += rows[i] ?? "";
        if (i < rows.length - 1) s += "\r\n"; // no trailing newline → never scrolls the last row
      }
      s += place + SHOW + SYNC_END;
      this.write(s);
      this.prev = rows.slice();
      this.prevCols = cols;
      return;
    }

    const prev = this.prev;
    let s = SYNC_BEGIN + HIDE;

    // Tier 2 — hardware region scroll. applyScroll only mutates `prev` when the shift truly matches
    // the new frame, so a bad hint just no-ops and the per-row diff below repaints normally.
    if (scroll && scroll.delta !== 0 && this.applyScroll(prev, rows, scroll)) {
      const { top, bottom, delta } = scroll;
      const move = delta > 0 ? `\x1b[${delta}T` : `\x1b[${-delta}S`; // +down (SD) / -up (SU)
      s += `\x1b[${top + 1};${bottom + 1}r` + move + "\x1b[r"; // set region · scroll · reset region
    }

    // Tier 3 — per-row diff (also paints the lines a Tier-2 scroll just exposed).
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? "";
      if (row !== prev[i]) s += `\x1b[${i + 1};1H` + row; // rewrite only this row, in place
    }
    s += place + SHOW + SYNC_END;
    this.write(s);

    this.prev = rows.slice();
    this.prevCols = cols;
  }

  /**
   * Verify a proposed band scroll against the new frame; if it's a clean shift, mutate `prev` to
   * reflect the terminal-side scroll (shift the band, mark the exposed rows with a sentinel so the
   * per-row diff repaints exactly those) and return true. Returns false — leaving `prev` untouched —
   * when the overlap doesn't match, so the caller falls back to a plain per-row diff.
   */
  private applyScroll(
    prev: string[],
    rows: string[],
    { top, bottom, delta }: { top: number; bottom: number; delta: number },
  ): boolean {
    if (top < 0 || bottom >= rows.length || top >= bottom) return false;
    const n = Math.abs(delta);
    if (n >= bottom - top + 1) return false; // shift ≥ band height → no cheaper than a full diff
    if (delta > 0) {
      // Content moved DOWN by n: row i (top+n..bottom) must equal prev[i-n]; expose top..top+n-1.
      for (let i = top + n; i <= bottom; i++) if (rows[i] !== prev[i - n]) return false;
      for (let i = bottom; i >= top + n; i--) prev[i] = prev[i - n]!;
      for (let i = top; i < top + n; i++) prev[i] = SCROLL_EXPOSED;
    } else {
      // Content moved UP by n: row i (top..bottom-n) must equal prev[i+n]; expose bottom-n+1..bottom.
      for (let i = top; i <= bottom - n; i++) if (rows[i] !== prev[i + n]) return false;
      for (let i = top; i <= bottom - n; i++) prev[i] = prev[i + n]!;
      for (let i = bottom - n + 1; i <= bottom; i++) prev[i] = SCROLL_EXPOSED;
    }
    return true;
  }
}
