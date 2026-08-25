// ─── Sandbox capability (what this MACHINE can do) ───
//
// sandbox-mode.ts holds the user's intent (on/off). This module holds the
// machine's ability: whether an OS isolation backend (seatbelt/bwrap) is
// actually available. The two are different facts and the distinction is
// load-bearing — the Rust factory silently falls back to a path-guard-only
// executor when the backend is missing (no sandbox-exec, no bwrap, all of
// Windows), so "sandbox on" can quietly mean "no containment at all".
// Everything that PREDICATES trust on containment (the permission broker's
// bash auto-approval, the /status row, the mode banner, the model-facing bash
// description) must read this module, not assume intent implies capability.
//
// Until probed, capability is UNKNOWN and treated as not isolated — the
// fail-safe direction: the worst case is a permission prompt that wasn't
// strictly needed, never a silently uncontained auto-approved command.

export interface SandboxCapability {
  /** Isolation backend that would run: "seatbelt", "bwrap", "none", "unknown". */
  mechanism: string;
  /** True only when an OS-level isolation backend is available. */
  osIsolation: boolean;
}

type CapabilityListener = (cap: SandboxCapability) => void;

let current: SandboxCapability | null = null;
let requireOs = false;
const listeners: CapabilityListener[] = [];

const UNKNOWN: SandboxCapability = { mechanism: "unknown", osIsolation: false };

/** Record the probed capability (engine at startup; tests directly). */
export function setSandboxCapability(cap: SandboxCapability): void {
  current = cap;
  for (const fn of listeners) fn(cap);
}

export function getSandboxCapability(): SandboxCapability {
  return current ?? UNKNOWN;
}

/** True only when OS-level isolation is confirmed available on this machine. */
export function isOsIsolationAvailable(): boolean {
  return current?.osIsolation === true;
}

/**
 * `[sandbox] requireOs = true`: refuse to run sandbox-tier commands degraded
 * instead of silently running them uncontained. For machines where the user
 * considers containment mandatory (CI runners, shared boxes).
 */
export function setRequireOsIsolation(value: boolean): void {
  requireOs = value === true;
}

export function isOsIsolationRequired(): boolean {
  return requireOs;
}

/**
 * Subscribe to capability changes. Fires immediately with the current state
 * (UNKNOWN before any probe) so registration order never leaves a consumer stale.
 */
export function onSandboxCapabilityChange(fn: CapabilityListener): void {
  listeners.push(fn);
  fn(getSandboxCapability());
}

/**
 * Probe the machine by running `gear-tools sandbox-check` (synchronous — a
 * one-time ~10ms startup cost buys the guarantee that no permission decision
 * ever races the probe). Any failure — binary missing, bad output — records
 * UNKNOWN/false rather than throwing: capability degrades to prompts, never
 * to a crash or a false "isolated".
 */
export function probeSandboxCapability(binaryPath: string): SandboxCapability {
  try {
    const proc = Bun.spawnSync([binaryPath, "sandbox-check"], {
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
    if (parsed?.success === true && parsed.result && typeof parsed.result.mechanism === "string") {
      const cap: SandboxCapability = {
        mechanism: parsed.result.mechanism,
        osIsolation: parsed.result.os_isolation === true,
      };
      setSandboxCapability(cap);
      return cap;
    }
  } catch {
    // fall through to unknown
  }
  setSandboxCapability(UNKNOWN);
  return UNKNOWN;
}

/** Reset to the unprobed state (tests). */
export function resetSandboxCapabilityForTest(): void {
  current = null;
  requireOs = false;
}
