// ─── Alan Terminal Theme ───
// Every styled string in the CLI funnels through this module. Each semantic token
// (text, muted, …) is a *stable* function that looks up the **active theme** at call
// time, so switching themes at runtime (setTheme) instantly recolours everything
// rendered afterward — no call site changes. Palettes live in ./themes.
//
// Capability detection (NO_COLOR / truecolor-vs-256) is an environment fact, independent
// of the chosen theme: it's resolved once here and applied on top of whatever theme is
// active. Under NO_COLOR, themes are inert (tokens pass text through unchanged).

import {
  type Pigment,
  type SlotName,
  type Theme,
  THEMES,
  DEFAULT_THEME,
  findTheme,
} from "./themes";

// ─── Capability detection ───

function detectNoColor(): boolean {
  // Honor the NO_COLOR standard (https://no-color.org). FORCE_COLOR overrides it.
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return false;
  return process.env.NO_COLOR != null && process.env.NO_COLOR !== "";
}

function detectTruecolor(): boolean {
  const tp = (process.env.TERM_PROGRAM ?? "").toLowerCase();
  // macOS Terminal.app renders only 256 colours, but many shells still export
  // COLORTERM=truecolor globally. Trusting that makes us emit 24-bit codes Terminal.app
  // silently drops — backgrounds never paint. Force the 256 path for it, no matter what
  // COLORTERM says, so fg+bg both render (and stay in contrast).
  if (tp === "apple_terminal") return false;
  const ct = (process.env.COLORTERM ?? "").toLowerCase();
  if (ct.includes("truecolor") || ct.includes("24bit")) return true;
  // Several modern terminals signal truecolor via TERM_PROGRAM instead of COLORTERM.
  if (["iterm.app", "wezterm", "warpterminal", "vscode", "ghostty", "hyper", "tabby"].includes(tp))
    return true;
  // …or only via TERM (kitty / alacritty / xterm-direct / *-truecolor).
  const term = (process.env.TERM ?? "").toLowerCase();
  if (
    term.includes("kitty") ||
    term.includes("alacritty") ||
    term.includes("direct") ||
    term.includes("truecolor")
  )
    return true;
  return false;
}

const NO_COLOR = detectNoColor();
const TRUECOLOR = detectTruecolor();

// ─── Core ───

const esc = (code: string) => `\x1b[${code}m`;
const RESET = esc("0");

/** Apply a pigment to a string, honoring the terminal's colour capability. */
function fmt(p: Pigment, value: string): string {
  if (NO_COLOR) return value;
  const code = TRUECOLOR ? `38;2;${p.rgb[0]};${p.rgb[1]};${p.rgb[2]}` : `38;5;${p.ansi}`;
  return `${esc(code)}${value}${RESET}`;
}

export const bold = (value: string): string => (NO_COLOR ? value : `${esc("1")}${value}${RESET}`);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

/** True when colors are being emitted (false under NO_COLOR). */
export const colorEnabled = !NO_COLOR;
/** True when 24-bit codes are being emitted (false → ANSI-256 fallback). */
export const truecolor = TRUECOLOR;

// ─── Active theme + control API ───

let active: Theme = findTheme(DEFAULT_THEME)!;

/** Switch the active theme. Returns false (and leaves the theme unchanged) if unknown. */
export function setTheme(name: string): boolean {
  const t = findTheme(name);
  if (!t) return false;
  active = t;
  return true;
}

/** The currently active theme. */
export function getTheme(): Theme {
  return active;
}

/** All bundled themes, in display order. */
export function listThemes(): Theme[] {
  return THEMES;
}

/** Format a string in a named theme's slot *without* changing the active theme. */
export function paintWith(themeName: string, slot: SlotName, value: string): string {
  const t = findTheme(themeName) ?? active;
  return fmt(t.slots[slot], value);
}

/** A tiny inline colour sample (accent · info · warn · ok) in a theme's own colours. */
export function swatch(themeName: string): string {
  return (
    paintWith(themeName, "accent", "●") +
    paintWith(themeName, "info", "●") +
    paintWith(themeName, "warn", "●") +
    paintWith(themeName, "ok", "●")
  );
}

// ─── Whole-terminal recolor (OSC 10/11) ───
// Themes set the terminal's default foreground + background so the *entire* surface
// recolours on a switch (not just newly-printed text). This is what makes a theme
// change feel complete and makes light themes readable on a dark terminal.

function hexOf(p: Pigment): string {
  return "#" + p.rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** OSC 10/11 escape setting the terminal's default fg + bg to the active theme. "" under NO_COLOR. */
export function terminalThemeSeq(): string {
  if (NO_COLOR) return "";
  return `\x1b]10;${hexOf(active.slots.text)}\x07\x1b]11;${hexOf(active.bg)}\x07`;
}

/** OSC 110/111 escape restoring the terminal's default fg + bg. Emit once on exit. */
export const TERMINAL_THEME_RESET = "\x1b]110\x07\x1b]111\x07";

// ─── Per-line background fill (SGR — works where OSC 11 doesn't, e.g. Warp) ───
// Some terminals (Warp, VS Code) ignore OSC 10/11, so the only way to actually paint a
// theme's background is to draw it ourselves with an SGR background + EL (erase-to-EOL,
// which fills the right margin with the current bg). EL and the bg SGR don't move the
// cursor and are stripped by visible-length math, so this is transparent to the inline
// renderer's caret positioning. We re-assert the bg after every RESET so it survives the
// per-token `\x1b[0m` resets that would otherwise drop it mid-line.

/** SGR sequence that opens the active theme's background (used for fills/clears).
 *  Respects the terminal's colour depth — truecolor `48;2` or 256-colour `48;5` — exactly
 *  like fmt() does for the foreground. (Terminal.app is 256-only and drops `48;2`, which
 *  is why the background never painted there.) */
export function themeBgSeq(): string {
  if (NO_COLOR) return "";
  const p = active.bg;
  const code = TRUECOLOR ? `48;2;${p.rgb[0]};${p.rgb[1]};${p.rgb[2]}` : `48;5;${p.ansi}`;
  return `\x1b[${code}m`;
}

/** Paint the active theme's background across a rendered line (right margin included). */
export function withThemeBg(line: string): string {
  if (NO_COLOR) return line;
  const bg = themeBgSeq();
  return bg + line.replace(/\x1b\[0m/g, RESET + bg) + "\x1b[K" + RESET;
}

// ─── Semantic tokens (read the active theme at call time) ───

const slot = (name: SlotName) => (value: string) => fmt(active.slots[name], value);

export const text = slot("text"); // primary text, banner name
export const muted = slot("muted"); // secondary text
export const faint = slot("faint"); // hints, connectors
export const accent = slot("accent"); // single emphasis, errors, `›`
export const info = slot("info"); // commands, paths, tool targets
export const warn = slot("warn"); // warnings, prompts, bar fill
export const ok = slot("ok"); // success ✓
export const line = slot("line"); // borders / rules

// ─── Back-compat raw pigment names (now mapped onto theme slots) ───
// welcome.ts, spinner.ts, diff-render.ts and alan-cli.ts import these; routing them
// through slots means diffs, the spinner and the provider list recolour with the
// active theme too, with no changes at their call sites.

export const paper = slot("text");
export const dim = slot("muted");
export const vermillion = slot("accent");
export const brass = slot("warn");
export const cyanotype = slot("info");
export const green = slot("ok");
export const draftLine = slot("line");
