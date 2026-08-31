// --- Folds: in-place expansion for the fixed viewport ---
// A committed block that holds more than it shows -- a chamber, a clipped
// command print-out, the rest of a long diff -- registers here with both of its
// forms. The viewport owns its transcript buffer outright (the alt screen's one
// honest advantage), so opening a fold is a splice: the closed rows come out,
// the open rows go in, and everything below simply moves. Nothing is redrawn
// that did not change, nothing is appended twice, and closing it restores the
// exact rows that were there.
//
// Pure bookkeeping. The ledger tracks positions in the CALLER's buffer
// coordinates and answers with splice instructions; it never touches a
// terminal, which is what makes every off-by-one in here testable.

export interface FoldRegion {
  id: number;
  /** First row of the region in the current buffer. */
  start: number;
  /** Rows the region occupies right now (closed or open form). */
  rows: number;
  closed: string[];
  opened: string[];
  open: boolean;
}

export interface FoldSplice {
  start: number;
  remove: number;
  insert: string[];
  /** Rows gained (positive on open, negative on close). */
  delta: number;
}

export class FoldLedger {
  private regions: FoldRegion[] = [];
  private seq = 0;

  /** Register a block just pushed at `start`, with its two forms. */
  register(start: number, closed: string[], opened: string[]): void {
    if (closed.length === 0 || opened.length === 0) return;
    this.regions.push({
      id: ++this.seq,
      start,
      rows: closed.length,
      closed,
      opened,
      open: false,
    });
  }

  /** The buffer dropped `count` rows from its head. Regions shift; a region
   *  the trim cut into is forgotten -- its rows are gone, restoring them from
   *  a ledger would invent scrollback. */
  noteTrim(count: number): void {
    if (count <= 0) return;
    this.regions = this.regions
      .map((region) => ({ ...region, start: region.start - count }))
      .filter((region) => region.start >= 0);
  }

  clear(): void {
    this.regions = [];
  }

  /** The region that owns buffer row `index`, if any. */
  at(index: number): FoldRegion | undefined {
    return this.regions.find(
      (region) => index >= region.start && index < region.start + region.rows,
    );
  }

  /** The most recently committed region -- what ctrl+o answers for. */
  newest(): FoldRegion | undefined {
    return this.regions.at(-1);
  }

  get size(): number {
    return this.regions.length;
  }

  /**
   * Toggle a region. Returns the splice the caller must apply to its buffer;
   * the ledger has already moved every region below by the delta, so ledger
   * and buffer stay one coordinate system.
   */
  toggle(region: FoldRegion): FoldSplice {
    const insert = region.open ? region.closed : region.opened;
    const splice: FoldSplice = {
      start: region.start,
      remove: region.rows,
      insert,
      delta: insert.length - region.rows,
    };
    region.open = !region.open;
    region.rows = insert.length;
    for (const other of this.regions) {
      if (other !== region && other.start > region.start) other.start += splice.delta;
    }
    return splice;
  }
}
