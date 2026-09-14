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
import {
  composeFrame,
  holdHeight,
  PANEL_MIN_COLS,
  refusalRows,
  regions,
  splitPanes,
  zones,
  COMPOSER_MIN_ROWS,
  MIN_COLS,
  MIN_ROWS,
  PANEL_COLS,
  PANEL_MIN_ROWS,
  SPLIT_MIN_ROWS,
  type Panes,
  type Regions,
  type Zones,
} from "./viewport";
import { arrowRun } from "./keys";
import { renderBanner } from "./banner";
import * as F from "./flow";
import { clampVisible, setTermWidthOverride, visLen } from "./render";
import { text, faint, accent, brand, muted, withThemeBg } from "./theme";
import { glyph } from "./glyphs";
import {
  fleetLedger,
  panelHint,
  renderAgentsPanel,
  renderAgentsStrip,
  renderSessionPanel,
  type SessionReadout,
} from "./agents-panel";
import {
  renderComposer,
  renderSlashPalette,
  composerCounts,
  composerHintRow,
  composerTextWidth,
  modeInfo,
} from "./composer";

/** Which region the keys act on. Lanes B and C read this off the controller. */
export type FrameFocus = "composer" | "panel" | "workspace" | "child";

/** One child's transcript, open in the workspace split. Lane B fills `lines`. */
export interface ChildPane {
  id: string;
  /** The name on the panel card and in the pane header. */
  name: string;
  /** State, elapsed, tokens -- whatever the header should carry after the name. */
  note?: string;
  lines: string[];
}
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
/**
 * The focus ring, as one pure list.
 *
 * Pure because it is the part with an order to get wrong, and because a test
 * for it should not need an Engine. The child only joins the ring while a split
 * is open -- a ring with a dead stop in it is worse than a shorter ring.
 */
export function focusRing(splitOpen: boolean): FrameFocus[] {
  const ring: FrameFocus[] = ["composer", "panel", "workspace"];
  if (splitOpen) ring.push("child");
  return ring;
}

/** The next region `ctrl+f` reaches from `current`. */
export function nextFocus(current: FrameFocus, splitOpen: boolean): FrameFocus {
  const ring = focusRing(splitOpen);
  const at = ring.indexOf(current);
  return ring[(at + 1) % ring.length] ?? "composer";
}

/**
 * flow indents by its 2-cell MARK; the right column's gutter is 1.
 *
 * Rather than teach the grammar a second indent rung -- which ui-grammar.test
 * forbids, and rightly -- the column renders one cell wider and drops the first
 * cell, so its rules land exactly where the mocks put them.
 */
const tighten = (line: string): string => (line.startsWith(" ") ? line.slice(1) : line);

/** Exactly `rows` rows: blanks added, extras dropped from the end. */
const padTo = (lines: string[], rows: number): string[] => {
  const out = lines.slice(0, Math.max(0, rows));
  while (out.length < rows) out.push("");
  return out;
};

export const FRAME_METHODS = {
  /**
   * The four regions of the current window, without building them.
   *
   * Called by the paint loop and by every key that needs to know how tall a
   * page is. `composerRows` is what the composer ASKED for; `regions` decides
   * what it gets -- the panel yields, and the workspace never does.
   */
  regionsNow(this: Tui, composerRows?: number): Regions {
    return regions({
      columns: cols(),
      rows: rowsCount(),
      headerRows: this.bannerLines().length,
      composerRows,
      strip: true,
    });
  },

  /**
   * Whether this frame is drawn as four regions or as the older three zones.
   *
   * The band is the writing surface, and as of lane E a **picker** is drawn
   * inside it rather than instead of it (§2.8: `/config`, `/sandbox` and
   * `/model` render in the workspace). Opening a settings list used to make the
   * panel, the divider and the whole right column blink out of existence and
   * come back on `esc`, which is a lot of screen to spend on a list of
   * nineteen settings.
   *
   * It is deliberately NOT every modal. Below `PANEL_MIN_COLS` there is no
   * column to preserve, and the footer layout is also the one that gives a long
   * list the most rows -- so a collapsed window keeps the old behaviour, and
   * gains nothing by changing. The permission card, sessions, keys, memory and
   * the work review keep the footer at every width: each is a decision that
   * deserves the screen, which is the opposite of what a picker needs.
   */
  bandLayout(this: Tui): boolean {
    if (this.inline) return false;
    if (this.mode === "input" || this.mode === "turn") return true;
    return this.bandModal();
  },

  /** A picker that opens inside the workspace instead of claiming the footer. */
  bandModal(this: Tui): boolean {
    if (this.inline || this.mode !== "picker") return false;
    return !this.regionsNow().collapsed;
  },

  /** The workspace, split between the main transcript and one child's. */
  panesNow(this: Tui, workspaceRows: number): Panes {
    return splitPanes(workspaceRows, this.childPane != null);
  },

  /**
   * Advance the focus ring: composer -> panel -> workspace -> child -> composer.
   *
   * At collapsed widths there is no panel to focus, so the same key opens it as
   * an overlay instead -- the keel rule that a side panel stale most of the time
   * should be one always-current row that names the key which expands it.
   */
  cycleFocus(this: Tui): void {
    if (this.regionsNow().collapsed) {
      this.panelOverlay = !this.panelOverlay;
      this.focus = this.panelOverlay ? "panel" : "composer";
      this.scheduleDraw();
      return;
    }
    this.focus = nextFocus(this.focus, this.childPane != null);
    this.scheduleDraw();
  },

  /** `esc` from anywhere in the ring. Returns true when it consumed the key --
   *  in the composer it did not, because there `esc` still interrupts. */
  releaseFocus(this: Tui): boolean {
    if (this.panelOverlay) {
      this.panelOverlay = false;
      this.focus = "composer";
      this.scheduleDraw();
      return true;
    }
    if (this.focus === "composer") return false;
    if (this.focus === "child") {
      this.closeChildPane();
      return true;
    }
    this.focus = "composer";
    this.scheduleDraw();
    return true;
  },

  /** Open one child's transcript in the workspace split. Only one at a time:
   *  opening another replaces it. Lane B supplies the rows. */
  openChildPane(this: Tui, pane: ChildPane): void {
    this.childPane = pane;
    this.childScroll = 0;
    this.focus = "child"; // you opened it to read it
    this.scheduleDraw();
  },

  /** `ctrl+w`. The child's rows stay in its buffer, so reopening it does not
   *  lose scrollback -- only the pane goes. */
  closeChildPane(this: Tui): void {
    if (!this.childPane) return;
    this.childPane = null;
    this.childScroll = 0;
    this.focus = "composer";
    this.scheduleDraw();
  },

  /**
   * One pane's window onto its own buffer.
   *
   * Per-region offsets are the point: paging the child must not move the main
   * pane, and opening a child must not move either.
   */
  paneRows(
    this: Tui,
    lines: string[],
    rows: number,
    scroll: number,
    width: number,
    marker?: (hidden: number) => string,
  ): { rows: string[]; scroll: number; hiddenAbove: number; marked: boolean } {
    const height = Math.max(0, rows);
    const maxScroll = Math.max(0, lines.length - height);
    const at = Math.max(0, Math.min(scroll, maxScroll));
    const marked = at > 0 && marker != null && height > 1;
    const content = marked ? height - 1 : height;
    const end = Math.max(0, lines.length - at);
    const start = Math.max(0, end - content);
    const out = lines.slice(start, end).map((l) => clampVisible(this.bound(l), width));
    const painted = marked ? [clampVisible(marker!(start), width), ...out] : out;
    while (painted.length < height) painted.push("");
    return { rows: painted.slice(0, height), scroll: at, hiddenAbove: start, marked };
  },

  /**
   * The right column: the agents panel while any exist, the session readout
   * otherwise (P4 §2.4).
   *
   * Three states, in this order, because each one displaces the one below it
   * for the same reason -- it is more specific about what is happening now:
   *
   *   AGENTS   any child dispatched this session, running or finished. The
   *            finished ones stay until `c`, which is the founder's
   *            requirement and the reverse of the old behaviour.
   *   the rung a turn is live and has delegated nothing. The column is never
   *            blank while work is happening; that is lane A's property and
   *            this keeps it.
   *   SESSION  the readout -- `/status`'s content as a column. Every field is
   *            optional and an absent one draws no row: a panel that printed
   *            `cost $0.00` before the first call would be stating a
   *            measurement nobody has made.
   */
  panelBlock(this: Tui, r: Regions): string[] {
    const w = r.panelContentCols;
    const inset = r.collapsed ? (l: string) => l : tighten;
    const view = fleetLedger.view(this.focus === "panel");
    // The open pane's header is refreshed from the paint path, so its clock and
    // its token count advance with the run rather than freezing at the moment
    // the pane was opened.
    fleetLedger.refreshPane();
    const out: string[] = [];
    if (view.running.length > 0 || view.finished.length > 0) {
      // The panel draws its own headings and rules -- it has two sections and
      // a per-section count, which one heading here could not carry.
      for (const line of this.atWidth(w + 2, () => renderAgentsPanel(view, w, r.panelRows))) {
        out.push(inset(`  ${clampVisible(line, w)}`));
      }
    } else {
      const live = this.mode === "turn" ? this.atWidth(w + 2, () => this.turnStateLines()) : [];
      if (live.length > 0) {
        const title = this.focus === "panel" ? accent("AGENTS") : faint("AGENTS");
        out.push(inset(`  ${F.row(title, r.collapsed ? faint("esc close") : "", w)}`));
        out.push(inset(`  ${faint(glyph("rule").repeat(w))}`));
        for (const line of live) out.push(inset(clampVisible(line, w + 2)));
      } else {
        for (const line of this.atWidth(w + 2, () =>
          renderSessionPanel(this.sessionReadout(), w),
        )) {
          out.push(inset(`  ${clampVisible(line, w)}`));
        }
      }
    }
    while (out.length < r.panelRows) out.push("");
    return out.slice(0, r.panelRows);
  },

  /**
   * What the idle column can honestly say about this session.
   *
   * Read straight off the engine at paint time rather than accumulated here:
   * a mirror of the engine's numbers held in the frame is a second copy that
   * can be wrong, and the one thing this column sells is that its numbers are
   * measurements. Anything this cannot reach is left undefined and draws no
   * row at all.
   */
  sessionReadout(this: Tui): SessionReadout {
    const engine = this.ctx.engine;
    const out: SessionReadout = {};
    try {
      const usage = engine.getContextUsage();
      out.contextPercent = usage.percent;
      out.contextUsed = usage.used;
      out.contextLimit = usage.limit;
    } catch {
      // An engine with no context accounting says nothing about context.
    }
    try {
      out.model = engine.getModel();
      out.effort = engine.getReasoningEffortLabel();
    } catch {
      // ditto
    }
    try {
      const cost = engine.getCost();
      if (cost > 0) out.costUsd = cost;
    } catch {
      // ditto
    }
    if (this.filesEdited.size > 0) out.filesChanged = this.filesEdited.size;
    try {
      out.sandbox = engine.isSandboxEnabled() ? "on" : "off";
    } catch {
      // ditto
    }
    try {
      out.gear = modeInfo(engine.getPermissionMode()).label;
    } catch {
      // ditto
    }
    return out;
  },

  /**
   * The collapsed one-line agents strip.
   *
   * Below PANEL_MIN_COLS the right column is worth less than the cells it
   * costs, so it becomes this: always current, and naming the key that opens
   * the full panel. It names the members it has room for rather than printing
   * a count -- a count is the thing this phase exists to replace.
   */
  stripRow(this: Tui, r: Regions): string {
    const w = r.workspaceCols;
    // The strip sits directly on top of the composer, so it is measured to the
    // composer's RULES and not to the band: two cells of indent and two of
    // right margin (`bandComposer`'s collapsed width, viewport.regions). Drawn
    // to the band instead, its `ctrl+f open` overhangs the rule beneath it by
    // two cells -- which in a fixed frame reads as a misprint, because every
    // other right edge in the column lands on the same column.
    const inner = Math.max(8, w - 4);
    const view = fleetLedger.view(this.focus === "panel");
    if (view.running.length > 0 || view.finished.length > 0) {
      return clampVisible(`  ${this.atWidth(w, () => renderAgentsStrip(view, inner))}`, w);
    }
    const live = this.mode === "turn" ? this.turnStateLines() : [];
    const left =
      live.length > 0
        ? clampVisible(live[0]!.trimStart(), Math.max(8, w - 18))
        : faint("no agents this session");
    return clampVisible(
      `  ${F.row(`${accent(glyph("phase"))} ${left}`, faint("ctrl+f open"), inner)}`,
      w,
    );
  },

  /**
   * The composer region: a rule, the field, a rule, one hint row.
   *
   * The field itself is still ./composer.ts's -- lane C replaces it with a
   * wrapping one. What this owns is the shape: four rows at rest, the palette
   * above the field when a `/` is being typed, and a hint row outside the rules
   * so it does not read as more input.
   */
  bandComposer(this: Tui, r: Regions): { lines: string[]; caretRow: number; caretCol: number } {
    const wide = !r.collapsed;
    const width = wide ? PANEL_COLS + 1 : this.contentCols();
    // What the field may grow to. `regions()` clamps a request for the whole
    // band down to the region's own ceiling, so asking it for the band is how
    // to read that ceiling back without restating the formula -- and it is what
    // makes the growth paid for by the PANEL, which is the only thing regions()
    // will give the rows up. The 3 is this region's chrome: two rules and the
    // hint row. (Lane C, over lane A's seam.)
    const maxRows = Math.max(1, this.regionsNow(r.bandRows).composerRows - 3);
    return this.atWidth(wide ? PANEL_COLS + 2 : this.contentCols(), () => {
      const base = renderComposer({
        input: this.input,
        caret: this.caret,
        width,
        status: "",
        maxRows,
      });
      // renderComposer owns a blank row above the field, for a layout where the
      // transcript runs right up to it. Here the region's own edge does that job.
      let lines = base.lines.slice(1);
      let caretRow = Math.max(0, base.caretRow - 1);
      const matches = this.slashMatches();
      if (matches.length > 0) {
        const palette = renderSlashPalette(
          matches,
          this.slashSel,
          wide ? PANEL_COLS + 1 : this.contentCols(),
          Math.max(1, r.bandRows - PANEL_MIN_ROWS - lines.length - 1),
          this.slashCatalog().length,
        );
        lines = [...palette, ...lines];
        caretRow += palette.length;
      }
      // Counted with the field's own measure, inside the same width override,
      // so the hint can never disagree with the rows above it.
      const counts = composerCounts(this.input, composerTextWidth(width));
      lines.push(`  ${faint(this.composerHint(counts, width - 2))}`);
      if (wide) {
        lines = lines.map(tighten);
      }
      return { lines, caretRow, caretCol: base.caretCol - (wide ? 1 : 0) };
    });
  },

  /**
   * One quiet hint row, by the same tier ladder the status line uses.
   *
   * The composer's three states are `composerHintRow` in ./composer.ts -- pure,
   * and tested beside the field whose rows it counts. What stays here is the
   * one thing that is not the composer's: where the keys currently GO.
   */
  composerHint(this: Tui, counts: { lines: number; chars: number }, max: number): string {
    // The keys act on the PANEL, so the hint row names the panel's keys. A
    // legend that went on advertising `enter send` while enter opened an
    // agent's transcript would be the row lying about where the keys go.
    if (this.focus === "panel") return panelHint(fleetLedger.view(true));
    return composerHintRow({ streaming: this.mode === "turn", counts, max });
  },

  /** The pane header naming the open child. Drawn with rules on both sides so
   *  it reads as a seam, not as content. */
  childHeader(this: Tui, r: Regions, panes: Panes): string {
    const w = r.workspaceCols - 2;
    const pane = this.childPane;
    if (!pane) {
      return clampVisible(
        `  ${faint(`the split needs ${SPLIT_MIN_ROWS} rows; this workspace has ${r.workspaceRows}`)}`,
        r.workspaceCols,
      );
    }
    const rule = glyph("rule").repeat(2);
    const paint = this.focus === "child" ? accent : faint;
    const parts = [pane.name, pane.note ?? "", "ctrl+w close"].filter((p) => p !== "");
    const body = ` ${parts.join(` ${glyph("rule")}${glyph("rule")} `)} `;
    const fill = Math.max(2, w - visLen(body) - rule.length);
    void panes;
    return clampVisible(
      `  ${paint(`${rule}${body}${glyph("rule").repeat(fill)}`)}`,
      r.workspaceCols,
    );
  },

  /**
   * The window that is too small to be told the truth in.
   *
   * At 44 columns a diff row is 38 cells after the rail -- below flow's own
   * 40-column floor -- so every line of evidence would be shortened without
   * saying so. Returns true when it painted, which is the caller's cue to stop.
   */
  renderRefusal(this: Tui): boolean {
    if (this.inline) return false;
    const columns = cols();
    const rows = rowsCount();
    if (columns >= MIN_COLS && rows >= MIN_ROWS) return false;
    const block = refusalRows(columns, rows);
    const top = Math.max(0, Math.floor((rows - block.length) / 2));
    const out: string[] = [];
    for (let i = 0; i < rows; i++) {
      const line = block[i - top];
      out.push(
        line == null
          ? ""
          : clampVisible(
              `  ${i - top === 0 ? brand(line) : faint(line)}`,
              Math.max(1, columns - 1),
            ),
      );
    }
    this.lastBodyMap = null;
    this.viewport.render(
      { rows: out, scroll: 0, hiddenAbove: 0, caretRow: 0, caretCol: 0, zones: zones(rows, 0, 0) },
      false,
    );
    return true;
  },

  /**
   * Paint the four-region frame.
   *
   * Header and status strip span the window; between them the band is the
   * workspace, one divider column and the fixed 40-cell right column. The
   * workspace is the ONLY scrolling region, and the composer's growth is paid
   * for by the panel -- so nothing above the divider ever moves because
   * somebody typed.
   */
  renderBand(this: Tui): void {
    const header = this.bannerLines().map((l) => withThemeBg(l));
    // Two passes, because the composer's height decides the split and the
    // split decides the composer's width. The width only depends on the
    // collapse, which only depends on the columns -- so one probe is enough.
    const probe = this.regionsNow();
    const composer = this.bandComposer(probe);
    const r = this.regionsNow(composer.lines.length);
    const panes = this.panesNow(r.workspaceRows);

    // A picker opens INSIDE the workspace, at the workspace's own measure --
    // `contentCols()` already reports the left column, so the block needs no
    // width argument, only the rows it may have.
    const modal = this.bandModal() ? this.composerBlock(panes.mainRows) : null;

    // Left column: the main pane, then the child's seam and rows when open.
    const main = this.paneRows(
      this.transcript,
      panes.mainRows,
      this.scroll,
      r.workspaceCols,
      (hidden) =>
        `  ${faint(`${hidden} earlier line${hidden === 1 ? "" : "s"} above -- pgdn to follow the latest`)}`,
    );
    this.scroll = main.scroll;
    const left = modal
      ? padTo(
          modal.lines.map((l) => clampVisible(this.bound(l), r.workspaceCols)),
          panes.mainRows,
        )
      : [...main.rows];
    if (panes.headerRows > 0) left.push(this.childHeader(r, panes));
    if (panes.open && this.childPane) {
      const child = this.paneRows(
        this.childPane.lines,
        panes.childRows,
        this.childScroll,
        r.workspaceCols,
      );
      this.childScroll = child.scroll;
      left.push(...child.rows);
    }

    // Right column: the panel on top, the composer pinned to the bottom of the
    // band. Collapsed, both move into the left column under the strip.
    const right: string[] = [];
    if (r.collapsed) {
      // `ctrl+f` at a collapsed width opens the panel OVER the workspace, the
      // same mechanic /sessions uses, and `esc` closes it. A side panel that is
      // stale most of the time should be one always-current row that names the
      // key which expands it -- so the strip stays, and this is the expansion.
      if (this.panelOverlay) {
        left.length = 0;
        left.push(
          ...this.panelBlock({
            ...r,
            // Full width, and its rules land on the composer's: both are drawn
            // as a 2-cell indent plus the remainder, so the overlay measures
            // itself against the same edge the field does.
            panelContentCols: Math.max(8, r.workspaceCols - 4),
            panelRows: r.workspaceRows,
          }),
        );
      }
      if (r.stripRows > 0) left.push(this.stripRow(r));
      left.push(...composer.lines.slice(-r.composerRows));
    } else {
      right.push(...this.panelBlock(r));
      right.push(...composer.lines.slice(-r.composerRows));
    }

    const caretRow = modal
      ? r.bandTop + Math.min(modal.caretRow, Math.max(0, panes.mainRows - 1))
      : r.bandTop + r.bandRows - r.composerRows + composer.caretRow;
    const caretCol = modal
      ? modal.caretCol
      : r.collapsed
        ? composer.caretCol
        : r.dividerCol + composer.caretCol;

    const frame = composeFrame({
      rows: rowsCount(),
      header,
      transcript: [],
      footer: [
        withThemeBg(
          this.atWidth(this.frameCols(), () =>
            clampVisible(this.statusStr(this.frameCols()), this.frameCols()),
          ),
        ),
      ],
      scroll: 0,
      caretRow,
      caretCol,
      blank: "",
      band: {
        regions: r,
        left: left.map((l) => withThemeBg(l)),
        right: right.map((l) => withThemeBg(l)),
        divider: this.focus === "composer" ? faint(glyph("gutter")) : muted(glyph("gutter")),
        width: visLen,
      },
    });
    // The main pane's window, for the click -> transcript-row math. A modal is
    // occupying those rows, so there is no transcript row under the pointer and
    // the map says so rather than naming one that is not there.
    this.lastBodyMap = modal
      ? null
      : {
          bodyTop: r.bandTop,
          bodyRows: panes.mainRows,
          hiddenAbove: main.hiddenAbove,
          marked: main.marked,
        };
    this.viewport.render(frame, !this.ownsCaret());
  },

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
    const usable = Math.max(8, width - 1);
    // In the workspace layout the transcript lives in the LEFT column, so the
    // measure every row is WRITTEN at is that column's, not the window's.
    // Getting this wrong is not a cosmetic bug: rows are stored rendered, so a
    // transcript written at 119 and clamped to 78 loses the right third of
    // every receipt, and a resize cannot get it back.
    //
    // It deliberately does NOT consult the mode. A measure that changed when a
    // picker opened would re-wrap the whole session under the user's hands.
    if (width >= PANEL_MIN_COLS) return Math.max(8, usable - PANEL_COLS - 2);
    return usable;
  },

  /**
   * The window's own width, for the two regions that span it: the header and
   * the status strip. `contentCols` is the workspace's; this is the frame's.
   */
  frameCols(this: Tui): number {
    return this.inline ? cols() : Math.max(8, cols() - 1);
  },

  /** Render something at a width other than the transcript's, then put the
   *  measure back. The override is a process global (render.ts) that flow reads
   *  through `termWidth()`; retiring it means changing flow.ts, which is lane
   *  D's file. Until then this is the honest way to draw two measures. */
  atWidth<T>(this: Tui, width: number, build: () => T): T {
    setTermWidthOverride(width);
    try {
      return build();
    } finally {
      setTermWidthOverride(this.inline ? null : this.contentCols());
    }
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
    if (this.focus === "child" && this.childPane) {
      return Math.max(0, this.childPane.lines.length - this.childRowsNow());
    }
    return Math.max(0, this.transcript.length - this.bodyRowsNow());
  },

  /** The open child pane's height, from the frame actually painted. */
  childRowsNow(this: Tui): number {
    if (!this.childPane) return 0;
    return this.panesNow(this.regionsNow().workspaceRows).childRows;
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
    if (this.renderRefusal()) return;
    if (this.bandLayout()) {
      this.renderBand();
      return;
    }
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
    // The header is full-width chrome in both layouts, so it is drawn at the
    // frame's measure and bounded to it -- not to the workspace column.
    return this.atWidth(this.frameCols(), () => this.bannerRows());
  },

  bannerRows(this: Tui): string[] {
    const { engine } = this.ctx;
    return (
      renderBanner({
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
        // Bounded to the frame's own measure, not one cell inside it. The margin
        // that keeps a row off the terminal's last cell is already in
        // `frameCols()` (`cols() - 1`); taking a second cell here clipped the
        // final glyph off the seam rule that `flow.chromeWidth()` draws to the
        // frame's edge, which is the whole of lane A's "header rule is short".
        .map((l) => clampVisible(l, Math.max(8, this.frameCols())))
    );
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
    const rows =
      this.focus === "child" && this.childPane ? this.childRowsNow() : this.bodyRowsNow();
    this.scrollLines(pages * Math.max(1, rows - 1));
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
    // Per-region offsets: the focused pane moves, and only it. Paging a child
    // transcript that must not disturb the main one is the whole reason the two
    // offsets are separate fields rather than one.
    if (this.focus === "child" && this.childPane) {
      const next = Math.max(0, Math.min(this.maxScroll(), this.childScroll + lines));
      if (next === this.childScroll) return;
      this.childScroll = next;
      this.scheduleDraw();
      return;
    }
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
