// ─── The pigment guardrail ───
//
// This test has been rebound four times: from `docs/design/rune-customizer-v2.html`
// to the Savoir DNA, from the Savoir DNA to an electric-blue identity, to the
// founder's violet, and now to the redesigned Savoir brand — one blue on a
// clean black-and-white ground. Rebound rather than deleted, because what it
// holds is not a hex table.
//
// It pins two things. The literal values, so a brand change arrives as a
// deliberate edit to a list rather than as drift. And the RULES those values
// encode — one accent, painted exact on PAPER and lifted on INK because blue is
// a dark accent; three status colours for state; derived rather than hand-picked
// variants; measured contrast floors — because a hex table alone would let the
// system be dismantled a value at a time while every assertion stayed green.

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
      accent: "#0B37E0",
      accentLift: "#3E63FF",
      ground: "#FAFAFA",
      surface: "#FFFFFF",
      sunk: "#F2F2F1",
      ink: "#000000",
      ink2: "#5A5F64",
      ink3: "#868B90",
      hairline: "#E3E3E2",
      groundDark: "#0B0C0D",
      surfaceDark: "#131416",
      sunkDark: "#060607",
      inkDark: "#FFFFFF",
      ink2Dark: "#9BA0A5",
      ink3Dark: "#6A6F74",
      hairlineDark: "#212325",
      ok: "#1F9D55",
      caution: "#C98A1A",
      danger: "#D2453B",
    });
  });

  it("carries no trace of the identities it replaced", () => {
    // The Savoir DNA (petrol teal, drafting paper, the brick negative), the
    // first electric-blue gear, and the founder's violet that followed it. A
    // value surviving here would be the rebrand half-done.
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
      "#A28CF3",
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

  it("paints the blue exactly on paper, where a dark accent belongs", () => {
    // Blue is dark, so paper is the ground it reads on exactly: #0B37E0 clears
    // the non-text floor on near-white with room to spare.
    expect(runeAccentHex("light")).toBe("#0B37E0");
    expect(RUNE_BASE_CSS.light.accent).toBe(RUNE_PALETTE.accent);
    expect(accentFor("light")).toBe(RUNE_PALETTE.accent);
  });

  it("lifts the blue on ink to a published second reading, not a smudge", () => {
    // #0B37E0 on near-black is under 2:1 — a dark accent on a dark ground. The
    // ink reading is Savoir's own dark-surface blue, taken from savoir.new
    // rather than derived at render time, so the mark reads unmistakably blue.
    expect(runeAccentHex("dark")).toBe("#3E63FF");
    expect(RUNE_BASE_CSS.dark.accent).toBe(RUNE_PALETTE.accentLift);
    expect(accentFor("dark")).toBe(RUNE_PALETTE.accentLift);
    // Both readings are one blue: blue-dominant, and close in hue.
    for (const hex of [RUNE_PALETTE.accent, RUNE_PALETTE.accentLift]) {
      const [r, g, b] = hexToRgbTuple(hex);
      expect(b, `${hex} is blue-dominant`).toBeGreaterThan(Math.max(r, g) + 60);
    }
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

  it("derives the hover accent rather than authoring a second blue", () => {
    expect(RUNE_BASE_CSS.light.accentHover).toBe(
      mixToward(RUNE_BASE_CSS.light.accent, "#000000", 0.16),
    );
    expect(RUNE_BASE_CSS.dark.accentHover).toBe(
      mixToward(RUNE_BASE_CSS.dark.accent, "#FFFFFF", 0.16),
    );
  });
});

describe("contrast", () => {
  it("commits to black-and-white ink on off-pure grounds", () => {
    // The redesigned Savoir brand is deliberately monochrome: the ink is true
    // black on paper and true white on ink. What keeps it off the aching pole
    // is the GROUND, which is never pure — paper is #FAFAFA, ink is #0B0C0D —
    // so the surface a person stares at for two hours is softened even though
    // the text on it is pure. That is the founder's direction, not drift.
    expect(RUNE_PALETTE.ink).toBe("#000000");
    expect(RUNE_PALETTE.inkDark).toBe("#FFFFFF");
    expect(RUNE_PALETTE.ground).not.toBe("#FFFFFF");
    expect(RUNE_PALETTE.groundDark).not.toBe("#000000");
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
      // Blue carries white, never ink: black on #0B37E0 is ~2:1, white clears
      // 4.5:1 on both the paper blue and the lifted ink blue.
      expect(css.onAccent).toBe("#FFFFFF");
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
    // blue, a palette change here would leave the product looking different.
    expect(runeTerminalRoles("light").accent).toBe(runeAccentHex("light"));
    expect(runeTerminalRoles("dark").accent).toBe(runeAccentHex("dark"));
    expect(runeTerminalRoles("dark").accent).toBe("#3E63FF");
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

// The syntax palette: nine reading-aid colours for code, kept OUTSIDE the
// brand palette (pinned verbatim above) and held to the same text floor.
import {
  RUNE_SYNTAX,
  SYNTAX_ROLES,
  syntaxPalette,
} from "../../../packages/shared/src/design-tokens";

describe("the syntax palette", () => {
  it("names nine roles on both grounds", () => {
    for (const base of ["light", "dark"] as const) {
      expect(Object.keys(syntaxPalette(base)).sort()).toEqual([...SYNTAX_ROLES].sort());
    }
  });
  it("clears 4.5:1 as text on its own ground, every role, both grounds", () => {
    const ground = { light: RUNE_PALETTE.ground, dark: RUNE_PALETTE.groundDark } as const;
    for (const base of ["light", "dark"] as const) {
      for (const role of SYNTAX_ROLES) {
        expect(
          contrastRatio(RUNE_SYNTAX[base][role], ground[base]),
          `${base} ${role}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("stays out of the brand palette", () => {
    const brand = new Set(Object.values(RUNE_PALETTE).map((v) => v.toUpperCase()));
    for (const base of ["light", "dark"] as const)
      for (const hex of Object.values(RUNE_SYNTAX[base]))
        expect(brand.has(hex.toUpperCase())).toBe(false);
  });
});

// The diff bands: the founder's swatches on ink, derived tints on paper.
import { RUNE_DIFF_BANDS } from "../../../packages/shared/src/design-tokens";

describe("the diff bands", () => {
  it("lays an added row on the opposite ground: the theme's white on ink, the mark's blue on paper", () => {
    expect(RUNE_DIFF_BANDS.dark).toEqual({ added: RUNE_PALETTE.inkDark, removed: "#370603" });
    expect(RUNE_DIFF_BANDS.light.added).toBe("#1936D7");
  });
  it("keeps one ink pole legible on every band", () => {
    for (const base of ["light", "dark"] as const) {
      for (const band of Object.values(RUNE_DIFF_BANDS[base])) {
        const pole = Math.max(contrastRatio("#000000", band), contrastRatio("#FFFFFF", band));
        expect(pole, `${base} ${band}`).toBeGreaterThanOrEqual(7);
      }
    }
  });
});
