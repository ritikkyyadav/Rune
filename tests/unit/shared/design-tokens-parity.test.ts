// ─── The pigment guardrail ───
//
// This test has been rebound five times: from `docs/design/rune-customizer-v2.html`
// to the Savoir DNA, from the Savoir DNA to an electric-blue identity, to the
// founder's violet, to the redesigned Savoir blue — and now (2026-09-26) to
// "Rune Mono": black and white chrome, a matte finish beside the crisp one, and
// exactly one blue left in the product, on the light-mode added-line band.
// Rebound rather than deleted, because what it holds is not a hex table.
//
// It pins two things. The literal values, so a brand change arrives as a
// deliberate edit to a list rather than as drift. And the RULES those values
// encode — the chrome is neutral grey and the accent is the ink; matte is
// DERIVED to measured contrast targets, never hand-picked; three status colours
// for state; the protected blue is untouchable — because a hex table alone
// would let the system be dismantled a value at a time while every assertion
// stayed green.

import { describe, it, expect } from "bun:test";
import {
  ACCENT_CONTRAST_FLOOR,
  DEFAULT_RUNE_FINISH,
  MATTE_CONTRAST,
  MATTE_STATUS_SATURATION,
  RUNE_ACCENT_LABELS,
  RUNE_ACCENT_NAMES,
  RUNE_BASE_CSS,
  RUNE_FINISHES,
  RUNE_PALETTE,
  RUNE_STATUS_COLORS,
  STATUS_CONTRAST_FLOOR,
  accentFor,
  contrastRatio,
  desaturate,
  hexToRgbTuple,
  mixToward,
  readableOn,
  runeAccentHex,
  runeBaseCss,
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

/** HSL saturation, for "matte is quieter than crisp". */
function saturation(hex: string): number {
  const [r, g, b] = hexToRgbTuple(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return 0;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** A true grey: all three channels equal. */
function isNeutral(hex: string): boolean {
  const [r, g, b] = hexToRgbTuple(hex);
  return r === g && g === b;
}

const GROUNDS: RuneBaseName[] = ["light", "dark"];

describe("the palette, verbatim", () => {
  it("carries the identity's published values and no others", () => {
    // If one of these changes, the brand changed — which is a decision, not a
    // refactor, and should arrive as a deliberate edit to this list.
    expect(RUNE_PALETTE).toEqual({
      ground: "#FAFAFA",
      surface: "#FFFFFF",
      sunk: "#F2F2F2",
      ink: "#000000",
      ink2: "#5E5E5E",
      ink3: "#8A8A8A",
      hairline: "#E3E3E3",
      groundDark: "#0C0C0C",
      surfaceDark: "#141414",
      sunkDark: "#060606",
      inkDark: "#FFFFFF",
      ink2Dark: "#9F9F9F",
      ink3Dark: "#6E6E6E",
      hairlineDark: "#232323",
      ok: "#1F9D55",
      caution: "#C98A1A",
      danger: "#D2453B",
    });
  });

  it("carries no trace of the identities it replaced", () => {
    // The Savoir DNA (petrol teal, drafting paper, the brick negative), the
    // first electric-blue gear, the founder's violet, the Savoir blue and its
    // lift — and the blue CAST the greys carried while the blue was the accent.
    // A value surviving here would be the rebrand half-done.
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
      "#0B37E0",
      "#3E63FF",
      "#9BA0A5",
      "#6A6F74",
      "#5A5F64",
      "#868B90",
      "#0B0C0D",
      "#131416",
    ]) {
      expect(values, `${ditched} is from a ditched identity`).not.toContain(ditched);
    }
  });

  it("has exactly one accent, named for the product", () => {
    expect(RUNE_ACCENT_NAMES).toEqual(["rune"]);
    expect(Object.keys(RUNE_ACCENT_LABELS)).toEqual(["rune"]);
    expect(RUNE_ACCENT_LABELS.rune).toBe("Rune mono");
  });

  it("keeps every grey neutral: no hue anywhere in the chrome", () => {
    // Grounds, inks and hairlines, published and derived, at both finishes.
    const published = Object.entries(RUNE_PALETTE).filter(
      ([key]) => !["ok", "caution", "danger"].includes(key),
    );
    for (const [key, hex] of published) expect(isNeutral(hex), `palette.${key} ${hex}`).toBe(true);
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = RUNE_BASE_CSS[finish][base];
        for (const key of [
          "ground",
          "surface",
          "sunk",
          "raised",
          "ink",
          "ink2",
          "ink3",
          "inkFaint",
          "hairline",
          "hairlineStrong",
          "accent",
          "accentHover",
          "onAccent",
        ] as const) {
          expect(isNeutral(css[key]), `${finish}.${base}.${key} ${css[key]}`).toBe(true);
        }
      }
    }
  });

  it("keeps status to three colours, used for state and never as an accent", () => {
    expect(RUNE_STATUS_COLORS).toEqual([
      RUNE_PALETTE.ok,
      RUNE_PALETTE.caution,
      RUNE_PALETTE.danger,
    ]);
    expect(RUNE_STATUS_COLORS).toHaveLength(3);
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        expect(RUNE_STATUS_COLORS).not.toContain(accentFor(base, finish));
      }
    }
  });
});

describe("the accent is the ink", () => {
  it("paints the ground's own ink, at every finish, on both grounds", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = runeBaseCss(base, finish);
        expect(accentFor(base, finish)).toBe(css.ink);
        expect(runeAccentHex(base, "rune", finish)).toBe(css.ink);
      }
    }
  });

  it("is the published pole when crisp", () => {
    expect(accentFor("dark", "crisp")).toBe("#FFFFFF");
    expect(accentFor("light", "crisp")).toBe("#000000");
  });

  it("opens matte: the default finish is the founder's softer reading", () => {
    expect(DEFAULT_RUNE_FINISH).toBe("matte");
    expect(accentFor("dark")).toBe(accentFor("dark", "matte"));
    expect(runeTerminalRoles("dark")).toEqual(runeTerminalRoles("dark", "matte"));
  });

  it("knocks the ground out of the accent, legibly", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = runeBaseCss(base, finish);
        expect(css.onAccent).toBe(css.ground);
        expect(contrastRatio(css.onAccent, css.accent), `${finish}.${base}`).toBeGreaterThanOrEqual(
          7,
        );
      }
    }
  });
});

describe("the matte finish", () => {
  it("lands every ink on its contrast target, stepping from the ground", () => {
    for (const base of GROUNDS) {
      const css = runeBaseCss(base, "matte");
      const pole = base === "dark" ? RUNE_PALETTE.inkDark : RUNE_PALETTE.ink;
      const cases = [
        ["ink", css.ink, MATTE_CONTRAST.ink],
        ["ink2", css.ink2, MATTE_CONTRAST.ink2],
        ["ink3", css.ink3, MATTE_CONTRAST.ink3],
        ["line", css.hairlineStrong, MATTE_CONTRAST.line],
      ] as const;
      for (const [name, hex, target] of cases) {
        const ratio = contrastRatio(hex, css.ground);
        expect(ratio, `${base}.${name}`).toBeGreaterThanOrEqual(target);
        // The FIRST step that clears it, not an arbitrary brighter one: half a
        // step back toward the ground falls under the target.
        const t = [...Array(201).keys()].find(
          (i) => mixToward(css.ground, pole, i * 0.005) === hex.toUpperCase(),
        );
        expect(t, `${base}.${name} is on the ground-to-pole line`).toBeDefined();
        const back = mixToward(css.ground, pole, Math.max(0, (t! - 1) * 0.005));
        expect(contrastRatio(back, css.ground), `${base}.${name} one step back`).toBeLessThan(
          target,
        );
      }
    }
  });

  it("is softer than crisp at every step, and never below the floors", () => {
    for (const base of GROUNDS) {
      const matte = runeBaseCss(base, "matte");
      const crisp = runeBaseCss(base, "crisp");
      expect(contrastRatio(matte.ink, matte.ground)).toBeLessThan(
        contrastRatio(crisp.ink, crisp.ground),
      );
      expect(contrastRatio(matte.ink, matte.ground)).toBeGreaterThanOrEqual(12);
      expect(contrastRatio(matte.ink2, matte.ground)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(matte.ink3, matte.ground)).toBeGreaterThanOrEqual(3);
    }
  });

  it("the resolved matte table, so a target change is a reviewed diff", () => {
    const pick = (base: RuneBaseName) => {
      const c = runeBaseCss(base, "matte");
      return [c.ink, c.ink2, c.ink3, c.hairlineStrong, c.ok, c.caution, c.danger];
    };
    expect(pick("dark")).toEqual([
      "#D3D3D3",
      "#9B9B9B",
      "#717171",
      "#4A4A4A",
      "#488C65",
      "#A6803D",
      "#B66863",
    ]);
    expect(pick("light")).toEqual([
      "#2E2E2E",
      "#565656",
      "#7B7B7B",
      "#ABABAB",
      "#388459",
      "#90713A",
      "#B15E58",
    ]);
  });

  it("quiets each status hue, then holds it to the same text floor", () => {
    for (const base of GROUNDS) {
      const css = runeBaseCss(base, "matte");
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(css[role]).toBe(
          readableOn(desaturate(RUNE_PALETTE[role], MATTE_STATUS_SATURATION), css.surface, css.ink),
        );
        expect(saturation(css[role]), `${base}.${role}`).toBeLessThan(
          saturation(runeBaseCss(base, "crisp")[role]),
        );
      }
    }
  });
});

describe("the crisp finish", () => {
  it("derives the readable status variants rather than hand-picking two sets", () => {
    for (const base of GROUNDS) {
      const css = runeBaseCss(base, "crisp");
      const ink = base === "dark" ? RUNE_PALETTE.inkDark : RUNE_PALETTE.ink;
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(css[role]).toBe(readableOn(RUNE_PALETTE[role], css.surface, ink));
      }
    }
  });

  it("moves the status hue as little as the floor allows", () => {
    for (const base of GROUNDS) {
      const css = runeBaseCss(base, "crisp");
      for (const role of ["ok", "caution", "danger"] as const) {
        const [pr, pg, pb] = hexToRgbTuple(RUNE_PALETTE[role]);
        const [cr, cg, cb] = hexToRgbTuple(css[role]);
        const drift = Math.abs(pr - cr) + Math.abs(pg - cg) + Math.abs(pb - cb);
        expect(drift, `${base}.${role} drifted ${drift}`).toBeLessThan(140);
      }
    }
  });

  it("commits to black-and-white ink on off-pure grounds", () => {
    // Crisp is the pure poles. What keeps it off the aching pole is the
    // GROUND, which is never pure — paper is #FAFAFA, ink is #0C0C0C.
    expect(RUNE_PALETTE.ink).toBe("#000000");
    expect(RUNE_PALETTE.inkDark).toBe("#FFFFFF");
    expect(RUNE_PALETTE.ground).not.toBe("#FFFFFF");
    expect(RUNE_PALETTE.groundDark).not.toBe("#000000");
  });
});

describe("contrast", () => {
  it("body and secondary text clear WCAG AA on both grounds, both finishes", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = RUNE_BASE_CSS[finish][base];
        expect(
          contrastRatio(css.ink, css.surface),
          `${finish}.${base} body`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(css.ink2, css.ground),
          `${finish}.${base} secondary`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("tertiary clears AA-large — it carries meta, never prose", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = RUNE_BASE_CSS[finish][base];
        expect(
          contrastRatio(css.ink3, css.ground),
          `${finish}.${base} tertiary`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the accent clears the non-text floor on both grounds, both finishes", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = RUNE_BASE_CSS[finish][base];
        expect(
          contrastRatio(css.accent, css.ground),
          `${finish}.${base} accent`,
        ).toBeGreaterThanOrEqual(ACCENT_CONTRAST_FLOOR);
      }
    }
  });

  it("every status colour clears AA as TEXT on the ground it appears on", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const css = RUNE_BASE_CSS[finish][base];
        for (const role of ["ok", "caution", "danger"] as const) {
          expect(
            contrastRatio(css[role], css.surface),
            `${finish}.${base}.${role}`,
          ).toBeGreaterThanOrEqual(STATUS_CONTRAST_FLOOR);
        }
      }
    }
  });
});

describe("the terminal derivation", () => {
  it("resolves every role on both grounds, both finishes", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const roles = runeTerminalRoles(base, finish);
        for (const key of ["body", "dim", "accent", "ok", "warn", "danger", "line", "ground"]) {
          expect(roles[key], `${finish}.${base}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
        }
      }
    }
  });

  it("the console paints the accent the token source resolves, and it is the ink", () => {
    // One brand, one surface, one source. If the console ever carried its own
    // accent, a palette change here would leave the product looking different.
    for (const finish of RUNE_FINISHES) {
      for (const base of GROUNDS) {
        const roles = runeTerminalRoles(base, finish);
        expect(roles.accent).toBe(runeAccentHex(base, "rune", finish));
        expect(roles.accent).toBe(roles.body);
      }
    }
  });

  it("composites translucency deterministically, because a terminal has no alpha", () => {
    expect(solidOver("#FAFAF8", "#000000")).toBe("#FAFAF8");
    expect(solidOver("rgba(255, 255, 255, 0.08)", "#111318")).toBe(
      solidOver("rgba(255,255,255,.08)", "#111318"),
    );
  });

  it("the two grounds are genuinely inverted, not two shades of the same", () => {
    for (const finish of RUNE_FINISHES) {
      expect(luminance(runeTerminalPalette("light", finish).bg)).toBeGreaterThan(0.6);
      expect(luminance(runeTerminalPalette("dark", finish).bg)).toBeLessThan(0.05);
    }
  });
});

// The syntax palette: nine reading-aid colours for code, kept OUTSIDE the
// brand palette (pinned verbatim above) and held to the same text floor. The
// monochrome pass does not touch it — code is read in colour.
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
  it("is the code palette it was: the monochrome pass left code alone", () => {
    expect(RUNE_SYNTAX.light.constant).toBe("#0000FF");
    expect(RUNE_SYNTAX.light.property).toBe("#001080");
    expect(RUNE_SYNTAX.dark.constant).toBe("#569CD6");
    expect(RUNE_SYNTAX.dark.property).toBe("#9CDCFE");
  });
});

// The diff bands: the founder's swatches on ink, the one kept blue on paper.
import { RUNE_DIFF_BANDS, diffBands } from "../../../packages/shared/src/design-tokens";

describe("the diff bands", () => {
  it("keeps the ONE blue: light mode's added-line band, byte for byte, at every finish", () => {
    // Founder, 2026-09-26: "the only place I want blue colour is in light mode
    // when the code outputs gets produced in blue ... do not change it".
    expect(RUNE_DIFF_BANDS.light.added).toBe("#1936D7");
    for (const finish of RUNE_FINISHES) {
      expect(diffBands("light", finish)).toEqual(RUNE_DIFF_BANDS.light);
    }
  });
  it("lays an added row on the opposite ground: the ink on ink, at the finish's strength", () => {
    expect(RUNE_DIFF_BANDS.dark).toEqual({ added: RUNE_PALETTE.inkDark, removed: "#370603" });
    expect(diffBands("dark", "crisp")).toEqual(RUNE_DIFF_BANDS.dark);
    expect(diffBands("dark", "matte")).toEqual({
      added: runeBaseCss("dark", "matte").ink,
      removed: "#370603",
    });
  });
  it("keeps one ink pole legible on every band", () => {
    for (const finish of RUNE_FINISHES) {
      for (const base of ["light", "dark"] as const) {
        for (const band of Object.values(diffBands(base, finish))) {
          const pole = Math.max(contrastRatio("#000000", band), contrastRatio("#FFFFFF", band));
          expect(pole, `${finish}.${base} ${band}`).toBeGreaterThanOrEqual(7);
        }
      }
    }
  });
});
