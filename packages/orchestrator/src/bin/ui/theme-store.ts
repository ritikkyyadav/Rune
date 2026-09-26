// --- Theme persistence ---
// The active theme is saved to ~/.rune/theme.json -- a tiny JSON sidecar, because
// config.ts ships only a TOML *reader* (writing TOML back would clobber user comments).
// This follows the existing ~/.rune/<file> persistence pattern.
//
// resolveInitialTheme picks the startup theme by precedence:
//   RUNE_THEME env  >  saved sidecar  >  [ui].theme in config  >  built-in default.
//
// The FINISH (matte | crisp, 2026-09-26) is saved in the same sidecar, beside
// the theme and not inside its name: it is a second axis, and a person who
// switches light/dark should keep the finish they chose. Its precedence --
// RUNE_FINISH > saved > [ui].finish > matte -- lives in @rune/shared
// (resolveUiFinish), because the engine reads `[ui] finish` for /config too.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getRuneHome } from "@rune/shared";
import { DEFAULT_THEME, findTheme, isProductionTheme } from "./themes";

function themeFile(dir: string): string {
  return join(dir, "theme.json");
}

/** The sidecar as written, or an empty object when absent or unreadable. */
function readSidecar(dir: string): { theme?: unknown; finish?: unknown } {
  try {
    const path = themeFile(dir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { theme?: unknown; finish?: unknown })
      : {};
  } catch {
    return {};
  }
}

/** Persist the chosen theme name (and, when given, the finish) to
 *  <dir>/theme.json. A finish already saved survives a theme-only save. Never
 *  throws -- a write failure must not crash the UI. */
export function saveTheme(name: string, dir: string = getRuneHome(), finish?: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const prior = readSidecar(dir);
    const kept = finish ?? (typeof prior.finish === "string" ? prior.finish : undefined);
    const next: { theme: string; finish?: string } = { theme: name };
    if (kept) next.finish = kept;
    writeFileSync(themeFile(dir), JSON.stringify(next, null, 2) + "\n");
  } catch {
    // Ignore -- the in-memory theme still applied; only persistence was lost.
  }
}

/** Read the saved theme name, or null if absent / unreadable / corrupt. */
export function loadSavedTheme(dir: string = getRuneHome()): string | null {
  const sidecar = readSidecar(dir);
  return typeof sidecar.theme === "string" ? sidecar.theme : null;
}

/** Read the saved finish, or null if none was ever chosen. */
export function loadSavedFinish(dir: string = getRuneHome()): string | null {
  const sidecar = readSidecar(dir);
  return typeof sidecar.finish === "string" ? sidecar.finish : null;
}

type ThemeSources = {
  env?: string | null;
  saved?: string | null;
  configured?: string | null;
};

/** Which source decides the startup theme, by the precedence resolveInitialTheme
 *  applies -- `default` when none of them names a production theme. */
export function initialThemeSource(opts: ThemeSources): "env" | "saved" | "configured" | "default" {
  const order: Array<["env" | "saved" | "configured", string | null | undefined]> = [
    ["env", opts.env],
    ["saved", opts.saved],
    ["configured", opts.configured],
  ];
  for (const [source, candidate] of order) {
    if (candidate && isProductionTheme(candidate)) return source;
  }
  return "default";
}

/** Resolve the startup theme: env > saved > configured > default. Only the small
 *  production theme set is honored -- a value naming any other (or a stale/typo'd one)
 *  is skipped and falls through to the next source, ultimately the default. */
export function resolveInitialTheme(opts: ThemeSources): string {
  for (const candidate of [opts.env, opts.saved, opts.configured]) {
    if (candidate && isProductionTheme(candidate)) {
      return findTheme(candidate)!.name;
    }
  }
  return DEFAULT_THEME;
}
