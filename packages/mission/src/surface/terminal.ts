// ─── Gear · the writer ───
// Never own the screen. Own the last N rows.
//
// A TUI that takes the alternate screen buffer has signed up to be correct about every
// cell forever — through resize, tmux reattach, an ssh link that drops for nine
// seconds, a scroll wheel, ⌘F. Almost none are. They corrupt, they leave debris, they
// take your scrollback with them when they exit, and they cannot be piped anywhere.
//
// So the terminal is split in two:
//
//   COMMITTED  everything above the cursor. written once, followed by "\n", never
//              touched again. ordinary scrollback — selectable, greppable, tee-able.
//   LIVE       a handful of rows at the very bottom. redrawn each frame, erased with
//              RELATIVE cursor moves only. when a live block reaches its final state
//              it is committed, and the live region shrinks.
//
// The whole escape vocabulary is five items, and they are all here. There is no
// absolute addressing (`ESC[H`), no full-screen clear (`ESC[2J`) and no alternate
// screen (`?1049`) anywhere in this package — absolute positioning is the single
// largest source of TUI rot, because it assumes the terminal's idea of where the
// cursor is matches yours, and under resize or a dropped frame it does not.
//
// Because history is immutable there are no history bugs. Because the live region is a
// handful of rows, the cursor arithmetic is small enough to be provably right — and it
// is proved: the interactive escape stream, replayed through a terminal emulator,
// equals the piped transcript byte for byte.

import { type Caps } from "../render/caps";
import { type Screen, paintRow } from "../render/ansi";
import { type Row } from "../render/row";

const UP = "\x1b[1A";
const ERASE_LINE = "\x1b[2K";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
/** Synchronised output: one atomic frame, no tearing mid-repaint. */
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

export interface Sink {
  write(chunk: string): void;
  isTTY: boolean;
}

export const stdoutSink = (): Sink => ({
  write: (chunk) => process.stdout.write(chunk),
  isTTY: Boolean(process.stdout.isTTY),
});

/** Collects everything written, for the tests that compare the two transcripts. */
export class MemorySink implements Sink {
  chunks: string[] = [];
  constructor(public isTTY = true) {}
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  get text(): string {
    return this.chunks.join("");
  }
}

export class Surface {
  /** how many rows the live region currently occupies on screen */
  private liveCount = 0;
  /** the last live frame, as a whole string — so an unchanged frame writes nothing */
  private lastFrame = "";
  private pending: Row[] = [];
  private cursorHidden = false;

  constructor(
    private readonly sink: Sink,
    private readonly caps: Caps,
    private readonly screen: Screen,
  ) {}

  /**
   * The NO_TTY rung. Piped, redirected, or in CI: no ANSI and no live region — every
   * block commits its **final** state only. This is the rung that makes the logs
   * readable in 2050.
   */
  private get interactive(): boolean {
    return this.sink.isTTY && this.caps.colour !== "none";
  }

  private render(rows: Array<Row | null>): string[] {
    return rows.map((r) =>
      r === null
        ? ""
        : this.interactive
          ? paintRow(r, this.caps, this.screen)
          : plain(r, this.caps, this.screen),
    );
  }

  /** Write rows into scrollback. Once written they are never touched again. */
  commit(rows: Array<Row | null>): void {
    if (!rows.length) return;
    const lines = this.render(rows);
    if (!this.interactive) {
      this.sink.write(lines.join("\n") + "\n");
      return;
    }
    const live = this.lastFrame;
    let out = SYNC_ON + this.eraseLive();
    out += lines.join("\n") + "\n";
    // The live region always sits below the committed text, so it is repainted after.
    out += this.paintLive(live ? live.split("\n") : []);
    this.sink.write(out + SYNC_OFF);
  }

  /**
   * Redraw the bottom rows. Nothing is written when the frame is byte-identical to the
   * one already on screen, which is what keeps a steady mission from flickering.
   */
  live(rows: Array<Row | null>): void {
    if (!this.interactive) {
      // Nothing to redraw on a pipe: the final state commits when it settles.
      this.pending = rows.filter((r): r is Row => r !== null);
      return;
    }
    const frame = this.render(rows).join("\n");
    if (frame === this.lastFrame) return;
    if (!this.cursorHidden) {
      this.sink.write(HIDE);
      this.cursorHidden = true;
    }
    this.sink.write(
      SYNC_ON + this.eraseLive() + this.paintLive(frame ? frame.split("\n") : []) + SYNC_OFF,
    );
    this.lastFrame = frame;
  }

  /**
   * A live block reached its final state: promote it into scrollback and shrink the
   * live region. On a pipe this is the *only* moment anything is written.
   */
  settle(rows?: Array<Row | null>): void {
    // `settle(rows)` commits exactly those rows — including none of them, which is how
    // the ledger leaves the screen without being frozen into scrollback. `settle()`
    // with no argument promotes whatever is live. The two must not be conflated: an
    // empty array is an instruction, not a missing value.
    const explicit = rows !== undefined;
    const pending = this.pending;
    this.pending = [];

    if (!this.interactive) {
      const final = explicit ? rows! : pending;
      if (final.length) this.sink.write(this.render(final).join("\n") + "\n");
      return;
    }

    const keep = this.lastFrame;
    this.lastFrame = "";
    let out = SYNC_ON + this.eraseLive();
    const lines = explicit ? this.render(rows!) : keep ? keep.split("\n") : [];
    if (lines.length) out += lines.join("\n") + "\n";
    this.sink.write(out + SYNC_OFF);
  }

  /** Relative moves only: up one, clear that line, repeat. Cursor lands where it started. */
  private eraseLive(): string {
    let out = "";
    for (let i = 0; i < this.liveCount; i++) out += UP + ERASE_LINE;
    this.liveCount = 0;
    return out + "\r";
  }

  private paintLive(lines: string[]): string {
    let out = "";
    for (const l of lines) out += ERASE_LINE + l + "\n";
    this.liveCount = lines.length;
    return out;
  }

  /** Give the terminal back exactly as it was found. */
  close(): void {
    if (!this.interactive) return;
    this.sink.write(this.eraseLive() + (this.cursorHidden ? SHOW : ""));
    this.cursorHidden = false;
    this.lastFrame = "";
  }
}

/** A row with every rung at its floor: no SGR at all. What `| cat` gets. */
function plain(row: Row, caps: Caps, screen: Screen): string {
  return paintRow(row, { ...caps, colour: "none", tint: false }, screen);
}

// ─── prose ───
// Model output arrives in ragged bursts. The screen must not.

export interface ProseOptions {
  /** hold bytes until whitespace or this long, so text arrives at a readable rate */
  flushAfterMs?: number;
}

/**
 * Renders only on word boundaries, and never commits partial text — freeze half a
 * paragraph into scrollback, let the user resize, and it is wrapped at the old width
 * forever. A line is committed the instant it can no longer change, which is when a
 * later word has pushed past it.
 */
export class Prose {
  private buffer = "";
  private held = "";
  private lastFlush: number;

  constructor(
    private readonly opts: ProseOptions = {},
    now = 0,
  ) {
    this.lastFlush = now;
  }

  /** Feed model output. Returns the text that is safe to show, or "" to hold. */
  push(chunk: string, now: number): string {
    this.held += chunk;
    const boundary = Math.max(this.held.lastIndexOf(" "), this.held.lastIndexOf("\n"));
    const stale = now - this.lastFlush >= (this.opts.flushAfterMs ?? 40);
    if (boundary < 0 && !stale) return "";
    const cut = boundary >= 0 ? boundary + 1 : this.held.length;
    const out = this.held.slice(0, cut);
    this.held = this.held.slice(cut);
    this.buffer += out;
    this.lastFlush = now;
    return out;
  }

  /** End of turn: whatever is left can no longer change. */
  flush(): string {
    const out = this.held;
    this.held = "";
    this.buffer += out;
    return out;
  }

  get text(): string {
    return this.buffer + this.held;
  }
}
