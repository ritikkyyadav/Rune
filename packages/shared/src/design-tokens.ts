// ─── Gear design tokens — the ONE pigment source ───
//
// `gear-customizer-v2.html` (repo root) is the product contract; this module is
// its machine-readable form. Every surface derives from here:
//
//   • CLI/TUI:   packages/orchestrator/src/bin/ui/themes.ts builds the ten
//                `gear*` terminal themes from gearTerminalPalette().
//   • Desktop:   scripts/generate-tokens-css.ts emits tokens.css with the same
//                [data-theme-base][data-accent] attribute API as the prototype.
//   • Guardrail: tests/unit/shared/design-tokens-parity.test.ts regex-extracts
//                the hexes from the HTML and fails on ANY divergence.
//
// Values are verbatim CSS strings from the v2 HTML (hex or rgba). Terminal
// consumers need solid colors, so rgba values are composited over the card
// background by gearTerminalPalette() — deterministically, at build time.
// Pure data + pure functions. No dependencies.

export type GearAccentName = "cobalt" | "orange" | "violet" | "emerald" | "mono";

export const GEAR_ACCENT_NAMES: readonly GearAccentName[] = [
  "cobalt",
  "orange",
  "violet",
  "emerald",
  "mono",
] as const;

export const GEAR_ACCENT_LABELS: Record<GearAccentName, string> = {
  cobalt: "Electric Cobalt",
  orange: "Cyber Orange",
  violet: "Hyper Violet",
  emerald: "Emerald Matrix",
  mono: "Stark Monochrome",
};

export type GearBaseName = "light" | "dark";

/** Raw CSS custom-property values for one base, verbatim from the v2 HTML. */
export interface GearBaseCss {
  canvasBg: string;
  cardBg: string;
  textMain: string;
  textSub: string;
  textMuted: string;
  textFaint: string;
  ochre: string;
  green: string;
  red: string;
  barBg: string;
  barHover: string;
  barActive: string;
  hairline: string;
  codeBg: string;
  codeTag: string;
  diffBg: string;
  diffHdr: string;
  popoverBg: string;
  kbdBg: string;
}

/** [data-theme-base="light"] and [data-theme-base="dark"] from the contract. */
export const GEAR_BASE_CSS: Record<GearBaseName, GearBaseCss> = {
  light: {
    canvasBg: "#CCD8D1",
    cardBg: "#FAF9F6",
    textMain: "#1A1917",
    textSub: "#524F48",
    textMuted: "#7A766D",
    textFaint: "#B5B1A8",
    ochre: "#946E2B",
    green: "#237845",
    red: "#C24136",
    barBg: "#F1EFEA",
    barHover: "#EAE7E0",
    barActive: "#E2DFD6",
    hairline: "#E5E2DB",
    codeBg: "#F0EEE8",
    codeTag: "#EFECE5",
    diffBg: "#F3F1EB",
    diffHdr: "#ECE9E2",
    popoverBg: "#FFFFFF",
    kbdBg: "#FFFFFF",
  },
  dark: {
    canvasBg: "#000000",
    cardBg: "#0A0A0C",
    textMain: "#FFFFFF",
    textSub: "#A6A6AC",
    textMuted: "#74747B",
    textFaint: "#45454C",
    ochre: "#FBBF24",
    green: "#4ADE80",
    red: "#F87171",
    barBg: "#121215",
    barHover: "#1A1A1E",
    barActive: "#24242A",
    hairline: "rgba(255, 255, 255, 0.08)",
    codeBg: "#0F0F12",
    codeTag: "#17171C",
    diffBg: "#0C0C0F",
    diffHdr: "#151518",
    popoverBg: "#101014",
    kbdBg: "#1A1A1F",
  },
};

/** Accent pigment per base — [data-accent] and [data-theme-base="dark"][data-accent]. */
export const GEAR_ACCENT_CSS: Record<GearBaseName, Record<GearAccentName, string>> = {
  light: {
    cobalt: "#0038FF",
    orange: "#FF5500",
    violet: "#7C3AED",
    emerald: "#059669",
    mono: "#1A1917",
  },
  dark: {
    cobalt: "#3875FF",
    orange: "#FF6E26",
    violet: "#A78BFA",
    emerald: "#10B981",
    mono: "#FFFFFF",
  },
};

/** Non-color scale constants from `:root` — for the desktop CSS emitter. */
export const GEAR_SCALE = {
  fontMono: "'Geist Mono', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace",
  ease: "cubic-bezier(0.16, 1, 0.3, 1)",
  radiusCard: "20px",
  radiusPanel: "12px",
  radiusItem: "8px",
  radiusChip: "6px",
} as const;

// ─── Solid-color derivation for terminal consumers ───

export type Rgb = [number, number, number];

export function hexToRgbTuple(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbTupleToHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/**
 * Resolve a CSS color (hex or rgba(...)) to a solid hex by alpha-compositing it
 * over `baseHex`. Terminals have no alpha channel, so a translucent contract
 * value becomes the exact color a browser would paint on the card background.
 */
export function solidOver(cssColor: string, baseHex: string): string {
  const trimmed = cssColor.trim();
  if (trimmed.startsWith("#")) return trimmed.toUpperCase();
  const match = trimmed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!match) return baseHex.toUpperCase();
  const [, r, g, b, a] = match;
  const alpha = a === undefined ? 1 : Number(a);
  const base = hexToRgbTuple(baseHex);
  const fg: Rgb = [Number(r), Number(g), Number(b)];
  return rgbTupleToHex([
    fg[0] * alpha + base[0] * (1 - alpha),
    fg[1] * alpha + base[1] * (1 - alpha),
    fg[2] * alpha + base[2] * (1 - alpha),
  ]);
}

/** Solid hexes for one base, in the terminal theme's slot vocabulary. */
export interface GearTerminalPalette {
  bg: string;
  canvas: string;
  text: string;
  muted: string;
  faint: string;
  /** Semantic red (errors / removals) — distinct from the cosmetic accent. */
  red: string;
  ochre: string;
  green: string;
  line: string;
  surfaces: {
    card: string;
    bar: string;
    barActive: string;
    code: string;
    diff: string;
    diffHeader: string;
    popover: string;
    hairline: string;
  };
}

/**
 * The contract's base variables mapped onto the terminal slot vocabulary:
 * text←text-main, muted←text-sub, faint←text-muted, line←text-faint. Any
 * translucent value is composited over the card background.
 */
export function gearTerminalPalette(base: GearBaseName): GearTerminalPalette {
  const css = GEAR_BASE_CSS[base];
  const over = (value: string) => solidOver(value, css.cardBg);
  return {
    bg: over(css.cardBg),
    canvas: over(css.canvasBg),
    text: over(css.textMain),
    muted: over(css.textSub),
    faint: over(css.textMuted),
    red: over(css.red),
    ochre: over(css.ochre),
    green: over(css.green),
    line: over(css.textFaint),
    surfaces: {
      card: over(css.cardBg),
      bar: over(css.barBg),
      barActive: over(css.barActive),
      code: over(css.codeBg),
      diff: over(css.diffBg),
      diffHeader: over(css.diffHdr),
      popover: over(css.popoverBg),
      hairline: over(css.hairline),
    },
  };
}

/** Accent hex for one base/accent pair (always solid in the contract). */
export function gearAccentHex(base: GearBaseName, accent: GearAccentName): string {
  return GEAR_ACCENT_CSS[base][accent].toUpperCase();
}
