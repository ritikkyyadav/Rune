import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOrgPolicy,
  policyDenial,
  policyAllowsModel,
  canonicalPolicyBytes,
  type OrgPolicy,
} from "../../../packages/orchestrator/src/org-policy";
import {
  generateEd25519KeyPair,
  signBytes,
} from "../../../packages/orchestrator/src/signing";
import { PermissionBroker } from "../../../packages/orchestrator/src/permissions";
import { setSandboxCapability } from "../../../packages/tool-registry/src/sandbox-capability";

// P9: admin-enforced constraints the end user cannot lift. The load path is
// driven through the BERNE_POLICY_FILE env override (honored only when no
// system policy exists — true on dev machines and CI).

setSandboxCapability({ mechanism: "seatbelt", osIsolation: true });

const POLICY: OrgPolicy = {
  version: 1,
  org: "Acme Compliance",
  toolsDeny: ["web_fetch"],
  forbidPermissionModes: ["turing"],
  networkDefaultDeny: true,
  providerAllow: ["anthropic"],
  modelAllow: ["claude-*"],
};

let dir: string;

function installPolicy(policy: OrgPolicy, opts: { tamper?: boolean; badKey?: boolean } = {}): void {
  const pair = generateEd25519KeyPair();
  const signature = signBytes(canonicalPolicyBytes(policy), pair.privateKeyPem);
  const filePolicy = opts.tamper ? { ...policy, toolsDeny: [] } : policy;
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ policy: filePolicy, signature }));
  const pub = opts.badKey ? generateEd25519KeyPair().publicKeyPem : pair.publicKeyPem;
  writeFileSync(join(dir, "org.pub"), pub);
  process.env.BERNE_POLICY_FILE = join(dir, "policy.json");
  process.env.BERNE_POLICY_PUBKEY = join(dir, "org.pub");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alan-policy-"));
});

afterEach(() => {
  delete process.env.BERNE_POLICY_FILE;
  delete process.env.BERNE_POLICY_PUBKEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrgPolicy", () => {
  test("valid signed policy loads with a stable fingerprint", () => {
    installPolicy(POLICY);
    const result = loadOrgPolicy();
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("unreachable");
    expect(result.loaded.policy.org).toBe("Acme Compliance");
    expect(result.loaded.fingerprint).toHaveLength(16);
  });

  test("tampered policy (bytes changed after signing) is an ERROR, not absence", () => {
    installPolicy(POLICY, { tamper: true });
    const result = loadOrgPolicy();
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error("unreachable");
    expect(result.error).toMatch(/signature verification/);
  });

  test("policy signed by a different key than the installed org key fails", () => {
    installPolicy(POLICY, { badKey: true });
    const result = loadOrgPolicy();
    expect(result?.ok).toBe(false);
  });

  test("policy without any public key installed fails closed", () => {
    installPolicy(POLICY);
    rmSync(join(dir, "org.pub"));
    delete process.env.BERNE_POLICY_PUBKEY;
    const result = loadOrgPolicy();
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error("unreachable");
    expect(result.error).toMatch(/public key/);
  });

  test("no policy anywhere → null (unmanaged machine, unchanged behavior)", () => {
    expect(loadOrgPolicy()).toBeNull();
  });
});

describe("PermissionBroker under org policy", () => {
  const bashSchema = {
    name: "bash",
    permissionLevel: "sandbox" as const,
    description: "",
    parameters: [],
  };
  const webSchema = {
    name: "web_fetch",
    permissionLevel: "confirm" as const,
    description: "",
    parameters: [],
  };

  test("policy denies bash network escalation even in turing (yolo) mode", () => {
    const broker = new PermissionBroker(true, { orgPolicy: POLICY });
    const decision = broker.check(bashSchema, { command: "curl x", network: true });
    expect(decision.type).toBe("denied");
    if (decision.type !== "denied") throw new Error("unreachable");
    expect(decision.reason).toMatch(/org policy/);
    // Plain sandboxed bash is not the policy's business — yolo still allows it.
    expect(broker.check(bashSchema, { command: "ls" }).type).toBe("allowed");
  });

  test("denied tools are terminal in every mode, grants cannot override", () => {
    const broker = new PermissionBroker(false, { orgPolicy: POLICY });
    broker.grantTool("web_fetch", "session");
    expect(broker.check(webSchema, { url: "https://x" }).type).toBe("denied");
    const yolo = new PermissionBroker(true, { orgPolicy: POLICY });
    expect(yolo.check(webSchema, { url: "https://x" }).type).toBe("denied");
  });

  test("allowlist mode: unlisted tools are denied", () => {
    const broker = new PermissionBroker(true, {
      orgPolicy: { version: 1, toolsAllow: ["read_file", "grep"] },
    });
    expect(
      broker.check(
        { name: "read_file", permissionLevel: "auto", description: "", parameters: [] },
        {},
      ).type,
    ).toBe("allowed");
    expect(broker.check(bashSchema, { command: "ls" }).type).toBe("denied");
  });

  test("forbidden permission modes are refused and the mode stands", () => {
    const broker = new PermissionBroker(false, { orgPolicy: POLICY });
    const res = broker.setMode("turing");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/forbids/);
    expect(broker.getMode()).toBe("confirm");
    // Allowed modes still work.
    expect(broker.setMode("auto").ok).toBe(true);
    expect(broker.getMode()).toBe("auto");
  });

  test("no policy → decisions identical to before (spot check)", () => {
    const broker = new PermissionBroker(true, {});
    expect(broker.check(webSchema, { url: "https://x" }).type).toBe("allowed");
    expect(broker.setMode("turing").ok).toBe(true);
  });
});

describe("model/provider allowlists", () => {
  test("prefix and exact entries", () => {
    expect(policyAllowsModel(POLICY, "anthropic", "claude-sonnet-5")).toBeNull();
    expect(policyAllowsModel(POLICY, "anthropic", "gpt-5")).toMatch(/model "gpt-5"/);
    expect(policyAllowsModel(POLICY, "openai", "claude-sonnet-5")).toMatch(/provider "openai"/);
    const exact: OrgPolicy = { version: 1, modelAllow: ["qwen3-coder-next"] };
    expect(policyAllowsModel(exact, "any", "qwen3-coder-next")).toBeNull();
    expect(policyAllowsModel(exact, "any", "qwen3-coder")).toMatch(/not on the allowlist/);
  });
});

describe("policyDenial unit surface", () => {
  test("network default-deny hits web tools and bash escalation only", () => {
    const p: OrgPolicy = { version: 1, networkDefaultDeny: true };
    expect(policyDenial(p, "web_search", {})).toMatch(/default-deny/);
    expect(policyDenial(p, "bash", { network: true })).toMatch(/default-deny/);
    expect(policyDenial(p, "bash", {})).toBeNull();
    expect(policyDenial(p, "read_file", {})).toBeNull();
  });
});
