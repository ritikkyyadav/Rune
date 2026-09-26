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
// The identity (2026-09-26, "Rune Mono"): black and white, and nothing else in
// the chrome. White ink on a near-black ground when the terminal is dark, black
// ink on near-white paper when it is light. The founder's words, set beside
// Claude Code: "remove the blue colour from the rune ui components and use the
// combo of white and black only" -- and keep blue in exactly one place, the
// light-mode code output (the added-line band below), which this file leaves
// alone.
//
// The rules that make a surface read as it does, in the order they bite: the
// chrome is monochrome, so hierarchy is carried by weight and by grey STEP,
// never by hue; the accent IS the ink -- the mark, the caret, the selection
// bar, the focused thing -- so there is nothing chromatic left to decorate
// with; three status colours for state only (and code keeps its own palette,
// because code is meant to be read in colour); every variant DERIVED from a
// published value by one rule rather than hand-picked twice.
//
// Two FINISHES of the same palette, a second axis beside light/dark. CRISP is
// the published poles: pure white or pure black ink, the status colours at full
// chroma. MATTE -- the default -- is the founder's other ask: "colours are too
// chunky, they create irritation on eyes due to glossy contrast". A terminal
// cannot soften its ground (the ground belongs to the user and is never
// painted), so matte softens the INK instead: every ink is the ground mixed
// toward the pole until it reaches a target contrast (13:1 for text instead of
// ~20:1, the way Material's dark theme sets text at 87% white), and the status
// colours lose 40% of their saturation before the same AA floor is applied.
//
// Everything else is a function of these literals — so a change to the brand is
// a change to a few lines, and the relationships cannot drift.
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

// ─── The literals ───
//
// Grounds, inks and three status colours. There is no accent literal any more:
// the accent is the ink of whichever ground it sits on (see `accentFor`). Every
// other colour in the product is one of these or `mixToward` of two of them.
//
// The greys are NEUTRAL. The previous identity tinted every one of them a few
// steps toward its blue (`#9BA0A5`, `#6A6F74`, `#0B0C0D`), which is invisible
// beside a blue accent and reads as a cold cast once the blue is gone. Each was
// replaced by the true grey of the same luminance, so no contrast moved.

export const RUNE_PALETTE = {
  /** Light ground, surface, sunk — near-white paper. */
  ground: "#FAFAFA",
  surface: "#FFFFFF",
  sunk: "#F2F2F2",
  /** Light ink, black in three steps: the crisp reading. Matte derives its
   *  own steps from the ground (see `runeBaseCss`). */
  ink: "#000000",
  ink2: "#5E5E5E",
  ink3: "#8A8A8A",
  /** The one border colour on paper. */
  hairline: "#E3E3E3",

  /** Dark ground, surface, sunk — near-black. */
  groundDark: "#0C0C0C",
  surfaceDark: "#141414",
  sunkDark: "#060606",
  /** Dark ink, white in three steps: the crisp reading. */
  inkDark: "#FFFFFF",
  ink2Dark: "#9F9F9F",
  ink3Dark: "#6E6E6E",
  /** The one border colour on ink. */
  hairlineDark: "#232323",

  /** Status. State only, never decoration — and the only chromatic colour the
   *  chrome has left, because a failed check and a diff's removals have to read
   *  as themselves. */
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

// ─── The two grounds, and the two finishes ───

export type RuneBaseName = "light" | "dark";

/**
 * How hard the ink presses against the ground. A second axis beside
 * light/dark, not a third theme: every screen exists in both.
 *
 *   matte  the default. Inks derived to target contrasts (below) and the status
 *          colours desaturated -- the founder's "easy on the eyes".
 *   crisp  the published poles: pure white or pure black ink, full-chroma status.
 */
export type RuneFinish = "matte" | "crisp";

export const RUNE_FINISHES: readonly RuneFinish[] = ["matte", "crisp"] as const;

/** The founder's call, 2026-09-26: the softer reading is the one Rune opens in. */
export const DEFAULT_RUNE_FINISH: RuneFinish = "matte";

/**
 * Matte's contrast targets, against the ground. Text at 13:1 is where a
 * two-hour session stops aching and still reads as unmistakably primary; the
 * secondary step keeps AAA (7:1); meta keeps AA-large (4:1, it never carries a
 * sentence); rules sit just above the point a hairline stops being seen.
 */
export const MATTE_CONTRAST = { ink: 13, ink2: 7, ink3: 4, line: 2.2 } as const;

/** How much of a status colour's saturation matte keeps. */
export const MATTE_STATUS_SATURATION = 0.6;

/**
 * The ink on the line from `ground` to `pole` that first reaches `target`
 * contrast against the ground. Half-percent steps, so the answer is stable to
 * the byte and a change to a target moves the ink by the least it can.
 */
function inkAt(ground: string, pole: string, target: number): string {
  for (let step = 0; step <= 200; step++) {
    const candidate = mixToward(ground, pole, step * 0.005);
    if (contrastRatio(candidate, ground) >= target) return candidate;
  }
  return pole.toUpperCase();
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
      : max === gn
        ? ((bn - rn) / d + 2) / 6
        : ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/** The same hue at `factor` of its saturation — lightness untouched. */
export function desaturate(hex: string, factor: number): string {
  const [h, s, l] = toHsl(hexToRgbTuple(hex));
  return rgbTupleToHex(fromHsl(h, Math.max(0, Math.min(1, s * factor)), l));
}

/**
 * The accent for one ground: its own ink. There is no chromatic accent in the
 * chrome any more -- the mark, the caret and the selection bar are drawn in the
 * ink of the ground they sit on (white on dark, black on light), at the
 * finish's strength.
 */
export function accentFor(base: RuneBaseName, finish: RuneFinish = DEFAULT_RUNE_FINISH): string {
  return runeBaseCss(base, finish).accent;
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
  rune: "Rune mono",
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
  /** The ink itself: the mark, the caret, the selection bar, the focused row. */
  accent: string;
  /** One step darker on paper, one step lighter on ink. */
  accentHover: string;
  /** Text and glyphs ON the accent -- the ground, knocked out of the bar. */
  onAccent: string;
  ok: string;
  caution: string;
  danger: string;
}

function baseFor(base: RuneBaseName, finish: RuneFinish): RuneBaseCss {
  const p = RUNE_PALETTE;
  const dark = base === "dark";
  const ground = dark ? p.groundDark : p.ground;
  const pole = dark ? p.inkDark : p.ink;
  const matte = finish === "matte";
  // Crisp is the published steps; matte walks each one back from the pole
  // toward the ground until it lands on its target contrast.
  const ink = matte ? inkAt(ground, pole, MATTE_CONTRAST.ink) : pole;
  const ink2 = matte ? inkAt(ground, pole, MATTE_CONTRAST.ink2) : dark ? p.ink2Dark : p.ink2;
  const ink3 = matte ? inkAt(ground, pole, MATTE_CONTRAST.ink3) : dark ? p.ink3Dark : p.ink3;
  const hairline = dark ? p.hairlineDark : p.hairline;
  const surface = dark ? p.surfaceDark : p.surface;
  // Matte softens chroma BEFORE the floor is applied, so a status colour is
  // quieter but still clears 4.5:1 as a word on its surface.
  const status = (hex: string) =>
    readableOn(matte ? desaturate(hex, MATTE_STATUS_SATURATION) : hex, surface, ink);
  return {
    ground,
    surface,
    sunk: dark ? p.sunkDark : p.sunk,
    // A hover is a surface that moved one step toward the text, not a new
    // colour: eight percent is the smallest move a person notices and the
    // largest that still reads as "the same row".
    raised: mixToward(surface, ink, 0.06),
    ink,
    ink2,
    ink3,
    inkFaint: mixToward(ink3, ground, dark ? 0.4 : 0.45),
    hairline,
    hairlineStrong: matte
      ? inkAt(ground, pole, MATTE_CONTRAST.line)
      : mixToward(hairline, pole, 0.35),
    accent: ink,
    accentHover: mixToward(ink, dark ? "#FFFFFF" : "#000000", 0.16),
    // What sits ON the accent is the ground itself: a bar of ink with the
    // letters knocked out of it, legible by construction at every finish.
    onAccent: ground,
    ok: status(p.ok),
    caution: status(p.caution),
    danger: status(p.danger),
  };
}

/** Every ground at every finish, derived once. `RUNE_BASE_CSS[finish][base]`. */
export const RUNE_BASE_CSS: Record<RuneFinish, Record<RuneBaseName, RuneBaseCss>> = {
  matte: { light: baseFor("light", "matte"), dark: baseFor("dark", "matte") },
  crisp: { light: baseFor("light", "crisp"), dark: baseFor("dark", "crisp") },
};

/** One ground at one finish. */
export function runeBaseCss(
  base: RuneBaseName,
  finish: RuneFinish = DEFAULT_RUNE_FINISH,
): RuneBaseCss {
  return RUNE_BASE_CSS[finish][base];
}

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
export function runeTerminalPalette(
  base: RuneBaseName,
  finish: RuneFinish = DEFAULT_RUNE_FINISH,
): RuneTerminalPalette {
  const css = runeBaseCss(base, finish);
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

/** Accent hex for one ground at one finish (always solid): the ground's ink. */
export function runeAccentHex(
  base: RuneBaseName,
  _accent: RuneAccentName = "rune",
  finish: RuneFinish = DEFAULT_RUNE_FINISH,
): string {
  return runeBaseCss(base, finish).accent.toUpperCase();
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
export function runeTerminalRoles(
  base: RuneBaseName,
  finish: RuneFinish = DEFAULT_RUNE_FINISH,
): Record<string, string> {
  const p = runeTerminalPalette(base, finish);
  return {
    // The six closed roles the console paints with. The names read from what
    // they MEAN, which is why they do not line up one-to-one with the slot
    // vocabulary they resolve through.
    body: p.text,
    dim: p.faint,
    accent: runeAccentHex(base, "rune", finish),
    ok: p.green,
    warn: p.ochre,
    danger: p.red,
    // Structure, not a role: rules, gutters and the ground itself.
    line: p.line,
    ground: p.bg,
  };
}

// ─── The syntax palette ───
//
// Code is meant to be read in colour, and the six chrome roles cannot do it:
// painting keywords in the accent and strings in the status green made every
// block read as one blue-and-grey texture (the founder's 2026-09-05 verdict:
// "some kind of NASA program"). So code gets its own palette, kept OUTSIDE
// `RUNE_PALETTE` on purpose -- the brand palette is pinned verbatim by the
// parity test and its chromatic budget is one accent plus three status hues;
// these nine are a reading aid for code, never chrome, never the mark.
//
// The values are the VS Code Dark Modern / Light Modern families, which is
// what the samples the founder pointed at (Claude Code's diffs) actually use:
// the most widely recognised "code in colour" vocabulary there is, so a Rune
// diff reads like the editor it came from. Every value clears 4.5:1 as text on
// its own ground (the parity test measures it), and the two light-ground
// values that did not in VS Code's own table (type teal, number green) are
// darkened one step until they do.

export type SyntaxRole =
  | "keyword"
  | "type"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "property"
  | "constant"
  | "decorator";

export const RUNE_SYNTAX: Record<RuneBaseName, Record<SyntaxRole, string>> = {
  dark: {
    keyword: "#C586C0",
    type: "#4EC9B0",
    function: "#DCDCAA",
    string: "#CE9178",
    number: "#B5CEA8",
    comment: "#6A9955",
    property: "#9CDCFE",
    constant: "#569CD6",
    decorator: "#D7BA7D",
  },
  light: {
    keyword: "#AF00DB",
    type: "#1E7A93",
    function: "#795E26",
    string: "#A31515",
    number: "#067A4F",
    comment: "#008000",
    property: "#001080",
    constant: "#0000FF",
    decorator: "#795E26",
  },
};

export const SYNTAX_ROLES: readonly SyntaxRole[] = [
  "keyword",
  "type",
  "function",
  "string",
  "number",
  "comment",
  "property",
  "constant",
  "decorator",
] as const;

/** The syntax palette for one ground. */
export function syntaxPalette(base: RuneBaseName): Record<SyntaxRole, string> {
  return RUNE_SYNTAX[base];
}

// ─── The diff bands ───
//
// A changed row in a diff is laid on a band, and an ADDED row is laid on the
// OPPOSITE ground (the founder's call, 2026-09-05, in two rounds): on ink it
// is the theme's own white -- the same white the speaker band uses -- and on
// paper it is the Savoir blue of the mark, the "CONTINUE" button blue. Both
// are solid, saturated surfaces, so the code on them is painted with the
// palette that reads there (black-based on the white, white-based on the
// blue); see theme.ts bandPalette / bandInk. Removals keep a deep red on ink,
// sampled from the Claude Code diff they pointed at, and a derived pink on
// paper. Green-for-added was the convention; the founder wanted the change
// itself to carry the identity.
//
// The paper-side blue is the ONE blue the monochrome identity keeps (founder,
// 2026-09-26: "the only place I want blue colour is in light mode when the code
// outputs gets produced in blue ... do not change it"). It is a literal here,
// not derived from anything, so no palette or finish change can reach it. The
// ink-side white band is the ink itself and so follows the finish: pure white
// when crisp, the matte ink when matte -- the same bar, without the glare.
export interface DiffBands {
  added: string;
  removed: string;
}
/** The published bands: crisp on ink, and paper at every finish. */
export const RUNE_DIFF_BANDS: Record<RuneBaseName, DiffBands> = {
  dark: { added: RUNE_PALETTE.inkDark, removed: "#370603" },
  light: {
    added: "#1936D7",
    removed: mixToward(RUNE_PALETTE.ground, RUNE_PALETTE.danger, 0.13),
  },
};
export function diffBands(base: RuneBaseName, finish: RuneFinish = DEFAULT_RUNE_FINISH): DiffBands {
  if (base === "light") return RUNE_DIFF_BANDS.light;
  return { ...RUNE_DIFF_BANDS.dark, added: runeBaseCss("dark", finish).ink };
}
