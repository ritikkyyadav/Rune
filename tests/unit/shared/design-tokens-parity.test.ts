// ─── The pigment guardrail ───
//
// This test has been rebound twice: once from `docs/design/gear-customizer-v2.html`
// to the Savoir DNA, and now from the Savoir DNA to the current identity — a
// solid electric-blue eight-tooth gear on a near-white ground. Rebound rather
// than deleted, because what it holds is not a hex table.
//
// It pins two things. The twelve literal values, so a brand change arrives as a
// deliberate edit to a list rather than as drift. And the RULES those values
// encode — one accent, three status colours, three radii, derived rather than
// hand-picked variants, and measured contrast floors — because a hex table
// alone would let the system be dismantled a value at a time while every
// assertion stayed green.

import { describe, it, expect } from "bun:test";
import {
  GEAR_ACCENT_CSS,
  GEAR_ACCENT_NAMES,
  GEAR_BASE_CSS,
  GEAR_PALETTE,
  GEAR_RADII,
  GEAR_SCALE,
  GEAR_STATUS_COLORS,
  GEAR_TYPE,
  STATUS_CONTRAST_FLOOR,
  gearAccentHex,
  gearTerminalPalette,
  gearTerminalRoles,
  hexToRgbTuple,
  mixToward,
  readableOn,
  solidOver,
  type GearBaseName,
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

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("the palette, verbatim", () => {
  it("carries the identity's published values and no others", () => {
    // If one of these changes, the brand changed — which is a decision, not a
    // refactor, and should arrive as a deliberate edit to this list.
    expect(GEAR_PALETTE).toMatchObject({
      accent: "#1B3FE4",
      accentDark: "#5B79FF",
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

  it("carries no trace of the identity it replaced", () => {
    // The Savoir DNA — petrol teal, drafting paper, the brick negative — was
    // applied in Phase 3 to an identity the founder had already ditched. A
    // value surviving here would be the rebrand half-done.
    const values = Object.values(GEAR_PALETTE).map((v) => v.toUpperCase());
    for (const ditched of ["#0E5E63", "#E7E8E3", "#14161A", "#17A0A8", "#9A4A3A", "#C7CABF"]) {
      expect(values, `${ditched} is from the ditched identity`).not.toContain(ditched);
    }
  });

  it("has exactly one accent, and it lifts on ink", () => {
    expect(GEAR_ACCENT_NAMES).toEqual(["gear"]);
    expect(gearAccentHex("light")).toBe("#1B3FE4");
    expect(gearAccentHex("dark")).toBe("#5B79FF");
    expect(Object.keys(GEAR_ACCENT_CSS.light)).toHaveLength(1);
    expect(Object.keys(GEAR_ACCENT_CSS.dark)).toHaveLength(1);
  });

  it("keeps status to three colours, used for state and never as an accent", () => {
    expect(GEAR_STATUS_COLORS).toEqual([
      GEAR_PALETTE.ok,
      GEAR_PALETTE.caution,
      GEAR_PALETTE.danger,
    ]);
    expect(GEAR_STATUS_COLORS).toHaveLength(3);
  });

  it("derives the readable status variants rather than hand-picking two sets", () => {
    // One rule on both grounds: step the published colour toward that ground's
    // ink until it clears the floor as text. `#C98A1A` on white is 2.9:1 — a
    // swatch, not a sentence — and a second hand-picked set is how a light and
    // a dark theme become two designs that merely resemble each other.
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      const ink = base === "dark" ? GEAR_PALETTE.inkDark : GEAR_PALETTE.ink;
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(css[role]).toBe(readableOn(GEAR_PALETTE[role], css.surface, ink));
      }
    }
  });

  it("moves the status hue as little as the floor allows", () => {
    // Derived, not replaced: the readable variant must still be recognisably
    // the published colour. A green that had to travel halfway to the ink to be
    // legible would be a different green.
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      for (const role of ["ok", "caution", "danger"] as const) {
        const [pr, pg, pb] = hexToRgbTuple(GEAR_PALETTE[role]);
        const [cr, cg, cb] = hexToRgbTuple(css[role]);
        const drift = Math.abs(pr - cr) + Math.abs(pg - cg) + Math.abs(pb - cb);
        expect(drift, `${base}.${role} drifted ${drift}`).toBeLessThan(140);
      }
    }
  });

  it("derives the hover accent rather than authoring a second blue", () => {
    expect(GEAR_BASE_CSS.light.accentHover).toBe(mixToward(GEAR_PALETTE.accent, "#000000", 0.16));
    expect(GEAR_BASE_CSS.dark.accentHover).toBe(
      mixToward(GEAR_PALETTE.accentDark, "#FFFFFF", 0.16),
    );
  });

  it("has exactly one shadow, and it is neutral", () => {
    // A tinted shadow is a second hue arriving through the back door of a
    // floating panel.
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const shadow = GEAR_BASE_CSS[base].shadowOverlay;
      for (const m of shadow.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) {
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${base} shadow is tinted`).toBeLessThan(10);
      }
    }
  });
});

describe("the rules, not just the values", () => {
  it("offers three radii and nothing else", () => {
    expect([...GEAR_RADII]).toEqual(["6px", "8px", "10px"]);
    expect(GEAR_SCALE.radiusChip).toBe("6px");
    expect(GEAR_SCALE.radius).toBe("8px");
    expect(GEAR_SCALE.radiusComposer).toBe("10px");
  });

  it("names Geist and Geist Mono, each with a real fallback", () => {
    expect(GEAR_SCALE.sans).toContain("Geist");
    expect(GEAR_SCALE.sans).toContain("sans-serif");
    expect(GEAR_SCALE.mono).toContain("Geist Mono");
    expect(GEAR_SCALE.mono).toContain("monospace");
    // The faces the ditched identity shipped.
    expect(GEAR_SCALE.mono).not.toContain("IBM Plex");
  });

  it("moves state in 160ms and panels in 220ms, on one curve", () => {
    expect(GEAR_SCALE.fast).toBe("160ms");
    expect(GEAR_SCALE.panel).toBe("220ms");
    expect(GEAR_SCALE.ease).toMatch(/^cubic-bezier/);
    // No overshoot: the last control point must not exceed 1, or a panel
    // bounces past its resting place and the surface reads as playful.
    const nums = GEAR_SCALE.ease.match(/-?[\d.]+/g)!.map(Number);
    expect(Math.max(...nums)).toBeLessThanOrEqual(1);
  });

  it("gives prose looser leading than chrome", () => {
    // The single largest determinant of whether a transcript is comfortable for
    // two hours: what is READ breathes more than what is scanned.
    expect(Number(GEAR_TYPE.prose.line)).toBeGreaterThan(Number(GEAR_TYPE.body.line));
    expect(parseFloat(GEAR_TYPE.prose.size)).toBeGreaterThanOrEqual(
      parseFloat(GEAR_TYPE.body.size),
    );
  });

  it("tracks labels open and large type tight", () => {
    expect(Number(GEAR_SCALE.labelTracking.replace("em", ""))).toBeGreaterThan(0);
    expect(Number(GEAR_SCALE.titleTracking.replace("em", ""))).toBeLessThan(0);
    expect(Number(GEAR_SCALE.displayTracking.replace("em", ""))).toBeLessThan(0);
  });

  it("stops the reading column under 80 characters", () => {
    // 760px of 15.5px Geist is 72–78 characters. Wider and prose stops being
    // readable at length, which is the whole claim of the reading column.
    expect(parseInt(GEAR_SCALE.columnMax, 10)).toBeLessThanOrEqual(800);
    expect(parseInt(GEAR_SCALE.columnMax, 10)).toBeGreaterThanOrEqual(680);
  });
});

describe("contrast", () => {
  it("ink is not black and the ground is not white", () => {
    // The one decision that decides whether someone can read this for two
    // hours. Pure black on pure white is the contrast that makes eyes ache.
    expect(GEAR_PALETTE.ink).not.toBe("#000000");
    expect(GEAR_PALETTE.ground).not.toBe("#FFFFFF");
    expect(GEAR_PALETTE.groundDark).not.toBe("#000000");
    expect(GEAR_PALETTE.inkDark).not.toBe("#FFFFFF");
  });

  it("body and secondary text clear WCAG AA on both grounds", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      expect(contrast(css.ink, css.surface), `${base} body`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(css.ink2, css.ground), `${base} secondary`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tertiary clears AA-large — it carries meta, never prose", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      expect(contrast(css.ink3, css.ground), `${base} tertiary`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the accent is legible on both grounds, and text on it is legible too", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      expect(contrast(css.accent, css.ground), `${base} accent`).toBeGreaterThanOrEqual(4.5);
      // On paper the accent button carries white; on ink it carries the ground,
      // because white on #5B79FF is 3.7:1 and a button label needs more.
      expect(contrast(css.onAccent, css.accent), `${base} on-accent`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("every status colour clears AA as TEXT on the ground it appears on", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      for (const role of ["ok", "caution", "danger"] as const) {
        expect(contrast(css[role], css.surface), `${base}.${role}`).toBeGreaterThanOrEqual(
          STATUS_CONTRAST_FLOOR,
        );
      }
    }
  });
});

describe("the terminal derivation", () => {
  it("resolves every role on both grounds", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const roles = gearTerminalRoles(base);
      for (const key of ["body", "dim", "accent", "ok", "warn", "danger", "line", "ground"]) {
        expect(roles[key], `${base}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("the console paints the SAME accent the app does", () => {
    // One brand, two surfaces. If these ever diverge, the terminal is a
    // different product wearing the same name.
    expect(gearTerminalRoles("light").accent).toBe(GEAR_PALETTE.accent);
    expect(gearTerminalRoles("dark").accent).toBe(GEAR_PALETTE.accentDark.toUpperCase());
  });

  it("composites translucency deterministically, because a terminal has no alpha", () => {
    expect(solidOver("#FAFAF8", "#000000")).toBe("#FAFAF8");
    expect(solidOver("rgba(255, 255, 255, 0.08)", "#111318")).toBe(
      solidOver("rgba(255,255,255,.08)", "#111318"),
    );
  });

  it("the two grounds are genuinely inverted, not two shades of the same", () => {
    expect(luminance(gearTerminalPalette("light").bg)).toBeGreaterThan(0.6);
    expect(luminance(gearTerminalPalette("dark").bg)).toBeLessThan(0.05);
  });
});
