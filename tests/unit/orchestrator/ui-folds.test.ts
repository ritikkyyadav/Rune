// The fold ledger is pure splice arithmetic, and splice arithmetic is where
// every "the transcript ate itself" bug would live -- so the buffer maths is
// exercised here against a real array, the way the viewport applies it.

import { describe, expect, it } from "bun:test";
import { FoldLedger } from "../../../packages/orchestrator/src/bin/ui/folds";

function apply(buffer: string[], splice: { start: number; remove: number; insert: string[] }) {
  buffer.splice(splice.start, splice.remove, ...splice.insert);
}

describe("FoldLedger", () => {
  it("opens in place and closes back to the exact rows", () => {
    const buffer = ["a", "head", "b"];
    const ledger = new FoldLedger();
    ledger.register(1, ["head"], ["head", "one", "two"]);

    const region = ledger.at(1)!;
    apply(buffer, ledger.toggle(region));
    expect(buffer).toEqual(["a", "head", "one", "two", "b"]);
    expect(region.open).toBe(true);
    // Every row of the open form still answers to the region.
    expect(ledger.at(3)).toBe(region);

    apply(buffer, ledger.toggle(region));
    expect(buffer).toEqual(["a", "head", "b"]);
    expect(region.open).toBe(false);
  });

  it("shifts later regions when an earlier one changes size", () => {
    const buffer = ["h1", "x", "h2"];
    const ledger = new FoldLedger();
    ledger.register(0, ["h1"], ["h1", "d1", "d2"]);
    ledger.register(2, ["h2"], ["h2", "e1"]);

    apply(buffer, ledger.toggle(ledger.at(0)!));
    // The second region moved with its rows: toggling it must still hit h2.
    const second = ledger.at(4)!;
    apply(buffer, ledger.toggle(second));
    expect(buffer).toEqual(["h1", "d1", "d2", "x", "h2", "e1"]);
  });

  it("survives a head trim: shifted regions keep working, cut ones are forgotten", () => {
    const buffer = ["h1", "x", "h2"];
    const ledger = new FoldLedger();
    ledger.register(0, ["h1"], ["h1", "d1"]);
    ledger.register(2, ["h2"], ["h2", "e1"]);

    buffer.splice(0, 2); // the buffer dropped h1 and x
    ledger.noteTrim(2);
    expect(ledger.at(0)?.closed).toEqual(["h2"]);
    expect(ledger.size).toBe(1);
    apply(buffer, ledger.toggle(ledger.at(0)!));
    expect(buffer).toEqual(["h2", "e1"]);
  });

  it("answers ctrl+o with the newest region", () => {
    const ledger = new FoldLedger();
    ledger.register(0, ["a"], ["a", "1"]);
    ledger.register(5, ["b"], ["b", "2"]);
    expect(ledger.newest()?.closed).toEqual(["b"]);
  });

  it("registers nothing for an empty form", () => {
    const ledger = new FoldLedger();
    ledger.register(0, [], ["x"]);
    ledger.register(0, ["x"], []);
    expect(ledger.size).toBe(0);
  });
});
