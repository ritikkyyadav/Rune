// ─── Theme persistence ───
// The active theme is saved to ~/.gear/theme.json — a tiny JSON sidecar, because
// config.ts ships only a TOML *reader* (writing TOML back would clobber user comments).
// This follows the existing ~/.gear/<file> persistence pattern.
//
// resolveInitialTheme picks the startup theme by precedence:
//   GEAR_THEME env  >  saved sidecar  >  [ui].theme in config  >  built-in default.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getGearHome } from "@gear/shared";
import { DEFAULT_THEME, findTheme, isProductionTheme } from "./themes";

function themeFile(dir: string): string {
  return join(dir, "theme.json");
}

/** Persist the chosen theme name to <dir>/theme.json. Never throws — a write failure
 *  must not crash the UI. */
export function saveTheme(name: string, dir: string = getGearHome()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(themeFile(dir), JSON.stringify({ theme: name }, null, 2) + "\n");
  } catch {
    // Ignore — the in-memory theme still applied; only persistence was lost.
  }
}

/** Read the saved theme name, or null if absent / unreadable / corrupt. */
export function loadSavedTheme(dir: string = getGearHome()): string | null {
  try {
    const path = themeFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { theme?: unknown };
    return typeof parsed.theme === "string" ? parsed.theme : null;
  } catch {
    return null;
  }
}

/** Resolve the startup theme: env > saved > configured > default. Only the small
 *  production theme set is honored — a value naming any other (or a stale/typo'd one)
 *  is skipped and falls through to the next source, ultimately the default. */
export function resolveInitialTheme(opts: {
  env?: string | null;
  saved?: string | null;
  configured?: string | null;
}): string {
  for (const candidate of [opts.env, opts.saved, opts.configured]) {
    if (candidate && isProductionTheme(candidate)) {
      return findTheme(candidate)!.name;
    }
  }
  return DEFAULT_THEME;
}
