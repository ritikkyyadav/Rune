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
  composerCaretRow,
  composerPaintRows,
  type Panes,
  type Regions,
  type Zones,
} from "./viewport";
import { uiLayout } from "./layout";
import { workingRow } from "./working";
import { arrowRun } from "./keys";
import { renderBanner } from "./banner";
import * as F from "./flow";
import { clampVisible, setTermWidthOverride, visLen } from "./render";
import { text, faint, accent, brand, muted, warn, withThemeBg } from "./theme";
import { glyph, TERMINAL_GLYPH_MODE } from "./glyphs";
import {
  ledgerRows,
  maskLive,
  savedActiveRows,
  MASK_CELL_ASCII,
  MASK_CELL_UTF8,
} from "../../first-run";
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
  renderKeyManagerPanel,
  renderKeysPanel,
  renderSlashPalette,
  composerCounts,
  composerHintRow,
  composerTextWidth,
  modeInfo,
  type RenderedBlock,
} from "./composer";

/** How long a window drag has to go quiet before the wrapped blocks of the
 *  transcript are set down again at the new measure. The frame itself repaints
 *  on every SIGWINCH; only the re-render waits. */
export const RESIZE_REFLOW_SETTLE_MS = 150;

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

/** The rung, read once. `ledgerRows` takes it as an argument because
 *  first-run.ts is engine-side and never learns what a terminal can draw. */
const ASCII_RUNG = TERMINAL_GLYPH_MODE === "ascii";

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
      layout: uiLayout(),
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
   * gains nothing by changing. The permission card, sessions, memory and the
   * work review keep the footer at every width: each is a decision that
   * deserves the screen, which is the opposite of what a picker needs.
   *
   * `/keys` joined the band because §2.8 splits it rather than moving it: the
   * provider list is EVIDENCE and belongs in the workspace, and the secret
   * being typed is INPUT and belongs in the composer. That is a split only the
   * four-region frame can draw, so `keysInBand` gates on the same width.
   */
  bandLayout(this: Tui): boolean {
    if (this.inline) return false;
    if (this.mode === "input" || this.mode === "turn") return true;
    if (this.mode === "setup") return this.setupInBand();
    return this.bandModal();
  },

  /** A list that opens inside the workspace instead of claiming the footer. */
  bandModal(this: Tui): boolean {
    if (this.inline) return false;
    if (this.mode !== "picker" && this.mode !== "keys") return false;
    return !this.regionsNow().collapsed;
  },

  /**
   * Whether `/keys` is drawn ACROSS the frame rather than as one footer panel.
   *
   * §2.8 gives the two halves of `/keys` different regions for a reason that is
   * not layout: the provider list is a statement about what is configured --
   * evidence, and it belongs where every other piece of evidence goes -- while
   * the key being pasted is a field, and a field belongs in the composer with
   * the caret. Drawn as one footer panel they were the same object, which is
   * how a masked list row and a live secret ended up rendered by the same code
   * with the same masking rule.
   *
   * Collapsed is a different answer, not a smaller one: below `PANEL_MIN_COLS`
   * there is no composer to put the field in, and the footer panel is also the
   * layout that gives a thirty-row provider roster the most rows.
   */
  keysInBand(this: Tui): boolean {
    if (this.inline || this.mode !== "keys") return false;
    return !this.regionsNow().collapsed;
  },

  /**
   * Whether the wizard is drawn ACROSS the frame rather than as one footer block.
   *
   * §2.8 gives each part of setup the region it belongs to: the six steps and
   * the saved-vs-active table are a ledger, so they go in the panel; a step's
   * receipt is evidence, so it goes in the workspace in the same box every
   * other tool call gets; and the question is one field, so it goes in the
   * composer with a title. Lane E built all three and drew them stacked in the
   * footer, which at 120 columns meant the panel and the divider blinked out of
   * existence for the whole of setup.
   *
   * Collapsed is a different answer, not a smaller one. There is no second
   * column to preserve below `PANEL_MIN_COLS`, and the footer block Lane E
   * froze at 80x24 already puts the ledger directly above the question, where
   * it costs no keystroke to read. Splitting there would move the ledger behind
   * `ctrl+f` and take rows from a window that has none to give — so a collapsed
   * window keeps exactly what it had.
   */
  setupInBand(this: Tui): boolean {
    if (this.inline || this.mode !== "setup" || !this.ctx.firstRun) return false;
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
    // §2.8: while the wizard is open the column IS the wizard's ledger. It
    // displaces the agents panel and the session readout for the same reason
    // they displace each other -- it is the more specific thing happening now,
    // and it is the object the acceptance checks read.
    if (this.mode === "setup" && this.ctx.firstRun) {
      const rows = this.atWidth(w + 2, () => this.setupPanelRows(w)).map((l) =>
        inset(`  ${clampVisible(l, w)}`),
      );
      return padTo(rows, r.panelRows);
    }
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
   * The wizard's ledger as a column: six steps, then saved vs active.
   *
   * Every row here comes from first-run.ts -- `steps()`, `ledgerRows`,
   * `savedVsActive()`, `savedActiveRows`, `precedenceLine()`. That is the point:
   * the integration test reads the same objects with no terminal at all, so the
   * panel and the test can never disagree about what a skipped step says or
   * which source won. What this owns is only the two headings, the rule under
   * each, and the one indent that makes the steps read as a list inside them.
   *
   * Returned UNINDENTED and bounded to `w`; `panelBlock` puts the column's own
   * gutter on afterwards, exactly as it does for the agents panel.
   */
  setupPanelRows(this: Tui, w: number): string[] {
    const setup = this.ctx.firstRun;
    if (!setup) return [];
    const focused = this.focus === "panel";
    const out: string[] = [];
    const heading = (label: string, right = ""): void => {
      out.push(F.row(focused ? accent(label) : faint(label), right ? faint(right) : "", w));
      out.push(faint(glyph("rule").repeat(w)));
    };
    // The steps are a list inside a heading, so they are indented inside the
    // column -- and `ledgerRows` is handed the NARROWER measure, so the value it
    // elides is counted against the cells it will really have rather than
    // against the column and then pushed over the edge by this indent.
    const indent = "  ";
    const inner = Math.max(8, w - indent.length);

    // Restart-required is its own row, not a banner (§2.8) -- and because it
    // is, the per-step `note` saying the same thing is dropped from the column.
    // It is eighteen of these thirty-six cells and it is the reason a saved
    // `custom` rendered as `cust…`: `ledgerRow` gives the note its room first
    // and elides the VALUE, which is the one field the row exists to carry. The
    // footer block has seventy-eight cells and keeps both. `checking...` is not
    // this note (first-run.ts sets it only for `restartRequired`) and stays: it
    // is transient, and it is the answer to "is it doing anything".
    const restart = setup.restartNote();
    const rows = setup
      .steps()
      .map((s) =>
        s.restartRequired && s.note === "restart required" ? { ...s, note: undefined } : s,
      );

    heading("SETUP", setup.heading());
    for (const row of ledgerRows(rows, inner, ASCII_RUNG)) {
      out.push(`${indent}${faint(row)}`);
    }
    if (restart) out.push(`${indent}${warn(clampVisible(restart, inner))}`);

    out.push("");
    heading("SAVED vs ACTIVE");
    const comparison = setup.savedVsActive();
    for (const row of savedActiveRows(comparison, inner)) {
      out.push(row === "" ? "" : `${indent}${faint(row)}`);
    }
    // `savedActiveRows` ends on the precedence ladder whenever a row differs --
    // that is what naming a winner means -- so the ladder is stated in exactly
    // one place, here as in the footer block.
    if (!comparison.some((row) => row.differs)) {
      out.push("");
      out.push(`${indent}${faint(setup.precedenceLine(inner))}`);
    }
    return out;
  },

  /**
   * The composer while the wizard is open: one question, one field (§2.8).
   *
   * The footer block stacks the ledger, the table and the receipt above the
   * field because in that layout there is nowhere else for them. Here there is:
   * the ledger is in the panel and the receipts are in the workspace, so this
   * region carries the two rows that are actually input -- the question as a
   * title, and the answer being typed, masked when the step is a secret.
   *
   * The block is built to fit the region rather than trimmed to it afterwards.
   * The band keeps a block's TAIL when it overflows, and the row that would be
   * cut off the front is the question -- a composer titled with nothing. So the
   * hint row is given up first when the window is short, which costs a legend
   * that is discovery rather than the sentence that says what to type.
   */
  bandSetupComposer(
    this: Tui,
    r: Regions,
  ): { lines: string[]; caretRow: number; caretCol: number } {
    const setup = this.ctx.firstRun!;
    const step = setup.current();
    const width = PANEL_COLS + 1;
    // The ceiling the region will actually grant this block: `regions()` asked
    // for more rows than the band has returns its own clamp, which IS the cap.
    const cap = Math.max(COMPOSER_MIN_ROWS, this.regionsNow(r.bandRows).composerRows);
    return this.atWidth(PANEL_COLS + 2, () => {
      const shown = step?.secret ? maskLive(this.input, setup.maskCell()) : this.input;
      const base = renderComposer({
        input: shown,
        caret: Math.min(this.caret, shown.length),
        width,
        status: "",
        placeholder: this.setupBusy
          ? "checking..."
          : step?.secret
            ? "paste key (masked)"
            : "type a value, or enter to skip",
        // Four rows of chrome: the two rules, the title, and the hint.
        maxRows: Math.max(1, cap - 4),
      });
      // renderComposer owns a blank row above the field; the region's own edge
      // does that job here, so it is dropped as the writing surface drops it.
      const field = base.lines.slice(1);
      const title = `  ${text(clampVisible(step ? step.question : "setup complete", width - 4))}`;
      const lines = [field[0] ?? "", title, ...field.slice(1)];
      const caretRow = Math.max(0, base.caretRow - 1) + 1;
      const hint = step
        ? `enter save ${glyph("observed")} esc skip ${glyph("observed")} ctrl+f steps`
        : `setup complete ${glyph("observed")} enter close`;
      if (lines.length < cap) lines.push(`  ${faint(hint)}`);
      return {
        lines: lines.map(tighten),
        caretRow,
        caretCol: base.caretCol - 1,
      };
    });
  },

  /**
   * `/keys` in the workspace: the provider roster, or one provider's pool.
   *
   * The same two renderers the footer panel uses, at the WORKSPACE's measure
   * instead of the window's -- and deliberately never the third one. When a key
   * is being typed `composerBlock` swaps the list for `renderKeyEditor`; here
   * the list stays exactly where it was and the field appears in the composer,
   * which is the whole of §2.8's "list + masked field": you can still read what
   * is configured while you paste the key that changes it.
   */
  keysWorkspaceBlock(this: Tui, rows: number): RenderedBlock {
    const w = this.contentCols();
    const mgr = this.keysManage;
    if (mgr) {
      const row = this.keysRows.find((r) => r.id === mgr.id);
      return renderKeyManagerPanel(mgr.label, row?.savedKeys ?? [], mgr.sel, w);
    }
    return renderKeysPanel(this.keysRows, this.keysSel, w, Math.max(4, rows));
  },

  /**
   * The composer while a key is being typed: one title, one masked field.
   *
   * Masked WHOLE, not to its last four. `renderKeyEditor`'s footer field shows
   * the tail as you type, which is the right call for a value you are checking
   * against a dashboard -- but the last four of a key you are pasting are on
   * screen for as long as the pane is open, and the band puts that field
   * beside a list that already carries the last four of every saved key. So the
   * live field is `maskLive`, the same cell the setup wizard's key step uses,
   * and the last four appear once the key is SAVED, in the list row.
   *
   * Built to fit like `bandSetupComposer`, and for the same reason: the band
   * keeps a block's tail, so an over-long block loses its title -- a field with
   * no question above it. The hint row is what is given up instead.
   */
  bandKeysComposer(this: Tui, r: Regions): { lines: string[]; caretRow: number; caretCol: number } {
    const e = this.keysEdit!;
    const width = PANEL_COLS + 1;
    const cap = Math.max(COMPOSER_MIN_ROWS, this.regionsNow(r.bandRows).composerRows);
    return this.atWidth(PANEL_COLS + 2, () => {
      const shown = e.masked
        ? maskLive(e.value, ASCII_RUNG ? MASK_CELL_ASCII : MASK_CELL_UTF8)
        : e.value;
      const base = renderComposer({
        input: shown,
        caret: Math.min(e.caret, shown.length),
        width,
        status: "",
        placeholder: e.masked ? "paste key (masked)" : "type a value",
        // Four rows of chrome: the two rules, the title and the hint.
        maxRows: Math.max(1, cap - 4),
      });
      // renderComposer owns a blank row above the field; the region's own edge
      // does that job here, so it is dropped as the writing surface drops it.
      const field = base.lines.slice(1);
      const title = `  ${text(clampVisible(e.title, width - 4))}`;
      const lines = [field[0] ?? "", title, ...field.slice(1)];
      const caretRow = Math.max(0, base.caretRow - 1) + 1;
      const hint = `enter save ${glyph("observed")} esc cancel`;
      if (lines.length < cap) lines.push(`  ${faint(hint)}`);
      return { lines: lines.map(tighten), caretRow, caretCol: base.caretCol - 1 };
    });
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
    // At rest, after a turn: `▄ done · 1m 58s`, held still. The last frame is
    // the one worth keeping on screen -- how long the thing you just watched
    // actually took -- and it is the only row here that survives the turn it
    // describes. Before the first turn there is nothing to report and the
    // strip says what it has always said.
    const settled =
      this.lastTurnMs != null
        ? workingRow({ kind: "done", elapsedMs: this.lastTurnMs })
        : `${accent(glyph("phase"))} ${faint("no agents this session")}`;
    const left =
      live.length > 0
        ? `${accent(glyph("phase"))} ${clampVisible(live[0]!.trimStart(), Math.max(8, w - 18))}`
        : settled;
    return clampVisible(`  ${F.row(left, faint("ctrl+f open"), inner)}`, w);
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
    if (this.setupInBand()) return this.bandSetupComposer(r);
    if (this.keysInBand() && this.keysEdit) return this.bandKeysComposer(r);
    const wide = !r.collapsed;
    const width = wide ? PANEL_COLS + 1 : this.contentCols();
    // What the field may grow to. `composerPaintRows` is that ceiling, asked
    // for the whole band so the answer is the ceiling itself rather than a
    // restatement of the formula: with a panel it is `regions()`'s own clamp
    // (the growth is paid for by the PANEL, which is the only region that will
    // give the rows up), and collapsed it is what the block may paint OVER the
    // workspace, since there is no panel to take it from. The 3 is this
    // region's chrome: two rules and the hint row. (Lane C, over lane A's seam.)
    const maxRows = Math.max(1, composerPaintRows(this.regionsNow(r.bandRows), r.bandRows) - 3);
    // The outer measure (what `F.surfaceWidth()` sees) is always one cell
    // WIDER than the field's own `width` above -- the wide branch already
    // keeps that one-cell split (`PANEL_COLS + 2` outer vs `PANEL_COLS + 1`
    // field); the collapsed branch fed `atWidth` the SAME number as `width`,
    // which shorted `composerTextWidth` by the one cell `surfaceWidth`'s own
    // `- MARK.length` margin expects, undercounting the field by a column at
    // every narrow size.
    return this.atWidth(wide ? PANEL_COLS + 2 : this.contentCols() + 1, () => {
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
    // `panes.open` (not `!pane`) is the gate: a child pane that was opened at a
    // taller window and never explicitly closed stays set on `this.childPane`
    // even after a shrink makes the split unaffordable, and `panesNow` reports
    // exactly that as `refused`. Branching on the stale pane instead of the
    // CURRENT geometry left the old header -- name, note, "ctrl+w close" -- on
    // screen with zero body rows under it, which is the one case splitPanes'
    // own doc comment says this row exists to prevent.
    if (!panes.open || !pane) {
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
    // How many rows the block actually paints, which is not `r.composerRows`
    // when the window is collapsed: there the region stays at its resting
    // height (so the workspace's own arithmetic never depends on what is being
    // typed) and the extra rows are painted OVER the workspace's bottom rows
    // instead. `cover` is how many rows that is.
    const paintRows = composerPaintRows(r, composer.lines.length);
    const cover = Math.max(0, paintRows - r.composerRows);

    // A picker opens INSIDE the workspace, at the workspace's own measure --
    // `contentCols()` already reports the left column, so the block needs no
    // width argument, only the rows it may have. `/keys` takes the same door
    // but keeps its own renderer: `composerBlock` would swap the list for the
    // key editor the moment one is open, and here the field is the composer's.
    const modal = this.bandModal()
      ? this.keysInBand()
        ? this.keysWorkspaceBlock(panes.mainRows)
        : this.composerBlock(panes.mainRows)
      : null;
    // Which region owns the caret. A modal normally does -- it is the only
    // thing the keys act on -- but while a key is being typed the field is in
    // the composer, so the caret has to follow it out of the workspace.
    const caretInModal = modal != null && !(this.keysInBand() && this.keysEdit != null);

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
      // The rows a grown field or an open palette needs, taken by covering the
      // BOTTOM of the workspace rather than by shrinking it: every row above
      // stays exactly where it was painted, which is the whole of "nothing
      // moves because somebody typed" once there is no panel to yield them.
      if (cover > 0) left.length = Math.max(0, left.length - cover);
      if (r.stripRows > 0) left.push(this.stripRow(r));
      left.push(...composer.lines.slice(-paintRows));
    } else {
      right.push(...this.panelBlock(r));
      right.push(...composer.lines.slice(-paintRows));
    }

    const caretRow = caretInModal
      ? r.bandTop + Math.min(modal!.caretRow, Math.max(0, panes.mainRows - 1))
      : composerCaretRow(r, composer.lines.length, composer.caretRow, paintRows);
    const caretCol = caretInModal
      ? modal!.caretCol
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
          // Rows a pointer can actually land on: the covered ones are behind
          // the composer, and naming a transcript row under them would map a
          // click to a line the user cannot see.
          bodyRows: Math.max(0, panes.mainRows - cover),
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
      // The rows follow the window once it has stopped moving. Every frame of
      // the drag re-clips the stored rows (above); the blocks that WRAP -- the
      // answers, their tables, the user's own messages -- are set down again
      // at the new measure when the drag has been quiet for a moment, through
      // the same amend path a streaming answer uses (tui.ts reflowTranscript).
      if (this.reflowTimer) clearTimeout(this.reflowTimer);
      this.reflowTimer = setTimeout(() => {
        this.reflowTimer = null;
        try {
          this.reflowTranscript();
        } catch {
          /* the rows keep their old width; the next resize tries again */
        }
      }, RESIZE_REFLOW_SETTLE_MS);
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
    // Nor the LAYOUT, past this one read: in `single` there is no right column
    // at any width, so the transcript is written at the window's own measure.
    if (uiLayout() === "split" && width >= PANEL_MIN_COLS) {
      return Math.max(8, usable - PANEL_COLS - 2);
    }
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
      // The window follows the SELECTION, not the tail.
      //
      // This used to keep the last `max` rows unconditionally, behind a "N more
      // lines above" marker — cropping the head, which is exactly where a
      // picker puts the row you are standing on. Since `single` became the
      // default at every width, every picker takes this path, and `/keys` at
      // 120×40 opened with no `›` anywhere on screen and none after the first
      // four presses of down: the selection was above the window and the window
      // never moved. The comment beside it was right about the hazard and
      // guarded the wrong end.
      //
      // The anchor is the row the block SAID it was standing on, the selection
      // marker where a picker drew one and said nothing, and the caret row
      // otherwise, which is what a composer overflowing its own field wants.
      // Either way the anchor stays on screen, and whichever side is cut says
      // how much it cut.
      //
      // The marker scan takes the LAST line carrying the glyph, not the first.
      // `›` is also the grammar's notice bullet: the held panel opens with
      // `› held for you`, and a window anchored on the first one it found
      // anchored on that title, never moved, and put 29 of 60 selections --
      // the last one included -- off the bottom of the screen (verifier pass
      // 3, finding 21). A decorative bullet leads a panel; the row you are
      // standing on is drawn after it. Blocks that know their own selection
      // say so in `anchorRow` and never reach this heuristic at all.
      const mark = glyph("selection", TERMINAL_GLYPH_MODE);
      const stated =
        typeof comp.anchorRow === "number" && comp.anchorRow >= 0 && comp.anchorRow < lines.length
          ? comp.anchorRow
          : -1;
      const selected = stated >= 0 ? stated : lines.findLastIndex((line) => line.includes(mark));
      const anchor = selected >= 0 ? selected : caretRow;
      const label = (n: number, where: "above" | "below") =>
        withThemeBg(
          this.bound(
            `  ${faint(
              `... ${n} more line${n === 1 ? "" : "s"} ${where}${
                where === "above" ? " (ctrl+r to expand)" : ""
              }`,
            )}`,
          ),
        );
      // The markers cost a row each, and how many there are depends on where
      // the window lands, which depends on how many rows are left for content.
      // Two passes settle it; the third is a guard, not a hope.
      let start = 0;
      let rows = max;
      for (let pass = 0; pass < 3; pass++) {
        start = Math.min(
          Math.max(0, anchor - Math.floor((rows - 1) / 2)),
          Math.max(0, lines.length - rows),
        );
        const next = max - (start > 0 ? 1 : 0) - (start + rows < lines.length ? 1 : 0);
        if (next === rows) break;
        rows = Math.max(1, next);
      }
      // Whatever the arithmetic decided, the anchor is on screen.
      if (anchor < start) start = anchor;
      if (anchor >= start + rows)
        start = Math.min(anchor - rows + 1, Math.max(0, lines.length - rows));
      const end = Math.min(lines.length, start + rows);
      const above = start;
      const below = lines.length - end;
      lines = [
        ...(above > 0 ? [label(above, "above")] : []),
        ...lines.slice(start, end),
        ...(below > 0 ? [label(below, "below")] : []),
      ].slice(0, max);
      caretRow = Math.min(
        Math.max(0, caretRow - start + (above > 0 ? 1 : 0)),
        Math.max(0, lines.length - 1),
      );
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
