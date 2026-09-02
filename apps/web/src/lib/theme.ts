// ─── Theme: light | dark | system ───
//
// There used to be five accents × two bases here, ported from the customizer,
// and three visual identities in the repository at once. Phase 3 collapsed all
// of it to the Savoir DNA: one accent, two grounds. Choosing a colour was never
// a thing anyone needed from a coding agent, and offering it made the product
// look like a theme gallery rather than an instrument.
//
// The attribute API is unchanged, because the stylesheet speaks it:
// `<html data-theme-base="light|dark" data-accent="datum">`.

export type ThemeBase = "light" | "dark" | "system";

/** The one accent. Kept as a type so the seam is visible, not so it is used. */
export type GearAccent = "datum";

const KEY = "gear.theme";

/**
 * The undocumented override.
 *
 * `[ui] accent` in config, or `gear.accent` in browser storage, still swaps the
 * accent — the customizer needs somewhere to go, and a hidden escape hatch
 * costs nothing. It is not in the picker, not in the docs the user reads, and
 * not supported.
 */
const ACCENT_OVERRIDE_KEY = "gear.accent";

export interface ThemeChoice {
  base: ThemeBase;
}

export const THEME_BASES: Array<{ id: ThemeBase; label: string; desc: string }> = [
  { id: "light", label: "Light", desc: "Drafting paper — the default ground" },
  { id: "dark", label: "Dark", desc: "Ink — the same system, inverted" },
  { id: "system", label: "Auto", desc: "Follow the operating system" },
];

export function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemeChoice> & { accent?: string };
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

export function resolveBase(base: ThemeBase): "light" | "dark" {
  if (base !== "system") return base;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function accentOverride(): string {
  try {
    return localStorage.getItem(ACCENT_OVERRIDE_KEY) || "datum";
  } catch {
    return "datum";
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.setAttribute("data-theme-base", resolveBase(choice.base));
  root.setAttribute("data-accent", accentOverride());
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* private mode: the theme still applies, it is just not remembered */
  }
}

/** The CLI's persisted theme id for this choice — the two surfaces stay in step. */
export function themeId(choice: ThemeChoice): string {
  return resolveBase(choice.base) === "dark" ? "gear-dark" : "gear";
}
