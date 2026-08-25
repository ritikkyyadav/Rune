// ─── Browser-mode persistence ───
// A `/browser on|off` choice is saved to ~/.gear/browser.json — the same tiny
// JSON-sidecar pattern as sandbox.json/theme.json/model.json (config.ts ships
// only a TOML reader, so writing config back would clobber user comments).
//
// resolveInitialBrowser picks the startup state by precedence:
//   CLI flag (--browser / --no-browser)  >  GEAR_BROWSER_ENABLED env
//   >  saved sidecar  >  [browser].enabled in config  >  off.
//
// Off by default: the agent browser spawns a real Chromium and fetches
// @playwright/mcp on first use — that is an opt-in posture, unlike the
// sandbox (a containment layer, on by default).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getGearHome } from "./paths.js";

function browserFile(dir: string): string {
  return join(dir, "browser.json");
}

/** Persist the chosen browser state. Never throws — a write failure must not
 *  crash the UI; the in-memory mode still applied. */
export function saveBrowserState(enabled: boolean, dir: string = getGearHome()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(browserFile(dir), JSON.stringify({ enabled }, null, 2) + "\n");
  } catch {
    // Ignore — only persistence was lost.
  }
}

/** Read the saved state, or null if absent / unreadable / corrupt. */
export function loadSavedBrowserState(dir: string = getGearHome()): boolean | null {
  try {
    const path = browserFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

/** Resolve the startup browser state: flag > env > saved > configured > off. */
export function resolveInitialBrowser(opts: {
  /** true for --browser, false for --no-browser, undefined when neither given. */
  flag?: boolean;
  /** Raw GEAR_BROWSER_ENABLED value ("true"/"false"), or null/undefined when unset. */
  env?: string | null;
  saved?: boolean | null;
  configured?: boolean | null;
}): boolean {
  if (typeof opts.flag === "boolean") return opts.flag;
  if (opts.env === "true") return true;
  if (opts.env === "false") return false;
  if (typeof opts.saved === "boolean") return opts.saved;
  if (typeof opts.configured === "boolean") return opts.configured;
  return false;
}
