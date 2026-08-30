// ─── Gear · the degradation ladder ───
// Four independent rungs, each detected separately, because they fail separately on
// real machines: colour depth, glyph repertoire, the pulse ramp, and the row tint.
// Nothing in the design is carried by any one of them — every rung can be at its
// bottom and the screen still says the same things. That is the whole test.

export type ColourDepth = "truecolor" | "ansi256" | "none";
export type Glyphs = "utf8" | "ascii";
/**
 * The block ramp (▁▂▃▄▅▆▇█) is East-Asian *Ambiguous* width: in a CJK locale a
 * terminal may render it double-wide and quietly eat a column, which breaks every
 * right-aligned column on the row. So it gets its own rung rather than riding on
 * `glyphs`, and falls back to the ASCII ramp while the rest of the UTF-8 set stays.
 */
export type PulseRamp = "blocks" | "ascii";

export interface Caps {
  colour: ColourDepth;
  glyphs: Glyphs;
  pulse: PulseRamp;
  /** the terminal's real width */
  columns: number;
  /** where the stream sets its type. wide terminals get margin, not filler. */
  measure: number;
  /** a 7% blend of the terminal's own ground, from OSC 11. a convenience, never a fact. */
  tint: boolean;
}

/** The stream is measured here and stays here on a 240-column display. */
export const MEASURE = 92;
/** Below this the layout changes shape — metadata drops to its own indented row. */
export const NARROW = 58;

const env = (name: string): string => (process.env[name] ?? "").toLowerCase();

export function detectColour(): ColourDepth {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return "truecolor";
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") return "none";
  if (!process.stdout.isTTY) return "none"; // `| cat` is a supported rung, not a bug
  const tp = env("TERM_PROGRAM");
  // Terminal.app exports COLORTERM=truecolor from many shells and then drops 24-bit
  // codes on the floor. Take it at its behaviour, not at its word.
  if (tp === "apple_terminal") return "ansi256";
  const ct = env("COLORTERM");
  if (ct.includes("truecolor") || ct.includes("24bit")) return "truecolor";
  if (["iterm.app", "wezterm", "vscode", "ghostty", "hyper", "tabby"].includes(tp))
    return "truecolor";
  const term = env("TERM");
  if (["kitty", "alacritty", "direct", "truecolor"].some((t) => term.includes(t)))
    return "truecolor";
  if (term === "dumb" || term === "") return "none";
  return "ansi256";
}

export function detectGlyphs(): Glyphs {
  const locale = env("LC_ALL") || env("LC_CTYPE") || env("LANG");
  if (!locale) return process.platform === "win32" ? "ascii" : "utf8";
  return locale.includes("utf-8") || locale.includes("utf8") ? "utf8" : "ascii";
}

export function detectPulseRamp(glyphs: Glyphs): PulseRamp {
  if (glyphs === "ascii") return "ascii";
  const locale = env("LC_ALL") || env("LC_CTYPE") || env("LANG");
  const ambiguousWide = ["ja", "ko", "zh"].some((l) => locale.startsWith(l));
  return ambiguousWide ? "ascii" : "blocks";
}

export function detectCaps(overrides: Partial<Caps> = {}): Caps {
  const glyphs = overrides.glyphs ?? detectGlyphs();
  const colour = overrides.colour ?? detectColour();
  const columns = overrides.columns ?? process.stdout.columns ?? 80;
  return {
    colour,
    glyphs,
    pulse: overrides.pulse ?? detectPulseRamp(glyphs),
    columns,
    measure: overrides.measure ?? Math.min(MEASURE, Math.max(NARROW, columns)),
    // 24-bit is what buys the tint, and the tint is the only thing it buys.
    tint: overrides.tint ?? colour === "truecolor",
  };
}

/**
 * Width is spent in exactly one place: the holds, where comparison is the task. A
 * decision at 140 columns puts the two options side by side; at 90 it stacks them; at
 * 58 it shows one and pages. That is where a wide terminal earns its width — at the
 * moment of judgement, not during the work. A hold is never narrower than the stream.
 */
export const holdWidth = (caps: Caps): Caps => ({
  ...caps,
  measure: Math.max(caps.measure, Math.min(caps.columns, 140)),
});

/** The floor of the ladder: every rung at its worst. What a serial console gets. */
export const plainCaps = (columns = MEASURE): Caps => ({
  colour: "none",
  glyphs: "ascii",
  pulse: "ascii",
  columns,
  measure: Math.min(MEASURE, columns),
  tint: false,
});
