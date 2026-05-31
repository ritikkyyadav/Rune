// ─── Alan Terminal Theme ───
// Brand-exact L'Atlas palette (savoir-atlas.jsx) rendered in 24-bit truecolor,
// with a graceful ANSI-256 fallback for terminals that don't advertise truecolor.
//
// L'Atlas pigments are tuned for a paper (light) ground. On a dark terminal we use
// `paper` as the primary text color and the pigments as accents — the same mapping
// the desktop dark theme (apps/desktop/src/styles/global.css) already ships.
//
// One place to tune: the RGB triples below. `line` is intentionally lifted off the
// brand draft-line so hairline borders stay visible on very dark terminals.

interface Pigment {
  /** Brand-exact 24-bit RGB. */
  rgb: [number, number, number];
  /** Closest ANSI-256 index for non-truecolor terminals. */
  ansi: number;
}

// ─── Palette (hex → pigment) ───

const PALETTE = {
  paper: { rgb: [242, 239, 230], ansi: 255 }, // #f2efe6  primary text
  graphite3: { rgb: [138, 138, 130], ansi: 244 }, // #8a8a82  secondary / dim
  dimText: { rgb: [106, 106, 98], ansi: 240 }, // #6a6a62  faint hints
  vermillion: { rgb: [181, 61, 32], ansi: 166 }, // #b53d20  emphasis / error
  cyanotype: { rgb: [31, 93, 122], ansi: 31 }, // #1f5d7a  info / paths / commands
  brass: { rgb: [197, 165, 114], ansi: 179 }, // #c5a572  warning / prompt / bar fill
  green: { rgb: [90, 138, 90], ansi: 71 }, // #5a8a5a  success
  lineGray: { rgb: [87, 83, 75], ansi: 240 }, // ~#57534b  borders (dark-tuned)
} satisfies Record<string, Pigment>;

// ─── Capability detection ───

function detectNoColor(): boolean {
  // Honor the NO_COLOR standard (https://no-color.org). FORCE_COLOR overrides it.
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return false;
  return process.env.NO_COLOR != null && process.env.NO_COLOR !== "";
}

function detectTruecolor(): boolean {
  const ct = (process.env.COLORTERM ?? "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return true;
  // A few terminals signal truecolor via TERM_PROGRAM instead.
  const tp = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  if (tp === "iterm.app" || tp === "wezterm" || tp === "warpterminal") return true;
  return false;
}

const NO_COLOR = detectNoColor();
const TRUECOLOR = detectTruecolor();

// ─── Core ───

const esc = (code: string) => `\x1b[${code}m`;
const RESET = esc("0");

function paint(p: Pigment): (value: string) => string {
  if (NO_COLOR) return (value) => value;
  const code = TRUECOLOR
    ? `38;2;${p.rgb[0]};${p.rgb[1]};${p.rgb[2]}`
    : `38;5;${p.ansi}`;
  const open = esc(code);
  return (value) => `${open}${value}${RESET}`;
}

export const bold = (value: string): string =>
  NO_COLOR ? value : `${esc("1")}${value}${RESET}`;

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** True when colors are being emitted (false under NO_COLOR). */
export const colorEnabled = !NO_COLOR;
/** True when 24-bit codes are being emitted (false → ANSI-256 fallback). */
export const truecolor = TRUECOLOR;

// ─── Back-compat raw pigment names ───
// Existing imports (welcome.ts, spinner.ts, diff-render.ts, alan-cli.ts) rely on these.

export const paper = paint(PALETTE.paper);
export const dim = paint(PALETTE.graphite3);
export const vermillion = paint(PALETTE.vermillion);
export const brass = paint(PALETTE.brass);
export const cyanotype = paint(PALETTE.cyanotype);
export const green = paint(PALETTE.green);
export const draftLine = paint(PALETTE.lineGray);

// ─── Semantic tokens (preferred for new code) ───

export const text = paint(PALETTE.paper); // primary text, banner name
export const muted = paint(PALETTE.graphite3); // secondary text
export const faint = paint(PALETTE.dimText); // hints, connectors
export const accent = paint(PALETTE.vermillion); // single emphasis, errors, `>_`
export const info = paint(PALETTE.cyanotype); // commands, paths, tool targets
export const warn = paint(PALETTE.brass); // warnings, prompts, bar fill
export const ok = paint(PALETTE.green); // success ✓
export const line = paint(PALETTE.lineGray); // borders / rules
