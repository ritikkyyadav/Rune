// ─── The frame: geometry and paint ───
// One half of the TUI controller, split out of tui.ts so the lanes working on
// the panes, the composer and the slash surfaces are not all editing the same
// six thousand lines.
//
// Everything here answers one of two questions: how many cells does a region
// get, and what goes in them. The pure part of that answer lives in
// ./viewport.ts (`zones`, `composeFrame`, `holdHeight`) and is tested there;
// what remains in this file is the part that has to read the terminal and the
// controller's state to call it.
//
// These are methods, not free functions: they are mixed onto `Tui.prototype` at
// the bottom of tui.ts, so `this` is the same object it always was and the
// bodies moved across unchanged. The `this: Tui` parameter is erased at
// compile time; it exists so TypeScript can check them where they are written.

import type { Tui } from "./tui";
import { composeFrame, holdHeight, zones, type Zones } from "./viewport";
import { arrowRun } from "./keys";
import { renderBanner } from "./banner";
import * as F from "./flow";
import { clampVisible, setTermWidthOverride } from "./render";
import { text, faint, withThemeBg } from "./theme";
// `columns`/`rows` are 0 (not undefined) on a PTY with no winsize -- `||` so a
// zero-size terminal falls back sanely instead of clamping every line to nothing.
export const cols = () => process.stdout.columns || 80;
export const rowsCount = () => process.stdout.rows || 24;

/** Whether the fixed frame captures the mouse wheel. OFF by default so native
 *  click-drag selection and copy work; RUNE_MOUSE=1 trades that for the wheel. */
export const mouseCaptureEnabled = (): boolean => {
  const v = process.env.RUNE_MOUSE;
  return v != null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
};

/**
 * How many blank rows the pinned block holds open beneath the transcript so the
 * field sits on the bottom of the window instead of floating under the header.
 *
 * Pure, and exported, because the interesting case is not the arithmetic — it
 * is what `printedRows` means after the screen has been wiped. It counts rows
 * committed to scrollback and only ever counts UP, which is right while a
 * session accumulates: once a window's worth of output exists there is nothing
 * left to hold open. But /clear erases that output, and if the count survives
 * the erase the padding stays at zero against a screen that is now empty, and
 * the whole bar collapses upward. Every path that clears the screen has to
 * reset the count with it — see resetTranscript.
 */
export function holdOpenRows(viewport: number, printedRows: number, blockRows: number): number {
  // One row spare: a pinned block that reaches the last cell wraps, and a wrap
  // desyncs the relative cursor math for every frame after it.
  return Math.max(0, viewport - printedRows - blockRows - 1);
}
export const MAX_TRANSCRIPT = 5000; // cap the in-memory scrollback
export const SCROLL_STEP = 3; // lines per mouse-wheel notch
/** Ceiling on the live block above the composer: the rung, its detail row, and
 *  up to a fleet's worth of sub-agent rows plus their `+N more`. Past this the
 *  status stops being a status. */
/** The live block is ONE row -- the rung -- plus a row per sub-agent in
 *  flight when there is a fleet. The cap bounds the fleet, not the rung. */
export const LIVE_BLOCK_ROWS = 8;

/** Geometry and paint, mixed onto `Tui.prototype`. */
export const FRAME_METHODS = {
  handleResize(this: Tui): void {
    // A handler that throws once is never called again -- and an unhandled throw
    // here was almost certainly the "resize breaks it and it stops reacting to
    // anything" the founder hit. Whatever goes wrong at one odd size, swallow
    // it: the next resize or keypress repaints from a clean slate.
    try {
      if (this.inline) {
        // The terminal owns the scrollback and reflows it; the composer just
        // trails the output, so all we do is redraw it at the new width. No
        // repositioning maths -- that is exactly what used to drift it around.
        this.renderRegion();
        return;
      }
      // The fixed frame owns every cell, and a resize moved all of them. Forget
      // the screen and repaint at the new size RIGHT NOW -- not after a settle
      // timer. The old code waited 50ms of quiet before repainting, but a
      // continuous drag never has 50ms of quiet, so the surface appeared frozen
      // for the whole drag and only snapped to size when the mouse stopped.
      // scheduleDraw already coalesces to one frame per ~16ms, so painting on
      // every SIGWINCH is smooth, not a strobe -- and it tracks the drag.
      setTermWidthOverride(this.contentCols());
      this.viewport.invalidate();
      this.scheduleDraw();
    } catch {
      /* next resize/keypress repaints */
    }
  },

  /**
   * The column the surface is allowed to draw into. The flow grammar bounds
   * itself to a 78-cell measure, so this only has to stop a line from touching
   * the right edge of a narrow window.
   */
  contentCols(this: Tui): number {
    const width = cols();
    if (this.inline) return width;
    return Math.max(8, width - 1);
  },

  /** Append a block to the transcript, theming each line in the *current* theme and bounding
   *  the buffer. (Lines keep their theme; switching themes recolours the live composer + new
   *  output, and history stays readable in the theme it was written in.) */
  /** Hard-bound a line to the terminal width. An over-wide line auto-wraps,
   *  which breaks the pinned region's row math -- and then every repaint leaks
   *  stale rows into the scrollback (the "duplicated spam" failure mode). */
  bound(this: Tui, ln: string): string {
    return clampVisible(ln, Math.max(8, this.contentCols() - 1));
  },

  /** A left click landing in the transcript toggles the fold under it. */
  clickTranscript(this: Tui, _x: number, y: number): void {
    if (this.inline || !this.lastBodyMap) return;
    if (this.mode !== "input" && this.mode !== "turn") return;
    const map = this.lastBodyMap;
    const row = y - 1; // SGR cells are 1-based
    const first = map.bodyTop + (map.marked ? 1 : 0);
    const last = map.bodyTop + map.bodyRows - 1;
    if (row < first || row > last) return;
    const index = map.hiddenAbove + (row - first);
    if (index < 0 || index >= this.transcript.length) return;
    const fold = this.folds.at(index);
    if (fold) this.toggleFold(fold);
  },

  /** --inline only: redraw just the pinned composer block (the transcript lives in the
   *  terminal's own scrollback). The fixed layout uses renderViewport() instead. */
  renderRegion(this: Tui): void {
    const comp = this.pinnedBlock();
    this.region.render(comp.lines, comp.caretRow, comp.caretCol, this.ownsCaret());
  },

  /** The zones of the current frame, without building it. Used by the scroll
   *  keys, which need to know how tall a page is before they can move by one. */
  frameZones(this: Tui): Zones {
    const headerRows = this.bannerLines().length;
    return zones(rowsCount(), headerRows, this.footerBlock(headerRows).lines.length);
  },

  /** How far back the transcript can be scrolled: everything that does not fit
   *  in the body. Clamping here (and again in composeFrame) is what stops a
   *  fast wheel from scrolling past the top into a screen of blank rows. */
  maxScroll(this: Tui): number {
    return Math.max(0, this.transcript.length - this.bodyRowsNow());
  },

  /** The body height of the frame on screen. Scrolling does not change the
   *  footer, so the last painted frame's zones are exact -- and a wheel notch
   *  must not rebuild the banner and the whole composer just to learn two
   *  integers (a dozen notches arrive in one stdin chunk). */
  bodyRowsNow(this: Tui): number {
    return this.lastBodyMap?.bodyRows ?? this.frameZones().bodyRows;
  },

  /**
   * The pinned FOOTER of the fixed layout.
   *
   * Same block as the inline surface's, minus the padding: the inline layout
   * has to hold blank rows open beneath the transcript to push the field to the
   * bottom of the window, because the terminal decides where the block lands.
   * Here the footer is at the bottom by construction, so the padding would be
   * a hole in the middle of the screen.
   *
   * A full-height panel (sessions, keys, memory, the work review) is still a
   * footer as far as layout is concerned; it just claims almost every row. The
   * clamp leaves the header standing and one row of transcript behind it, so
   * even a panel never erases where you are.
   */
  footerBlock(
    this: Tui,
    headerRows: number,
  ): { lines: string[]; caretRow: number; caretCol: number } {
    const max = Math.max(3, rowsCount() - headerRows - 1);
    // Let selectable dialogs window their own items within the actual footer.
    // Cropping the rendered tail can otherwise remove the selected first row.
    const comp = this.composerBlock(max);
    let lines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    let caretRow = comp.caretRow;
    if (lines.length > max) {
      const drop = lines.length - max;
      const marker = withThemeBg(
        this.bound(
          `  ${faint(`... ${drop} more line${drop === 1 ? "" : "s"} above (ctrl+r to expand)`)}`,
        ),
      );
      lines = [marker, ...lines.slice(drop + 1)];
      caretRow = Math.max(0, caretRow - drop);
    }
    return { lines, caretRow, caretCol: comp.caretCol };
  },

  /**
   * Paint one whole frame of the fixed layout.
   *
   * The header is re-rendered every frame rather than drawn once, so a model
   * switch, a gear change or a theme change is reflected in the band the moment
   * it happens -- and costs nothing, because the diff only writes the rows whose
   * text actually changed.
   */
  renderViewport(this: Tui): void {
    const header = this.bannerLines().map((l) => withThemeBg(l));
    const footer = this.footerBlock(header.length);
    const frame = composeFrame({
      rows: rowsCount(),
      header,
      transcript: this.transcript,
      // Bound at paint time, for the rows that made the window only: the
      // transcript is stored unbounded so a resize re-clips it.
      themeBody: (l) => withThemeBg(this.bound(l)),
      footer: footer.lines,
      scroll: this.scroll,
      caretRow: footer.caretRow,
      caretCol: footer.caretCol,
      blank: "",
      scrolledMarker: (hidden) =>
        withThemeBg(
          this.bound(
            `  ${faint(`${hidden} earlier line${hidden === 1 ? "" : "s"} above -- pgdn to follow the latest`)}`,
          ),
        ),
    });
    // composeFrame clamps the scroll to what the transcript can offer; adopting
    // its answer is what keeps a held PgUp from accumulating an offset the body
    // cannot honour, then swallowing the first N presses of PgDn on the way back.
    this.scroll = frame.scroll;
    // Where the body landed, for the click -> transcript-row math. Recorded
    // from the frame actually painted, never recomputed later against state
    // that may have moved.
    this.lastBodyMap = {
      bodyTop: frame.zones.bodyTop,
      bodyRows: frame.zones.bodyRows,
      hiddenAbove: frame.hiddenAbove,
      marked: frame.scroll > 0 && frame.zones.bodyRows > 1,
    };
    this.viewport.render(frame, !this.ownsCaret());
  },

  /** --inline only. The pinned composer block, themed, width-bounded, and height-clamped to the
   *  viewport. (The fixed layout's equivalent is footerBlock(), which needs none of the padding
   *  below because its footer is at the bottom of the window by construction.) The
   *  inline region draws with *relative* cursor moves, so a block taller than the screen would
   *  scroll the terminal mid-draw and desync that math (garbled/duplicated footer under heavy
   *  streaming). Keep the tail -- the composer + status the user is actually using -- and elide the
   *  top (the older work/prose preview) behind a marker. */
  /**
   * The pinned block — and, at launch, the empty space that puts it where it
   * belongs.
   *
   * A program that prints eight lines into a forty-row window leaves the header
   * floating in the middle of the screen with the field somewhere under it and
   * dead space below. Both are technically "in the terminal"; neither is in its
   * place. The old surface solved this by taking the alternate screen and
   * owning every cell, which put the header on row one and the field on the
   * last row — and cost native scrollback, wheel scroll, ⌘F and pipeability to
   * do it, and painted an empty session as a viewport of nothing.
   *
   * This holds the space open from below instead. The pinned block carries the
   * blank rows itself, so the field sits on the bottom rows of the window from
   * the first frame while the header stays at the top. As output arrives the
   * padding shrinks by exactly as much as was printed, so the field never
   * moves — and once the session has filled the window the padding reaches zero
   * and the whole thing scrolls like any other program, with its history in the
   * terminal's own buffer where it belongs.
   *
   * Nothing is painted into the held space: they are ordinary blank rows, so a
   * pipe, NO_COLOR and a narrow window all see exactly what they should.
   */
  /**
   * Whether the block about to be drawn paints its own caret.
   *
   * Only the writing surface does. A picker, a permission card and the sessions
   * panel all use the caret purely to park the terminal's cursor somewhere
   * sensible, and hiding it there would take away the one signal that says the
   * pane is focused at all.
   */
  ownsCaret(this: Tui): boolean {
    // Only the writing surface paints a caret. Every other mode — pickers, the
    // permission card, the sessions panel, the key sheet — parks the terminal's
    // cursor somewhere sensible and needs it visible, because there it is the
    // only signal that the pane has focus at all.
    //
    // The sessions panel joined the writing surface on 2026-09-05: its selected
    // row is a full-width band and its search field paints a caret cell, so
    // the parked hardware cursor had become a second, foreign-coloured block
    // sitting on the band (Warp draws its cursor in its own theme and ignores
    // OSC 12 -- see theme.ts). Focus is already unmistakable there.
    return this.mode === "input" || this.mode === "turn" || this.mode === "sessions";
  },

  pinnedBlock(this: Tui): { lines: string[]; caretRow: number; caretCol: number } {
    const comp = this.composerBlock();
    let lines = comp.lines.map((l) => withThemeBg(this.bound(l)));
    let caretRow = comp.caretRow;

    // No hold-open padding. In the Claude Code model the composer TRAILS the
    // output: right under the masthead on a fresh session, and at the bottom of
    // the window once a screenful has scrolled. The old padding tried to jam it
    // to the bottom of an empty screen, which (a) put a gap of blank rows
    // between the masthead and the field and (b) drifted the field to the
    // middle after a reflow when the row count went stale -- both read as the
    // "floating footer". Trailing the output is simpler and is exactly how the
    // terminal already wants to place a prompt.
    const max = Math.max(3, rowsCount() - 1);
    if (lines.length > max) {
      const drop = lines.length - max;
      const marker = withThemeBg(
        this.bound(
          `  ${faint(`... ${drop} more line${drop === 1 ? "" : "s"} above (ctrl+r to expand)`)}`,
        ),
      );
      lines = [marker, ...lines.slice(drop + 1)];
      caretRow = Math.max(0, caretRow - drop);
    }
    return { lines, caretRow, caretCol: comp.caretCol };
  },

  /** The banner, rendered live (re-themed every frame) so the header always matches the
   *  current theme -- pinned at the top of the viewport by renderViewport(). */
  bannerLines(this: Tui): string[] {
    const { engine } = this.ctx;
    return renderBanner({
      model: engine.getModel(),
      modelLabel: this.modelLabel(),
      provider: engine.getProvider(),
      effort: engine.getReasoningEffort(),
      sessionId: this.ctx.sessionId,
      workspace: this.ctx.workspaceRoot,
      version: this.ctx.version,
      ...this.gearScope(),
    })
      .split("\n")
      .map((l) => this.bound(l));
  },

  /** Request a repaint, coalesced to at most one paint per ~16ms (60fps). Almost every input and
   *  stream event funnels through here; together with the diff renderer this turns a burst of
   *  changes into a single frame, which is what removes the scroll/stream jitter. */
  scheduleDraw(this: Tui): void {
    if (this.drawScheduled) return;
    this.drawScheduled = true;
    const wait = Math.max(0, 16 - (Date.now() - this.lastPaint));
    this.drawTimer = setTimeout(() => this.paint(), wait);
  },

  paint(this: Tui): void {
    this.drawScheduled = false;
    this.drawTimer = null;
    this.lastPaint = Date.now();
    if (this.inline) this.renderRegion();
    else this.renderViewport();
  },

  /** Scroll the body by whole screens (PgUp/PgDn). One row of overlap, so the
   *  line you were reading at the seam is still there after the jump. */
  scrollBy(this: Tui, pages: number): void {
    this.scrollLines(pages * Math.max(1, this.bodyRowsNow() - 1));
  },

  /**
   * Scroll the body. Positive moves back through history, negative returns
   * toward the live tail -- matching `scroll`, which counts lines ABOVE the
   * bottom.
   *
   * Under --inline this stays a no-op on purpose: there the transcript is in
   * the terminal's own buffer, and a program that also scrolled it would be
   * fighting the scrollbar the user is already holding.
   */
  /**
   * Fixed frame only: does an arrow key READ the transcript or RECALL history?
   * The same two keys carry both, because alternate-scroll mode delivers the
   * wheel as arrows and the composer already uses them for history. The two
   * meanings are told apart here, in one place, so the input and mid-turn
   * paths cannot drift. `burst` is true when the whole read was a one-way
   * arrow run (arrowRun) -- the wheel's signature. History stays reachable
   * on ctrl+p / ctrl+n whatever this decides.
   *
   * TODO(human): this is the policy seam. Current rule: a burst always
   * scrolls; once the transcript is scrolled away from the tail the arrows
   * keep scrolling (down returns to the tail); a lone arrow on an EMPTY
   * composer scrolls; a lone arrow with a draft in the composer recalls
   * history. The trade: Up-on-empty no longer recalls the last prompt the way
   * Claude Code does, because a slow trackpad sends one arrow per read and
   * would otherwise recall history mid-scroll.
   */
  arrowScrolls(this: Tui, burst: boolean): boolean {
    if (this.inline) return false;
    if (this.mode !== "input" && this.mode !== "turn") return false;
    if (burst) return true;
    if (this.scroll > 0) return true;
    return this.input.length === 0;
  },

  scrollLines(this: Tui, lines: number): void {
    if (this.inline) return;
    const next = Math.max(0, Math.min(this.maxScroll(), this.scroll + lines));
    if (next === this.scroll) return;
    this.scroll = next;
    this.scheduleDraw();
  },

  liveBlockBudget(this: Tui): number {
    return Math.max(2, Math.min(LIVE_BLOCK_ROWS, Math.floor(rowsCount() / 3)));
  },

  /**
   * Hold the live block at the tallest it has been THIS TURN.
   *
   * The block's natural height moves constantly: the streaming prose tail is
   * four rows while the agent narrates and zero the instant a tool call starts
   * (the prose is captured as intent), then four again on the next sentence.
   * Every change re-splits the frame, the body shrinks or grows by that many
   * rows, and the transcript re-indexes -- the whole body repainted, the text
   * the user was reading jumping up or down. Twenty tool calls, forty jumps.
   * Pinning the height to the turn's high-water mark makes the block grow a
   * few times early and then stand still; the one collapse comes at the end
   * of the turn, where the reader expects the screen to settle anyway.
   */
  pinLiveHeight(this: Tui, lines: string[]): string[] {
    const held = holdHeight(lines, this.liveBlockRows, this.liveBlockBudget());
    this.liveBlockRows = held.highWater;
    return held.rows;
  },
};

export type FrameMethods = typeof FRAME_METHODS;
