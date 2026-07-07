// ─── Alan Terminal Themes ───
// Pure data + types for the bundled colour themes. No runtime dependency on theme.ts
// (the dependency is one-way: theme.ts imports this), so there's no import cycle.
//
// Each theme fills the same 8 semantic slots PLUS a terminal background (`bg`). The
// renderer (theme.ts) looks slots up on the active theme at call time, and emits the
// `bg` + `text` colours to the terminal via OSC 10/11 so the *whole* surface recolours
// (not just newly-printed text) and light themes are readable on a dark terminal.
// Themes are authored as hex; the ANSI-256 fallback is derived automatically
// (nearestAnsi256). The `atlas` (brand) theme keeps its original hand-tuned pigments.

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
  accent: Pigment; // emphasis, errors, prompt `›`
  info: Pigment; // commands, paths, tool targets
  warn: Pigment; // warnings, prompts, bar fill
  ok: Pigment; // success
  line: Pigment; // borders / rules
}

export interface Theme {
  /** Stable id (kebab-case) used by /theme and persistence. */
  name: string;
  /** Human label shown in the picker. */
  label: string;
  appearance: "dark" | "light";
  /** Terminal background — applied via OSC 11 so the whole window recolours. */
  bg: Pigment;
  slots: ThemeSlots;
}

// Production ships two themes only (see PRODUCTION_THEME_NAMES); the default is
// monochrome black. The full palette set below is kept intact but not surfaced.
export const DEFAULT_THEME = "mono";

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

function theme(name: string, label: string, appearance: "dark" | "light", hex: Hexes): Theme {
  return {
    name,
    label,
    appearance,
    bg: pig(hex.bg),
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

// ─── atlas (brand) — exact existing pigments, never auto-derived ───

const ATLAS: Theme = {
  name: "atlas",
  label: "Atlas (brand)",
  appearance: "dark",
  bg: { rgb: [22, 19, 13], ansi: 233 }, // #16130d  warm near-black ground
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

// ─── The bundled themes (display order) ───

export const THEMES: Theme[] = [
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
  return THEMES.find((t) => t.name === name);
}

// ─── Production theme set ───
// The shipped product exposes exactly two themes — monochrome black and monochrome
// light. Every other palette above stays in the source (unremoved) but is never
// offered in the picker, accepted by `/theme`, or honored from env/config. To bring
// the full set back, widen this list.
export const PRODUCTION_THEME_NAMES: readonly string[] = ["mono", "mono-light"];

/** Whether `name` is one of the two production themes. */
export function isProductionTheme(name: string): boolean {
  return PRODUCTION_THEME_NAMES.includes(name);
}

/** The production themes, in display order (monochrome black, then light). */
export function productionThemes(): Theme[] {
  return PRODUCTION_THEME_NAMES.map((n) => findTheme(n)!).filter(Boolean);
}
