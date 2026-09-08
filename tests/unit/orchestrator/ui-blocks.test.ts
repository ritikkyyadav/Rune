// The block ledger is the splice arithmetic under amend-in-place: a call's
// provisional row finishing, a burst folding into a chamber, prose growing as
// it streams. Exercised against a real array, the way the viewport applies it,
// with the fold ledger alongside, because the two share one coordinate system.

import { describe, expect, it } from "bun:test";
import { BlockLedger } from "../../../packages/orchestrator/src/bin/ui/blocks";
import { FoldLedger } from "../../../packages/orchestrator/src/bin/ui/folds";

function amend(buffer: string[], ledger: BlockLedger, handle: number, rows: string[]) {
  const region = ledger.get(handle)!;
  buffer.splice(region.start, region.rows, ...rows);
  return ledger.replace(handle, rows.length)!;
}

describe("BlockLedger", () => {
  it("replaces a block in place and moves every block below it", () => {
    const buffer = ["a"];
    const ledger = new BlockLedger();
    const h1 = ledger.register(1, 1);
    buffer.push("row1");
    const h2 = ledger.register(2, 1);
    buffer.push("row2");

    const splice = amend(buffer, ledger, h1, ["row1", "diff+", "diff-"]);
    expect(splice).toEqual({ start: 1, remove: 1, delta: 2 });
    expect(buffer).toEqual(["a", "row1", "diff+", "diff-", "row2"]);
    expect(ledger.get(h2)).toMatchObject({ start: 4, rows: 1 });
  });

  it("an empty replacement removes the block and forgets its handle", () => {
    const buffer = ["r1", "r2", "r3"];
    const ledger = new BlockLedger();
    const h1 = ledger.register(0, 1);
    const h2 = ledger.register(1, 1);
    const h3 = ledger.register(2, 1);
    amend(buffer, ledger, h2, []);
    expect(buffer).toEqual(["r1", "r3"]);
    expect(ledger.get(h2)).toBeUndefined();
    expect(ledger.get(h1)).toMatchObject({ start: 0 });
    expect(ledger.get(h3)).toMatchObject({ start: 1 });
    expect(ledger.replace(h2, 3)).toBeNull();
  });

  it("a fold opening inside a block grows that block and shifts the rest", () => {
    const ledger = new BlockLedger();
    const h1 = ledger.register(0, 2); // rows 0-1, a chamber with a fold
    const h2 = ledger.register(2, 1);
    ledger.noteSplice(0, 4); // the chamber opened: +4 rows at its head
    expect(ledger.get(h1)).toMatchObject({ start: 0, rows: 6 });
    expect(ledger.get(h2)).toMatchObject({ start: 6, rows: 1 });
    ledger.noteSplice(0, -4);
    expect(ledger.get(h1)).toMatchObject({ start: 0, rows: 2 });
    expect(ledger.get(h2)).toMatchObject({ start: 2 });
  });

  it("a head trim shifts blocks and forgets the ones it cut into", () => {
    const ledger = new BlockLedger();
    const h1 = ledger.register(0, 3);
    const h2 = ledger.register(3, 2);
    ledger.noteTrim(2);
    expect(ledger.get(h1)).toBeUndefined();
    expect(ledger.get(h2)).toMatchObject({ start: 1, rows: 2 });
  });
});

describe("FoldLedger.replaceRange", () => {
  it("forgets folds inside an amended range and shifts the ones below", () => {
    const folds = new FoldLedger();
    folds.register(0, ["h1"], ["h1", "d"]);
    folds.register(3, ["h2"], ["h2", "e"]);
    // Rows 0-1 replaced by 4 rows.
    folds.replaceRange(0, 2, 4);
    expect(folds.at(0)).toBeUndefined();
    expect(folds.at(5)).toMatchObject({ start: 5 });
    expect(folds.size).toBe(1);
  });
});
