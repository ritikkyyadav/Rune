// ─── Rune Terminal Themes ───
// Pure data + types for the bundled colour themes. No runtime dependency on theme.ts
// (the dependency is one-way: theme.ts imports this), so there's no import cycle.
//
// Each theme fills the same 8 semantic slots PLUS a terminal background (`bg`). The
// renderer (theme.ts) looks slots up on the active theme at call time, and emits the
// `bg` + `text` colours to the terminal via OSC 10/11 so the *whole* surface recolours
// (not just newly-printed text) and light themes are readable on a dark terminal.
// Themes are authored as hex; the ANSI-256 fallback is derived automatically
// (nearestAnsi256). The `atlas` (brand) theme keeps its original hand-tuned pigments.

import { RUNE_ACCENT_LABELS, runeTerminalPalette, runeAccentHex } from "@rune/shared";

export interface Pigment {
  /** Brand-exact 24-bit RGB. */
  rgb: [number, number, number];
  /** Closest ANSI-256 index for non-truecolor terminals. */
  ansi: number;
}

export type SlotName = "text" | "muted" | "faint" | "accent" | "info" | "warn" | "ok" | "line";

export interface ThemeSlots {
  text: Pigment; // primary text
  muted: Pigment; // secondary text / labels
  faint: Pigment; // hints / connectors
  accent: Pigment; // emphasis, errors, the prompt chevron
  info: Pigment; // commands, paths, tool targets
  warn: Pigment; // warnings, prompts, bar fill
  ok: Pigment; // success
  line: Pigment; // borders / rules
}

/** Exact surface tokens from the Rune visual specification. Terminals cannot
 * render CSS shadows or translucency, but they can reproduce every solid
 * surface, border, and semantic foreground with 24-bit ANSI colour. */
export interface ThemeSurfaces {
  card: Pigment;
  bar: Pigment;
  barActive: Pigment;
  code: Pigment;
  diff: Pigment;
  diffHeader: Pigment;
  popover: Pigment;
  hairline: Pigment;
}

export interface Theme {
  /** Stable id (kebab-case) used by /theme and persistence. */
  name: string;
  /** Human label shown in the picker. */
  label: string;
  appearance: "dark" | "light";
  /** Terminal background — applied via OSC 11 so the whole window recolours. */
  bg: Pigment;
  /** Canvas behind the centered terminal card. Explicit Rune themes use the
   *  sage/black customizer canvas; legacy themes simply fall back to `bg`. */
  canvas?: Pigment;
  /** Card, task-bar, code, diff, and popover fills from the HTML contract. */
  surfaces?: ThemeSurfaces;
  /** Exact cosmetic signal used for the Rune mark, selection dots, and active
   *  controls. It is intentionally separate from `info`: some supplied accent
   *  colours are decorative-only on a light surface, while paths and links must
   *  retain text-level contrast. */
  brand: Pigment;
  slots: ThemeSlots;
  /** Rune customizer metadata. Absent on legacy/community palettes. */
  runeAccent?: RuneAccent;
  /** Follow-terminal mode keeps the host terminal's own surface instead of repainting it. */
  preserveTerminal?: boolean;
  /** No trustworthy background was detected, so emitting our own foreground
   *  colors could make text unreadable. Use the terminal's native colors. */
  useNativeColors?: boolean;
}

// One accent (P3.3). The union keeps a single member rather than disappearing,
// because `[ui] accent` survives as an undocumented override and a type that
// can only be "datum" states the decision instead of hiding that there was one.
export type RuneAccent = "rune";

export const RUNE_ACCENTS: readonly RuneAccent[] = ["rune"];

// Rune opens on ink. The picker is `light | dark | auto` and nothing else: the
// five cosmetic accents are gone from both surfaces, because one accent is a
// brand rule and a coding agent offering a colour gallery is telling you what
// it thinks it is. Every pigment below the Savoir pair comes from
// packages/shared/src/design-tokens.ts.
export const DEFAULT_THEME = "rune-dark";

// ─── ANSI-256 nearest-match (xterm cube + grayscale ramp) ───

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function nearestCubeIndex(v: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < CUBE_LEVELS.length; i++) {
    const d = Math.abs(CUBE_LEVELS[i]! - v);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Closest ANSI-256 index for an RGB triple (picks the nearer of the 6×6×6 cube / gray ramp). */
export function nearestAnsi256([r, g, b]: [number, number, number]): number {
  // Candidate from the 6×6×6 colour cube (indices 16–231).
  const ri = nearestCubeIndex(r);
  const gi = nearestCubeIndex(g);
  const bi = nearestCubeIndex(b);
  const cr = CUBE_LEVELS[ri]!;
  const cg = CUBE_LEVELS[gi]!;
  const cb = CUBE_LEVELS[bi]!;
  const cubeIdx = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;

  // Candidate from the 24-step grayscale ramp (indices 232–255, levels 8,18,…,238).
  const avg = (r + g + b) / 3;
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + 10 * gi2;
  const grayIdx = 232 + gi2;
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;

  return grayDist < cubeDist ? grayIdx : cubeIdx;
}

// ─── Builders ───

function hexToRgb(hex: string): [number, number, number] {
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

/** Pigment from a hex string, with the ANSI-256 fallback derived automatically. */
function pig(hex: string): Pigment {
  const rgb = hexToRgb(hex);
  return { rgb, ansi: nearestAnsi256(rgb) };
}

type Hexes = Record<SlotName, string> & { bg: string };

type SurfaceHexes = Record<keyof ThemeSurfaces, string>;

function theme(
  name: string,
  label: string,
  appearance: "dark" | "light",
  hex: Hexes,
  options: {
    brand?: string;
    runeAccent?: RuneAccent;
    canvas?: string;
    surfaces?: SurfaceHexes;
  } = {},
): Theme {
  return {
    name,
    label,
    appearance,
    bg: pig(hex.bg),
    canvas: options.canvas ? pig(options.canvas) : undefined,
    surfaces: options.surfaces
      ? {
          card: pig(options.surfaces.card),
          bar: pig(options.surfaces.bar),
          barActive: pig(options.surfaces.barActive),
          code: pig(options.surfaces.code),
          diff: pig(options.surfaces.diff),
          diffHeader: pig(options.surfaces.diffHeader),
          popover: pig(options.surfaces.popover),
          hairline: pig(options.surfaces.hairline),
        }
      : undefined,
    brand: pig(options.brand ?? hex.info),
    runeAccent: options.runeAccent,
    slots: {
      text: pig(hex.text),
      muted: pig(hex.muted),
      faint: pig(hex.faint),
      accent: pig(hex.accent),
      info: pig(hex.info),
      warn: pig(hex.warn),
      ok: pig(hex.ok),
      line: pig(hex.line),
    },
  };
}

type Rgb = [number, number, number];

const PRIMARY_TEXT_CONTRAST = 7;
const SECONDARY_TEXT_CONTRAST = 4.5;
const DECORATIVE_CONTRAST = 3;

function channelLuminance(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * A pigment pushed AWAY from the ground -- the identity colour at display
 * weight.
 *
 * A terminal has one weight axis, `SGR 1`, and it is a REQUEST the host is free
 * to refuse: a font with no bold face, or a terminal that reads an explicit
 * 24-bit foreground as "the emphasis is already handled", renders the bold
 * attribute as no change at all. That is what the wordmark hit -- the bytes were
 * correct and the screen was flat.
 *
 * So weight is asked for twice, and the second way cannot be refused. Strokes
 * read heavier the further they sit from the ground beneath them, which is why
 * this lifts LIGHTNESS rather than mixing toward white: mixing desaturates, and
 * a washed-out mark reads lighter, not heavier. Saturation rises a little with
 * it, and the direction follows the surface -- brighter on a dark theme, darker
 * on a light one -- so it never reduces contrast anywhere.
 */
export function displayWeight(rgb: Rgb, appearance: "dark" | "light"): Rgb {
  const [h, s, l] = toHsl(rgb);
  return fromHsl(
    h,
    Math.min(1, s + 0.1),
    appearance === "light" ? Math.max(0.08, l - 0.16) : Math.min(0.95, l + 0.16),
  );
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
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const shifted = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
    if (shifted < 1 / 2) return q;
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  return from.map((value, index) => Math.round(value + (to[index]! - value) * amount)) as Rgb;
}

function readable(base: Rgb, background: Rgb, toward: Rgb, minimum = 3): Rgb {
  if (contrastRatio(base, background) >= minimum) return base;
  for (let amount = 0.1; amount <= 1; amount += 0.1) {
    const candidate = mix(base, toward, amount);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return toward;
}

function rgbPigment(rgb: Rgb): Pigment {
  return { rgb, ansi: nearestAnsi256(rgb) };
}

/** Build Follow-terminal mode from the terminal's reported colors.
 *
 * The background is the one piece of information required to choose safe
 * foreground colors. If it is unknown, every semantic token passes through
 * uncolored so the terminal's own foreground/background pair remains intact.
 * With a known background, saturated custom surfaces (red, blue, etc.) keep
 * their identity while semantic colors move toward a high-contrast pole. */
export function adaptiveTheme(colors: { background?: Rgb; foreground?: Rgb } = {}): Theme {
  // Use the true contrast poles here, not the warmer explicit-theme neutrals:
  // Follow terminal must remain readable even on saturated custom surfaces.
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const background = colors.background;

  if (!background) {
    // These pigments are inert while useNativeColors is true. Keeping a
    // complete Theme object avoids special cases in pickers and persistence.
    return {
      name: "auto",
      label: "Auto - follows terminal",
      appearance: "dark",
      preserveTerminal: true,
      useNativeColors: true,
      bg: rgbPigment(black),
      brand: rgbPigment(white),
      slots: {
        text: rgbPigment(white),
        muted: rgbPigment(white),
        faint: rgbPigment(white),
        accent: rgbPigment(white),
        info: rgbPigment(white),
        warn: rgbPigment(white),
        ok: rgbPigment(white),
        line: rgbPigment(white),
      },
    };
  }

  const contrastPole =
    contrastRatio(white, background) >= contrastRatio(black, background) ? white : black;
  const foreground = colors.foreground;
  const textColor =
    foreground && contrastRatio(foreground, background) >= PRIMARY_TEXT_CONTRAST
      ? foreground
      : contrastPole;
  const appearance = relativeLuminance(background) < 0.42 ? "dark" : "light";

  return {
    name: "auto",
    label: `Auto - follows terminal (${appearance})`,
    appearance,
    preserveTerminal: true,
    useNativeColors: false,
    bg: rgbPigment(background),
    brand: rgbPigment(readable([77, 112, 255], background, contrastPole, SECONDARY_TEXT_CONTRAST)),
    slots: {
      text: rgbPigment(textColor),
      muted: rgbPigment(
        readable(mix(textColor, background, 0.28), background, textColor, SECONDARY_TEXT_CONTRAST),
      ),
      faint: rgbPigment(
        readable(mix(textColor, background, 0.45), background, textColor, SECONDARY_TEXT_CONTRAST),
      ),
      accent: rgbPigment(
        readable([77, 112, 255], background, contrastPole, SECONDARY_TEXT_CONTRAST),
      ),
      info: rgbPigment(readable([67, 156, 232], background, contrastPole, SECONDARY_TEXT_CONTRAST)),
      warn: rgbPigment(readable([211, 154, 62], background, contrastPole, SECONDARY_TEXT_CONTRAST)),
      ok: rgbPigment(readable([64, 166, 112], background, contrastPole, SECONDARY_TEXT_CONTRAST)),
      line: rgbPigment(
        readable(mix(textColor, background, 0.68), background, textColor, DECORATIVE_CONTRAST),
      ),
    },
  };
}

export const AUTO_THEME: Theme = adaptiveTheme();

// ─── atlas (brand) — exact existing pigments, never auto-derived ───

const ATLAS: Theme = {
  name: "atlas",
  label: "Atlas (brand)",
  appearance: "dark",
  bg: { rgb: [22, 19, 13], ansi: 233 }, // #16130d  warm near-black ground
  brand: { rgb: [31, 93, 122], ansi: 31 }, // #1f5d7a
  slots: {
    text: { rgb: [242, 239, 230], ansi: 255 }, // #f2efe6
    muted: { rgb: [138, 138, 130], ansi: 244 }, // #8a8a82
    faint: { rgb: [106, 106, 98], ansi: 240 }, // #6a6a62
    accent: { rgb: [181, 61, 32], ansi: 166 }, // #b53d20
    info: { rgb: [31, 93, 122], ansi: 31 }, // #1f5d7a
    warn: { rgb: [197, 165, 114], ansi: 179 }, // #c5a572
    ok: { rgb: [90, 138, 90], ansi: 71 }, // #5a8a5a
    line: { rgb: [87, 83, 75], ansi: 240 }, // ~#57534b
  },
};

// ─── The product's two modes ───
// Pigments live in ONE place: packages/shared/src/design-tokens.ts. This module
// derives the console's light and dark modes from those tokens, so the accent
// and the three status colours are the SAME values the app paints with and a
// brand change propagates from one edit instead of three hand-synced copies.
//
// The console's `accent` slot is the semantic negative, not the identity blue:
// it is what the prompt chevron and an error use, and the brand accent arrives
// as `info` and as `brand`. Those names are the console's, and they read from
// what each slot MEANS rather than from what colour it happens to be.

const RUNE_ACCENT_LABEL: Record<RuneAccent, string> = RUNE_ACCENT_LABELS;

/** Stable persisted id for one base. `rune` and `rune-dark` are the ids every
 *  existing install already has recorded, so a rebrand does not reset anyone's
 *  theme; only the pigments behind them moved. */
export function runeThemeName(appearance: "light" | "dark", _accent: RuneAccent = "rune"): string {
  return appearance === "light" ? "rune" : "rune-dark";
}

function runeTheme(appearance: "light" | "dark", accentName: RuneAccent = "rune"): Theme {
  // Derived from the shared token source, including its distinction between
  // semantic text and the cosmetic accent. Translucent values arrive here
  // already composited to solid terminal colours, because a terminal has no
  // alpha channel and a guess made at render time is a different guess each
  // time.
  const palette = runeTerminalPalette(appearance);
  const brand = runeAccentHex(appearance, accentName);
  const label = appearance === "light" ? "Light" : "Dark";
  return theme(
    runeThemeName(appearance, accentName),
    label,
    appearance,
    {
      bg: palette.bg,
      text: palette.text,
      muted: palette.muted,
      faint: palette.faint,
      accent: palette.red,
      info: brand,
      warn: palette.ochre,
      ok: palette.green,
      line: palette.line,
    },
    {
      brand,
      runeAccent: accentName,
      canvas: palette.canvas,
      surfaces: palette.surfaces,
    },
  );
}

// ─── The bundled themes (display order) ───

export const THEMES: Theme[] = [
  // The two modes are the product. `flow` — the recorded dark palette
  // that used to sit here — is gone as a theme and kept as an alias
  // (`findTheme("flow")` resolves to the dark mode), because its pigments were
  // a fourth identity in a repository that now has one. The community palettes
  // below stay reachable by name for anyone who wants them; they are not in
  // the picker.
  runeTheme("dark"),
  runeTheme("light"),

  // studio — the default: a dark instrument panel (Codex-style). Near-black ground
  // with a faint green cast, grey mono text, one teal-green signal for live state
  // and diff adds; errors keep a single warm red. Quiet by design.
  theme("studio", "Studio (default)", "dark", {
    bg: "#0d0f0e",
    text: "#d6dad6",
    muted: "#9aa29b",
    faint: "#5f6660",
    accent: "#e06055", // errors / interrupts — the one warm emphasis
    info: "#8fd6c2", // paths, commands, links — soft teal readout
    warn: "#d9b45b",
    ok: "#22c08e", // the signal: ⬢, diff adds, success
    line: "#2a2f2c",
  }),

  ATLAS,

  theme("atlas-light", "Atlas Light", "light", {
    bg: "#f2efe6",
    text: "#2b2a26",
    muted: "#5c5a52",
    faint: "#8a877d",
    accent: "#b53d20",
    info: "#1f5d7a",
    warn: "#9a6f24",
    ok: "#3f6f3f",
    line: "#c9c3b4",
  }),

  theme("mono", "Monochrome Black", "dark", {
    bg: "#0a0a0a",
    text: "#e8e8e8",
    muted: "#9a9a9a",
    faint: "#6a6a6a",
    accent: "#ffffff",
    info: "#c0c0c0",
    warn: "#b8b8b8",
    ok: "#d0d0d0",
    line: "#4a4a4a",
  }),

  theme("mono-light", "Monochrome Light", "light", {
    bg: "#f4f4f4",
    text: "#1a1a1a",
    muted: "#555555",
    faint: "#8a8a8a",
    accent: "#000000",
    info: "#3a3a3a",
    warn: "#444444",
    ok: "#2a2a2a",
    line: "#c8c8c8",
  }),

  theme("matrix", "Matrix", "dark", {
    bg: "#000000",
    text: "#33ff66",
    muted: "#1f9e3f",
    faint: "#146b29",
    accent: "#aaffaa",
    info: "#2effc7",
    warn: "#b6ff00",
    ok: "#00ff41",
    line: "#0d3b1a",
  }),

  theme("dracula", "Dracula", "dark", {
    bg: "#282a36",
    text: "#f8f8f2",
    muted: "#6272a4",
    faint: "#565869",
    accent: "#ff79c6",
    info: "#8be9fd",
    warn: "#ffb86c",
    ok: "#50fa7b",
    line: "#44475a",
  }),

  theme("nord", "Nord", "dark", {
    bg: "#2e3440",
    text: "#d8dee9",
    muted: "#9aa5b9",
    faint: "#616e88",
    accent: "#bf616a",
    info: "#88c0d0",
    warn: "#ebcb8b",
    ok: "#a3be8c",
    line: "#434c5e",
  }),

  theme("solarized-dark", "Solarized Dark", "dark", {
    bg: "#002b36",
    text: "#93a1a1",
    muted: "#839496",
    faint: "#586e75",
    accent: "#dc322f",
    info: "#268bd2",
    warn: "#b58900",
    ok: "#859900",
    line: "#073642",
  }),

  theme("solarized-light", "Solarized Light", "light", {
    bg: "#fdf6e3",
    text: "#586e75",
    muted: "#657b83",
    faint: "#93a1a1",
    accent: "#dc322f",
    info: "#268bd2",
    warn: "#b58900",
    ok: "#859900",
    line: "#eee8d5",
  }),

  theme("gruvbox", "Gruvbox", "dark", {
    bg: "#282828",
    text: "#ebdbb2",
    muted: "#a89984",
    faint: "#7c6f64",
    accent: "#fb4934",
    info: "#83a598",
    warn: "#fabd2f",
    ok: "#b8bb26",
    line: "#504945",
  }),

  theme("tokyo-night", "Tokyo Night", "dark", {
    bg: "#1a1b26",
    text: "#c0caf5",
    muted: "#9aa5ce",
    faint: "#565f89",
    accent: "#f7768e",
    info: "#7aa2f7",
    warn: "#e0af68",
    ok: "#9ece6a",
    line: "#3b4261",
  }),

  theme("catppuccin", "Catppuccin Mocha", "dark", {
    bg: "#1e1e2e",
    text: "#cdd6f4",
    muted: "#a6adc8",
    faint: "#6c7086",
    accent: "#f38ba8",
    info: "#89b4fa",
    warn: "#fab387",
    ok: "#a6e3a1",
    line: "#45475a",
  }),

  theme("one-dark", "One Dark", "dark", {
    bg: "#282c34",
    text: "#abb2bf",
    muted: "#828997",
    faint: "#5c6370",
    accent: "#e06c75",
    info: "#61afef",
    warn: "#e5c07b",
    ok: "#98c379",
    line: "#3b4048",
  }),

  theme("synthwave", "Synthwave", "dark", {
    bg: "#262335",
    text: "#f6f2ff",
    muted: "#a599c0",
    faint: "#6d5c8c",
    accent: "#ff7edb",
    info: "#36f9f6",
    warn: "#fede5d",
    ok: "#72f1b8",
    line: "#463465",
  }),

  theme("neon", "Neon", "dark", {
    bg: "#0a0a12", // near-black with a faint violet cast — makes the neons glow
    text: "#f0f6ff",
    muted: "#8b95b5",
    faint: "#565d7a",
    accent: "#ff2e97", // hot magenta — prompt ›, errors
    info: "#00e5ff", // electric cyan — commands, paths, tool targets
    warn: "#faff00", // neon yellow — warnings, bar fill
    ok: "#00ff9c", // neon green — success ✓
    line: "#2a2f4a", // dim violet border / rules
  }),

  theme("neon-lime", "Neon Lime", "dark", {
    bg: "#0a0f0a", // near-black with a faint green cast — makes the lime glow
    text: "#e9ffcf", // pale lime-white, readable as body text
    muted: "#9fd17a",
    faint: "#5f7a4e",
    accent: "#66ff00", // parrot / lime green — prompt ›, emphasis (the signature colour)
    info: "#b6ff3c", // chartreuse — commands, paths, tool targets
    warn: "#f3ff66", // pale neon yellow — warnings, bar fill
    ok: "#28ff7d", // neon spring green — success ✓ (distinct from the accent)
    line: "#2c3a22", // dark olive border / rules
  }),

  theme("high-contrast", "High Contrast", "dark", {
    bg: "#000000",
    text: "#ffffff",
    muted: "#cfcfcf",
    faint: "#9a9a9a",
    accent: "#ff4040",
    info: "#29e6e6",
    warn: "#ffe000",
    ok: "#2bff2b",
    line: "#b8b8b8",
  }),

  theme("github-light", "GitHub Light", "light", {
    bg: "#ffffff",
    text: "#24292f",
    muted: "#57606a",
    faint: "#8c959f",
    accent: "#cf222e",
    info: "#0969da",
    warn: "#9a6700",
    ok: "#1a7f37",
    line: "#d0d7de",
  }),
];

/** Look up a theme by its `name`. */
export function findTheme(name: string): Theme | undefined {
  if (name === "auto") return AUTO_THEME;
  const normalized = name.trim().toLowerCase();
  // Every retired accent name still resolves, to the ground it was saved on.
  // Someone with `gear-violet-dark` (or `gear-dark`, the previous name's
  // default) in ~/.rune/theme.json gets the dark mode, not an "unknown theme"
  // error and a surprise repaint.
  const accentAlias =
    /^(?:rune-|gear-)?(cobalt|orange|violet|emerald|mono|datum|rune|gear)(?:-(light|dark))?$/.exec(
      normalized,
    );
  const canonical = accentAlias
    ? runeThemeName(
        (accentAlias[2] as "light" | "dark" | undefined) ??
          // Pre-rename `mono` was Monochrome Black: a saved bare "mono" keeps
          // its dark surface. The other bare accents defaulted to light.
          (accentAlias[1] === "mono" ? "dark" : "light"),
      )
    : normalized === "light"
      ? "rune"
      : normalized === "dark"
        ? "rune-dark"
        : normalized === "system"
          ? "auto"
          : // `flow` was the dark default before the Savoir modes replaced it.
            normalized === "flow"
            ? "rune-dark"
            : normalized;
  if (canonical === "auto") return AUTO_THEME;
  return THEMES.find((t) => t.name === canonical);
}

// ─── Production theme set ───
// Light, dark, and the host escape hatch. Three modes, not thirteen.
export const PRODUCTION_THEME_NAMES: readonly string[] = ["rune-dark", "rune", "auto"];

/** Whether `name` is one of the production theme modes. */
export function isProductionTheme(name: string): boolean {
  const resolved = findTheme(name);
  return resolved != null && PRODUCTION_THEME_NAMES.includes(resolved.name);
}

/** The production theme modes, in customizer display order (light, dark, host). */
export function productionThemes(): Theme[] {
  return PRODUCTION_THEME_NAMES.map((n) => findTheme(n)!).filter(Boolean);
}

// ─── The six roles, restored on top of the palette rather than instead of it ───
//
// Phase 02 closed the colour budget to six semantic roles, which was right: a
// seventh hue is always a missing word. What went wrong is that it also
// collapsed the palette to five hardcoded ANSI-16 codes and deleted thirty
// themes, on an instruction of mine that said "a closed palette does not need a
// theme engine". That conflated two different things. The budget closes the set
// of MEANINGS a colour may carry. It says nothing about which pigment a theme
// chooses to carry them with.
//
// Six roles times thirty themes is not a contradiction — it is the point. The
// roles are the grammar; a theme is a voice speaking it.
//
// The other cost of collapsing to ANSI-16 was that ANSI-16 does not name a
// colour, it names a SLOT IN THE TERMINAL'S OWN SCHEME. Emitting `36` asks for
// "whatever this terminal calls cyan", which is why the identical build looked
// rich in one terminal and washed out in another. A Pigment carries exact
// 24-bit RGB and a derived ANSI-256 index, so the product looks like itself
// wherever it runs and degrades on purpose rather than by accident.

export type ColorRole = "body" | "dim" | "accent" | "ok" | "warn" | "danger";

export const COLOR_ROLES: readonly ColorRole[] = ["body", "dim", "accent", "ok", "warn", "danger"];

/**
 * Which slot a role reads its pigment from.
 *
 * `danger` maps to the `accent` slot and `accent` to `info` because the old
 * eight-slot vocabulary named them from the other direction: `accent` was
 * "emphasis, errors, prompt" and `info` was "commands, paths, tool targets".
 * The roles are named for what they MEAN; the slots for where they came from.
 */
export const ROLE_SLOT: Record<Exclude<ColorRole, "body">, SlotName> = {
  dim: "faint",
  accent: "info",
  ok: "ok",
  warn: "warn",
  danger: "accent",
};
