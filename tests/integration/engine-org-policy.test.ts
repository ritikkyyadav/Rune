import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../../packages/orchestrator/src/engine";
import { canonicalPolicyBytes, type OrgPolicy } from "../../packages/orchestrator/src/org-policy";
import { generateEd25519KeyPair, signBytes } from "../../packages/orchestrator/src/signing";

const RUST_RELEASE = join(import.meta.dir, "../../target/release/rune-tools");
const RUST_DEBUG = join(import.meta.dir, "../../target/debug/rune-tools");
const RUST_BIN = existsSync(RUST_RELEASE) ? RUST_RELEASE : RUST_DEBUG;
const HAS_RUST_BIN = existsSync(RUST_BIN);

// P9 acceptance: an installed-but-invalid policy REFUSES to start (running
// unpoliced is the failure the signature prevents); a valid one is enforced
// and surfaced in status.

describe("Engine under org policy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rune-engine-policy-"));
  });

  afterEach(() => {
    delete process.env.RUNE_POLICY_FILE;
    delete process.env.RUNE_POLICY_PUBKEY;
    rmSync(dir, { recursive: true, force: true });
  });

  function install(policy: OrgPolicy, tamper: boolean): void {
    const pair = generateEd25519KeyPair();
    const signature = signBytes(canonicalPolicyBytes(policy), pair.privateKeyPem);
    const written = tamper ? { ...policy, org: "Mallory" } : policy;
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ policy: written, signature }));
    writeFileSync(join(dir, "org.pub"), pair.publicKeyPem);
    process.env.RUNE_POLICY_FILE = join(dir, "policy.json");
    process.env.RUNE_POLICY_PUBKEY = join(dir, "org.pub");
  }

  function makeEngine(): Engine {
    return new Engine({
      model: "mock-model",
      provider: "anthropic",
      workspaceRoot: dir,
      dbPath: join(dir, "rune.db"),
      toolsBinaryPath: RUST_BIN,
      yoloMode: true, // the policy must beat even this
    });
  }

  test.skipIf(!HAS_RUST_BIN)("tampered policy refuses to start", () => {
    install({ version: 1, org: "Acme" }, true);
    expect(() => makeEngine()).toThrow(/Refusing to start/);
  });

  test.skipIf(!HAS_RUST_BIN)(
    "valid policy: enforced in status, Autonomy III stripped, mode cycle skips it",
    () => {
      install(
        { version: 1, org: "Acme", forbidPermissionModes: ["turing"], networkDefaultDeny: true },
        false,
      );
      const engine = makeEngine();
      try {
        const status = engine.getStatus();
        expect(status.orgPolicy?.org).toBe("Acme");
        expect(status.orgPolicy?.fingerprint).toHaveLength(16);
        // yoloMode:true in config was stripped by the forbidden-mode rule.
        expect(engine.getPermissionMode()).not.toBe("gear-4");
        // The Shift+Tab cycle can never land on the forbidden mode.
        const seen = new Set<string>();
        for (let i = 0; i < 6; i++) seen.add(engine.cyclePermissionMode());
        expect(seen.has("gear-4")).toBe(false);
        expect(engine.setPermissionMode("turing").ok).toBe(false);
      } finally {
        engine.close();
      }
    },
  );

  test.skipIf(!HAS_RUST_BIN)("no policy: nothing changes", () => {
    const engine = makeEngine();
    try {
      expect(engine.getStatus().orgPolicy).toBeNull();
      expect(engine.getPermissionMode()).toBe("gear-4");
    } finally {
      engine.close();
    }
  });
});
