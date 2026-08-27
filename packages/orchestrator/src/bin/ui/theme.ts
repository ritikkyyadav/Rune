// Flow's six foreground roles, painted from the active theme's palette.
//
// Body text inherits the terminal's own foreground and backgrounds are never
// painted — both of those are law and both survive. What does NOT survive is
// the idea that six roles means six fixed codes: see themes.ts for why that
// collapsed thirty palettes into one, and why ANSI-16 is the reason the same
// build looked rich in Warp and washed out in Terminal.app.

import { glyph } from "./glyphs";
import { terminalText } from "./glyphs";
import {
  type ColorRole,
  type Pigment,
  type SlotName,
  type Theme,
  AUTO_THEME,
  COLOR_ROLES,
  DEFAULT_THEME,
  ROLE_SLOT,
  adaptiveTheme,
  findTheme,
  productionThemes,
} from "./themes";

const RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function noColor(): boolean {
  return (
    (process.env.NO_COLOR != null && process.env.NO_COLOR !== "") ||
    (process.env.TERM ?? "").toLowerCase() === "dumb"
  );
}

const COLOR_CAPABLE = Boolean(process.stdout.isTTY) && !noColor();

/**
 * How much colour this terminal can actually be told.
 *
 * This is the whole reason the product looked like two different applications
 * in two different terminals. ANSI-16 does not name a colour — it names an
 * INDEX INTO THE TERMINAL'S OWN SCHEME. Asking for `36` asks for "whatever you
 * call cyan", and Warp's answer and Terminal.app's answer are different
 * colours. A theme that only ever emits sixteen codes therefore has no say in
 * how it looks; the host decides, and the author's palette is decoration in the
 * source file.
 *
 * Detected once. Truecolor is announced by COLORTERM, which every terminal that
 * supports it sets; 256 by TERM. macOS Terminal.app is the notable one that
 * reports 256 and not truecolor, which is exactly the case that made this
 * visible.
 */
type ColorDepth = "truecolor" | "ansi256" | "ansi16";

function detectDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  if (!COLOR_CAPABLE) return "ansi16";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term.includes("truecolor") || term.includes("direct")) return "truecolor";
  if (term.includes("256")) return "ansi256";
  // A terminal that says nothing gets the floor. Guessing high here is the one
  // failure that produces unreadable text rather than merely duller text.
  return "ansi16";
}

const DEPTH: ColorDepth = detectDepth();

/** The floor, used only when a terminal admits to nothing better. */
const ANSI16: Readonly<Record<Exclude<ColorRole, "body">, number>> = {
  dim: 90,
  accent: 36,
  ok: 32,
  warn: 33,
  danger: 31,
};

let autoTheme = AUTO_THEME;
let active: Theme = findTheme(DEFAULT_THEME)!;

/** One pigment, in the richest form this terminal will understand. */
function sgr(pigment: Pigment, role: Exclude<ColorRole, "body">): string {
  if (DEPTH === "truecolor") {
    const [r, g, b] = pigment.rgb;
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  if (DEPTH === "ansi256") return `\x1b[38;5;${pigment.ansi}m`;
  return `\x1b[${ANSI16[role]}m`;
}

function pigmentFor(slot: SlotName, theme: Theme = active): Pigment {
  return theme.slots[slot];
}

function fmt(role: ColorRole, value: string, theme: Theme = active): string {
  const safe = terminalText(value);
  // Body inherits the user's foreground. Asserting over it fights every scheme
  // they might be running, and it is the one rule here with no exceptions.
  if (role === "body" || !COLOR_CAPABLE || theme.useNativeColors) return safe;
  return `${sgr(pigmentFor(ROLE_SLOT[role], theme), role)}${safe}${RESET}`;
}

/** Paint by the older eight-slot vocabulary, for callers that still speak it. */
function fmtSlot(slot: SlotName, value: string, theme: Theme = active): string {
  const safe = terminalText(value);
  if (slot === "text" || !COLOR_CAPABLE || theme.useNativeColors) return safe;
  return `${sgr(pigmentFor(slot, theme), roleFor(slot) as Exclude<ColorRole, "body">)}${safe}${RESET}`;
}

function roleFor(slot: SlotName): ColorRole {
  switch (slot) {
    case "text":
      return "body";
    case "muted":
    case "faint":
    case "line":
      return "dim";
    case "info":
      return "accent";
    default:
      return slot;
  }
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export const colorEnabled = COLOR_CAPABLE;
export const truecolor = DEPTH === "truecolor";
export const colorDepth = DEPTH;

export function configureAutoTheme(colors: {
  background?: [number, number, number];
  foreground?: [number, number, number];
}): void {
  autoTheme = adaptiveTheme(colors);
  if (active.name === "auto") active = autoTheme;
}

export function setTheme(name: string): boolean {
  const next =
    name.trim().toLowerCase() === "auto" || name.trim().toLowerCase() === "system"
      ? autoTheme
      : findTheme(name);
  if (!next) return false;
  active = next.name === "auto" ? autoTheme : next;
  return true;
}

export function getTheme(): Theme {
  return active;
}

export function listThemes(): Theme[] {
  return productionThemes().map((theme) => (theme.name === "auto" ? autoTheme : theme));
}

/** Paint with a named theme rather than the active one — the picker's preview
 *  paints every theme at once, which is only meaningful now that a theme has a
 *  palette of its own to be previewed. Accepts either vocabulary. */
export function paintWith(themeName: string, slot: SlotName | ColorRole, value: string): string {
  const theme = themeName === "auto" ? autoTheme : (findTheme(themeName) ?? active);
  const role: ColorRole = (COLOR_ROLES as readonly string[]).includes(slot)
    ? (slot as ColorRole)
    : roleFor(slot as SlotName);
  return fmt(role, value, theme);
}

export function paintBrandWith(themeName: string, value: string): string {
  return paintWith(themeName, "accent", value);
}

/** The picker's per-theme preview: one mark per coloured role, in that theme's
 *  own pigments. With a single hardcoded palette this was the same four cells
 *  on every row, which is what made the theme list look decorative. */
export function swatch(themeName: string): string {
  const mark = glyph("live");
  return (["accent", "ok", "warn", "danger"] as const)
    .map((role) => paintWith(themeName, role, mark))
    .join("");
}

/** Flow never mutates terminal foreground, background, or cursor colors. */
export function terminalThemeSeq(): string {
  return "";
}

export const TERMINAL_THEME_RESET = "";

/** Compatibility APIs kept while Phase 03 removes the old full-screen surface. */
export function themeBgSeq(): string {
  return "";
}

export function withThemeBg(value: string): string {
  return body(value);
}

export function panel(value: string): string {
  return body(value);
}

export function selection(value: string): string {
  return accent(value);
}

export function positiveSurface(value: string): string {
  return body(value);
}

export function negativeSurface(value: string): string {
  return body(value);
}

export function cardSurface(value: string): string {
  return body(value);
}

export function codeSurface(value: string): string {
  return body(value);
}

export function diffSurface(value: string): string {
  return body(value);
}

export function diffHeaderSurface(value: string): string {
  return body(value);
}

export function popoverSurface(value: string): string {
  return body(value);
}

export function hairline(value: string): string {
  return dim(value);
}

export type TintKind = "ok" | "warn" | "accent" | "brand" | "muted" | "text";

export function chip(kind: TintKind, value: string): string {
  if (kind === "ok") return ok(value);
  if (kind === "warn") return warn(value);
  if (kind === "accent" || kind === "brand") return accent(value);
  if (kind === "muted") return dim(value);
  return body(value);
}

export function tintSurface(_kind: TintKind, value: string): string {
  return body(value);
}

export const body = (value: string): string => fmt("body", value);
export const dim = (value: string): string => fmt("dim", value);
export const accent = (value: string): string => fmt("accent", value);
export const ok = (value: string): string => fmt("ok", value);
export const warn = (value: string): string => fmt("warn", value);
export const danger = (value: string): string => fmt("danger", value);

export const bold = (value: string): string => {
  const safe = terminalText(value);
  return COLOR_CAPABLE && !active.useNativeColors ? `\x1b[1m${safe}${RESET}` : safe;
};

// Compatibility names retain source stability while every renderer moves onto
// the six canonical roles above.
export const text = body;
export const brand = accent;
export const muted = dim;
export const faint = dim;
export const info = accent;
export const line = dim;

export function between(from: SlotName, to: SlotName, amount: number): (value: string) => string {
  const role = amount < 0.5 ? roleFor(from) : roleFor(to);
  return (value: string) => fmt(role, value);
}

export const paper = body;
export const vermillion = danger;
export const brass = warn;
export const cyanotype = accent;
export const green = ok;
export const draftLine = dim;
