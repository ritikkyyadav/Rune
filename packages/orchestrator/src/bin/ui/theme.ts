// ─── Gear Terminal Theme ───
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
  AUTO_THEME,
  DEFAULT_THEME,
  adaptiveTheme,
  findTheme,
  gearThemeName,
  GEAR_ACCENTS,
  nearestAnsi256,
  productionThemes,
  type GearAccent,
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
function fmt(p: Pigment, value: string, useNativeColors = false): string {
  if (NO_COLOR || useNativeColors) return value;
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

let autoTheme = AUTO_THEME;
let active: Theme = findTheme(DEFAULT_THEME)!;

/** Refresh Follow-terminal mode from the host terminal's reported colors. */
export function configureAutoTheme(colors: {
  background?: [number, number, number];
  foreground?: [number, number, number];
}): void {
  autoTheme = adaptiveTheme(colors);
  if (active.name === "auto") active = autoTheme;
}

/** Switch the active theme. Returns false (and leaves the theme unchanged) if unknown. */
export function setTheme(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  const currentAccent = active.gearAccent ?? "cobalt";
  let canonical = normalized;
  if (normalized === "light" || normalized === "dark") {
    canonical = gearThemeName(normalized, currentAccent);
  } else if ((GEAR_ACCENTS as readonly string[]).includes(normalized)) {
    canonical = gearThemeName(active.appearance, normalized as GearAccent);
  } else if (normalized === "system") {
    canonical = "auto";
  }
  const t = canonical === "auto" ? autoTheme : findTheme(canonical);
  if (!t) return false;
  active = t;
  return true;
}

/** The currently active theme. */
export function getTheme(): Theme {
  return active;
}

/** The intentionally small set of product themes offered to the user. */
export function listThemes(): Theme[] {
  return productionThemes().map((theme) => (theme.name === "auto" ? autoTheme : theme));
}

/** Format a string in a named theme's slot *without* changing the active theme. */
export function paintWith(themeName: string, slot: SlotName, value: string): string {
  const t = themeName === "auto" ? autoTheme : (findTheme(themeName) ?? active);
  return fmt(t.slots[slot], value, t.useNativeColors);
}

/** Paint with a palette's exact cosmetic Gear signal without changing themes. */
export function paintBrandWith(themeName: string, value: string): string {
  const t = themeName === "auto" ? autoTheme : (findTheme(themeName) ?? active);
  return fmt(t.brand, value, t.useNativeColors);
}

/** A tiny inline colour sample (accent · info · warn · ok) in a theme's own colours. */
export function swatch(themeName: string): string {
  return (
    paintBrandWith(themeName, "●") +
    paintWith(themeName, "accent", "●") +
    paintWith(themeName, "warn", "●") +
    paintWith(themeName, "ok", "●")
  );
}

// ─── Whole-terminal recolor (OSC 10/11/12) ───
// Themes set the terminal's default foreground, background, and cursor so the *entire* surface
// recolours on a switch (not just newly-printed text). This is what makes a theme
// change feel complete and makes light themes readable on a dark terminal.

function hexOf(p: Pigment): string {
  return "#" + p.rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

/** OSC 10/11/12 escape setting the terminal's foreground, background, and cursor. */
export function terminalThemeSeq(): string {
  if (NO_COLOR || active.preserveTerminal) return "";
  return (
    `\x1b]10;${hexOf(active.slots.text)}\x07` +
    `\x1b]11;${hexOf(active.bg)}\x07` +
    `\x1b]12;${hexOf(active.brand)}\x07`
  );
}

/** Restore the host terminal's foreground, background, and cursor colors. */
export const TERMINAL_THEME_RESET = "\x1b]110\x07\x1b]111\x07\x1b]112\x07";

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
  if (NO_COLOR || active.preserveTerminal) return "";
  // The sage/black canvas belongs to the browser customizer around the card.
  // The production CLI *is* the terminal card, so it paints the card base
  // edge-to-edge instead of recreating the customizer's outer page chrome.
  const p = active.bg;
  const code = TRUECOLOR ? `48;2;${p.rgb[0]};${p.rgb[1]};${p.rgb[2]}` : `48;5;${p.ansi}`;
  return `\x1b[${code}m`;
}

/** Paint the active theme's background across a rendered line (right margin included). */
export function withThemeBg(line: string): string {
  if (NO_COLOR || active.preserveTerminal) return line;
  const bg = themeBgSeq();
  return bg + line.replace(/\x1b\[0m/g, RESET + bg) + "\x1b[K" + RESET;
}

// ─── In-surface fills (task bar, popovers, selected rows) ───

function blendPigment(base: Pigment, overlay: Pigment, amount: number): Pigment {
  const rgb = base.rgb.map((value, index) =>
    Math.round(value + (overlay.rgb[index]! - value) * amount),
  ) as [number, number, number];
  return { rgb, ansi: nearestAnsi256(rgb) };
}

function pigmentBgSeq(p: Pigment): string {
  const code = TRUECOLOR ? `48;2;${p.rgb[0]};${p.rgb[1]};${p.rgb[2]}` : `48;5;${p.ansi}`;
  return esc(code);
}

/** Apply a bounded background fill while preserving nested foreground styles. */
function onBackground(p: Pigment, value: string): string {
  if (NO_COLOR || active.preserveTerminal) return value;
  const bg = pigmentBgSeq(p);
  return bg + value.replace(/\x1b\[0m/g, RESET + bg) + RESET;
}

/** Neutral card/bar fill derived from the active base. */
export function panel(value: string): string {
  if (active.surfaces) return onBackground(active.surfaces.bar, value);
  return onBackground(
    blendPigment(active.bg, active.slots.text, active.appearance === "dark" ? 0.06 : 0.035),
    value,
  );
}

/** Active-row fill derived from the exact cosmetic accent. */
export function selection(value: string): string {
  if (active.surfaces) return onBackground(active.surfaces.barActive, value);
  return onBackground(
    blendPigment(active.bg, active.brand, active.appearance === "dark" ? 0.18 : 0.09),
    value,
  );
}

/** Semantic diff fills, deliberately quieter than their foreground signals. */
export function positiveSurface(value: string): string {
  return onBackground(
    blendPigment(
      active.surfaces?.diff ?? active.bg,
      active.slots.ok,
      active.appearance === "dark" ? 0.13 : 0.08,
    ),
    value,
  );
}

export function negativeSurface(value: string): string {
  return onBackground(
    blendPigment(
      active.surfaces?.diff ?? active.bg,
      active.slots.accent,
      active.appearance === "dark" ? 0.13 : 0.08,
    ),
    value,
  );
}

/** The warm-ivory / near-black product card. */
export function cardSurface(value: string): string {
  return onBackground(active.surfaces?.card ?? active.bg, value);
}

/** Shell commands and compact code evidence. */
export function codeSurface(value: string): string {
  return onBackground(active.surfaces?.code ?? active.bg, value);
}

/** Neutral body of a unified-diff card. */
export function diffSurface(value: string): string {
  return onBackground(active.surfaces?.diff ?? active.bg, value);
}

/** File/range header at the top of a diff card. */
export function diffHeaderSurface(value: string): string {
  return onBackground(active.surfaces?.diffHeader ?? active.bg, value);
}

/** Commands, model, theme, and approval overlays. */
export function popoverSurface(value: string): string {
  return onBackground(active.surfaces?.popover ?? active.bg, value);
}

/** Exact customizer hairline pigment (rather than the higher-contrast text rule). */
export function hairline(value: string): string {
  return fmt(active.surfaces?.hairline ?? active.slots.line, value, active.useNativeColors);
}

// ─── Tinted chips and card washes ───
// The customizer's pills (`.oi-tag.free`, `.session-pill-status`, `.auto-chip
// .chip`, `.env-badge`) and tinted cards (`.fallback-card`, `.ctx-compact`) are
// a semantic colour laid over a faint wash of itself. Terminals cannot blend
// alpha, so the wash is composited here over the card base at build time.

export type TintKind = "ok" | "warn" | "accent" | "brand" | "muted" | "text";

function tintPigments(kind: TintKind): { fg: Pigment; wash: Pigment } {
  const fg = kind === "brand" ? active.brand : active.slots[kind];
  const base = active.surfaces?.card ?? active.bg;
  // Dark bases need a stronger wash to read at all; light bases stay airy.
  const amount = active.appearance === "dark" ? 0.16 : 0.1;
  return { fg, wash: blendPigment(base, fg, amount) };
}

/** A pill: the slot colour on its own faint wash. Pad the value yourself (" free "). */
export function chip(kind: TintKind, value: string): string {
  if (NO_COLOR || active.preserveTerminal || active.useNativeColors) return value;
  const { fg, wash } = tintPigments(kind);
  return onBackground(wash, fmt(fg, value));
}

/** A row-spanning wash for tinted cards (fallback banner, compaction receipt). */
export function tintSurface(kind: TintKind, value: string): string {
  if (NO_COLOR || active.preserveTerminal || active.useNativeColors) return value;
  return onBackground(tintPigments(kind).wash, value);
}

// ─── Semantic tokens (read the active theme at call time) ───

const slot = (name: SlotName) => (value: string) =>
  fmt(active.slots[name], value, active.useNativeColors);

export const text = slot("text"); // primary text, banner name
export const brand = (value: string): string => fmt(active.brand, value, active.useNativeColors);
export const muted = slot("muted"); // secondary text
export const faint = slot("faint"); // hints, connectors
export const accent = slot("accent"); // single emphasis, errors, `›`
export const info = slot("info"); // commands, paths, tool targets
export const warn = slot("warn"); // warnings, prompts, bar fill
export const ok = slot("ok"); // success ✓
export const line = slot("line"); // borders / rules

/**
 * A colour part-way between two slots. The live rung is the only caller, and it
 * exists for one reason: a mark that snaps between two pigments reads as a
 * blink, and a blink is how a terminal says *something is wrong* — it is the
 * grammar of a smoke alarm, not of a colleague working. Easing along a ramp
 * instead reads as breathing, which is what a process that is fine but busy
 * should look like. On a 256-colour terminal the ramp quantises to a handful of
 * steps and simply breathes more coarsely; under NO_COLOR it is inert, like
 * every other token here.
 */
export function between(from: SlotName, to: SlotName, amount: number): (value: string) => string {
  const ratio = Math.max(0, Math.min(1, amount));
  return (value: string) =>
    fmt(blendPigment(active.slots[from], active.slots[to], ratio), value, active.useNativeColors);
}

// ─── Back-compat raw pigment names (now mapped onto theme slots) ───
// welcome.ts, diff-render.ts and gear-cli.ts import these; routing them
// through slots means diffs and the provider list recolour with the
// active theme too, with no changes at their call sites.

export const paper = slot("text");
export const dim = slot("muted");
export const vermillion = slot("accent");
export const brass = slot("warn");
export const cyanotype = slot("info");
export const green = slot("ok");
export const draftLine = slot("line");
