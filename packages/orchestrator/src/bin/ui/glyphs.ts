// Flow's closed terminal alphabet. Product marks live here; renderers import
// their meaning instead of inventing a new symbol locally. Every mark has a
// one-cell ASCII twin, and block ramps fall back on ambiguous-width terminals.

export type GlyphMode = "utf8" | "ambig" | "ascii";
export type GlyphColorRole = "dim" | "accent" | "ok" | "warn" | "danger";

export interface GlyphDefinition {
  utf8: string;
  ascii: string;
  role: GlyphColorRole;
}

// Kept in the runtime path so an installed bundle can prove that the closed
// Flow alphabet made it into the executable being exercised.
export const GLYPH_BUDGET_MARKER = "FLOW_GLYPH_BUDGET_V1";

export const GLYPH_DEFINITIONS = {
  phase: { utf8: "◆", ascii: "*", role: "accent" },
  // The brand mark: the Rune gear, one cell, in the Savoir blue -- the same
  // gear-beside-the-wordmark lockup the Savoir site uses at small sizes
  // (SAV⚙IR becomes "SAVOIR ⚙" where the toothed O cannot resolve). A literal
  // ⚙ paints blue as a text glyph on most terminals; where a terminal forces
  // its emoji face instead, swap to a mono cog (⊛) -- the header is the only
  // caller that shows it large. ascii twin `*`.
  gear: { utf8: "⚙", ascii: "*", role: "accent" },
  // The agent's voice. NOT a filled circle: a hollow diamond, geometric and
  // quiet, echoing the gear mark rather than borrowing Claude Code's ●. Painted
  // `muted` at the call site so blue stays reserved for the mark and critical
  // signals; the role here is only its fallback tint.
  live: { utf8: "◇", ascii: "o", role: "dim" },
  // The inline separator between receipt parts and header fields -- a middot,
  // which is what a separator should be. It is NOT used as a leading bullet any
  // more: the tool row's neutral tick is blank (see STATUS_GLYPH.ok in flow.ts),
  // so the dots left the work rows.
  observed: { utf8: "·", ascii: ".", role: "dim" },
  verified: { utf8: "✓", ascii: "+", role: "ok" },
  failure: { utf8: "✗", ascii: "x", role: "danger" },
  gutter: { utf8: "│", ascii: "|", role: "dim" },
  rule: { utf8: "─", ascii: "-", role: "dim" },
  // The rule the wordmark stands on. One weight heavier than `rule`, and used
  // in exactly one place -- a second rule weight anywhere else would turn a
  // distinction into texture.
  ruleHeavy: { utf8: "━", ascii: "=", role: "accent" },
  selection: { utf8: "›", ascii: ">", role: "accent" },
  elision: { utf8: "…", ascii: ".", role: "dim" },
  retry: { utf8: "↻", ascii: "r", role: "warn" },
} as const satisfies Record<string, GlyphDefinition>;

export type GlyphName = keyof typeof GLYPH_DEFINITIONS;

// The Rune mark as a masthead: the Savoir gear, a round eight-tooth cog with a
// round hub, drawn in QUADRANT block cells (each cell is a 2x2 grid of solid
// sub-pixels) so the edges are smoother than half-blocks can manage while the
// fill stays solid -- the ceiling a character grid can reach for this shape.
// The pixel grid is 2:1 (32x16) because a quadrant sub-pixel is twice as tall
// as it is wide, so an equal grid would render an oval. Lives here because this
// is the only bin/ui file allowed non-ASCII literals, and it is NOT part of the
// closed glyph budget above -- it is art, printed once at session start, not a
// mark the grammar reuses. On a seven-bit terminal the caller drops it and
// shows the wordmark alone. Eight rows.
export const RUNE_LOGO: readonly string[] = [
  "    ▗▄▄  ▄▄▖",
  "    ▜██▄▄██▛",
  " ▟█▄██▀▀▀▀██▄█▙",
  "▝▀▜█▛      ▜█▛▀▘",
  "▗▄▟█▙      ▟█▙▄▖",
  " ▜█▀██▄▄▄▄██▀█▛",
  "    ▟██▀▀██▙",
  "    ▝▀▀  ▀▀▘",
];

export const PULSE_GLYPHS = [
  { utf8: "▁", ascii: "_", role: "accent" },
  { utf8: "▂", ascii: ".", role: "accent" },
  { utf8: "▃", ascii: ",", role: "accent" },
  { utf8: "▄", ascii: "-", role: "accent" },
  { utf8: "▅", ascii: "=", role: "accent" },
  { utf8: "▆", ascii: "+", role: "accent" },
  { utf8: "▇", ascii: "*", role: "accent" },
  { utf8: "█", ascii: "#", role: "accent" },
] as const satisfies readonly GlyphDefinition[];

export const PULSE_RAMP = PULSE_GLYPHS.map((glyph) => glyph.utf8) as readonly string[];
export const PULSE_RAMP_ASCII = PULSE_GLYPHS.map((glyph) => glyph.ascii) as readonly string[];

function enabled(value: string | undefined): boolean {
  return value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** Resolve the text-width rung once, when this module is loaded. */
export function detectGlyphMode(env: Record<string, string | undefined> = process.env): GlyphMode {
  if (enabled(env.RUNE_ASCII)) return "ascii";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale && !/utf-?8/i.test(locale)) return "ascii";
  if (enabled(env.RUNE_AMBIGUOUS_WIDTH) || /^(?:ja|ko|zh)(?:[_@.]|$)/i.test(locale)) {
    return "ambig";
  }
  return "utf8";
}

export const TERMINAL_GLYPH_MODE = detectGlyphMode();

export function glyph(name: GlyphName, mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  const definition = GLYPH_DEFINITIONS[name];
  if (!definition) throw new Error(`${GLYPH_BUDGET_MARKER}: unknown glyph ${String(name)}`);
  return mode === "ascii" ? definition.ascii : definition.utf8;
}

export function pulseGlyphAt(step: number, mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  const index = Math.max(0, Math.min(PULSE_GLYPHS.length - 1, Math.floor(step)));
  const definition = PULSE_GLYPHS[index]!;
  return mode === "utf8" ? definition.utf8 : definition.ascii;
}

const NAMED_ASCII: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u00a0/g, " "],
  [/\u2010|\u2011|\u2012|\u2013|\u2212/g, "-"],
  [/\u2014/g, "--"],
  [/\u2018|\u2019|\u201a|\u201b/g, "'"],
  [/\u201c|\u201d|\u201e|\u201f/g, '"'],
  [/\u2026/g, "..."],
  [/\u2190/g, "<-"],
  [/\u2192/g, "->"],
  [/\u2194/g, "<->"],
  [/\u2264/g, "<="],
  [/\u2265/g, ">="],
  [/\u00d7/g, "x"],
  [/\u00b7/g, "."],
];

/**
 * Fold arbitrary user/model/tool data for a seven-bit terminal. Named
 * punctuation is made readable first, then NFKD removes diacritics, and any
 * remaining unrepresentable code point becomes a visible question mark.
 */
export function foldTerminalData(value: string, mode: GlyphMode = TERMINAL_GLYPH_MODE): string {
  if (mode !== "ascii") return value;
  let folded = value;
  for (const [pattern, replacement] of NAMED_ASCII) {
    folded = folded.replace(pattern, replacement);
  }
  return folded
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .replace(/[^\x00-\x7f]/g, "?");
}

/** Final-boundary text folding for render surfaces. */
export function terminalText(value: string): string {
  return foldTerminalData(value, TERMINAL_GLYPH_MODE);
}
