// ─── Fixed-chrome viewport ───
// Three zones, and only one of them moves:
//
//   HEADER  the identity band, pinned to the top rows. Never scrolls.
//   BODY    the transcript. The ONLY scrolling region in the product.
//   FOOTER  the composer/status (or a panel), pinned to the bottom rows.
//           Never scrolls.
//
// This is what a terminal application looks like when its chrome is chrome. The
// previous layout committed the transcript into the terminal's own scrollback
// and pinned only the composer, which meant a wheel flick or a Page Up dragged
// the header, the field and the status bar off-screen together -- the whole
// window sliding as one sheet. Everything read as one undifferentiated column
// of text with no fixed frame around it.
//
// Owning the frame means owning the viewport, so this takes the alternate
// screen. That is a real trade and it is stated plainly in tui.ts's header: the
// terminal's native scrollback and momentum scrolling stop applying to the
// transcript, and Rune scrolls its own buffer instead: PgUp/PgDn, the arrows on
// an empty composer, and the wheel by way of alternate-scroll mode (below),
// which keeps the mouse uncaptured so selection stays the terminal's.
// `--inline` keeps the old layout for anyone who wants native scrollback back.
//
// Everything here is deliberately split into a PURE part (`composeFrame`,
// `zones`) and a tiny writing part (`Viewport`). The pure part is where every
// off-by-one that can garble a screen lives, so it is the part with tests.

type Writer = (s: string) => void;

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const WRAP_OFF = "\x1b[?7l";
const WRAP_ON = "\x1b[?7h";
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
/**
 * Alternate-scroll mode (DEC private 1007). On the alternate screen the
 * terminal has no scrollback of its own to move, so with this set it turns a
 * wheel notch or a trackpad flick into arrow keys instead -- three per notch on
 * most terminals, one per line on a trackpad. That is how the wheel reaches the
 * transcript WITHOUT the mouse being captured, so click-drag selection stays
 * the terminal's. Deliberately not reset on leave: most terminals default it
 * on, and a shell that finds it on afterwards only gains wheel-scroll in less
 * and vim. (Querying and restoring the prior state would need DECRQM; the
 * sticky-on side effect is benign, the sticky-off one is not.)
 */
const ALT_SCROLL_ON = "\x1b[?1007h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";
const RESET = "\x1b[0m";
const EL = "\x1b[0K"; // erase from cursor to end of line
const CLEAR_ALL = "\x1b[2J\x1b[H";
/**
 * Synchronized output (DEC private mode 2026). Between these two marks a
 * terminal that understands them holds the frame and presents it whole, so a
 * full-body rewrite -- a resize, a theme change, a scroll -- can never be seen
 * half-painted. Terminals that do not know the mode ignore it; that is the
 * whole reason it is safe to send unconditionally.
 */
export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/** Escapes a caller must send to leave the terminal exactly as it was found.
 *  Exported so the crash/`exit` hook can restore without holding a Viewport. */
export const VIEWPORT_RESTORE = MOUSE_OFF + WRAP_ON + SHOW + ALT_LEAVE;

/** The body may never be squeezed out of existence -- a scrolling region with no
 *  rows is a window with nothing in it. Chrome yields before content does. */
const MIN_BODY_ROWS = 1;

// ─── Four regions ───
//
// The three zones above are a column: header, body, footer. The workspace
// layout keeps that column and splits the middle of it in two, so the frame
// reads:
//
//   rows 1..3    HEADER     full width. never scrolls.
//   rows 4..R-1  BAND       WORKSPACE | divider | PANEL over COMPOSER
//   row  R       STATUS     full width. the gear/model/context strip.
//
// Only the workspace scrolls. The right column is a FIXED 40 cells: a card does
// not get better at 60, and a proportional column changes the workspace measure
// on every resize, which re-wraps the whole transcript under the user's hands.
//
// Everything in this section is arithmetic on two integers, which is exactly
// why it is here and not in the controller: the off-by-one that puts a divider
// through a diff is a unit test, not a screenshot.

/** Below either, the frame refuses rather than lying by truncation. */
export const MIN_COLS = 60;
export const MIN_ROWS = 16;
/**
 * The width at which the right column stops earning its cells.
 *
 * At 99 columns a 40-cell panel leaves the workspace 58, and a diff row loses
 * its right half -- so below this the column collapses to a one-line agents
 * strip above a full-width composer and `ctrl+f` opens the panel as an overlay.
 * One constant, so moving the threshold is one line and the pty capture at 99
 * and 100 columns is the test.
 */
export const PANEL_MIN_COLS = 100;
/** The right column, when there is one. Fixed, not proportional. */
export const PANEL_COLS = 40;
/** Cells between the divider and the panel's content, and again at the edge. */
export const PANEL_GUTTER = 1;
/** The composer at rest: a rule, the field, a rule, one hint row. */
export const COMPOSER_MIN_ROWS = 4;
/** The panel never yields past this, so a grown composer cannot erase it. */
export const PANEL_MIN_ROWS = 8;
/** Under this many workspace rows a split would be two unreadable slivers. */
export const SPLIT_MIN_ROWS = 14;

export interface Regions {
  /** True when the window is under MIN_COLS x MIN_ROWS. Nothing else is valid. */
  refused: boolean;
  /** Columns the frame may draw into: `columns - 1`. The last cell stays empty,
   *  because a line that touches it wraps and desyncs every row below. */
  usable: number;
  /** True below PANEL_MIN_COLS: no right column, a strip instead. */
  collapsed: boolean;
  /** 1-based column carrying the `|` divider; 0 when collapsed. */
  dividerCol: number;
  /** Cells the workspace may draw into, left of the divider. */
  workspaceCols: number;
  /** Cells the right column occupies, divider excluded; 0 when collapsed. */
  panelCols: number;
  /** Cells inside the right column, gutters excluded; 0 when collapsed. */
  panelContentCols: number;
  headerRows: number;
  /** 0-based screen row the band starts on. */
  bandTop: number;
  bandRows: number;
  /** 0-based screen row of the full-width status strip. */
  statusTop: number;
  /** Rows of the left column. The band's full height when there is a right
   *  column -- the composer takes its rows from the panel, never from here. */
  workspaceRows: number;
  /** The collapsed one-line agents strip, directly above the composer. */
  stripRows: number;
  /** Rows of the right column above the composer; 0 when collapsed. */
  panelRows: number;
  composerRows: number;
  /** 0-based screen row the composer block starts on. */
  composerTop: number;
}

export interface RegionInput {
  columns: number;
  rows: number;
  headerRows: number;
  /** Rows the composer would like. Clamped to [COMPOSER_MIN_ROWS, cap]. */
  composerRows?: number;
  /** Whether a collapsed layout should spend a row on the agents strip. */
  strip?: boolean;
}

/**
 * Split the window into four regions.
 *
 * Pure and total: every field is a number, and a caller that draws what this
 * says will never overhang an edge. The one judgement encoded here is the
 * yielding order -- the composer grows into the PANEL and never into the
 * workspace, because a transcript that re-lays itself while you type is the
 * thing that made the old footer feel like it was moving.
 */
export function regions(input: RegionInput): Regions {
  const columns = Math.max(1, Math.floor(input.columns));
  const rows = Math.max(1, Math.floor(input.rows));
  const usable = Math.max(1, columns - 1);
  const refused = columns < MIN_COLS || rows < MIN_ROWS;
  const collapsed = columns < PANEL_MIN_COLS;

  const headerRows = Math.min(Math.max(0, input.headerRows), Math.max(0, rows - 2));
  const statusRows = rows > headerRows ? 1 : 0;
  const bandRows = Math.max(1, rows - headerRows - statusRows);

  const stripRows = collapsed && input.strip ? 1 : 0;
  // The composer's ceiling: never more than three fifths of the band, and never
  // so much that the panel falls under its floor. Both clamps, and the lower of
  // the two wins -- at a 36-row band that is 21 rows, leaving the panel 15.
  const cap = Math.max(
    COMPOSER_MIN_ROWS,
    Math.min(bandRows - (collapsed ? stripRows + 1 : PANEL_MIN_ROWS), Math.floor(bandRows * 0.6)),
  );
  const composerRows = Math.max(
    COMPOSER_MIN_ROWS,
    Math.min(cap, Math.floor(input.composerRows ?? COMPOSER_MIN_ROWS)),
  );

  const dividerCol = collapsed ? 0 : usable - PANEL_COLS;
  const workspaceCols = collapsed ? usable : Math.max(1, dividerCol - 1);
  const panelCols = collapsed ? 0 : PANEL_COLS;
  const panelContentCols = collapsed ? 0 : Math.max(1, PANEL_COLS - PANEL_GUTTER * 2);

  const workspaceRows = collapsed ? Math.max(1, bandRows - stripRows - composerRows) : bandRows;
  const panelRows = collapsed ? 0 : Math.max(0, bandRows - composerRows);

  return {
    refused,
    usable,
    collapsed,
    dividerCol,
    workspaceCols,
    panelCols,
    panelContentCols,
    headerRows,
    bandTop: headerRows,
    bandRows,
    statusTop: rows - statusRows,
    workspaceRows,
    stripRows,
    panelRows,
    composerRows,
    composerTop: headerRows + bandRows - composerRows,
  };
}

export interface Panes {
  /** True while a child transcript is open beside the main pane. */
  open: boolean;
  /** True when a split was asked for and the workspace is too short for one. */
  refused: boolean;
  mainRows: number;
  /** The pane header naming the child. One row, or zero when closed. */
  headerRows: number;
  childRows: number;
}

/**
 * Split the workspace between the main transcript and one child's.
 *
 * Stacked, not side by side: at 120 columns the workspace is 78 cells and a
 * vertical cut gives each pane 39 -- under flow's own 40-column measure floor,
 * so every diff in both panes would be a lie by truncation.
 */
export function splitPanes(workspaceRows: number, open: boolean): Panes {
  const rows = Math.max(1, Math.floor(workspaceRows));
  if (!open) return { open: false, refused: false, mainRows: rows, headerRows: 0, childRows: 0 };
  if (rows < SPLIT_MIN_ROWS) {
    // One row saying why beats two slivers that can hold nothing.
    return {
      open: false,
      refused: true,
      mainRows: Math.max(1, rows - 1),
      headerRows: 1,
      childRows: 0,
    };
  }
  const mainRows = Math.max(3, Math.floor(rows * 0.4));
  return { open: true, refused: false, mainRows, headerRows: 1, childRows: rows - mainRows - 1 };
}

/**
 * What the frame says instead of drawing itself.
 *
 * At 44 columns a diff row is 38 cells wide after the rail, below flow's
 * 40-column floor, so every line of evidence on screen would be shortened
 * without saying so. Refusing is the honest answer, and it names both the size
 * needed and the way out.
 */
export function refusalRows(columns: number, rows: number): string[] {
  // The message must fit the window it is refusing to draw in -- a refusal that
  // overhangs is the exact bug it exists to avoid -- so both lines have a
  // ladder, in the order a reader needs them: the size, then the way out.
  const room = Math.max(8, columns - 4);
  const pick = (tiers: string[]): string =>
    tiers.find((t) => t.length <= room) ?? tiers[tiers.length - 1]!;
  const have = `${Math.max(0, columns)}x${Math.max(0, rows)}`;
  const need = `${MIN_COLS}x${MIN_ROWS}`;
  return [
    "R U N E",
    pick([
      `needs ${need}. this window is ${have}.`,
      `needs ${need}, this is ${have}.`,
      `needs ${need}.`,
    ]),
    pick([
      "resize, or run with --inline for the scrollback layout.",
      "resize, or run --inline.",
      "resize.",
    ]),
  ];
}

export interface BandInput {
  regions: Regions;
  /** Left column rows, already windowed by whoever owns the scroll. */
  left: string[];
  /** Right column rows, top-aligned. Empty when collapsed. */
  right: string[];
  /** The divider cell, painted by the caller. One cell wide. */
  divider: string;
  /** Visible width of a styled string. ANSI-aware; supplied by the caller so
   *  this file keeps no opinion about escape sequences. */
  width: (value: string) => number;
  /** Filler for rows neither column claims. */
  blank?: string;
}

/**
 * Join the two columns into one array of band rows.
 *
 * Rows are padded on the LEFT column only and never on the right: the painter
 * erases to end of line, so trailing spaces buy nothing and asserting them
 * would paint a background the terminal did not ask for.
 */
export function composeBand(band: BandInput): string[] {
  const r = band.regions;
  const blank = band.blank ?? "";
  const out: string[] = [];
  for (let i = 0; i < r.bandRows; i++) {
    const left = band.left[i] ?? "";
    if (r.collapsed) {
      out.push(left === "" ? blank : left);
      continue;
    }
    const right = band.right[i] ?? "";
    const pad = Math.max(0, r.workspaceCols - band.width(left));
    const row = `${left}${" ".repeat(pad)}${band.divider}${right}`;
    out.push(row);
  }
  return out;
}

export interface Zones {
  headerRows: number;
  bodyRows: number;
  footerRows: number;
  /** 0-based screen row the body starts on. */
  bodyTop: number;
  /** 0-based screen row the footer starts on. */
  footerTop: number;
}

/**
 * Split `rows` between the three zones.
 *
 * Priority under pressure is footer > body > header, and it is not arbitrary:
 * the footer is where the user is typing (take it away and the program is
 * unusable), the body is the work, and the header is the only zone whose whole
 * content is also obtainable by other means. So a window too short for all
 * three loses header rows first, and a window too short even for the footer
 * gives the footer everything but one row.
 */
export function zones(rows: number, header: number, footer: number): Zones {
  const total = Math.max(1, rows);
  const wantFooter = Math.max(0, footer);
  const wantHeader = Math.max(0, header);
  // The footer never takes the last row it would need to leave for the body.
  const footerRows = Math.min(wantFooter, Math.max(0, total - MIN_BODY_ROWS));
  const remaining = total - footerRows;
  const headerRows = Math.min(wantHeader, Math.max(0, remaining - MIN_BODY_ROWS));
  const bodyRows = remaining - headerRows;
  return {
    headerRows,
    bodyRows,
    footerRows,
    bodyTop: headerRows,
    footerTop: headerRows + bodyRows,
  };
}

/**
 * Hold a block at its high-water height.
 *
 * A footer block whose height follows its content re-splits the frame every
 * time the content changes shape, and every re-split moves the body. Padding
 * the block up to the tallest it has been (within `budget`) makes it grow a
 * few times and then stand still. Pure, so the invariant -- never shorter
 * than the high-water mark, never taller than the budget -- is testable.
 */
export function holdHeight(
  lines: string[],
  highWater: number,
  budget: number,
  blank = "",
): { rows: string[]; highWater: number } {
  const cap = Math.max(1, budget);
  const rows = lines.slice(0, cap);
  const next = Math.min(cap, Math.max(highWater, rows.length));
  while (rows.length < next) rows.push(blank);
  return { rows, highWater: next };
}

export interface FrameInput {
  rows: number;
  /** Full header block; trimmed from the BOTTOM if the window cannot hold it,
   *  so the identity rule at the top survives a short window. */
  header: string[];
  /** The whole transcript. The frame windows it; the caller does not. */
  transcript: string[];
  /** Full footer block; trimmed from the TOP if it does not fit, so the input
   *  row and status line -- the tail -- are the parts that survive. */
  footer: string[];
  /** Lines scrolled up from the live tail. 0 = following the newest output. */
  scroll: number;
  /** Caret position within the footer block, before any trimming. */
  caretRow: number;
  caretCol: number;
  /** Filler for rows no zone claims. Themed by the caller. */
  blank?: string;
  /** Row drawn at the top of the body while scrolled up. Costs a body row, and
   *  only while it is earned. */
  scrolledMarker?: (hidden: number) => string;
  /** Applied to the body lines that made the window -- and only those. The
   *  transcript can hold thousands of lines; theming all of them once per frame
   *  to show forty is the kind of waste that shows up as stream jitter. */
  themeBody?: (line: string) => string;
  /**
   * The workspace layout's middle: two columns instead of one.
   *
   * When this is present the body is the joined band and `transcript`,
   * `scroll`, `scrolledMarker` and `themeBody` are not consulted -- whoever
   * owns a column owns its scroll, which is the whole point of per-region
   * offsets. The header and status strip above and below are unchanged, so the
   * three-zone path and the four-region path are the same function.
   */
  band?: Omit<BandInput, "blank">;
}

export interface Frame {
  /** Exactly `rows` entries: the whole screen, top to bottom. */
  rows: string[];
  /** `scroll` after clamping to what the transcript can actually offer. */
  scroll: number;
  /** Transcript lines above the visible window. */
  hiddenAbove: number;
  /** Absolute 0-based caret cell. */
  caretRow: number;
  caretCol: number;
  zones: Zones;
}

/**
 * Build one whole screen.
 *
 * Pure, total, and the only place that decides what occupies a given row. Every
 * "the footer jumped", "the header slid up", "the last line is cut off" class of
 * bug is a bug in this function, which is why it takes plain arrays and returns
 * a plain array instead of touching a terminal.
 */
export function composeFrame(input: FrameInput): Frame {
  const blank = input.blank ?? "";
  const total = Math.max(1, input.rows);
  const z = zones(total, input.header.length, input.footer.length);

  // Header: keep the top. A trimmed header loses its closing rule, not its name.
  const header = input.header.slice(0, z.headerRows);

  // Footer: keep the tail. A trimmed footer loses the preview above the field,
  // never the field itself -- and the caret moves up by exactly what was cut.
  const footerDrop = Math.max(0, input.footer.length - z.footerRows);
  const footer = input.footer.slice(footerDrop);
  const caretRow = z.footerTop + Math.max(0, input.caretRow - footerDrop);

  // Four regions: the band is already windowed and already two columns wide,
  // and the caret is ABSOLUTE -- the composer sits inside the band, not in the
  // footer, so there is no trimming for it to be measured against.
  if (input.band) {
    const band = composeBand({ ...input.band, blank });
    const body = band.slice(0, z.bodyRows);
    while (body.length < z.bodyRows) body.push(blank);
    const rows = [...header, ...body, ...footer];
    while (rows.length < total) rows.push(blank);
    return {
      rows: rows.slice(0, total),
      scroll: 0,
      hiddenAbove: 0,
      caretRow: Math.max(0, Math.min(total - 1, input.caretRow)),
      caretCol: Math.max(0, input.caretCol),
      zones: z,
    };
  }

  // Body: the tail of the transcript, offset by the clamped scroll. A marker
  // row is spent only while scrolled up, so following the tail never pays for it.
  const maxScroll = Math.max(0, input.transcript.length - z.bodyRows);
  const scroll = Math.max(0, Math.min(input.scroll, maxScroll));
  const marked = scroll > 0 && input.scrolledMarker != null && z.bodyRows > 1;
  const contentRows = marked ? z.bodyRows - 1 : z.bodyRows;
  const end = Math.max(0, input.transcript.length - scroll);
  const start = Math.max(0, end - contentRows);
  const raw = input.transcript.slice(start, end);
  const window = input.themeBody ? raw.map(input.themeBody) : raw;
  const hiddenAbove = start;

  const body: string[] = [];
  if (marked) body.push(input.scrolledMarker!(hiddenAbove));
  body.push(...window);
  // Short transcript: content sits under the header and blank rows fall to the
  // bottom of the body. Reading downward from the header is the natural
  // direction; a half-empty window that pushes three lines onto the footer is not.
  while (body.length < z.bodyRows) body.push(blank);

  const rows = [...header, ...body.slice(0, z.bodyRows), ...footer];
  while (rows.length < total) rows.push(blank);

  return {
    rows: rows.slice(0, total),
    scroll,
    hiddenAbove,
    caretRow: Math.max(0, Math.min(total - 1, caretRow)),
    caretCol: Math.max(0, input.caretCol),
    zones: z,
  };
}

/**
 * The writing half: enter/leave the alternate screen and paint a Frame onto it.
 *
 * Rows are addressed absolutely and diffed against the last frame, so a
 * streaming turn rewrites the two or three rows that actually changed rather
 * than the window. That is what keeps a pinned header from flickering while
 * tokens land underneath it.
 */
export class Viewport {
  private write: Writer;
  private prev: string[] = [];
  private active = false;
  private caret: { row: number; col: number; shown: boolean } | null = null;

  constructor(write: Writer = (s) => process.stdout.write(s)) {
    this.write = write;
  }

  get mounted(): boolean {
    return this.active;
  }

  /** Take the alternate screen. The user's shell scrollback is untouched and
   *  comes back exactly as it was on `leave()` -- which is the one thing the
   *  alternate screen is unambiguously good at. */
  enter(): void {
    if (this.active) return;
    // Autowrap off: a line one cell too wide would otherwise wrap, push every
    // row below it down by one, and desync the diff for the rest of the session.
    this.write(ALT_ENTER + WRAP_OFF + HIDE + CLEAR_ALL + ALT_SCROLL_ON);
    this.active = true;
    this.prev = [];
    this.caret = null;
  }

  /** Start reporting the wheel. Only meaningful on the alternate screen: it is
   *  the terminal's scroll gesture, and here it has to drive ours instead. */
  captureMouse(): void {
    this.write(MOUSE_ON);
  }

  /** Everything `enter()` and `captureMouse()` turned on, turned off. Safe to
   *  call twice and safe to call having never entered. */
  leave(): void {
    if (!this.active) {
      this.write(MOUSE_OFF);
      return;
    }
    this.write(VIEWPORT_RESTORE);
    this.active = false;
    this.prev = [];
    this.caret = null;
  }

  /** Forget what is on screen, so the next paint writes every row. For a
   *  resize, a SIGCONT, or anything else that wrote to our screen behind us.
   *
   *  Deliberately does NOT clear the screen: forgetting `prev` already makes
   *  the next frame rewrite every row, and each row ends in an erase-to-end,
   *  so a clear would only add a blank frame between the old picture and the
   *  new one -- which, on a window drag, is the flash the user sees at every
   *  resize step. */
  invalidate(): void {
    this.prev = [];
    this.caret = null;
  }

  /**
   * Paint a frame, writing only the rows whose content changed.
   *
   * `showCaret` is false while the surface paints its own caret cell: two
   * carets on one row is worse than either alone. The hardware cursor is still
   * PLACED either way, so anything reading the terminal's idea of where input
   * goes still gets the right answer.
   */
  render(frame: Frame, showCaret = true): void {
    if (!this.active) return;
    let out = "";
    for (let i = 0; i < frame.rows.length; i++) {
      const line = frame.rows[i]!;
      if (this.prev[i] === line) continue;
      // Reset before AND after: leading reset stops the previous row's colour
      // leaking into this one, trailing reset makes the erase-to-end use the
      // terminal's own background rather than whatever the line ended in.
      out += `\x1b[${i + 1};1H${RESET}${line}${RESET}${EL}`;
      this.prev[i] = line;
    }
    if (this.prev.length > frame.rows.length) this.prev.length = frame.rows.length;

    const caretMoved =
      !this.caret ||
      this.caret.row !== frame.caretRow ||
      this.caret.col !== frame.caretCol ||
      this.caret.shown !== showCaret;
    if (out !== "" || caretMoved) {
      out += `\x1b[${frame.caretRow + 1};${frame.caretCol + 1}H`;
      if (showCaret) out += SHOW;
      this.caret = { row: frame.caretRow, col: frame.caretCol, shown: showCaret };
      // One write, one frame: hidden cursor, every changed row, the caret,
      // all inside a synchronized-output bracket.
      this.write(SYNC_BEGIN + HIDE + out + SYNC_END);
    }
  }
}
