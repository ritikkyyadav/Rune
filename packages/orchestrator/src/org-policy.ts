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
//  - /etc/rune/policy.json + /etc/rune/org.pub (also the macOS
//    /Library/Application Support/Rune/ pair, and the same pair under the
//    previous name `gear`, read-through only) are writable only by root.
//    The signature stops on-disk tampering; the path ownership stops
//    replacement. The key ships SEPARATELY from the policy — a file that
//    carried its own key would verify any forgery.
//  - RUNE_POLICY_FILE / RUNE_POLICY_PUBKEY env overrides are consulted ONLY
//    when no system-path policy exists (dev/test). They can never shadow an
//    installed org policy.
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
  /**
   * Tools that may never run. Checked before every mode/grant/trust path.
   * Entries may contain `*` (e.g. `plugin:acme:*` for a whole plugin bundle,
   * `mcp_*` for every connector tool).
   */
  toolsDeny?: string[];
  /** When present, ONLY these tools may run (allowlist mode). Same wildcards. */
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
  { ok: true; loaded: LoadedOrgPolicy } | { ok: false; error: string } | null; // no policy anywhere — unmanaged machine, behavior unchanged

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
  { policy: "/etc/rune/policy.json", pubkey: "/etc/rune/org.pub" },
  {
    policy: "/Library/Application Support/Rune/policy.json",
    pubkey: "/Library/Application Support/Rune/org.pub",
  },
  // The previous name's locations. A policy an organisation deployed as root
  // under `gear` must keep binding after the rename, or the rename silently
  // disarms it; these are read, never written.
  { policy: "/etc/gear/policy.json", pubkey: "/etc/gear/org.pub" },
  {
    policy: "/Library/Application Support/Gear/policy.json",
    pubkey: "/Library/Application Support/Gear/org.pub",
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
  const envPolicy = process.env.RUNE_POLICY_FILE;
  const envPubkey = process.env.RUNE_POLICY_PUBKEY;
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
 * Whether a policy entry names this tool. `*` matches any run of characters,
 * so `plugin:acme:*` names every tool in one plugin bundle and `mcp_*` every
 * connector tool. Everything else is exact — a policy is read by an admin who
 * must be able to predict what it covers.
 */
export function toolPatternMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`).test(name);
  } catch {
    return false;
  }
}

/**
 * The single policy evaluation the broker calls before any mode shortcut.
 * Returns a denial reason, or null when the policy has no objection.
 *
 * `opts.identities` is every other name this call answers to — for a plugin
 * tool, its `plugin:<plugin>:<tool>` policy id. A DENY hits if ANY identity
 * matches: an admin who wrote `plugin:acme:*` meant it, and a bundle that
 * renamed its model-facing tool must not escape. An ALLOWLIST needs only one
 * identity to match, since both names describe the same call.
 *
 * `opts.category` lets `networkDefaultDeny` cover tools that did not exist
 * when the hard-coded list was written — a plugin's network-capability tool
 * reaches the network exactly as `web_fetch` does.
 */
export function policyDenial(
  policy: OrgPolicy,
  toolName: string,
  args: Record<string, unknown>,
  opts: { identities?: readonly string[]; category?: string } = {},
): string | null {
  const names = [toolName, ...(opts.identities ?? [])].filter(
    (n, i, all) => typeof n === "string" && n.length > 0 && all.indexOf(n) === i,
  );
  if (
    policy.toolsAllow &&
    !policy.toolsAllow.some((pattern) => names.some((n) => toolPatternMatches(pattern, n)))
  ) {
    return `org policy: tool "${toolName}" is not on the allowlist`;
  }
  const denied = policy.toolsDeny?.find((pattern) =>
    names.some((n) => toolPatternMatches(pattern, n)),
  );
  if (denied) {
    return denied === toolName
      ? `org policy: tool "${toolName}" is denied`
      : `org policy: tool "${toolName}" is denied by "${denied}"`;
  }
  if (policy.networkDefaultDeny) {
    if (NETWORK_TOOLS.has(toolName) || opts.category === "network") {
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
