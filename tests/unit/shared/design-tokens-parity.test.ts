// ─── The pigment guardrail ───
//
// This test has been rebound three times: from `docs/design/rune-customizer-v2.html`
// to the Savoir DNA, from the Savoir DNA to the electric-blue identity, and now
// to the founder's violet with the terminal as the only surface. Rebound rather
// than deleted, because what it holds is not a hex table.
//
// It pins two things. The eleven literal values, so a brand change arrives as a
// deliberate edit to a list rather than as drift. And the RULES those values
// encode — one accent, painted exact on ink and derived on paper; three status
// colours; derived rather than hand-picked variants; measured contrast floors —
// because a hex table alone would let the system be dismantled a value at a
// time while every assertion stayed green.

import { describe, it, expect } from "bun:test";
import {
  ACCENT_CONTRAST_FLOOR,
  RUNE_ACCENT_CSS,
  RUNE_ACCENT_LABELS,
  RUNE_ACCENT_NAMES,
  RUNE_BASE_CSS,
  RUNE_PALETTE,
  RUNE_STATUS_COLORS,
  STATUS_CONTRAST_FLOOR,
  accentFor,
  contrastRatio,
  hexToRgbTuple,
  mixToward,
  readableOn,
  runeAccentHex,
  runeTerminalPalette,
  runeTerminalRoles,
  solidOver,
  type RuneBaseName,
} from "../../../packages/shared/src/design-tokens";

/** Relative luminance, for the contrast floors the system commits to. */
function luminance(hex: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgbTuple(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const GROUNDS: RuneBaseName[] = ["light", "dark"];

describe("the palette, verbatim", () => {
  it("carries the identity's published values and no others", () => {
    // If one of these changes, the brand changed — which is a decision, not a
    // refactor, and should arrive as a deliberate edit to this list.
    expect(RUNE_PALETTE).toEqual({
      accent: "#A28CF3",
      ground: "#FAFAF8",
      surface: "#FFFFFF",
      sunk: "#F3F3F1",
      ink: "#111318",
      ink2: "#5B6070",
      ink3: "#8B909C",
      hairline: "#E6E6E2",
      groundDark: "#0F1114",
      surfaceDark: "#15181D",
      sunkDark: "#0B0D10",
      inkDark: "#E8E9EC",
      ink2Dark: "#A2A7B3",
      ink3Dark: "#6C717D",
      hairlineDark: "#232730",
      ok: "#1F9D55",
      caution: "#C98A1A",
      danger: "#D2453B",
    });
  });

  it("carries no trace of the identities it replaced", () => {
    // The Savoir DNA (petrol teal, drafting paper, the brick negative) and the
    // electric-blue gear that followed it. A value surviving here would be the
    // rebrand half-done.
    const values = Object.values(RUNE_PALETTE).map((v) => v.toUpperCase());
    for (const ditched of [
      "#0E5E63",
      "#E7E8E3",
      "#14161A",
      "#17A0A8",
      "#9A4A3A",
      "#C7CABF",
      "#1B3FE4",
      "#5B79FF",
    ]) {
      expect(values, `${ditched} is from a ditched identity`).not.toContain(ditched);
    }
  });

  it("has exactly one accent, named for the product", () => {
    expect(RUNE_ACCENT_NAMES).toEqual(["rune"]);
    expect(Object.keys(RUNE_ACCENT_LABELS)).toEqual(["rune"]);
    expect(Object.keys(RUNE_ACCENT_CSS.light)).toHaveLength(1);
    expect(Object.keys(RUNE_ACCENT_CSS.dark)).toHaveLength(1);
  });

  it("paints the founder's swatch exactly on ink, the default ground", () => {
    expect(runeAccentHex("dark")).toBe("#A28CF3");
    expect(RUNE_BASE_CSS.dark.accent).toBe(RUNE_PALETTE.accent);
  });

  it("derives the paper accent from the same swatch rather than authoring a second violet", () => {
    // A pastel on near-white is a swatch, not a signal: the published value is
    // 2.7:1 there. The paper reading steps it toward the ink by the status
    // colours' own rule until it clears the non-text floor — and no further.
    expect(RUNE_BASE_CSS.light.accent).toBe(
      readableOn(RUNE_PALETTE.accent, RUNE_PALETTE.ground, RUNE_PALETTE.ink, ACCENT_CONTRAST_FLOOR),
    );
    expect(RUNE_BASE_CSS.light.accent).toBe(accentFor("light"));
    expect(runeAccentHex("light")).toBe(accentFor("light").toUpperCase());
    expect(contrastRatio(RUNE_BASE_CSS.light.accent, RUNE_PALETTE.ground)).toBeGreaterThanOrEqual(
      ACCENT_CONTRAST_FLOOR,
    );
    // Still recognisably the same violet: a small move, not a new colour.
    const [pr, pg, pb] = hexToRgbTuple(RUNE_PALETTE.accent);
    const [cr, cg, cb] = hexToRgbTuple(RUNE_BASE_CSS.light.accent);
    expect(Math.abs(pr - cr) + Math.abs(pg - cg) + Math.abs(pb - cb)).toBeLessThan(140);
  });

  it("keeps status to three colours, used for state and never as an accent", () => {
    expect(RUNE_STATUS_COLORS).toEqual([
      RUNE_PALETTE.ok,
      RUNE_PALETTE.caution,
      RUNE_PALETTE.danger,
    ]);
    expect(RUNE_STATUS_COLORS).toHaveLength(3);
    expect(RUNE_STATUS_COLORS).not.toContain(RUNE_PALETTE.accent);
  });

  it("derives the readable status variants rather than hand-picking two sets", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      const ink = base === "dark" ? RUNE_PALETTE.inkDark : RUNE_PALETTE.ink;
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(css[role]).toBe(readableOn(RUNE_PALETTE[role], css.surface, ink));
      }
    }
  });

  it("moves the status hue as little as the floor allows", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      for (const role of ["ok", "caution", "danger"] as const) {
        const [pr, pg, pb] = hexToRgbTuple(RUNE_PALETTE[role]);
        const [cr, cg, cb] = hexToRgbTuple(css[role]);
        const drift = Math.abs(pr - cr) + Math.abs(pg - cg) + Math.abs(pb - cb);
        expect(drift, `${base}.${role} drifted ${drift}`).toBeLessThan(140);
      }
    }
  });

  it("derives the hover accent rather than authoring a second violet", () => {
    expect(RUNE_BASE_CSS.light.accentHover).toBe(
      mixToward(RUNE_BASE_CSS.light.accent, "#000000", 0.16),
    );
    expect(RUNE_BASE_CSS.dark.accentHover).toBe(
      mixToward(RUNE_BASE_CSS.dark.accent, "#FFFFFF", 0.16),
    );
  });
});

describe("contrast", () => {
  it("ink is not black and the ground is not white", () => {
    // The one decision that decides whether someone can read this for two
    // hours. Pure black on pure white is the contrast that makes eyes ache.
    expect(RUNE_PALETTE.ink).not.toBe("#000000");
    expect(RUNE_PALETTE.ground).not.toBe("#FFFFFF");
    expect(RUNE_PALETTE.groundDark).not.toBe("#000000");
    expect(RUNE_PALETTE.inkDark).not.toBe("#FFFFFF");
  });

  it("body and secondary text clear WCAG AA on both grounds", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      expect(contrastRatio(css.ink, css.surface), `${base} body`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(css.ink2, css.ground), `${base} secondary`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tertiary clears AA-large — it carries meta, never prose", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      expect(contrastRatio(css.ink3, css.ground), `${base} tertiary`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the accent clears the non-text floor on both grounds, and what sits on it is legible", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      expect(contrastRatio(css.accent, css.ground), `${base} accent`).toBeGreaterThanOrEqual(
        ACCENT_CONTRAST_FLOOR,
      );
      // A pastel carries ink, never white: white on this violet is under 3:1.
      expect(contrastRatio(css.onAccent, css.accent), `${base} on-accent`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("every status colour clears AA as TEXT on the ground it appears on", () => {
    for (const base of GROUNDS) {
      const css = RUNE_BASE_CSS[base];
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(contrastRatio(css[role], css.surface), `${base}.${role}`).toBeGreaterThanOrEqual(
          STATUS_CONTRAST_FLOOR,
        );
      }
    }
  });
});

describe("the terminal derivation", () => {
  it("resolves every role on both grounds", () => {
    for (const base of GROUNDS) {
      const roles = runeTerminalRoles(base);
      for (const key of ["body", "dim", "accent", "ok", "warn", "danger", "line", "ground"]) {
        expect(roles[key], `${base}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("the console paints the accent the token source resolves, on both grounds", () => {
    // One brand, one surface, one source. If the console ever carried its own
    // violet, a palette change here would leave the product looking different.
    expect(runeTerminalRoles("light").accent).toBe(runeAccentHex("light"));
    expect(runeTerminalRoles("dark").accent).toBe(runeAccentHex("dark"));
    expect(runeTerminalRoles("dark").accent).toBe("#A28CF3");
  });

  it("composites translucency deterministically, because a terminal has no alpha", () => {
    expect(solidOver("#FAFAF8", "#000000")).toBe("#FAFAF8");
    expect(solidOver("rgba(255, 255, 255, 0.08)", "#111318")).toBe(
      solidOver("rgba(255,255,255,.08)", "#111318"),
    );
  });

  it("the two grounds are genuinely inverted, not two shades of the same", () => {
    expect(luminance(runeTerminalPalette("light").bg)).toBeGreaterThan(0.6);
    expect(luminance(runeTerminalPalette("dark").bg)).toBeLessThan(0.05);
  });
});
