// ─── Theme: base (light/dark/system) × accent, persisted locally ───
// Mirrors the CLI's gear themes (gear[-accent][-dark]). The attribute API is
// the contract's: <html data-theme-base="light|dark" data-accent="orange">.

export type GearAccent = "cobalt" | "orange" | "violet" | "emerald" | "mono";
export type ThemeBase = "light" | "dark" | "system";

export const ACCENTS: Array<{ id: GearAccent; label: string; desc: string; swatch: string }> = [
  { id: "cobalt", label: "Electric Cobalt", desc: "Signature blueprint blue", swatch: "#0038FF" },
  { id: "orange", label: "Cyber Orange", desc: "High-contrast amber", swatch: "#FF5500" },
  { id: "violet", label: "Hyper Violet", desc: "Modern editorial purple", swatch: "#8B5CF6" },
  { id: "emerald", label: "Emerald Matrix", desc: "Terminal phosphor green", swatch: "#10B981" },
  { id: "mono", label: "Stark Monochrome", desc: "Minimalist grayscale", swatch: "#888888" },
];

const KEY = "gear.theme";

export interface ThemeChoice {
  base: ThemeBase;
  accent: GearAccent;
}

export function loadTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ThemeChoice>;
      const accent = ACCENTS.some((a) => a.id === parsed.accent)
        ? (parsed.accent as GearAccent)
        : "orange";
      const base =
        parsed.base === "light" || parsed.base === "dark" || parsed.base === "system"
          ? parsed.base
          : "system";
      return { base, accent };
    }
  } catch {
    /* first run */
  }
  return { base: "system", accent: "orange" };
}

export function resolveBase(base: ThemeBase): "light" | "dark" {
  if (base !== "system") return base;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.setAttribute("data-theme-base", resolveBase(choice.base));
  root.setAttribute("data-accent", choice.accent);
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    /* private mode */
  }
}

/** The CLI's persisted theme id for this choice (shown in the picker's tag). */
export function themeId(choice: ThemeChoice): string {
  const dark = resolveBase(choice.base) === "dark";
  if (choice.accent === "cobalt") return dark ? "gear-dark" : "gear";
  return dark ? `gear-${choice.accent}-dark` : `gear-${choice.accent}`;
}
