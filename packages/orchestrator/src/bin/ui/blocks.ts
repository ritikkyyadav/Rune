// --- Blocks: the identity of a committed block, for amending it in place ---
// The fixed viewport owns its transcript buffer outright, which is what lets a
// row be REPLACED after it was set down: a call's provisional row becomes its
// finished row, three consecutive gathering rows become one chamber row, the
// model's prose grows as it streams. Each of those is a splice at a position
// the ledger tracks, in the caller's buffer coordinates, and every other block
// below simply moves -- the same arithmetic the fold ledger does for its
// regions, kept in one place so the two cannot disagree about where a row is.
//
// Pure bookkeeping, like ./folds: it never touches a terminal, so every
// off-by-one in here is testable against a plain array.

export type BlockHandle = number;

export interface BlockRegion {
  handle: BlockHandle;
  /** First row of the block in the current buffer. */
  start: number;
  /** Rows the block occupies right now. */
  rows: number;
}

export interface BlockSplice {
  start: number;
  remove: number;
  /** Rows gained (positive when the block grew). */
  delta: number;
}

export class BlockLedger {
  private blocks: BlockRegion[] = [];
  private seq = 0;

  /** Register a block just pushed at `start`, `rows` tall. */
  register(start: number, rows: number): BlockHandle {
    const handle = ++this.seq;
    if (rows > 0) this.blocks.push({ handle, start, rows });
    return handle;
  }

  get(handle: BlockHandle): BlockRegion | undefined {
    return this.blocks.find((b) => b.handle === handle);
  }

  get size(): number {
    return this.blocks.length;
  }

  /**
   * The block now occupies `rows` rows (zero removes it). Returns the splice
   * the caller must apply to its buffer; every later block has already moved
   * by the delta, so ledger and buffer stay one coordinate system.
   */
  replace(handle: BlockHandle, rows: number): BlockSplice | null {
    const block = this.get(handle);
    if (!block) return null;
    const splice: BlockSplice = {
      start: block.start,
      remove: block.rows,
      delta: rows - block.rows,
    };
    for (const other of this.blocks) {
      if (other !== block && other.start > block.start) other.start += splice.delta;
    }
    block.rows = rows;
    if (rows === 0) this.blocks = this.blocks.filter((b) => b !== block);
    return splice;
  }

  /**
   * Something else spliced the buffer at `start` by `delta` rows -- a fold
   * opening or closing. The block that owns that row grows or shrinks with
   * it; the blocks below move.
   */
  noteSplice(start: number, delta: number): void {
    if (delta === 0) return;
    for (const block of this.blocks) {
      if (start >= block.start && start < block.start + block.rows) block.rows += delta;
      else if (block.start > start) block.start += delta;
    }
    this.blocks = this.blocks.filter((b) => b.rows > 0);
  }

  /** The buffer dropped `count` rows from its head. A block the trim cut
   *  into is forgotten: its rows are gone. */
  noteTrim(count: number): void {
    if (count <= 0) return;
    this.blocks = this.blocks
      .map((block) => ({ ...block, start: block.start - count }))
      .filter((block) => block.start >= 0);
  }

  clear(): void {
    this.blocks = [];
  }
}
