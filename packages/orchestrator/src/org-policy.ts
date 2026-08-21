// ─── Signed org policy: admin-enforced constraints the end user cannot lift ───
//
// The compliance primitives (sandbox, redaction, signed exports) mean nothing
// to a regulated buyer if the end user can toggle them off. This module loads
// a policy file from a ROOT-OWNED system path, verifies its Ed25519 signature
// against a separately installed org public key, and hands the result to the
// PermissionBroker, which checks it BEFORE every mode shortcut — a policy
// denial is terminal even in 4th gear (the legacy turing / hands-free mode).
//
// Trust model:
//  - /etc/gear/policy.json + /etc/gear/org.pub (also the macOS
//    /Library/Application Support/Gear/ pair) are writable only by root.
//    The signature stops on-disk tampering; the path ownership stops
//    replacement. The key ships SEPARATELY from the policy — a file that
//    carried its own key would verify any forgery.
//  - GEAR_POLICY_FILE / GEAR_POLICY_PUBKEY env overrides are consulted ONLY
//    when no system-path policy exists (dev/test). They can never shadow an
//    installed org policy. Elio/Alan/Berne spellings remain migration fallbacks.
//  - A policy that exists but fails verification is an ERROR, not an absence:
//    the engine refuses to start rather than running unpoliced.
//
// Signing a policy (org admin, offline):
//   bun run scripts/sign-policy.ts <policy.json> <out-dir>   # emits signed file + keys

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { verifySignature } from "./signing";
import type { PermissionMode, LegacyPermissionMode } from "./permissions";
import type { AutoModePolicyConfig } from "./auto-mode";

export interface OrgPolicy {
  version: 1;
  /** Display name shown in /status. */
  org?: string;
  /** Tools that may never run. Checked before every mode/grant/trust path. */
  toolsDeny?: string[];
  /** When present, ONLY these tools may run (allowlist mode). */
  toolsAllow?: string[];
  /** Gears the user may not enter. Legacy signed values (turing, hands-free, autonomy-iii…) remain valid. */
  forbidPermissionModes?: Array<PermissionMode | LegacyPermissionMode>;
  /** Deny bash network escalation and network-reaching tools outright. */
  networkDefaultDeny?: boolean;
  /** When present, only these providers may serve inference. */
  providerAllow?: string[];
  /** When present, only these models may run. Entries may end with '*' (prefix). */
  modelAllow?: string[];
  /** Pin the telemetry endpoint (any other configured endpoint is refused). */
  telemetryEndpoint?: string;
  /** Signed, admin-owned additions to the classifier-backed Auto policy. */
  autoMode?: AutoModePolicyConfig;
}

export interface LoadedOrgPolicy {
  policy: OrgPolicy;
  /** sha256 of the signed policy bytes — the fingerprint /status displays. */
  fingerprint: string;
  /** Which file the policy came from. */
  source: string;
}

export type OrgPolicyLoadResult =
  | { ok: true; loaded: LoadedOrgPolicy }
  | { ok: false; error: string }
  | null; // no policy anywhere — unmanaged machine, behavior unchanged

interface SignedPolicyFile {
  policy: OrgPolicy;
  /** base64 Ed25519 signature over the canonical JSON of `policy`. */
  signature: string;
}

/** Canonical bytes that get signed: stable-key-order JSON of the policy. */
export function canonicalPolicyBytes(policy: OrgPolicy): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(policy));
}

const SYSTEM_LOCATIONS: Array<{ policy: string; pubkey: string }> = [
  { policy: "/etc/gear/policy.json", pubkey: "/etc/gear/org.pub" },
  {
    policy: "/Library/Application Support/Gear/policy.json",
    pubkey: "/Library/Application Support/Gear/org.pub",
  },
  // Legacy locations remain valid during the Elio/Alan/Berne -> Gear migration.
  { policy: "/etc/elio/policy.json", pubkey: "/etc/elio/org.pub" },
  {
    policy: "/Library/Application Support/Elio/policy.json",
    pubkey: "/Library/Application Support/Elio/org.pub",
  },
  { policy: "/etc/berne/policy.json", pubkey: "/etc/berne/org.pub" },
  {
    policy: "/Library/Application Support/Berne/policy.json",
    pubkey: "/Library/Application Support/Berne/org.pub",
  },
];

/**
 * Load and verify the org policy. Resolution order: system paths (always win),
 * then the env-var pair when NO system policy exists. Returns null when no
 * policy is installed anywhere.
 */
export function loadOrgPolicy(): OrgPolicyLoadResult {
  const candidates = [...SYSTEM_LOCATIONS];
  const systemPresent = SYSTEM_LOCATIONS.some((l) => existsSync(l.policy));
  const envPolicy =
    process.env.GEAR_POLICY_FILE ??
    process.env.ELIO_POLICY_FILE ??
    process.env.ALAN_POLICY_FILE ??
    process.env.BERNE_POLICY_FILE;
  const envPubkey =
    process.env.GEAR_POLICY_PUBKEY ??
    process.env.ELIO_POLICY_PUBKEY ??
    process.env.ALAN_POLICY_PUBKEY ??
    process.env.BERNE_POLICY_PUBKEY;
  if (!systemPresent && envPolicy) {
    candidates.push({
      policy: envPolicy,
      pubkey: envPubkey ?? "",
    });
  }

  for (const location of candidates) {
    if (!existsSync(location.policy)) continue;

    let raw: string;
    try {
      raw = readFileSync(location.policy, "utf8");
    } catch (err) {
      return { ok: false, error: `org policy at ${location.policy} is unreadable: ${err}` };
    }

    let parsed: SignedPolicyFile;
    try {
      parsed = JSON.parse(raw) as SignedPolicyFile;
    } catch {
      return { ok: false, error: `org policy at ${location.policy} is not valid JSON` };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.policy || !parsed.signature) {
      return {
        ok: false,
        error: `org policy at ${location.policy} is missing policy/signature fields`,
      };
    }

    if (!location.pubkey || !existsSync(location.pubkey)) {
      return {
        ok: false,
        error:
          `org policy found at ${location.policy} but no org public key at ` +
          `${location.pubkey || "(unset)"} — install the key or remove the policy`,
      };
    }
    const publicKeyPem = readFileSync(location.pubkey, "utf8");
    const bytes = canonicalPolicyBytes(parsed.policy);
    if (!verifySignature(bytes, parsed.signature, publicKeyPem)) {
      return {
        ok: false,
        error:
          `org policy at ${location.policy} failed signature verification — ` +
          `the file was modified after signing, or the wrong org key is installed`,
      };
    }

    return {
      ok: true,
      loaded: {
        policy: parsed.policy,
        fingerprint: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        source: location.policy,
      },
    };
  }

  return null;
}

/** Tools that reach the network regardless of args (for networkDefaultDeny). */
const NETWORK_TOOLS = new Set(["web_fetch", "web_search", "n8n_trigger"]);

/**
 * The single policy evaluation the broker calls before any mode shortcut.
 * Returns a denial reason, or null when the policy has no objection.
 */
export function policyDenial(
  policy: OrgPolicy,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (policy.toolsAllow && !policy.toolsAllow.includes(toolName)) {
    return `org policy: tool "${toolName}" is not on the allowlist`;
  }
  if (policy.toolsDeny?.includes(toolName)) {
    return `org policy: tool "${toolName}" is denied`;
  }
  if (policy.networkDefaultDeny) {
    if (NETWORK_TOOLS.has(toolName)) {
      return `org policy: network access is default-deny (tool "${toolName}")`;
    }
    if (toolName === "bash" && args.network === true) {
      return "org policy: network access is default-deny (bash network escalation)";
    }
  }
  return null;
}

/** Whether the policy allows this provider/model pair to serve inference. */
export function policyAllowsModel(
  policy: OrgPolicy,
  provider: string,
  model: string,
): string | null {
  if (policy.providerAllow && !policy.providerAllow.includes(provider)) {
    return `org policy: provider "${provider}" is not on the allowlist (${policy.providerAllow.join(", ")})`;
  }
  if (policy.modelAllow) {
    const ok = policy.modelAllow.some((entry) =>
      entry.endsWith("*") ? model.startsWith(entry.slice(0, -1)) : model === entry,
    );
    if (!ok) {
      return `org policy: model "${model}" is not on the allowlist (${policy.modelAllow.join(", ")})`;
    }
  }
  return null;
}
