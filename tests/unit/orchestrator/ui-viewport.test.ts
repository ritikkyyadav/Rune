import { describe, expect, it } from "bun:test";
import {
  Viewport,
  composeFrame,
  zones,
  VIEWPORT_RESTORE,
} from "../../../packages/orchestrator/src/bin/ui/viewport";

// ─── Fixed chrome ───
// The whole point of this surface is one sentence: the header and the footer do
// not move, and the transcript between them is the only thing that does. That
// sentence is what these tests assert, at every window size and in every state
// the layout can be put into — because the bug it replaced ("everything scrolls
// together, including the header and the input") is invisible to a test that
// only checks the rows are rendered somewhere.

const HEADER = ["── rune 0.3.0 ──", "  atlas | main", "  opus | 1st gear", "───────────────"];
const FOOTER = ["  > type here", "  status line"];

function transcript(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

function frame(over: Partial<Parameters<typeof composeFrame>[0]> = {}) {
  return composeFrame({
    rows: 24,
    header: HEADER,
    transcript: transcript(100),
    footer: FOOTER,
    scroll: 0,
    caretRow: 0,
    caretCol: 4,
    ...over,
  });
}

describe("ui/viewport zones", () => {
  it("gives the body every row the chrome does not claim", () => {
    const z = zones(24, 4, 2);
    expect(z).toEqual({
      headerRows: 4,
      bodyRows: 18,
      footerRows: 2,
      bodyTop: 4,
      footerTop: 22,
    });
  });

  it("always accounts for exactly the rows it was given", () => {
    for (let rows = 1; rows <= 60; rows++) {
      for (const [h, f] of [
        [0, 1],
        [4, 2],
        [4, 20],
        [12, 12],
        [40, 40],
      ] as const) {
        const z = zones(rows, h, f);
        expect(z.headerRows + z.bodyRows + z.footerRows).toBe(rows);
        expect(z.bodyRows).toBeGreaterThanOrEqual(1);
        expect(z.bodyTop).toBe(z.headerRows);
        expect(z.footerTop).toBe(z.headerRows + z.bodyRows);
      }
    }
  });

  it("sheds the header before the body and the body before the footer", () => {
    // A window too short for all three: chrome yields, content does not.
    expect(zones(6, 4, 5)).toMatchObject({ headerRows: 0, bodyRows: 1, footerRows: 5 });
    // And a footer that alone exceeds the window still leaves a row of work.
    expect(zones(3, 4, 9)).toMatchObject({ headerRows: 0, bodyRows: 1, footerRows: 2 });
  });
});

describe("ui/viewport composeFrame", () => {
  it("fills the window exactly, with the header on top and the footer on the last rows", () => {
    const f = frame();
    expect(f.rows).toHaveLength(24);
    expect(f.rows.slice(0, 4)).toEqual(HEADER);
    expect(f.rows.slice(22)).toEqual(FOOTER);
  });

  it("keeps header and footer on the SAME rows no matter how far the body scrolls", () => {
    // This is the regression. Scrolling used to move the whole window as one
    // sheet; here the only rows allowed to differ are the body's.
    const bottom = frame({ scroll: 0 });
    for (const scroll of [1, 5, 40, 82, 500]) {
      const scrolled = frame({ scroll });
      expect(scrolled.rows.slice(0, 4)).toEqual(bottom.rows.slice(0, 4));
      expect(scrolled.rows.slice(22)).toEqual(bottom.rows.slice(22));
      expect(scrolled.caretRow).toBe(bottom.caretRow);
    }
  });

  it("follows the live tail at scroll 0", () => {
    const f = frame();
    expect(f.rows[21]).toBe("line 100");
    expect(f.hiddenAbove).toBe(82);
  });

  it("moves the body by exactly the lines it was asked to scroll", () => {
    const a = frame({ scroll: 0 });
    const b = frame({ scroll: 3 });
    // Row 21 is the last body row; three lines back is line 97.
    expect(a.rows[21]).toBe("line 100");
    expect(b.rows[21]).toBe("line 97");
  });

  it("clamps scroll to what the transcript can offer, so the body never goes blank", () => {
    const f = frame({ scroll: 9999 });
    expect(f.scroll).toBe(100 - 18);
    expect(f.hiddenAbove).toBe(0);
    // The top of the body is the very first line of the session, not padding.
    expect(f.rows[4]).toBe("line 1");
  });

  it("spends a body row on the scrolled marker only while scrolled up", () => {
    const marker = (hidden: number) => `-- ${hidden} above --`;
    expect(frame({ scroll: 0, scrolledMarker: marker }).rows[4]).toBe("line 83");
    const up = frame({ scroll: 10, scrolledMarker: marker });
    expect(up.rows[4]).toBe(`-- ${up.hiddenAbove} above --`);
    // ...and the marker costs one line of content, not one line of chrome.
    expect(up.rows.slice(0, 4)).toEqual(HEADER);
    expect(up.rows.slice(22)).toEqual(FOOTER);
  });

  it("pads a short transcript below the content, never above it", () => {
    // Three lines of work read down from the header. Blank rows fall to the
    // bottom of the body, so nothing is pushed up against the footer.
    const f = frame({ transcript: ["a", "b", "c"], blank: "" });
    expect(f.rows.slice(4, 8)).toEqual(["a", "b", "c", ""]);
    expect(f.rows.slice(8, 22).every((r) => r === "")).toBe(true);
    expect(f.rows.slice(22)).toEqual(FOOTER);
  });

  it("an empty session is blank rows, not a painted viewport", () => {
    const f = frame({ transcript: [], blank: "" });
    expect(f.rows.slice(4, 22).every((r) => r === "")).toBe(true);
  });

  it("themes only the lines that made the window", () => {
    const seen: string[] = [];
    const f = frame({
      themeBody: (l) => {
        seen.push(l);
        return `<${l}>`;
      },
    });
    expect(seen).toHaveLength(18); // the body height — not the 100-line transcript
    expect(f.rows[21]).toBe("<line 100>");
  });

  it("trims an over-tall footer from the top and carries the caret with it", () => {
    // A full-height panel is still a footer. It loses its head, never its field,
    // and the caret lands on the row it was actually drawn on.
    const panel = Array.from({ length: 30 }, (_, i) => `panel ${i + 1}`);
    const f = frame({ footer: panel, caretRow: 29 });
    expect(f.rows.at(-1)).toBe("panel 30");
    expect(f.rows[f.caretRow]).toBe("panel 30");
    expect(f.zones.bodyRows).toBeGreaterThanOrEqual(1);
  });

  it("puts the caret inside the footer at the row and column it was given", () => {
    const f = frame({ caretRow: 0, caretCol: 4 });
    expect(f.caretRow).toBe(22);
    expect(f.caretCol).toBe(4);
    expect(f.rows[f.caretRow]).toBe("  > type here");
  });

  it("survives windows too small to be sensible", () => {
    for (const rows of [1, 2, 3, 5]) {
      const f = frame({ rows, blank: "" });
      expect(f.rows).toHaveLength(rows);
      expect(f.caretRow).toBeLessThan(rows);
      expect(f.caretRow).toBeGreaterThanOrEqual(0);
    }
  });
});

function harness() {
  const writes: string[] = [];
  const vp = new Viewport((s) => writes.push(s));
  return { vp, writes, all: () => writes.join(""), reset: () => (writes.length = 0) };
}

describe("ui/viewport Viewport", () => {
  it("takes the alternate screen and hands it back intact", () => {
    const h = harness();
    h.vp.enter();
    h.vp.captureMouse();
    expect(h.all()).toContain("\x1b[?1049h");
    expect(h.all()).toContain("\x1b[?7l"); // autowrap off: a wrapped row desyncs every row below it
    expect(h.all()).toContain("\x1b[?1006h");
    h.reset();
    h.vp.leave();
    // Everything enter() turned on, turned off — in the reverse order, so the
    // shell never sees a moment with the mouse captured and no screen to use.
    expect(h.all()).toBe(VIEWPORT_RESTORE);
    expect(h.all()).toContain("\x1b[?1049l");
    expect(h.all()).toContain("\x1b[?25h");
  });

  it("leave() is safe without enter(), and safe twice", () => {
    const h = harness();
    expect(() => {
      h.vp.leave();
      h.vp.leave();
    }).not.toThrow();
  });

  it("writes nothing before it is mounted", () => {
    const h = harness();
    h.vp.render(frame());
    expect(h.all()).toBe("");
  });

  it("addresses every row absolutely on the first frame", () => {
    const h = harness();
    h.vp.enter();
    h.reset();
    h.vp.render(frame());
    const out = h.all();
    for (let r = 1; r <= 24; r++) expect(out).toContain(`\x1b[${r};1H`);
  });

  it("rewrites ONLY the rows whose text changed", () => {
    // The header is re-rendered every frame; if identical text still cost a
    // write, a streaming turn would repaint the band under itself and flicker.
    const h = harness();
    h.vp.enter();
    h.vp.render(frame({ transcript: transcript(100) }));
    h.reset();
    h.vp.render(frame({ transcript: transcript(101) }));
    const out = h.all();
    expect(out).not.toContain("\x1b[1;1H"); // header row 1: untouched
    expect(out).not.toContain("\x1b[23;1H"); // footer row 1: untouched
    expect(out).toContain("line 101");
    // 18 body rows shifted up by one, and nothing else.
    expect(out.match(/\x1b\[\d+;1H/g) ?? []).toHaveLength(18);
  });

  it("erases to end of line so a shorter row cannot leave the old one behind", () => {
    const h = harness();
    h.vp.enter();
    h.vp.render(frame({ footer: ["  a long footer line", "  status"] }));
    h.reset();
    h.vp.render(frame({ footer: ["  x", "  status"] }));
    expect(h.all()).toContain("\x1b[0K");
    expect(h.all()).not.toContain("long footer line");
  });

  it("invalidate() forgets the screen so the next frame writes all of it", () => {
    const h = harness();
    h.vp.enter();
    h.vp.render(frame());
    h.reset();
    h.vp.render(frame()); // identical: nothing to do
    expect(h.all()).toBe("");
    h.vp.invalidate();
    h.reset();
    h.vp.render(frame());
    expect((h.all().match(/\x1b\[\d+;1H/g) ?? []).length).toBe(24);
  });

  it("places the cursor in the footer, and hides it when the surface paints its own", () => {
    const h = harness();
    h.vp.enter();
    h.reset();
    h.vp.render(frame({ caretRow: 0, caretCol: 4 }), true);
    expect(h.all()).toContain("\x1b[23;5H"); // 1-based: row 22+1, col 4+1
    expect(h.all()).toContain("\x1b[?25h");
    h.vp.invalidate();
    h.reset();
    h.vp.render(frame({ caretRow: 0, caretCol: 4 }), false);
    expect(h.all()).toContain("\x1b[23;5H");
    expect(h.all()).not.toContain("\x1b[?25h");
  });
});

// ─── Held height ───
// The live block above the composer used to be as tall as its content, and its
// content changed shape on every tool call (four rows of streaming prose, then
// none, then four). Each change re-split the frame and re-indexed the whole
// body. holdHeight pins the block to its high-water mark for the turn.

import {
  holdHeight,
  SYNC_BEGIN,
  SYNC_END,
} from "../../../packages/orchestrator/src/bin/ui/viewport";

describe("ui/viewport holdHeight", () => {
  it("grows to the tallest content seen and never shrinks below it", () => {
    let high = 0;
    const a = holdHeight(["rung", "detail", "p1", "p2", "p3", "p4"], high, 9);
    high = a.highWater;
    expect(a.rows).toHaveLength(6);
    // The prose collapsed at a tool call: the block keeps its six rows.
    const b = holdHeight(["rung"], high, 9);
    expect(b.rows).toHaveLength(6);
    expect(b.rows.slice(1)).toEqual(["", "", "", "", ""]);
    expect(b.highWater).toBe(6);
    // …and grows again only when the content is taller.
    const c = holdHeight(["rung", "d", "f1", "f2", "f3", "f4", "f5", "f6"], high, 9);
    expect(c.rows).toHaveLength(8);
    expect(c.highWater).toBe(8);
  });

  it("never exceeds the budget, trimming from the bottom", () => {
    const r = holdHeight(["rung", "detail", "a", "b", "c", "d"], 0, 3);
    expect(r.rows).toEqual(["rung", "detail", "a"]);
    expect(r.highWater).toBe(3);
    // A high-water mark from a taller window is clamped to the new budget.
    expect(holdHeight(["rung"], 8, 3).rows).toHaveLength(3);
  });

  it("a fresh turn starts from zero", () => {
    expect(holdHeight(["rung"], 0, 9).rows).toEqual(["rung"]);
  });
});

describe("ui/viewport synchronized output", () => {
  it("brackets every frame write in DEC 2026 and hides the cursor first", () => {
    const writes: string[] = [];
    const vp = new Viewport((s) => writes.push(s));
    vp.enter();
    writes.length = 0;
    vp.render(frame(), true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.startsWith(SYNC_BEGIN + "\x1b[?25l")).toBe(true);
    expect(writes[0]!.endsWith(SYNC_END)).toBe(true);
  });

  it("an unchanged frame writes nothing at all", () => {
    const writes: string[] = [];
    const vp = new Viewport((s) => writes.push(s));
    vp.enter();
    vp.render(frame(), true);
    writes.length = 0;
    vp.render(frame(), true);
    expect(writes).toHaveLength(0);
  });

  it("invalidate forgets the screen without clearing it — the next frame rewrites every row", () => {
    const writes: string[] = [];
    const vp = new Viewport((s) => writes.push(s));
    vp.enter();
    vp.render(frame(), true);
    writes.length = 0;
    vp.invalidate();
    expect(writes.join("")).not.toContain("\x1b[2J");
    vp.render(frame(), true);
    const rows = (writes.join("").match(/\x1b\[\d+;1H/g) ?? []).length;
    expect(rows).toBe(24);
  });
});
