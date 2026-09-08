// ─── Sandbox-mode persistence ───
// A `/sandbox` choice is saved to ~/.rune/sandbox.json — the same tiny
// JSON-sidecar pattern as theme.json/model.json (config.ts ships only a TOML
// reader, so writing config back would clobber user comments).
//
// The sidecar holds the two interactive choices — the Mode and the Overrides
// tab. The lists (excluded commands, filesystem paths) live in config.toml
// under [sandbox], where they can be read and edited as text.
//
// resolveInitialSandboxPolicy picks the startup state by precedence:
//   CLI flag (--sandbox / --no-sandbox)  >  RUNE_SANDBOX_MODE / RUNE_SANDBOX_ENABLED env
//   >  saved sidecar  >  [sandbox] in config  >  auto-allow.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { getRuneHome } from "./paths.js";
import {
  DEFAULT_SANDBOX_POLICY,
  mergeSandboxPolicy,
  normalizeSandboxMode,
  normalizeSandboxPolicyInput,
  type SandboxMode,
  type SandboxPolicy,
} from "./sandbox-policy.js";

export interface SavedSandboxState {
  mode?: SandboxMode;
  allowUnsandboxedFallback?: boolean;
}

function sandboxFile(dir: string): string {
  return join(dir, "sandbox.json");
}

/** A config edit supersedes the older /sandbox sidecar. Report write failures. */
export function clearSavedSandboxState(dir: string = getRuneHome()): void {
  rmSync(sandboxFile(dir), { force: true });
}

/**
 * Forget ONE saved choice, so a value just written to config.toml is not
 * shadowed by the sidecar at the next launch while the other choice survives.
 */
export function forgetSavedSandboxKey(
  key: keyof SavedSandboxState,
  dir: string = getRuneHome(),
): void {
  try {
    const previous = loadSavedSandboxState(dir);
    if (!previous || previous[key] === undefined) return;
    const next: SavedSandboxState = { ...previous };
    delete next[key];
    if (Object.keys(next).length === 0) {
      rmSync(sandboxFile(dir), { force: true });
      return;
    }
    writeFileSync(sandboxFile(dir), JSON.stringify(next, null, 2) + "\n");
  } catch {
    // Ignore — only persistence was lost.
  }
}

/**
 * Persist an interactive choice. A boolean is the historical spelling
 * (`true` = auto-allow, `false` = off); an object merges into what is saved.
 * Never throws — a write failure must not crash the UI; the in-memory mode
 * still applied.
 */
export function saveSandboxState(
  state: boolean | SavedSandboxState,
  dir: string = getRuneHome(),
): void {
  try {
    const previous = loadSavedSandboxState(dir) ?? {};
    const patch: SavedSandboxState =
      typeof state === "boolean" ? { mode: state ? "auto-allow" : "off" } : state;
    const next: SavedSandboxState = { ...previous, ...patch };
    mkdirSync(dir, { recursive: true });
    writeFileSync(sandboxFile(dir), JSON.stringify(next, null, 2) + "\n");
  } catch {
    // Ignore — only persistence was lost.
  }
}

/**
 * Read the saved state, or null if absent / unreadable / corrupt. A legacy
 * `{ "enabled": false }` file written by the old on/off switch still reads.
 */
export function loadSavedSandboxState(dir: string = getRuneHome()): SavedSandboxState | null {
  try {
    const path = sandboxFile(dir);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const out: SavedSandboxState = {};
    const mode = normalizeSandboxMode(parsed.mode);
    if (mode) out.mode = mode;
    else if (typeof parsed.enabled === "boolean") out.mode = parsed.enabled ? "auto-allow" : "off";
    if (typeof parsed.allowUnsandboxedFallback === "boolean") {
      out.allowUnsandboxedFallback = parsed.allowUnsandboxedFallback;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export interface ResolveSandboxOptions {
  /** true for --sandbox, false for --no-sandbox, undefined when neither given. */
  flag?: boolean;
  /** Raw RUNE_SANDBOX_ENABLED value ("true"/"false"), or null/undefined when unset. */
  env?: string | null;
  /** Raw RUNE_SANDBOX_MODE value (auto-allow | regular | off), or null/undefined. */
  envMode?: string | null;
  /** The sidecar. A bare boolean is the historical shape and still resolves. */
  saved?: boolean | SavedSandboxState | null;
  /** `[sandbox]` from config.toml: the legacy `enabled` boolean or the whole table. */
  configured?: boolean | Partial<SandboxPolicy> | Record<string, unknown> | null;
}

/**
 * Resolve the whole startup policy: flag > env > saved > configured > default.
 * The flag and env decide only the mode; the sidecar decides mode and the
 * fallback override; config supplies everything it names.
 */
export function resolveInitialSandboxPolicy(opts: ResolveSandboxOptions): SandboxPolicy {
  const configured: Partial<SandboxPolicy> =
    typeof opts.configured === "boolean"
      ? { mode: opts.configured ? "auto-allow" : "off" }
      : normalizeSandboxPolicyInput(opts.configured ?? undefined);
  let policy = mergeSandboxPolicy(
    { ...DEFAULT_SANDBOX_POLICY, filesystem: { ...DEFAULT_SANDBOX_POLICY.filesystem } },
    configured,
  );
  const saved: SavedSandboxState | null =
    typeof opts.saved === "boolean"
      ? { mode: opts.saved ? "auto-allow" : "off" }
      : (opts.saved ?? null);
  if (saved) policy = mergeSandboxPolicy(policy, saved);
  const envMode = normalizeSandboxMode(opts.envMode ?? undefined);
  if (envMode) policy = { ...policy, mode: envMode };
  else if (opts.env === "true") policy = { ...policy, mode: "auto-allow" };
  else if (opts.env === "false") policy = { ...policy, mode: "off" };
  if (typeof opts.flag === "boolean") {
    // --sandbox re-enables containment without changing a saved regular/auto
    // choice; --no-sandbox is the one switch that always means off.
    policy = {
      ...policy,
      mode: opts.flag ? (policy.mode === "off" ? "auto-allow" : policy.mode) : "off",
    };
  }
  return policy;
}

/** Resolve just the on/off question — kept for every caller that only asks that. */
export function resolveInitialSandbox(opts: ResolveSandboxOptions): boolean {
  return resolveInitialSandboxPolicy(opts).mode !== "off";
}
