// ─── Theme: light | dark | system ───
//
// Three states, and the browser's own vocabulary for them:
//
//   <html>                     nothing stamped — follow the OS
//   <html data-theme="dark">   an explicit choice, which wins
//   <html data-theme="light">  the same, in the other direction
//
// `system` is the default and stamps NOTHING, so `prefers-color-scheme` decides
// and the page follows a machine that switches at sunset without anyone
// touching a setting. An explicit choice writes the attribute, and tokens.css
// defines every colour in all three states — a colour whose only definition
// lives inside a media query is a colour that is missing in one of them, and
// the missing one is always the one nobody tested.

export type ThemeBase = "light" | "dark" | "system";

/** The one accent. Kept as a type so the seam is visible, not so it is used. */
export type GearAccent = "gear";

const KEY = "gear.theme";

/**
 * The undocumented override.
 *
 * `[ui] accent` in config, or `gear.accent` in browser storage, still swaps the
 * accent. It is not in Settings, not in the docs a user reads, and not
 * supported; it exists so a custom build has somewhere to go.
 */
const ACCENT_OVERRIDE_KEY = "gear.accent";

export interface ThemeChoice {
  base: ThemeBase;
}

export const THEME_BASES: Array<{ id: ThemeBase; label: string; desc: string }> = [
  { id: "system", label: "System", desc: "Follow this machine" },
  { id: "light", label: "Light", desc: "Near-white ground" },
  { id: "dark", label: "Dark", desc: "The same system, inverted" },
];

export function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemeChoice>;
      const base =
        parsed.base === "light" || parsed.base === "dark" || parsed.base === "system"
          ? parsed.base
          : "system";
      return { base };
    }
  } catch {
    /* first run, or storage refused */
  }
  return { base: "system" };
}

/** What the choice resolves to right now — for anything that needs the answer. */
export function resolveBase(base: ThemeBase): "light" | "dark" {
  if (base !== "system") return base;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function accentOverride(): string {
  try {
    return localStorage.getItem(ACCENT_OVERRIDE_KEY) || "gear";
  } catch {
    return "gear";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  // `system` removes the attribute rather than stamping a resolved value: the
  // page then tracks the OS live, without a listener and without a repaint that
  // arrives one frame after the rest of the desktop has already changed.
  if (choice.base === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice.base);
  root.setAttribute("data-accent", accentOverride());
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* private mode: the theme still applies, it is just not remembered */
  }
}

/** The console's persisted theme id for this choice — the two surfaces stay in step. */
export function themeId(choice: ThemeChoice): string {
  return resolveBase(choice.base) === "dark" ? "gear-dark" : "gear";
}
