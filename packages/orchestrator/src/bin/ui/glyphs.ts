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
  live: { utf8: "●", ascii: "o", role: "accent" },
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
