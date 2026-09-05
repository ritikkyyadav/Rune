// ─── Rune design tokens — the ONE pigment source ───
//
// The terminal is the product, and this is where its colours come from:
//
//   • Console:   packages/orchestrator/src/bin/ui/themes.ts builds the two
//                terminal modes from runeTerminalPalette(), 24-bit with a
//                derived ANSI-256 fallback.
//   • Review:    scripts/generate-terminal-colors.ts prints the resolved table
//                so a palette change is reviewable as swatches, not hex diffs.
//   • Guardrail: tests/unit/shared/design-tokens-parity.test.ts pins these
//                values and the rules they encode.
//
// The identity (2026-09-03): one violet, `#A28CF3`, chosen by the founder as
// the agent's colour, on a near-black ground by default and on near-white
// paper when the terminal is light. The rules that make a surface read as it
// does, in the order they bite: ink is not black and the ground is not white;
// one accent, under 5% of any screen, never carrying running text; three
// status colours for state and nothing else; every variant DERIVED from the
// published value by one rule rather than hand-picked twice.
//
// Eleven literal values. Everything else is a function of them — so a change to
// the brand is a change to eleven lines, and the relationships cannot drift.
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

// ─── The eleven literals ───
//
// The accent is the founder's swatch; the grounds and inks are what it sits on.
// Every other colour in the product is one of these or `mixToward` of two of
// them.

export const RUNE_PALETTE = {
  /**
   * THE accent: the violet of the mark, exact. It is painted as-is on ink (the
   * default ground). On paper it is a pastel — 2.7:1 against the ground — so
   * `accentFor("light")` steps it toward the ink by the same rule the status
   * colours use, until it clears the non-text floor. One published value, two
   * legible readings, no second hand-picked violet.
   */
  accent: "#A28CF3",

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
export const RUNE_STATUS_COLORS = [
  RUNE_PALETTE.ok,
  RUNE_PALETTE.caution,
  RUNE_PALETTE.danger,
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
 * The floor the accent must clear against its ground. WCAG's non-text floor,
 * because the accent paints glyphs, rules, the caret and emphasis — never a
 * sentence. The status colours, which ARE words, hold the 4.5 above.
 */
export const ACCENT_CONTRAST_FLOOR = 3;

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

export type RuneBaseName = "light" | "dark";

/**
 * The accent for one ground. Exact on ink; on paper, the published violet moved
 * toward the ink in 2% steps until it clears `ACCENT_CONTRAST_FLOOR`.
 */
export function accentFor(base: RuneBaseName): string {
  const p = RUNE_PALETTE;
  if (base === "dark") return p.accent;
  return readableOn(p.accent, p.ground, p.ink, ACCENT_CONTRAST_FLOOR);
}

/**
 * One accent.
 *
 * The union survives with a single member on purpose: `[ui] accent` remains as
 * an undocumented override for anyone maintaining a custom build, and a type
 * that can only ever be `"rune"` says the shape of the decision instead of
 * deleting the seam and pretending there was never a choice.
 */
export type RuneAccentName = "rune";

export const RUNE_ACCENT_NAMES: readonly RuneAccentName[] = ["rune"] as const;

export const RUNE_ACCENT_LABELS: Record<RuneAccentName, string> = {
  rune: "Rune violet",
};

/** Raw CSS custom-property values for one ground. */
export interface RuneBaseCss {
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
}

function baseFor(base: RuneBaseName): RuneBaseCss {
  const p = RUNE_PALETTE;
  const dark = base === "dark";
  const ground = dark ? p.groundDark : p.ground;
  const ink = dark ? p.inkDark : p.ink;
  const ink3 = dark ? p.ink3Dark : p.ink3;
  const accent = accentFor(base);
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
    // A pastel accent carries ink, never white: white on this violet is under
    // 3:1 on either ground, while the ink clears 6:1 on both. The accent never
    // carries running text; a glyph or a label sits on it.
    onAccent: dark ? p.sunkDark : p.ink,
    ok: status(p.ok),
    caution: status(p.caution),
    danger: status(p.danger),
  };
}

/** `:root` and `:root[data-theme="dark"]`. */
export const RUNE_BASE_CSS: Record<RuneBaseName, RuneBaseCss> = {
  light: baseFor("light"),
  dark: baseFor("dark"),
};

/** The accent per ground. */
export const RUNE_ACCENT_CSS: Record<RuneBaseName, Record<RuneAccentName, string>> = {
  light: { rune: accentFor("light") },
  dark: { rune: accentFor("dark") },
};

// ─── Terminal derivation ───

/** Solid hexes for one ground, in the terminal theme's slot vocabulary. */
export interface RuneTerminalPalette {
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
export function runeTerminalPalette(base: RuneBaseName): RuneTerminalPalette {
  const css = RUNE_BASE_CSS[base];
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
export function runeAccentHex(base: RuneBaseName, accent: RuneAccentName = "rune"): string {
  return RUNE_ACCENT_CSS[base][accent].toUpperCase();
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
export function runeTerminalRoles(base: RuneBaseName): Record<string, string> {
  const p = runeTerminalPalette(base);
  return {
    // The six closed roles the console paints with. The names read from what
    // they MEAN, which is why they do not line up one-to-one with the slot
    // vocabulary they resolve through.
    body: p.text,
    dim: p.faint,
    accent: runeAccentHex(base),
    ok: p.green,
    warn: p.ochre,
    danger: p.red,
    // Structure, not a role: rules, gutters and the ground itself.
    line: p.line,
    ground: p.bg,
  };
}
