// ─── Gear design tokens — the ONE pigment source ───
//
// Every surface reads from here:
//
//   • The app:   scripts/generate-tokens-css.ts emits apps/web/src/styles/tokens.css.
//   • Console:   packages/orchestrator/src/bin/ui/themes.ts builds the two
//                terminal modes from gearTerminalPalette(), 24-bit with a
//                derived ANSI-256 fallback.
//   • Guardrail: tests/unit/shared/design-tokens-parity.test.ts pins these
//                values and the rules they encode; tests/unit/brand-checklist.test.ts
//                checks the BUILT stylesheet.
//
// What this replaced, and why it is a deletion rather than a re-skin: Phase 3
// applied a previous identity — drafting paper, petrol teal, a plex mono, a
// block cursor, a 28px dot grid — that the founder had already ditched. See
// docs/program/09-web-product.md. Nothing below descends from it, and the brand
// checklist fails on any byte of it that survives anywhere.
//
// The identity is a solid electric-blue eight-tooth gear on a near-white
// ground, and the rules that make a surface read as it does, in the order they
// bite: ink is not black and the ground is not white; every border is one
// hairline at 1px; one accent, under 5% of any screen, never carrying text; a
// shadow only on things that float; radii from {6, 8, 10}; Geist for voice and
// Geist Mono for the record; tabular numerals wherever numbers align.
//
// Twelve literal values. Everything else is a function of them — so a change to
// the brand is a change to twelve lines, and the relationships cannot drift.
//
// Pure data + pure functions. No dependencies.

// ─── Color math ───

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
  const part = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/**
 * Resolve a CSS color (hex or rgba) to a solid hex by compositing it over
 * `baseHex`. Terminals have no alpha channel, so a translucent value becomes
 * the exact color a browser would paint on that ground.
 */
export function solidOver(cssColor: string, baseHex: string): string {
  const trimmed = cssColor.trim();
  if (trimmed.startsWith("#")) return trimmed.toUpperCase();
  const match = trimmed.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/,
  );
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

/** Move `from` a fraction of the way toward `toward`. The system's one lever. */
export function mixToward(from: string, toward: string, amount: number): string {
  const a = hexToRgbTuple(from);
  const b = hexToRgbTuple(toward);
  return rgbTupleToHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

// ─── The twelve literals ───
//
// Sampled from the mark and the ground it sits on. Every other colour in the
// product is one of these or `mixToward` of two of them.

export const GEAR_PALETTE = {
  /** THE accent, on paper. The blue of the mark. */
  accent: "#1B3FE4",
  /** THE accent, on ink. The same identity at a legible weight on a dark ground. */
  accentDark: "#5B79FF",

  /** Light ground, surface, sunk. Never pure white. */
  ground: "#FAFAF8",
  surface: "#FFFFFF",
  sunk: "#F3F3F1",
  /** Light ink, in three steps. Never pure black. */
  ink: "#111318",
  ink2: "#5B6070",
  ink3: "#8B909C",
  /** The one border colour on paper. */
  hairline: "#E6E6E2",

  /** Dark ground, surface, sunk. */
  groundDark: "#0F1114",
  surfaceDark: "#15181D",
  sunkDark: "#0B0D10",
  /** Dark ink, in three steps. */
  inkDark: "#E8E9EC",
  ink2Dark: "#A2A7B3",
  ink3Dark: "#6C717D",
  /** The one border colour on ink. */
  hairlineDark: "#232730",

  /** Status. State only, never decoration, never an accent. */
  ok: "#1F9D55",
  caution: "#C98A1A",
  danger: "#D2453B",
} as const;

/**
 * The status colours, named as a set.
 *
 * The brand checklist allows exactly one chromatic hue outside these. Naming
 * the exception list here rather than in the test is deliberate: a designer
 * adding a status colour has to add it to the system, not to the assertion.
 */
export const GEAR_STATUS_COLORS = [
  GEAR_PALETTE.ok,
  GEAR_PALETTE.caution,
  GEAR_PALETTE.danger,
] as const;

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgbTuple(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two solid colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The floor every status colour must clear as TEXT on its own surface. */
export const STATUS_CONTRAST_FLOOR = 4.5;

/**
 * The same colour, moved far enough toward the ink to be read on that ground.
 *
 * The identity publishes three status colours, and a status colour in this
 * product is usually a WORD — "refused", "3 checks failed" — not a rule or a
 * fill. `#C98A1A` on white is 2.9:1, which is a swatch, not a sentence.
 *
 * So the readable variant is DERIVED by one rule on both grounds rather than
 * hand-picked twice: step toward the ground's ink in 2% increments until the
 * ratio clears the floor. On paper that darkens; on ink it lightens; the hue
 * does not move, and changing a published status colour moves both grounds by
 * construction. A hand-picked second set is how a light theme and a dark theme
 * become two designs that merely resemble each other.
 */
export function readableOn(
  hex: string,
  surface: string,
  ink: string,
  floor = STATUS_CONTRAST_FLOOR,
): string {
  for (let step = 0; step <= 50; step++) {
    const candidate = mixToward(hex, ink, step * 0.02);
    if (contrastRatio(candidate, surface) >= floor) return candidate;
  }
  return ink;
}

// ─── The two grounds ───

export type GearBaseName = "light" | "dark";

/**
 * One accent.
 *
 * The union survives with a single member on purpose: `[ui] accent` remains as
 * an undocumented override for anyone maintaining a custom build, and a type
 * that can only ever be `"gear"` says the shape of the decision instead of
 * deleting the seam and pretending there was never a choice.
 */
export type GearAccentName = "gear";

export const GEAR_ACCENT_NAMES: readonly GearAccentName[] = ["gear"] as const;

export const GEAR_ACCENT_LABELS: Record<GearAccentName, string> = {
  gear: "Gear blue",
};

/** Raw CSS custom-property values for one ground. */
export interface GearBaseCss {
  /** The page. */
  ground: string;
  /** Cards, the composer, the sidebar head — one step above the ground. */
  surface: string;
  /** Code, diffs, wells — one step below it. */
  sunk: string;
  /** A hover tint. The only other surface level there is. */
  raised: string;
  /** Body and prose. */
  ink: string;
  /** Secondary: labels, sublines, inactive tabs. */
  ink2: string;
  /** Tertiary: timestamps, ids, counts. Meta only, never prose. */
  ink3: string;
  /** Quieter than tertiary: disabled text, tree guides. Never a sentence. */
  inkFaint: string;
  /** Every border in the product. One weight: 1px. */
  hairline: string;
  /** The same rule, one step firmer, where a card edge meets a filled header. */
  hairlineStrong: string;
  accent: string;
  /** One step darker on paper, one step lighter on ink. */
  accentHover: string;
  /** Text and glyphs ON the accent. */
  onAccent: string;
  ok: string;
  caution: string;
  danger: string;
  /** The single shadow token. Legal on floating overlays and nowhere else. */
  shadowOverlay: string;
}

function baseFor(base: GearBaseName): GearBaseCss {
  const p = GEAR_PALETTE;
  const dark = base === "dark";
  const ground = dark ? p.groundDark : p.ground;
  const ink = dark ? p.inkDark : p.ink;
  const ink3 = dark ? p.ink3Dark : p.ink3;
  const accent = dark ? p.accentDark : p.accent;
  const surface = dark ? p.surfaceDark : p.surface;
  const status = (hex: string) => readableOn(hex, surface, ink);
  return {
    ground,
    surface,
    sunk: dark ? p.sunkDark : p.sunk,
    // A hover is a surface that moved one step toward the text, not a new
    // colour: eight percent is the smallest move a person notices and the
    // largest that still reads as "the same row".
    raised: mixToward(surface, ink, 0.06),
    ink,
    ink2: dark ? p.ink2Dark : p.ink2,
    ink3,
    inkFaint: mixToward(ink3, ground, dark ? 0.4 : 0.45),
    hairline: dark ? p.hairlineDark : p.hairline,
    hairlineStrong: mixToward(dark ? p.hairlineDark : p.hairline, ink, 0.35),
    accent,
    accentHover: mixToward(accent, dark ? "#FFFFFF" : "#000000", 0.16),
    // White on the paper accent is 7.3:1. White on the ink accent is 3.7:1 —
    // not enough for a button label — so on ink the accent carries the ground
    // instead, at 5.2:1. The accent never carries text; text sits on it.
    onAccent: dark ? p.sunkDark : "#FFFFFF",
    ok: status(p.ok),
    caution: status(p.caution),
    danger: status(p.danger),
    // Two layers, one soft and one tight, so a floating panel has an edge as
    // well as a lift. Neutral by construction: a tinted shadow is a second
    // hue arriving through the back door.
    shadowOverlay: dark
      ? "0 12px 32px rgba(0, 0, 0, 0.48), 0 2px 6px rgba(0, 0, 0, 0.32)"
      : "0 12px 32px rgba(16, 18, 22, 0.10), 0 2px 6px rgba(16, 18, 22, 0.06)",
  };
}

/** `:root` and `:root[data-theme="dark"]`. */
export const GEAR_BASE_CSS: Record<GearBaseName, GearBaseCss> = {
  light: baseFor("light"),
  dark: baseFor("dark"),
};

/** The accent per ground. */
export const GEAR_ACCENT_CSS: Record<GearBaseName, Record<GearAccentName, string>> = {
  light: { gear: GEAR_PALETTE.accent },
  dark: { gear: GEAR_PALETTE.accentDark },
};

/**
 * Non-colour scale constants.
 *
 * Three radii and nothing else: 6 for chips and inline tags, 8 for cards,
 * fields, buttons and panels, 10 for the composer — the one element that should
 * read as the softest thing on the page. A circle (`50%`) is a circle, not a
 * corner, and is allowed for status dots.
 */
export const GEAR_SCALE = {
  sans: "'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  mono: "'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  /** One curve. Decelerating, no overshoot: work finishing, not a thing arriving. */
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  /** A state change. */
  fast: "160ms",
  /** A panel sliding. */
  panel: "220ms",
  radiusChip: "6px",
  radius: "8px",
  radiusComposer: "10px",
  /** Labels open slightly; large type tightens as it grows. */
  labelTracking: "0.02em",
  titleTracking: "-0.015em",
  displayTracking: "-0.02em",
  /** Layout constants the shell and the reading column agree on. */
  sidebarWidth: "264px",
  railWidth: "380px",
  /** 760px of 15.5px Geist is 72–78 characters. */
  columnMax: "760px",
} as const;

/** The radii the brand checklist permits, as a set the test reads. */
export const GEAR_RADII = [
  GEAR_SCALE.radiusChip,
  GEAR_SCALE.radius,
  GEAR_SCALE.radiusComposer,
] as const;

/**
 * The type scale.
 *
 * Prose is looser than chrome because it is read rather than scanned, and that
 * one difference is most of why a transcript is comfortable for two hours.
 */
export const GEAR_TYPE = {
  display: { size: "22px", line: "1.25", tracking: GEAR_SCALE.displayTracking },
  title: { size: "17px", line: "1.35", tracking: GEAR_SCALE.titleTracking },
  prose: { size: "15.5px", line: "1.65", tracking: "0" },
  body: { size: "15px", line: "1.55", tracking: "0" },
  small: { size: "13px", line: "1.5", tracking: "0" },
  label: { size: "12px", line: "1.4", tracking: GEAR_SCALE.labelTracking },
  micro: { size: "11px", line: "1.35", tracking: GEAR_SCALE.labelTracking },
} as const;

// ─── Terminal derivation ───

/** Solid hexes for one ground, in the terminal theme's slot vocabulary. */
export interface GearTerminalPalette {
  bg: string;
  canvas: string;
  text: string;
  muted: string;
  faint: string;
  /** Semantic negative (errors / removals) — distinct from the cosmetic accent. */
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
 * The ground's variables mapped onto the terminal slot vocabulary. Any
 * translucent value is composited over the surface, because a terminal has no
 * alpha channel and a guess made at render time is a guess made differently
 * every time.
 */
export function gearTerminalPalette(base: GearBaseName): GearTerminalPalette {
  const css = GEAR_BASE_CSS[base];
  const over = (value: string) => solidOver(value, css.surface);
  return {
    bg: over(css.surface),
    canvas: over(css.ground),
    text: over(css.ink),
    muted: over(css.ink2),
    faint: over(css.ink3),
    red: over(css.danger),
    ochre: over(css.caution),
    green: over(css.ok),
    line: over(css.hairlineStrong),
    surfaces: {
      card: over(css.surface),
      bar: over(css.sunk),
      barActive: over(css.raised),
      code: over(css.sunk),
      diff: over(css.sunk),
      diffHeader: over(css.raised),
      popover: over(css.surface),
      hairline: over(css.hairline),
    },
  };
}

/** Accent hex for one ground (always solid). */
export function gearAccentHex(base: GearBaseName, accent: GearAccentName = "gear"): string {
  return GEAR_ACCENT_CSS[base][accent].toUpperCase();
}

/**
 * The terminal's colour table for one ground: exact 24-bit RGB, plus the
 * ANSI-256 index a terminal without truecolor gets instead.
 *
 * `nearestAnsi256` lives in the console (it needs no brand knowledge); this
 * function is the brand half, and `scripts/generate-terminal-colors.ts` prints
 * what it resolves to so a change is reviewable as a table rather than as a
 * diff of hex strings.
 */
export function gearTerminalRoles(base: GearBaseName): Record<string, string> {
  const p = gearTerminalPalette(base);
  return {
    // The six closed roles the console paints with. The names read from what
    // they MEAN, which is why they do not line up one-to-one with the slot
    // vocabulary they resolve through.
    body: p.text,
    dim: p.faint,
    accent: gearAccentHex(base),
    ok: p.green,
    warn: p.ochre,
    danger: p.red,
    // Structure, not a role: rules, gutters and the ground itself.
    line: p.line,
    ground: p.bg,
  };
}
