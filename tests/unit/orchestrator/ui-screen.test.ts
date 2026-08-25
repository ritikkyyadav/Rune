import { describe, it, expect } from "bun:test";
import { AltScreen, BottomRegion } from "../../../packages/orchestrator/src/bin/ui/screen";

// Control sequences the renderer emits (kept in sync with screen.ts).
const HOME = "\x1b[H";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** AltScreen wired to a capturing writer so we can assert exactly what gets sent to the terminal. */
function harness() {
  const writes: string[] = [];
  const screen = new AltScreen((s) => writes.push(s));
  screen.enter();
  writes.length = 0; // drop the enter() sequence; we only care about frame() output
  return {
    screen,
    /** The most recent frame write. */
    last: () => writes[writes.length - 1] ?? "",
    writes,
  };
}

describe("ui/AltScreen differential renderer", () => {
  it("paints the first frame in full (HOME + every row)", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("c");
    expect(out).toContain(SYNC_BEGIN);
    expect(out).toContain(SYNC_END);
  });

  it("rewrites only the rows that changed on the next frame", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0); // baseline
    h.screen.frame(["a", "X", "c"], 0, 0); // only row 2 (index 1) changed
    const out = h.last();
    // Row 2 is rewritten in place via absolute addressing…
    expect(out).toContain("\x1b[2;1HX");
    // …and the unchanged rows are NOT repainted, nor is the screen homed.
    expect(out).not.toContain(HOME);
    expect(out).not.toContain("a");
    expect(out).not.toContain("c");
    // Still wrapped in a synchronized update.
    expect(out).toContain(SYNC_BEGIN);
    expect(out).toContain(SYNC_END);
  });

  it("moves the cursor without repainting any row when only the caret changes", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    h.screen.frame(["a", "b", "c"], 1, 2); // identical rows, caret moved
    const out = h.last();
    expect(out).toContain("\x1b[2;3H"); // caret placed at row 2, col 3 (1-based)
    expect(out).not.toContain(HOME);
    expect(out).not.toContain("\x1b[1;1Ha"); // no row rewrites
  });

  it("forces a full repaint when the row count changes", () => {
    const h = harness();
    h.screen.frame(["a", "b", "c"], 0, 0);
    h.screen.frame(["a", "b", "c", "d"], 0, 0); // 3 → 4 rows
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("d");
    expect(out).toContain("a"); // full repaint re-emits every row
  });

  it("forces a full repaint after invalidate(), even with identical rows", () => {
    const h = harness();
    h.screen.frame(["a", "b"], 0, 0);
    h.screen.invalidate();
    h.screen.frame(["a", "b"], 0, 0);
    const out = h.last();
    expect(out).toContain(HOME);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("emits nothing once exited", () => {
    const h = harness();
    h.screen.exit();
    h.writes.length = 0;
    h.screen.frame(["a", "b"], 0, 0);
    expect(h.writes.length).toBe(0);
  });

  it("hardware-scrolls the band (and paints only the exposed line) on a downward shift", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0); // baseline (band = rows 1..4)
    // A new line entered at the top: content shifts DOWN by 1 → delta = +1.
    h.screen.frame(["HDR", "NEW", "a1", "a2", "a3", "CMP"], 0, 0, { top: 1, bottom: 4, delta: 1 });
    const out = h.last();
    expect(out).toContain("\x1b[2;5r"); // DECSTBM scroll region = band (rows 2..5, 1-based)
    expect(out).toContain("\x1b[1T"); // SD: scroll the region down by 1
    expect(out).toContain("\x1b[r"); // reset the scroll region
    expect(out).toContain("\x1b[2;1HNEW"); // only the freshly exposed top line is painted
    expect(out).not.toContain("a1"); // shifted lines are NOT repainted (the terminal moved them)
    expect(out).not.toContain("CMP"); // composer/banner untouched
  });

  it("hardware-scrolls the band on an upward shift (streaming / scroll toward newer)", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0);
    // A new line entered at the bottom: content shifts UP by 1 → delta = -1.
    h.screen.frame(["HDR", "a2", "a3", "a4", "NEW", "CMP"], 0, 0, { top: 1, bottom: 4, delta: -1 });
    const out = h.last();
    expect(out).toContain("\x1b[2;5r");
    expect(out).toContain("\x1b[1S"); // SU: scroll the region up by 1
    expect(out).toContain("\x1b[5;1HNEW"); // only the exposed bottom line is painted
    expect(out).not.toContain("a2");
  });

  it("falls back to a per-row diff when the proposed shift does not actually match", () => {
    const h = harness();
    h.screen.frame(["HDR", "a1", "a2", "a3", "a4", "CMP"], 0, 0);
    // Claim a scroll, but the content is entirely different — not a clean shift.
    h.screen.frame(["HDR", "b1", "b2", "b3", "b4", "CMP"], 0, 0, { top: 1, bottom: 4, delta: 1 });
    const out = h.last();
    expect(out).not.toContain("\x1b[2;5r"); // no region scroll emitted
    expect(out).not.toContain("\x1b[1T");
    expect(out).toContain("b1"); // rows repainted directly instead
    expect(out).toContain("b4");
  });
});

// ─── Inline renderer (default surface: native scrollback + pinned composer) ───

const ALT_ENTER = "\x1b[?1049h";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR_BELOW = "\x1b[0J";

function regionHarness() {
  const writes: string[] = [];
  const region = new BottomRegion((s) => writes.push(s));
  return { region, writes, all: () => writes.join(""), reset: () => (writes.length = 0) };
}

describe("ui/BottomRegion inline renderer", () => {
  it("renders the pinned block without ever entering the alternate screen", () => {
    const h = regionHarness();
    h.region.render(["> hello"], 0, 2);
    const out = h.all();
    expect(out).toContain("> hello");
    expect(out).toContain(HIDE); // cursor hidden while drawing…
    expect(out).toContain(SHOW); // …and restored after
    expect(out).not.toContain(ALT_ENTER); // crucial: stays in the normal buffer (native scroll)
    expect(out).toContain("\x1b[2C"); // caret advanced to column 2
  });

  it("redraws in place: returns to the block top and clears below before repainting", () => {
    const h = regionHarness();
    h.region.render(["a", "b"], 1, 0); // 2-line block, caret on the bottom row
    h.reset();
    h.region.render(["c", "d"], 1, 0);
    const out = h.all();
    expect(out).toContain("\x1b[1A"); // move up from caret row 1 to the block top
    expect(out).toContain(CLEAR_BELOW); // wipe the old block
    expect(out).toContain("c");
    expect(out).toContain("d");
  });

  it("printAbove emits transcript into scrollback above the block, then redraws the block", () => {
    const h = regionHarness();
    h.region.render(["> "], 0, 2); // mount the composer
    h.reset();
    h.region.printAbove("assistant line", ["> "], 0, 2);
    const out = h.all();
    expect(out).toContain("assistant line\n"); // flushed above (into native scrollback)
    expect(out).toContain("> "); // composer redrawn beneath it
    expect(out).not.toContain(ALT_ENTER);
  });

  it("clear() erases the block and restores the cursor", () => {
    const h = regionHarness();
    h.region.render(["x"], 0, 0);
    h.reset();
    h.region.clear();
    expect(h.all()).toContain(CLEAR_BELOW);
    expect(h.all()).toContain(SHOW);
  });

  it("clamps a block taller than the viewport to its tail (never scrolls the terminal mid-draw)", () => {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: 4, configurable: true }); // tiny viewport
    try {
      const h = regionHarness();
      // A 6-line block into a 4-row terminal: only the last 3 (rows-1) may be drawn, so drawing it
      // never pushes the cursor past the bottom and desyncs the relative cursor math.
      h.region.render(["top1", "top2", "top3", "mid", "box", "status"], 5, 0);
      const out = h.all();
      expect(out).toContain("status"); // the tail (composer + status) is kept…
      expect(out).toContain("box");
      expect(out).not.toContain("top1"); // …and the overflowing top is dropped
      expect(out).not.toContain("top2");
      expect(h.region.lineCount).toBe(3); // rows - 1
    } finally {
      if (orig) Object.defineProperty(process.stdout, "rows", orig);
    }
  });

  it("setBgFill makes in-place clears repaint the theme background (Warp/VS Code fallback)", () => {
    const h = regionHarness();
    h.region.setBgFill("\x1b[48;5;235m");
    h.region.render(["a"], 0, 0); // first mount — nothing to clear yet
    h.reset();
    h.region.render(["b"], 0, 0); // re-render → the clear is prefixed with the bg fill
    expect(h.all()).toContain("\x1b[48;5;235m" + CLEAR_BELOW);
  });
});

// ─── The Tui→frame() region-scroll wiring ───
// The hint below is the piece that connects the transcript band's window math
// to AltScreen's Tier-2 hardware scroll. It was once computed and never passed
// (frame() ran the per-row diff on every streamed line); these tests pin both
// the pure hint and the end-to-end escape sequence.

import { transcriptScrollHint } from "../../../packages/orchestrator/src/bin/ui/tui";

describe("transcriptScrollHint → AltScreen region scroll", () => {
  const geom = { bandTop: 4, transH: 10 };

  it("streams (window advanced) as an upward band scroll", () => {
    const hint = transcriptScrollHint(
      { end: 40, ...geom },
      { end: 42, ...geom, visibleLen: 10 },
    );
    expect(hint).toEqual({ top: 4, bottom: 13, delta: -2 });
  });

  it("a wheel notch up (window rewound) scrolls the band down", () => {
    const hint = transcriptScrollHint(
      { end: 40, ...geom },
      { end: 37, ...geom, visibleLen: 10 },
    );
    expect(hint).toEqual({ top: 4, bottom: 13, delta: 3 });
  });

  it("refuses when geometry changed, the band is part-empty, or the shift is too big", () => {
    const next = { end: 42, ...geom, visibleLen: 10 };
    expect(transcriptScrollHint({ end: 42, ...geom }, next)).toBeUndefined(); // no shift
    expect(transcriptScrollHint({ end: 40, bandTop: 3, transH: 10 }, next)).toBeUndefined();
    expect(transcriptScrollHint({ end: 40, bandTop: 4, transH: 9 }, next)).toBeUndefined();
    expect(
      transcriptScrollHint({ end: 40, ...geom }, { ...next, visibleLen: 9 }),
    ).toBeUndefined(); // top-padded band
    expect(
      transcriptScrollHint({ end: 20, ...geom }, { ...next, end: 40 }),
    ).toBeUndefined(); // shift ≥ band height
  });

  it("drives a real DECSTBM region scroll instead of rewriting every band row", () => {
    const h = harness();
    const rows = (lines: string[]) => ["hdr", ...lines, "composer"];
    h.screen.frame(rows(["l1", "l2", "l3", "l4"]), 0, 0); // baseline
    // One streamed line: band rows 1..4 shift up by one, exposing "l5" at the bottom.
    const hint = transcriptScrollHint(
      { end: 4, bandTop: 1, transH: 4 },
      { end: 5, bandTop: 1, transH: 4, visibleLen: 4 },
    );
    expect(hint).toEqual({ top: 1, bottom: 4, delta: -1 });
    h.screen.frame(rows(["l2", "l3", "l4", "l5"]), 0, 0, hint);
    const out = h.last();
    expect(out).toContain("\x1b[2;5r"); // DECSTBM band = rows 2..5 (1-based)
    expect(out).toContain("\x1b[1S"); // scroll up one line inside the band
    expect(out).toContain("l5"); // only the exposed row is painted…
    expect(out).not.toContain("l3"); // …the surviving rows are not rewritten
  });
});
