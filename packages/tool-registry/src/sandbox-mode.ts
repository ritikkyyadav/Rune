// ─── Runtime sandbox mode ───
//
// The single switch behind "run commands in the OS sandbox" vs "full access",
// mirroring Claude Code's sandbox toggle. One process = one mode: the engine
// sets it at startup (config/flag/env/sidecar) and `/sandbox on|off` flips it
// live. Everything that must agree on the answer — the Rust bridge (--sandbox
// flag), the network preflight, the permission broker's confinement logic, and
// the model-facing bash tool description — reads this module instead of
// carrying its own copy, so the mode can never be half-applied.
//
// ON  (default): foreground bash runs under Seatbelt/Bubblewrap — deny-net,
//                workspace-confined writes, credential denylist. `network:
//                true` escalates a single call out of the sandbox (permission-
//                gated); background shells run unsandboxed (they bind ports).
// OFF:           bash runs directly on the host with full network and
//                filesystem access. Nothing is contained, so the permission
//                broker stops treating bash as auto-approvable under
//                workspace trust — in auto mode every command prompts, and
//                only Hands-Free skips prompts (its existing contract).

export type SandboxMode = "on" | "off";

type SandboxModeListener = (enabled: boolean) => void;

let current: SandboxMode = "on";
const listeners: SandboxModeListener[] = [];

/** Set the process-wide sandbox mode and notify listeners (idempotent-safe). */
export function setSandboxMode(mode: SandboxMode): void {
  current = mode;
  for (const fn of listeners) fn(mode === "on");
}

export function getSandboxMode(): SandboxMode {
  return current;
}

/** True when foreground bash runs inside the OS sandbox. */
export function isSandboxEnabled(): boolean {
  return current === "on";
}

/**
 * Subscribe to mode changes. The listener fires immediately with the current
 * state so registration order never leaves a consumer stale.
 */
export function onSandboxModeChange(fn: SandboxModeListener): void {
  listeners.push(fn);
  fn(current === "on");
}
