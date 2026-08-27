import { describe, expect, it } from "bun:test";
import { BottomRegion } from "../../../packages/orchestrator/src/bin/ui/screen";

// ─── The one surface ───
// Phase 03 deleted the alternate-screen compositor. What remains is committed
// scrollback the terminal owns, plus a handful of pinned rows redrawn with
// RELATIVE cursor moves only.
//
// The load-bearing test is the last one in this file: replay the interactive
// escape stream through a miniature terminal emulator and assert the result is
// byte-identical to what a pipe would have received. If the erases and
// cursor-ups do not exactly cancel, that test fails — which is the only real
// proof the cursor arithmetic is right.

/** The escape that must never appear again. Asserted absent, not used. */
const ALT_ENTER = "\x1b[?1049h";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR_BELOW = "\x1b[0J";

function regionHarness() {
  const writes: string[] = [];
  const region = new BottomRegion((s) => writes.push(s));
  return { region, writes, all: () => writes.join(""), reset: () => (writes.length = 0) };
}

describe("ui/BottomRegion — the only render surface", () => {
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

// ─── The acceptance test for Phase 03 ───
// A miniature terminal: enough of a VT to prove the live region's arithmetic
// cancels. It understands exactly the vocabulary the surface is allowed to use
// — \n, \r, ESC[2K (erase line), ESC[0J (erase below), ESC[nA (up),
// ESC[nC (right), ESC[?25l/h (cursor) — and nothing else. An escape outside
// that set is a test failure by construction, because the emulator throws.
class MiniTerm {
  rows: string[] = [""];
  row = 0;
  col = 0;
  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[(\??)(\d*)([A-Za-z])/.exec(s.slice(i));
        if (!m) throw new Error("unparsable escape at " + i);
        const [full, priv, numRaw, verb] = m;
        const n = numRaw === "" ? 1 : parseInt(numRaw!, 10);
        if (priv === "?") {
          if (verb !== "l" && verb !== "h") throw new Error("forbidden private mode: " + full);
          if (numRaw === "1049") throw new Error("ALTERNATE SCREEN — forbidden");
        } else if (verb === "A") {
          this.row = Math.max(0, this.row - n);
          this.col = 0;
        } else if (verb === "C") {
          this.col += n;
        } else if (verb === "K") {
          this.rows[this.row] = (this.rows[this.row] ?? "").slice(0, this.col);
        } else if (verb === "J") {
          this.rows[this.row] = (this.rows[this.row] ?? "").slice(0, this.col);
          this.rows.length = this.row + 1;
        } else if (verb === "m") {
          /* colour — no geometry */
        } else if (verb === "H" || verb === "d" || verb === "f") {
          throw new Error("ABSOLUTE ADDRESSING — forbidden: " + full);
        } else {
          throw new Error("escape outside the allowed vocabulary: " + full);
        }
        i += full.length;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
        while (this.rows.length <= this.row) this.rows.push("");
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        while (this.rows.length <= this.row) this.rows.push("");
        const line = this.rows[this.row] ?? "";
        this.rows[this.row] =
          line.padEnd(this.col, " ").slice(0, this.col) + ch + line.slice(this.col + 1);
        this.col += 1;
      }
      i += 1;
    }
  }
  /** What a human sees: trailing blank rows dropped, right margin trimmed. */
  screen(): string {
    const out = this.rows.map((r) => r.replace(/\s+$/, ""));
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }
}

describe("Phase 03 — the interactive stream replays to the piped transcript", () => {
  it("is byte-identical after a realistic session", () => {
    // What a pipe would have received: every committed line, final state only.
    const transcript = [
      "assistant: looking at the retry ladder",
      "  read  src/http/retry.ts",
      "  edit  src/http/retry.ts",
    ];
    const finalBlock = ["", "> ready"];
    const piped = transcript.join("\n") + "\n" + finalBlock.join("\n");

    // What the interactive surface actually writes: the composer mounts, gets
    // redrawn on every keystroke and every streamed line, and each transcript
    // line is flushed above it. Every one of those redraws must leave no trace.
    const writes: string[] = [];
    const region = new BottomRegion((s) => writes.push(s));

    region.render(["", "> "], 1, 2);
    region.render(["", "> r"], 1, 3);
    region.render(["", "> re"], 1, 4);
    for (const line of transcript) {
      region.printAbove(line, ["", "> re"], 1, 4);
      region.render(["", "> re"], 1, 4); // a repaint that changes nothing
    }
    region.render(["", "> ready"], 1, 7);

    const term = new MiniTerm();
    term.feed(writes.join("")); // throws on any forbidden escape

    expect(term.screen()).toBe(piped);
  });

  it("a repaint that changes nothing leaves the screen identical", () => {
    const writes: string[] = [];
    const region = new BottomRegion((s) => writes.push(s));
    region.render(["> steady"], 0, 8);
    const term = new MiniTerm();
    term.feed(writes.join(""));
    const before = term.screen();
    writes.length = 0;
    for (let i = 0; i < 20; i++) region.render(["> steady"], 0, 8);
    term.feed(writes.join(""));
    expect(term.screen()).toBe(before);
  });

  it("no code path can re-enter the alternate screen", () => {
    const writes: string[] = [];
    const region = new BottomRegion((s) => writes.push(s));
    region.render(["a"], 0, 0);
    region.printAbove("b", ["a"], 0, 0);
    region.clear();
    const all = writes.join("");
    expect(all).not.toContain(ALT_ENTER);
    expect(all).not.toContain("\x1b[?1049l");
    expect(all).not.toMatch(/\x1b\[\d*;\d*H/); // no absolute addressing
    expect(all).not.toContain("\x1b[2J"); // no full-screen clear in a render path
  });
});

// ─── Streaming into a viewport that actually scrolls ───
// The emulator above never runs out of rows, so it cannot see what happens when
// a tall pinned block plus new output overflows the window and the terminal
// scrolls under us. Every cursor move here is RELATIVE, so a scroll the surface
// does not account for makes the next erase land in the wrong place — which
// shows up as stale copies of the composer stranded in scrollback, or as real
// output being wiped. Both are silent; neither is visible in a short session.
class ScrollingTerm {
  scrollback: string[] = [];
  view: string[] = [""];
  row = 0;
  col = 0;
  constructor(readonly rows: number) {}
  feed(s: string): void {
    for (let i = 0; i < s.length;) {
      const ch = s[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[(\??)(\d*)([A-Za-z])/.exec(s.slice(i));
        if (!m) throw new Error("unparsable escape");
        const [full, priv, n, verb] = m;
        const k = n === "" ? 1 : parseInt(n!, 10);
        if (priv === "?") {
          if (n === "1049") throw new Error("ALTERNATE SCREEN — forbidden");
        } else if (verb === "A") {
          this.row = Math.max(0, this.row - k);
          this.col = 0;
        } else if (verb === "C") {
          this.col += k;
        } else if (verb === "K") {
          this.view[this.row] = (this.view[this.row] ?? "").slice(0, this.col);
        } else if (verb === "J") {
          this.view[this.row] = (this.view[this.row] ?? "").slice(0, this.col);
          this.view.length = this.row + 1;
        } else if (verb === "H" || verb === "d") {
          throw new Error("ABSOLUTE ADDRESSING — forbidden");
        }
        i += full.length;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
        while (this.view.length <= this.row) this.view.push("");
        while (this.row >= this.rows) {
          this.scrollback.push(this.view.shift() ?? "");
          this.row -= 1;
        }
      } else if (ch === "\r") {
        this.col = 0;
      } else {
        while (this.view.length <= this.row) this.view.push("");
        const line = this.view[this.row] ?? "";
        this.view[this.row] =
          line.padEnd(this.col, " ").slice(0, this.col) + ch + line.slice(this.col + 1);
        this.col += 1;
      }
      i += 1;
    }
  }
  get everything(): string[] {
    return [...this.scrollback, ...this.view];
  }
}

describe("a long run: the composer holds the bottom, history keeps flowing", () => {
  const ROWS = 12;
  const CORE = ["------------", "  > type here", "------------", "  >>> 3rd gear"];

  function stream(lines: number) {
    const orig = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
    try {
      const term = new ScrollingTerm(ROWS);
      const writes: string[] = [];
      const region = new BottomRegion((s) => writes.push(s));
      const drain = () => {
        term.feed(writes.join(""));
        writes.length = 0;
      };
      let printed = 0;
      // The pinned block holds the field on the bottom rows until output has
      // earned the space — the same arithmetic the TUI uses.
      const block = () => [
        ...Array.from({ length: Math.max(0, ROWS - printed - CORE.length - 1) }, () => ""),
        ...CORE,
      ];
      let b = block();
      region.render(b, b.length - 3, 4);
      drain();
      for (let n = 1; n <= lines; n++) {
        printed += 1;
        b = block();
        region.printAbove(`  output line ${n}`, b, b.length - 3, 4);
        drain();
      }
      return term;
    } finally {
      if (orig) Object.defineProperty(process.stdout, "rows", orig);
    }
  }

  it("leaves exactly one composer, never a trail of stale ones", () => {
    const term = stream(25);
    const copies = term.everything.filter((l) => l.includes("> type here")).length;
    expect(copies).toBe(1);
  });

  it("loses no output to the redraw", () => {
    const term = stream(25);
    const missing = Array.from({ length: 25 }, (_, i) => i + 1).filter(
      (n) => !term.everything.some((l) => l.includes(`output line ${n}`)),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the field on the bottom rows while output flows above it", () => {
    const term = stream(25);
    const inputRow = term.view.findIndex((l) => l.includes("> type here"));
    expect(inputRow).toBeGreaterThanOrEqual(0);
    // Two rows below it: the closing rule and the status line.
    expect(term.view.length - 1 - inputRow).toBe(2);
    // …and the row above it is the field's own opening rule, not stray output.
    expect(term.view[inputRow - 1]).toContain("---");
  });

  it("history reaches scrollback rather than being overwritten in place", () => {
    const term = stream(25);
    expect(term.scrollback.some((l) => l.includes("output line 1"))).toBe(true);
    expect(term.view.some((l) => l.includes("output line 25"))).toBe(true);
  });
});

describe("the hardware cursor is always given back", () => {
  // The writing surface hides it to draw its own caret. That is the one way
  // this whole design could leave a terminal worse than it found it, so every
  // path that stops drawing has to hand it back.
  it("clear() restores the cursor", () => {
    const writes: string[] = [];
    const region = new BottomRegion((s) => writes.push(s));
    region.render(["  > x"], 0, 4, true); // ownCursor: no SHOW on the draw
    expect(writes.join("")).not.toContain("\x1b[?25h");
    writes.length = 0;
    region.clear();
    expect(writes.join("")).toContain("\x1b[?25h");
  });

  it("a block that does not own its caret shows the cursor as before", () => {
    // Pickers, permission cards and the sessions panel keep the real cursor:
    // there it is the only signal that the pane has focus.
    const writes: string[] = [];
    const region = new BottomRegion((s) => writes.push(s));
    region.render(["  > x"], 0, 4);
    expect(writes.join("")).toContain("\x1b[?25h");
  });
});
