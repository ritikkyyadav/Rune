// Flow's six foreground roles, painted from the active theme's palette.
//
// Body text inherits the terminal's own foreground, and the GROUND is never
// painted — the surface behind everything belongs to the user. Two marks are
// allowed to carry a background because they are marks, not ground, and each
// states its own defence where it lives: the caret (cursorCell), and the diff
// evidence bands (positiveSurface/negativeSurface), which tint one row from
// the theme's own bg and degrade to foreground-only wherever the ground is
// unknown. What does NOT survive is the idea that six roles means six fixed
// codes: see themes.ts for why that collapsed thirty palettes into one, and
// why ANSI-16 is the reason the same build looked rich in Warp and washed out
// in Terminal.app.

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
  contrastRatio,
  displayWeight,
  findTheme,
  nearestAnsi256,
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
/**
 * Flow mutates no terminal state. Background, foreground and cursor colour all
 * belong to the host.
 *
 * The cursor was briefly claimed here with OSC 12, on the reasoning that it is
 * a glyph inside our own field rather than the ground beneath it. The reasoning
 * was fine and the mechanism was not: the sequence went out correctly — an
 * emitted `OSC 12 -> #a78bfa` matching the theme exactly — and the terminal
 * ignored it and drew its own cursor anyway. A request a terminal is free to
 * refuse is not a way to own something.
 *
 * So the cursor is drawn instead of asked for. See cursorCell() below and
 * renderComposer: the hardware cursor is hidden and the caret cell is painted,
 * which works identically everywhere and needs nothing from the host.
 */
export function terminalThemeSeq(): string {
  return "";
}

/**
 * One cell, painted as the caret.
 *
 * This is the single place in the product that sets a background, and the rule
 * it bends is worth restating so the exception stays one: never painting a
 * background is about the GROUND — the surface behind everything, which is the
 * user's and which is why a TUI that claims it looks broken on someone else's
 * theme. A caret is not ground. It is a mark exactly one cell wide, and a block
 * caret has no other way to exist.
 *
 * The foreground is chosen against the accent's own luminance rather than fixed,
 * so the character under the caret stays legible on a pale accent as well as a
 * dark one — a caret you cannot read through is worse than one in the wrong
 * colour.
 */
/**
 * Which foreground keeps the character legible inside a painted caret.
 *
 * Pure, and exported, because the rule is the interesting part and a test
 * process has no tty — cursorCell falls back to reverse video there, so
 * inspecting its output tells you nothing about the choice being made.
 *
 * Measured, not guessed. A luminance threshold picked by eye put white on Cyber
 * Orange at ~2.9:1 where black reaches 7.5:1 — legible enough to pass a glance,
 * not enough to read the character you are typing over. Asking which of the two
 * actually contrasts more is exact, and cannot drift when a palette changes.
 */
export function caretForeground(accent: [number, number, number]): "black" | "white" {
  return contrastRatio(accent, [0, 0, 0]) >= contrastRatio(accent, [255, 255, 255])
    ? "black"
    : "white";
}

export function cursorCell(ch: string): string {
  const safe = terminalText(ch || " ");
  if (!COLOR_CAPABLE || active.useNativeColors) {
    // Nothing to paint with: fall back to reverse video, which every terminal
    // understands and which the host's own colours make legible by definition.
    return `\x1b[7m${safe}${RESET}`;
  }
  const [r, g, b] = pigmentFor(ROLE_SLOT.accent).rgb;
  // Measured, not guessed. A luminance threshold picked by eye put white on
  // Cyber Orange at about 2.9:1 where black reaches 7:1 — legible enough to
  // pass a glance and not enough to read the character you are typing over.
  // Asking which of the two actually contrasts more is exact and cannot drift
  // when a palette changes.
  const onDark = caretForeground([r, g, b]) === "black" ? "30" : "97";
  if (DEPTH === "truecolor") return `\x1b[48;2;${r};${g};${b}m\x1b[${onDark}m${safe}${RESET}`;
  if (DEPTH === "ansi256") {
    return `\x1b[48;5;${pigmentFor(ROLE_SLOT.accent).ansi}m\x1b[${onDark}m${safe}${RESET}`;
  }
  return `\x1b[7m${safe}${RESET}`;
}

/** Nothing to hand back — Flow never took anything. */
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

// --- Evidence bands ---
// The second place a background exists, and the same defence as the caret: a
// band is not GROUND. It is one row of a diff, saying "this exact line changed"
// the way every code review surface the reader already lives in says it. The
// no-backgrounds law protects the user's surface from being repainted; a tint
// mixed FROM that surface — the theme's own bg pulled a few steps toward the
// role's pigment — asserts nothing over it.
//
// Honesty about capability is the other half. A band needs to know the ground
// to mix from it, so it exists only when the theme knows its background:
// follow-terminal themes, ANSI-16 hosts, NO_COLOR and pipes all degrade to the
// foreground-only rendering these rows always had. Nothing is ever the band
// alone — the sign column and the +/- foreground survive every degrade.

type Rgb = [number, number, number];

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Whether evidence bands can be painted honestly on this host + theme. */
export function bandsEnabled(): boolean {
  return COLOR_CAPABLE && DEPTH !== "ansi16" && !active.useNativeColors;
}

function bandSeq(role: "ok" | "danger"): string {
  const ground = active.bg.rgb as Rgb;
  const tone = pigmentFor(ROLE_SLOT[role]).rgb as Rgb;
  // Further toward the pigment on a dark ground: dark mixes lose chroma faster.
  const t = active.appearance === "light" ? 0.14 : 0.24;
  const [r, g, b] = mixRgb(ground, tone, t);
  if (DEPTH === "truecolor") return `\x1b[48;2;${r};${g};${b}m`;
  return `\x1b[48;5;${nearestAnsi256([r, g, b])}m`;
}

/** Lay `value` on a band. Inner resets are re-armed so a row assembled from
 *  several painted fragments keeps one continuous tint to its last cell. */
function banded(value: string, role: "ok" | "danger"): string {
  if (!bandsEnabled()) return body(value);
  const seq = bandSeq(role);
  return `${seq}${value.split(RESET).join(RESET + seq)}${RESET}`;
}

export function positiveSurface(value: string): string {
  return banded(value, "ok");
}

export function negativeSurface(value: string): string {
  return banded(value, "danger");
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

/**
 * Secondary prose: quieter than body, still readable.
 *
 * `muted` and `faint` below are BOTH aliases of `dim`, and `dim` reads the
 * FAINT slot -- so every "make this slightly quieter" call in this codebase
 * lands on the faintest grey the theme owns. That is 2.62:1 on Flow and 2.03:1
 * on Dracula. Correct for rails, gutters and elisions; wrong for anything a
 * person is expected to read, and invisible in review because the call site
 * says `muted(...)` and means it.
 *
 * This is the only way to reach the `muted` slot the palettes already author
 * and nothing else could get at: 4.5-7.3:1 across the bundled set. Use it for a
 * block that should recede without becoming work to read.
 */
export const quiet = (value: string): string => fmtSlot("muted", value);

/**
 * The wordmark, knocked out of a filled chip.
 *
 * This is the SECOND place in the product that paints a background, and the
 * carve-out is the one the caret already established, so the exceptions stay
 * countable. Never painting a background is about the GROUND -- the surface
 * behind everything, which belongs to the user, and which is why a TUI that
 * claims it looks broken under someone else's theme. A caret is not ground.
 * Neither is a mark nine cells wide. Both are ink.
 *
 * It is here because a terminal has exactly one weight axis, `SGR 1`, and it is
 * a request the host is free to refuse -- a font with no bold face, or a host
 * that reads an explicit 24-bit foreground as "the emphasis is already handled",
 * renders it as no change at all. That is what the wordmark hit: the bytes were
 * right and the screen was flat, and no amount of pigment fixes a stroke one
 * pixel wide. Reverse video is the only thing in a terminal that makes a stroke
 * genuinely heavier, because it stops drawing the letter and starts drawing
 * everything around it: the cell becomes the ink.
 *
 * The FILL is the identity pigment lifted off the ground (see displayWeight),
 * not the pigment as authored. That is the second, smaller weight adjustment
 * and it works on the letters rather than the block: knocked-out type reads
 * heavier the further the fill sits from the ink around it, so a brighter chip
 * gives the letters inside it more presence without making the chip itself any
 * larger. The ink is then chosen by measured contrast against that lifted fill
 * rather than fixed -- the same rule, and the same helper, as the caret -- so
 * the letters stay legible on a pale accent as well as a dark one.
 */
export const heavy = (value: string): string => {
  const safe = terminalText(value);
  // Nothing to paint with, and nothing that may be painted: a piped or
  // NO_COLOR run emits no escapes at all.
  if (!COLOR_CAPABLE) return safe;
  // Reverse video is the fallback at both ends -- a theme that keeps the host's
  // own colours, and a terminal that only speaks ANSI-16. It is understood
  // everywhere, and the host's palette makes it legible by definition.
  if (active.useNativeColors || DEPTH === "ansi16") return `\x1b[7m${safe}${RESET}`;
  const [r, g, b] = displayWeight(pigmentFor(ROLE_SLOT.accent).rgb, active.appearance);
  const ink = caretForeground([r, g, b]) === "black" ? "30" : "97";
  const fill =
    DEPTH === "truecolor" ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[48;5;${nearestAnsi256([r, g, b])}m`;
  return `${fill}\x1b[${ink}m\x1b[1m${safe}${RESET}`;
};

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
