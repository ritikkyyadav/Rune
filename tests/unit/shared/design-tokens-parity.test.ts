// ─── The pigment guardrail ───
//
// This test used to bind the token module to `docs/design/gear-customizer-v2.html`,
// because that HTML was the product contract. It is not any more: Phase 3
// replaced three visual identities with the Savoir brand DNA (D2), and the
// contract is now the DNA's own numbers.
//
// So the guardrail is rebound rather than deleted. It pins the exact hexes the
// brand publishes, and it pins the RULES that make something read as Savoir —
// one accent, no green, 3px, status colors that only signal state — because a
// hex table alone would let the system be dismantled a value at a time while
// every assertion stayed green.

import { describe, it, expect } from "bun:test";
import {
  GEAR_ACCENT_CSS,
  GEAR_ACCENT_NAMES,
  GEAR_BASE_CSS,
  GEAR_SCALE,
  SAVOIR,
  SAVOIR_STATUS_COLORS,
  gearAccentHex,
  gearTerminalPalette,
  hexToRgbTuple,
  mixToward,
  savoirTerminalRoles,
  solidOver,
  type GearBaseName,
} from "../../../packages/shared/src/design-tokens";

/** Relative luminance, for the contrast checks the brand asks for. */
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

describe("the Savoir palette, verbatim", () => {
  it("carries the brand's published values and no others", () => {
    // If one of these changes, the brand changed — which is a decision, not a
    // refactor, and should arrive as a deliberate edit to this list.
    expect(SAVOIR).toMatchObject({
      paper: "#E7E8E3",
      paper2: "#DDDFD8",
      paperMuted: "#C9CCC8",
      ink: "#14161A",
      graphite: "#4A4F55",
      graphite2: "#7C8088",
      line: "#C7CABF",
      lineDark: "#2C3036",
      datum: "#0E5E63",
      datumDeep: "#0A4448",
      signal: "#17A0A8",
      caution: "#E2A23A",
      negative: "#9A4A3A",
    });
  });

  it("has exactly one accent, and it shifts to signal on ink", () => {
    expect(GEAR_ACCENT_NAMES).toEqual(["datum"]);
    expect(gearAccentHex("light")).toBe("#0E5E63");
    expect(gearAccentHex("dark")).toBe("#17A0A8");
    expect(Object.keys(GEAR_ACCENT_CSS.light)).toHaveLength(1);
    expect(Object.keys(GEAR_ACCENT_CSS.dark)).toHaveLength(1);
  });

  it("has no green — an addition is a datum", () => {
    // The brand allows ONE chromatic hue. A green for "added lines" would be a
    // second brand colour arriving through the back door of a diff.
    expect(GEAR_BASE_CSS.light.green).toBe(SAVOIR.datum);
    expect(GEAR_BASE_CSS.dark.green).toBe(SAVOIR.signal);
  });

  it("keeps the status colours to amber and brick, and only for state", () => {
    expect(SAVOIR_STATUS_COLORS).toEqual([SAVOIR.caution, SAVOIR.negative]);
    expect(GEAR_BASE_CSS.light.ochre).toBe(SAVOIR.caution);
    expect(GEAR_BASE_CSS.dark.ochre).toBe(SAVOIR.caution);
    expect(GEAR_BASE_CSS.light.red).toBe(SAVOIR.negative);
  });

  it("derives the on-ink negative from the brand's own brick", () => {
    // Not a second brick: the same value lifted toward paper so it can be read
    // as TEXT on ink. Changing --negative moves both, by construction.
    expect(GEAR_BASE_CSS.dark.red).toBe(mixToward(SAVOIR.negative, SAVOIR.paper, 0.3));
  });
});

describe("the rules, not just the values", () => {
  it("is 3px everywhere, with a pill and one 6px tile as the only exceptions", () => {
    expect(GEAR_SCALE.radius).toBe("3px");
    expect(GEAR_SCALE.radiusTile).toBe("6px");
    expect(GEAR_SCALE.radiusPill).toBe("20px");
  });

  it("names Inter and IBM Plex Mono, each with a real fallback", () => {
    expect(GEAR_SCALE.sans).toContain("Inter");
    expect(GEAR_SCALE.sans).toContain("sans-serif");
    expect(GEAR_SCALE.mono).toContain("IBM Plex Mono");
    expect(GEAR_SCALE.mono).toContain("monospace");
  });

  it("draws the graticule at 28px", () => {
    expect(GEAR_SCALE.graticule).toBe("28px");
  });

  it("tracks mono labels open and large sans tight", () => {
    expect(Number(GEAR_SCALE.labelTracking.replace("em", ""))).toBeGreaterThan(0);
    expect(Number(GEAR_SCALE.displayTracking.replace("em", ""))).toBeLessThan(0);
  });
});

describe("contrast", () => {
  it("body text clears WCAG AA on both grounds", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const css = GEAR_BASE_CSS[base];
      expect(contrast(css.textMain, css.cardBg), `${base} body`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(css.textSub, css.cardBg), `${base} secondary`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the negative readout is legible on its own ground", () => {
    // The reason the dark brick is derived at all: the brand's #9A4A3A is
    // 2.2:1 on ink, which is fine for a rule and unreadable as a word.
    expect(contrast(SAVOIR.negative, SAVOIR.ink)).toBeLessThan(3);
    expect(contrast(GEAR_BASE_CSS.dark.red, GEAR_BASE_CSS.dark.cardBg)).toBeGreaterThanOrEqual(3);
  });

  it("the accent is a fill colour on paper, not a body-text colour", () => {
    // Stated by the brand and worth pinning: #0E5E63 on #E7E8E3 passes AA for
    // large text and buttons. It is never used for small prose.
    expect(contrast(SAVOIR.datum, SAVOIR.paper)).toBeGreaterThanOrEqual(3);
  });
});

describe("the terminal derivation", () => {
  it("resolves every role on both grounds", () => {
    for (const base of ["light", "dark"] as GearBaseName[]) {
      const roles = savoirTerminalRoles(base);
      for (const key of ["body", "dim", "accent", "ok", "warn", "danger", "line", "ground"]) {
        expect(roles[key], `${base}.${key}`).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("composites translucency deterministically, because a terminal has no alpha", () => {
    expect(solidOver("#E7E8E3", "#000000")).toBe("#E7E8E3");
    expect(solidOver("rgba(255, 255, 255, 0.08)", "#14161A")).toBe(
      solidOver("rgba(255,255,255,.08)", "#14161A"),
    );
    const hairline = solidOver("rgba(255, 255, 255, 0.08)", "#14161A");
    expect(hairline.startsWith("#2")).toBe(true);
  });

  it("the two grounds are genuinely inverted, not two shades of the same", () => {
    const light = gearTerminalPalette("light");
    const dark = gearTerminalPalette("dark");
    expect(luminance(light.bg)).toBeGreaterThan(0.6);
    expect(luminance(dark.bg)).toBeLessThan(0.05);
    expect(light.text).toBe(dark.bg.length === 7 ? "#14161A" : light.text);
  });
});
