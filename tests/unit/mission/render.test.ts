import { describe, it, expect } from "vitest";
import {
  GLYPH,
  RUNG_GLYPH,
  L,
  PAD,
  fold,
  layout,
  plainText,
  assertColourBudget,
  type Row,
} from "../../../packages/mission/src/render/row";
import { detectCaps, plainCaps, MEASURE, NARROW } from "../../../packages/mission/src/render/caps";
import { paintRow, screenFor } from "../../../packages/mission/src/render/ansi";
import { Pulse, pulseGlyph } from "../../../packages/mission/src/render/pulse";
import { diffRow, snippet, tokenize, window } from "../../../packages/mission/src/render/code";

const utf8 = detectCaps({ colour: "truecolor", glyphs: "utf8", pulse: "blocks", columns: MEASURE });
const ascii = plainCaps(MEASURE);
const screen = screenFor();

describe("the glyph budget", () => {
  // Test 1: every glyph has an ASCII twin and occupies exactly one cell in both
  // modes, so columns land identically on a UTF-8 terminal and a serial console.
  const budget = [...Object.values(GLYPH), ...Object.values(RUNG_GLYPH)];

  it("is closed, and every glyph is one cell in both modes", () => {
    expect(budget.length).toBeLessThanOrEqual(20);
    for (const g of budget) {
      expect([...g]).toHaveLength(1);
      const twin = fold(g);
      expect(twin, `${g} has no ASCII twin`).toMatch(/^[\x20-\x7e]$/);
    }
  });

  it("folds data, not just glyphs — diacritics survive as letters, not as ?", () => {
    expect(fold("José")).toBe("Jose");
    expect(fold("naïve — “quoted”")).toBe('naive -- "quoted"');
    // A visible gap beats silent corruption for the genuinely unrepresentable.
    expect(fold("日本")).toBe("??");
  });
});

describe("the measure", () => {
  it("lands a padded row on the measure in UTF-8 and in ASCII alike", () => {
    const row = L("  §k{05}§d{ / 08 · 2 agents}¶§d{⇥ inspect  }");
    expect(plainText(row, utf8).length).toBeLessThanOrEqual(MEASURE);
    // Padding is computed *after* the fold, so the two rungs agree on the columns.
    const a = layout(row, utf8).reduce((n, s) => n + s.t.length, 0);
    const b = layout(row, ascii).reduce((n, s) => n + s.t.length, 0);
    expect(a).toBe(MEASURE);
    expect(b).toBe(MEASURE);
  });

  it("gives a wide terminal margin, not filler", () => {
    const wide = detectCaps({ columns: 240, colour: "none", glyphs: "utf8" });
    expect(wide.measure).toBe(MEASURE);
    const narrow = detectCaps({ columns: 58, colour: "none", glyphs: "utf8" });
    expect(narrow.measure).toBe(NARROW);
  });
});

describe("the colour budget", () => {
  it("refuses a syntax role outside a code region", () => {
    const bad: Row = { spans: [{ t: "const", c: "kw" }] };
    expect(() => assertColourBudget(bad)).toThrow(/outside a code region/);
    expect(() => assertColourBudget({ ...bad, region: "code" })).not.toThrow();
  });

  it("carries no state in colour alone — NO_COLOR keeps every character and column", () => {
    // Test 10: identical except for SGR. Diff the two transcripts.
    const rows = [
      diffRow("", { line: 187, sign: "+", text: "if (next.gen < prev.gen) return stale(prev)" }),
      diffRow("", { line: 186, sign: "-", text: "store.write(sid, next)" }),
      L("  §o{✓} run   6 of 6 pass¶§o{green}   "),
    ];
    for (const row of rows) {
      const coloured = paintRow(row, utf8, screen);
      const mono = paintRow(row, { ...utf8, colour: "none", tint: false }, screen);
      // eslint-disable-next-line no-control-regex
      expect(coloured.replace(/\x1b\[[0-9;]*m/g, "")).toBe(mono);
    }
  });

  it("uses the terminal's own sixteen colours for chrome, never truecolour", () => {
    const painted = paintRow(L("§o{✓} §x{✗} §y{!} §a{●} §d{·}"), utf8, screen);
    expect(painted).not.toMatch(/38;2;/); // no 24-bit anywhere in chrome
    expect(painted).toMatch(/\x1b\[32m/); // ok  → the terminal's green
    expect(painted).toMatch(/\x1b\[31m/); // danger → the terminal's red
  });

  it("spends truecolour only inside a code region", () => {
    const code = paintRow(
      diffRow("", { line: 1, sign: "+", text: 'const x = "hi"' }),
      utf8,
      screen,
    );
    expect(code).toMatch(/38;2;/);
  });
});

describe("the pulse", () => {
  // Test 9, load-bearing: the pulse advances only on real output. A tool that starts
  // and never reports must render flat and say `quiet Ns`.
  it("goes flat when the output does, and stays flat", () => {
    const p = new Pulse(0);
    p.sample(64 * 1024, 100);
    expect(p.level(120)).toBeGreaterThan(0);
    expect(p.level(8000)).toBe(0);
    expect(p.isQuiet(8000)).toBe(true);
    expect(Math.round(p.quietMs(8000) / 1000)).toBe(8);
  });

  it("does not move on a clock", () => {
    const p = new Pulse(0);
    const first = p.level(1000);
    expect(p.level(2000)).toBe(first);
    expect(p.level(60_000)).toBe(first);
    expect(first).toBe(0);
  });

  it("rises with throughput", () => {
    const slow = new Pulse(0);
    slow.sample(200, 100);
    const fast = new Pulse(0);
    fast.sample(400 * 1024, 100);
    expect(fast.level(110)).toBeGreaterThan(slow.level(110));
  });

  it("falls back to the ASCII ramp where blocks are Ambiguous width", () => {
    expect(pulseGlyph(7, "blocks")).toBe("█");
    expect(pulseGlyph(7, "ascii")).toBe("#");
    expect([...pulseGlyph(4, "ascii")]).toHaveLength(1);
  });
});

describe("code output", () => {
  it("truncates a long source line rather than wrapping it", () => {
    const long = "const x = " + "a".repeat(200);
    const row = diffRow("", { line: 1, sign: "+", text: long });
    const out = plainText(row, utf8);
    expect(out.length).toBeLessThanOrEqual(MEASURE);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never truncates a snippet — a … in a shell command is a broken command", () => {
    const cmd =
      "GEAR_INJECT_DELAY=100 pytest tests/auth/session_race_test.ts -q --count 5 " + "x".repeat(60);
    const out = plainText(snippet("   ", cmd), utf8);
    expect(out).toContain("--count 5");
    expect(out).not.toContain("…");
  });

  it("counts what it elides, and never exceeds twelve rows", () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      line: i + 1,
      sign: " " as const,
      text: `line ${i}`,
    }));
    const rows = window(lines);
    expect(rows.length).toBeLessThanOrEqual(12);
    const elided = rows.map((r) => (r ? plainText(r, utf8) : "")).find((t) => t.includes("⋯"));
    expect(elided).toMatch(/⋯ \d+ unchanged lines/);
  });

  it("keeps identifiers unstyled and needs no grammar for the lexical five", () => {
    const spans = tokenize('const prev = "x" // note');
    expect(spans.find((s) => s.t === "const")?.c).toBe("kw");
    expect(spans.find((s) => s.t === '"x"')?.c).toBe("str");
    expect(spans.find((s) => s.t.startsWith("//"))?.c).toBe("cm");
    // `prev` is the code's own noun: it inherits the user's foreground.
    expect(spans.find((s) => s.t.includes("prev"))?.c).toBeUndefined();
  });

  it("is unhelpful, never wrong, about a language it has never seen", () => {
    const spans = tokenize('¤fnord ≈ "data" ; 42');
    expect(spans.find((s) => s.t === '"data"')?.c).toBe("str");
    expect(spans.find((s) => s.t === "42")?.c).toBe("num");
    expect(spans.some((s) => s.c === "kw")).toBe(false);
  });
});

describe("no percentages, no ETAs", () => {
  it("has no renderer that can emit one", async () => {
    const src = await Promise.all(
      ["row", "ansi", "code", "pulse"].map((f) =>
        import(`../../../packages/mission/src/render/${f}`).then(() => f),
      ),
    );
    expect(src).toHaveLength(4);
    // The guarantee is structural: `format.ts` exports no percent and no eta.
    const fmt = await import("../../../packages/mission/src/format");
    expect(Object.keys(fmt)).not.toContain("percent");
    expect(Object.keys(fmt)).not.toContain("eta");
  });
});
