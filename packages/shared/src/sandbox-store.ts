// ─── Sandbox-mode persistence ───
// A `/sandbox on|off` choice is saved to ~/.alan/sandbox.json — the same tiny
// JSON-sidecar pattern as theme.json/model.json (config.ts ships only a TOML
// reader, so writing config back would clobber user comments).
//
// resolveInitialSandbox picks the startup state by precedence:
//   CLI flag (--sandbox / --no-sandbox)  >  ALAN_SANDBOX_ENABLED env
//   >  saved sidecar  >  [sandbox].enabled in config  >  on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getAlanHome } from "./config.js";

function sandboxFile(dir: string): string {
  return join(dir, "sandbox.json");
}

/** Persist the chosen sandbox state. Never throws — a write failure must not
 *  crash the UI; the in-memory mode still applied. */
export function saveSandboxState(enabled: boolean, dir: string = getAlanHome()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(sandboxFile(dir), JSON.stringify({ enabled }, null, 2) + "\n");
  } catch {
    // Ignore — only persistence was lost.
  }
}

/** Read the saved state, or null if absent / unreadable / corrupt. */
export function loadSavedSandboxState(dir: string = getAlanHome()): boolean | null {
  try {
    const path = sandboxFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

/** Resolve the startup sandbox state: flag > env > saved > configured > on. */
export function resolveInitialSandbox(opts: {
  /** true for --sandbox, false for --no-sandbox, undefined when neither given. */
  flag?: boolean;
  /** Raw ALAN_SANDBOX_ENABLED value ("true"/"false"), or null/undefined when unset. */
  env?: string | null;
  saved?: boolean | null;
  configured?: boolean | null;
}): boolean {
  if (typeof opts.flag === "boolean") return opts.flag;
  if (opts.env === "true") return true;
  if (opts.env === "false") return false;
  if (typeof opts.saved === "boolean") return opts.saved;
  if (typeof opts.configured === "boolean") return opts.configured;
  return true;
}
