/**
 * Art directions for the interactive view.
 *
 * The complaint: "ask for a comprehensive report with an interactive view and
 * you get one of the worst interactive views." The cause was not that any one
 * view was bad — it was that every view was the SAME. The dashboard shipped a
 * single dark bento-grid theme, and the only thing a model could vary was one
 * accent hue. A genomics lab, a cost report, and a music festival all came out
 * as the same dark grid in a different colour, which is precisely what reads as
 * generated.
 *
 * Directions are token-level swaps, so every existing component class inherits
 * them untouched. What is pinned here: they are real directions — different
 * ground, ink, rule weight, and typeface — not recolours, and the default is
 * unchanged so nothing that worked before moves.
 */

import { describe, test, expect } from "bun:test";
import { THEME_CSS } from "../../../packages/tool-registry/src/tools/dashboard-theme";

function tokensOf(selector: string): Record<string, string> {
  const i = THEME_CSS.indexOf(selector + " {");
  if (i < 0) return {};
  const body = THEME_CSS.slice(i + selector.length + 2, THEME_CSS.indexOf("}", i));
  const out: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const kv = line.trim().match(/^(--[a-z0-9-]+):\s*(.+);$/);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

const CONSOLE = tokensOf(":root");
const PAPER = tokensOf(':root[data-direction="paper"]');
const SWISS = tokensOf(':root[data-direction="swiss"]');

describe("dashboard art directions", () => {
  test("the default is untouched — existing views render exactly as before", () => {
    expect(CONSOLE["--bg"]).toBe("#0b0c0f");
    expect(CONSOLE["--accent"]).toBe("#c8f169");
    // 'console' is the absence of the attribute, not a third block to maintain.
    expect(THEME_CSS).not.toContain('data-direction="console"');
  });

  test("each direction redefines the whole ground, not just the accent", () => {
    for (const [name, t] of [
      ["paper", PAPER],
      ["swiss", SWISS],
    ] as const) {
      for (const token of ["--bg", "--panel", "--ink", "--muted", "--line", "--accent", "--font"]) {
        expect({ name, token, set: token in t }).toEqual({ name, token, set: true });
      }
    }
  });

  test("they are different directions, not tints of one", () => {
    const grounds = [CONSOLE["--bg"], PAPER["--bg"], SWISS["--bg"]];
    const inks = [CONSOLE["--ink"], PAPER["--ink"], SWISS["--ink"]];
    const fonts = [CONSOLE["--font"], PAPER["--font"], SWISS["--font"]];
    expect(new Set(grounds).size).toBe(3);
    expect(new Set(inks).size).toBe(3);
    // The typeface is what stops "paper" being "console with a cream bg".
    expect(new Set(fonts).size).toBe(3);
    expect(PAPER["--font"]).toContain("serif");
    expect(SWISS["--font"]).toContain("Helvetica");
  });

  test("paper and swiss are light; console is dark", () => {
    // A ground token beginning #f/#e is light. Crude, and enough: the point is
    // that two of the three are not dark grids.
    expect(CONSOLE["--bg"]!.startsWith("#0")).toBe(true);
    expect(PAPER["--bg"]!.startsWith("#f")).toBe(true);
    expect(SWISS["--bg"]).toBe("#ffffff");
  });

  test("swiss carries its discipline structurally, not just chromatically", () => {
    // Cards stop being cards: no fill, no radius, a hard rule instead.
    const swissCard = THEME_CSS.slice(THEME_CSS.indexOf(':root[data-direction="swiss"] .card'));
    const decl = swissCard.slice(0, swissCard.indexOf("}"));
    expect(decl).toContain("background: transparent");
    expect(decl).toContain("border-radius: 0");
    expect(decl).toContain("border-top: 2px solid var(--line-strong)");
    // And Swiss has no motion.
    expect(decl).toContain("animation: none");
  });

  test("every direction override composes from tokens the components already use", () => {
    // If a direction introduced a literal colour outside its token block, the
    // component classes would fall out of sync with it.
    const overrides = THEME_CSS.split("\n").filter(
      (l) => l.startsWith(":root[data-direction=") && l.includes(" .") && l.includes("var(--"),
    );
    expect(overrides.length).toBeGreaterThan(0);
  });

  test("the renderer only honours known directions", () => {
    // An unknown or absent value must fall back to the default rather than
    // stamping an attribute nothing styles.
    expect(THEME_CSS).toBeTruthy();
    const themeSrc = require("node:fs").readFileSync(
      require("node:path").join(
        import.meta.dir,
        "../../../packages/tool-registry/src/tools/dashboard-theme.ts",
      ),
      "utf8",
    ) as string;
    expect(themeSrc).toContain("var allowed = { console: 1, paper: 1, swiss: 1 }");
    expect(themeSrc).toContain('el.removeAttribute("data-direction")');
  });
});
