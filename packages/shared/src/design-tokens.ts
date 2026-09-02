// ─── Gear design tokens — the ONE pigment source ───
//
// Derived from the Savoir brand DNA (D2). Every surface reads from here:
//
//   • CLI/TUI:   packages/orchestrator/src/bin/ui/themes.ts builds the two
//                terminal modes from gearTerminalPalette(), 24-bit with a
//                derived ANSI-256 fallback.
//   • Desktop:   scripts/generate-tokens-css.ts emits tokens.css, which the
//                desktop AND the web client (the same bundle) consume.
//   • Guardrail: tests/unit/shared/design-tokens-parity.test.ts pins these
//                values against the brand's own numbers, and
//                tests/unit/brand-checklist.test.ts checks the BUILT css.
//
// What changed in Phase 3, and why it is a deletion rather than a re-skin:
// there were three visual identities in this repository — the customizer's
// five accents × two bases, the desktop's own CSS, and the Savoir rebrand — and
// a product cannot have three. The five-accent picker is gone from both
// surfaces. One accent, two grounds, and status colors that only ever signal
// state.
//
// The nine rules that make something read as Savoir, in the order they bite:
// the block cursor is the mark; ONE accent, under ~5% of any surface; hairlines
// and never shadows; 3px radii (pills and the icon tile excepted); a sans for
// voice and a mono for the record; mono labels uppercase and tracked; tabular
// numerals; a 28px graticule ground; tight tracking on large sans.
//
// Pure data + pure functions. No dependencies.

// ─── The brand's own numbers ───
//
// Verbatim from the Savoir DNA. Nothing else in the repository may introduce a
// pigment; everything below is either one of these or derived from them by a
// function in this file.

export const SAVOIR = {
  /** Cool drafting ground. NOT cream. */
  paper: "#E7E8E3",
  paper2: "#DDDFD8",
  /** Muted/secondary text ON ink. */
  paperMuted: "#C9CCC8",
  /** Cool near-black: text on light, and the inverse ground. */
  ink: "#14161A",
  ink2: "#22262B",
  surfaceDark: "#191C20",
  graphite: "#4A4F55",
  graphite2: "#7C8088",
  line: "#C7CABF",
  lineDark: "#2C3036",
  /** THE accent. Petrol/instrument teal, rationed under ~5% of a surface. */
  datum: "#0E5E63",
  datumDeep: "#0A4448",
  /** The same idea, brighter: live readouts and on-dark. Not a second brand color. */
  signal: "#17A0A8",
  onDatum: "#EAF6F6",
  /** Status only. Never decoration. */
  caution: "#E2A23A",
  negative: "#9A4A3A",
  n50: "#F2F3EF",
  n100: "#E7E8E3",
  n200: "#C7CABF",
  n400: "#9DA29A",
  n500: "#6C7178",
  n600: "#4A4F55",
  n800: "#2A2D32",
  n900: "#14161A",
} as const;

/**
 * The status colors, named as a set.
 *
 * The brand checklist allows exactly one chromatic hue outside these. Naming
 * the exception list here rather than in the test is deliberate: a designer
 * adding a status color has to add it to the system, not to the assertion.
 */
export const SAVOIR_STATUS_COLORS = [SAVOIR.caution, SAVOIR.negative] as const;

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

/**
 * Move `from` a fraction of the way toward `toward`.
 *
 * Used for exactly one thing: the brand gives a single `--negative`
 * (`#9A4A3A`), tuned to be read on paper. On ink it is a dark shape on a dark
 * ground — fine as a rule or a fill, not readable as text. Rather than invent a
 * second brick, the on-ink readout is DERIVED from the brand's own value, so
 * changing `--negative` moves both and the relationship cannot drift.
 */
export function mixToward(from: string, toward: string, amount: number): string {
  const a = hexToRgbTuple(from);
  const b = hexToRgbTuple(toward);
  return rgbTupleToHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

// ─── The two grounds ───

export type GearBaseName = "light" | "dark";

/**
 * One accent.
 *
 * The union survives with a single member on purpose: `[ui] accent` remains as
 * an undocumented override for anyone maintaining the customizer, and a type
 * that can only ever be `"datum"` says the shape of the decision instead of
 * deleting the seam and pretending there was never a choice.
 */
export type GearAccentName = "datum";

export const GEAR_ACCENT_NAMES: readonly GearAccentName[] = ["datum"] as const;

export const GEAR_ACCENT_LABELS: Record<GearAccentName, string> = {
  datum: "Datum",
};

/** Raw CSS custom-property values for one ground. */
export interface GearBaseCss {
  canvasBg: string;
  cardBg: string;
  textMain: string;
  textSub: string;
  textMuted: string;
  textFaint: string;
  /** Caution. Amber. Warnings, "needs work", a paused permission. */
  ochre: string;
  /** Positive. There is no green in this system: an addition is a datum. */
  green: string;
  /** Negative. Errors, removals, refusals. */
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

/**
 * `[data-theme-base="light"]` and `[data-theme-base="dark"]`.
 *
 * Two decisions in here are worth reading twice.
 *
 * There is NO GREEN. The brand has one chromatic hue, and a second one
 * introduced for "added lines" would be a second brand color arriving through
 * the back door. An addition is a datum — the thing that is now there — which
 * is both on-brand and, once seen, obviously right for a diff.
 *
 * `red` on ink is the brand's `--negative` lifted toward paper, because the
 * brand's single brick is tuned for paper and is unreadable as text on ink. The
 * fill and the rule keep the exact brand value; only the readout moves.
 */
export const GEAR_BASE_CSS: Record<GearBaseName, GearBaseCss> = {
  light: {
    canvasBg: SAVOIR.paper2,
    cardBg: SAVOIR.paper,
    textMain: SAVOIR.ink,
    textSub: SAVOIR.graphite,
    textMuted: SAVOIR.graphite2,
    textFaint: SAVOIR.n400,
    ochre: SAVOIR.caution,
    green: SAVOIR.datum,
    red: SAVOIR.negative,
    barBg: SAVOIR.n50,
    barHover: SAVOIR.paper2,
    barActive: SAVOIR.line,
    hairline: SAVOIR.line,
    codeBg: SAVOIR.n50,
    codeTag: SAVOIR.paper2,
    diffBg: SAVOIR.n50,
    diffHdr: SAVOIR.paper2,
    popoverBg: SAVOIR.n50,
    kbdBg: SAVOIR.n50,
  },
  dark: {
    canvasBg: "#0E1013",
    cardBg: SAVOIR.ink,
    textMain: SAVOIR.paper,
    textSub: SAVOIR.paperMuted,
    textMuted: SAVOIR.graphite2,
    textFaint: SAVOIR.graphite,
    ochre: SAVOIR.caution,
    green: SAVOIR.signal,
    red: mixToward(SAVOIR.negative, SAVOIR.paper, 0.3),
    barBg: SAVOIR.surfaceDark,
    barHover: SAVOIR.ink2,
    barActive: SAVOIR.n800,
    hairline: SAVOIR.lineDark,
    codeBg: SAVOIR.surfaceDark,
    codeTag: SAVOIR.ink2,
    diffBg: SAVOIR.surfaceDark,
    diffHdr: SAVOIR.ink2,
    popoverBg: SAVOIR.surfaceDark,
    kbdBg: SAVOIR.ink2,
  },
};

/** The accent per ground: datum on paper, signal on ink. */
export const GEAR_ACCENT_CSS: Record<GearBaseName, Record<GearAccentName, string>> = {
  light: { datum: SAVOIR.datum },
  dark: { datum: SAVOIR.signal },
};

/**
 * Non-color scale constants.
 *
 * `radius` is 3px everywhere. The two exceptions are named rather than
 * scattered: a pill is fully round, and the icon tile is 6px — the one place in
 * the whole system where a 6px corner is allowed.
 */
export const GEAR_SCALE = {
  sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  ease: "cubic-bezier(0.16, 1, 0.3, 1)",
  radius: "3px",
  radiusPill: "20px",
  radiusTile: "6px",
  /** The engineering graticule: a faint dot grid, the texture of drafting paper. */
  graticule: "28px",
  /** Mono label tracking. Uppercase, small, +.04em. */
  labelTracking: "0.04em",
  /** Large sans tightens as it grows. */
  displayTracking: "-0.03em",
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
 * The ground's variables mapped onto the terminal slot vocabulary:
 * text←text-main, muted←text-sub, faint←text-muted, line←text-faint. Any
 * translucent value is composited over the card background, because a terminal
 * has no alpha channel and a guess made at render time is a guess made
 * differently every time.
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

/** Accent hex for one ground (always solid). */
export function gearAccentHex(base: GearBaseName, accent: GearAccentName = "datum"): string {
  return GEAR_ACCENT_CSS[base][accent].toUpperCase();
}

/**
 * The terminal's colour table for one ground: exact 24-bit RGB, plus the
 * ANSI-256 index a terminal without truecolor gets instead.
 *
 * `nearestAnsi256` lives in the TUI (it needs no brand knowledge); this
 * function is the brand half, and `scripts/generate-terminal-colors.ts` prints
 * what it resolves to so a change is reviewable as a table rather than as a
 * diff of hex strings.
 */
export function savoirTerminalRoles(base: GearBaseName): Record<string, string> {
  const p = gearTerminalPalette(base);
  return {
    // The six closed roles the TUI paints with, in the TUI's own mapping:
    // `accent` is the identity pigment (the datum) and `danger` is the
    // negative. The names read from what they MEAN, which is why they do not
    // line up one-to-one with the slot vocabulary they resolve through.
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
