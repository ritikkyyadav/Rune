// ─── Runtime sandbox policy ───
//
// The single source of truth for "how does a bash command run right now",
// mirroring the three tabs of Claude Code's /sandbox: a Mode, an Overrides
// choice, and the Config lists. One process = one policy: the engine sets it
// at startup (config/flag/env/sidecar) and `/sandbox` changes it live.
// Everything that must agree on the answer — the Rust bridge (--sandbox flag
// and the path lists), the background shell planner, the network preflight,
// the permission broker's confinement logic, Auto mode's containment check,
// and the model-facing bash description — reads this module instead of
// carrying its own copy, so the policy can never be half-applied.
//
//   auto-allow (default)  foreground bash runs under Seatbelt/Bubblewrap and,
//                         because the sandbox is the boundary, 3rd gear and
//                         Auto approve it without a prompt.
//   regular               same containment; the gear's ordinary permission
//                         prompt still applies to each command.
//   off                   bash runs directly on the host with full network
//                         and filesystem access. Nothing is contained, so the
//                         broker stops treating bash as auto-approvable — only
//                         4th gear skips prompts, and Auto reviews it.
//
// Per call, `resolveSandboxLaunch` folds the Overrides and Config tabs in:
// an excluded command runs on the host whatever the mode; `unsandboxed: true`
// runs on the host when the fallback override allows it and is refused when
// the policy is strict.

import {
  DEFAULT_SANDBOX_POLICY,
  effectiveSandboxPaths,
  isExcludedCommand,
  mergeSandboxPolicy,
  normalizeSandboxMode,
  type SandboxMode,
  type SandboxPathLists,
  type SandboxPolicy,
} from "@rune/shared";

export type { SandboxMode, SandboxPolicy, SandboxPathLists };

/** Accepted on input: the three modes, plus the historical `"on"` (= auto-allow). */
export type SandboxModeInput = SandboxMode | "on";

type SandboxModeListener = (enabled: boolean) => void;
type SandboxPolicyListener = (policy: Readonly<SandboxPolicy>) => void;

let current: SandboxPolicy = mergeSandboxPolicy(DEFAULT_SANDBOX_POLICY as SandboxPolicy, null);
const modeListeners: SandboxModeListener[] = [];
const policyListeners: SandboxPolicyListener[] = [];

function notify(): void {
  const enabled = current.mode !== "off";
  for (const fn of modeListeners) fn(enabled);
  for (const fn of policyListeners) fn(current);
}

/** Set the process-wide sandbox mode and notify listeners (idempotent-safe). */
export function setSandboxMode(mode: SandboxModeInput | boolean): void {
  const canonical = normalizeSandboxMode(mode);
  if (!canonical) throw new Error(`unknown sandbox mode "${String(mode)}"`);
  current = { ...current, mode: canonical };
  notify();
}

export function getSandboxMode(): SandboxMode {
  return current.mode;
}

/** True when foreground bash runs inside the OS sandbox (auto-allow or regular). */
export function isSandboxEnabled(): boolean {
  return current.mode !== "off";
}

/** True only in auto-allow: the sandbox both contains AND vouches for a command. */
export function isSandboxAutoAllow(): boolean {
  return current.mode === "auto-allow";
}

/** The Overrides tab: may a call that failed on a sandbox restriction retry on the host? */
export function isUnsandboxedFallbackAllowed(): boolean {
  return current.allowUnsandboxedFallback;
}

/** Replace part of the policy live (`/sandbox`, `/config`, the update_config tool). */
export function setSandboxPolicy(patch: Partial<SandboxPolicy>): void {
  current = mergeSandboxPolicy(current, patch);
  notify();
}

export function getSandboxPolicy(): Readonly<SandboxPolicy> {
  return current;
}

/** Reset to the built-in default (tests). */
export function resetSandboxPolicyForTest(): void {
  current = mergeSandboxPolicy(DEFAULT_SANDBOX_POLICY as SandboxPolicy, null);
  notify();
}

/**
 * Subscribe to mode changes. The listener fires immediately with the current
 * state so registration order never leaves a consumer stale, and again on
 * every policy change (a regular↔auto-allow switch keeps `enabled` true but
 * still changes what the bash description has to say).
 */
export function onSandboxModeChange(fn: SandboxModeListener): void {
  modeListeners.push(fn);
  fn(current.mode !== "off");
}

export function onSandboxPolicyChange(fn: SandboxPolicyListener): void {
  policyListeners.push(fn);
  fn(current);
}

/** How one bash call will actually be launched under the current policy. */
export interface SandboxLaunch {
  /** Whether the OS sandbox wraps this call (before asking whether the machine can). */
  sandboxed: boolean;
  reason: "sandboxed" | "off" | "excluded" | "fallback";
  /** The excludedCommands pattern that matched, when `reason` is "excluded". */
  matched?: string;
  /**
   * Set when the call asked for something the policy refuses: `unsandboxed:
   * true` under the strict override. The call must not run as written.
   */
  refusal?: string;
}

/**
 * Fold the Mode, Overrides and Config tabs into one answer for one call.
 * Order matters and is deliberate: an excluded command is the user's explicit
 * decision and wins even under strict; the strict refusal applies only to a
 * request the AGENT made.
 */
export function resolveSandboxLaunch(args: Record<string, unknown>): SandboxLaunch {
  if (current.mode === "off") return { sandboxed: false, reason: "off" };
  const command = typeof args.command === "string" ? args.command : "";
  const matched = isExcludedCommand(command, current.excludedCommands);
  if (matched) return { sandboxed: false, reason: "excluded", matched };
  if (args.unsandboxed === true) {
    if (current.allowUnsandboxedFallback) return { sandboxed: false, reason: "fallback" };
    return {
      sandboxed: true,
      reason: "sandboxed",
      refusal:
        "unsandboxed: true is refused — the sandbox is in strict mode. Run the command inside " +
        "the sandbox (workspace writes, no network unless network: true), or tell the user " +
        "exactly which host access it needs so they can add it to [sandbox] excludedCommands " +
        "or choose the fallback override with /sandbox.",
    };
  }
  return { sandboxed: true, reason: "sandboxed" };
}

/**
 * Could this command be run CONTAINED if its escapes were stripped? False when
 * the sandbox is off or the command is excluded — in both cases "run it in the
 * sandbox instead" would be a promise nothing can keep.
 */
export function canContainCommand(command: string): boolean {
  if (current.mode === "off") return false;
  return isExcludedCommand(command, current.excludedCommands) === undefined;
}

/** The absolute path lists `rune-tools` enforces for this workspace. */
export function sandboxPathsFor(workspaceRoot: string): SandboxPathLists {
  return effectiveSandboxPaths(current, workspaceRoot);
}
