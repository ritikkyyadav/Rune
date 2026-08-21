#!/usr/bin/env bun
/**
 * Org-admin tool: sign a Gear org policy for distribution to managed machines.
 *
 *   bun run scripts/sign-policy.ts <policy.json> <out-dir> [--key <ed25519.key>]
 *
 * Reads a PLAIN policy JSON (the OrgPolicy shape — see
 * packages/orchestrator/src/org-policy.ts), signs its canonical bytes with an
 * Ed25519 key (generated into <out-dir> on first run unless --key is given),
 * and writes:
 *
 *   <out-dir>/policy.json   — { policy, signature }  → install at /etc/gear/policy.json
 *   <out-dir>/org.pub       — public key (PEM)       → install at /etc/gear/org.pub
 *   <out-dir>/ed25519.key   — PRIVATE key. Keep offline. Never distribute.
 *
 * Install both files root-owned (0644) on managed machines; macOS may use
 * /Library/Application Support/Gear/ instead. Gear refuses to start if the
 * policy file is present but fails verification against org.pub.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateEd25519KeyPair, signBytes } from "../packages/orchestrator/src/signing";
import { canonicalPolicyBytes, type OrgPolicy } from "../packages/orchestrator/src/org-policy";

function main(): void {
  const args = process.argv.slice(2);
  const keyFlag = args.indexOf("--key");
  const keyPath = keyFlag !== -1 ? args.splice(keyFlag, 2)[1] : undefined;
  const [policyPath, outDir] = args;
  if (!policyPath || !outDir) {
    console.error(
      "Usage: bun run scripts/sign-policy.ts <policy.json> <out-dir> [--key <ed25519.key>]",
    );
    process.exit(2);
  }

  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as OrgPolicy;
  if (policy.version !== 1) {
    console.error(`policy.version must be 1 (got ${String(policy.version)})`);
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  let privateKeyPem: string;
  let publicKeyPem: string | null = null;
  if (keyPath) {
    privateKeyPem = readFileSync(keyPath, "utf8");
  } else {
    const privFile = join(outDir, "ed25519.key");
    if (existsSync(privFile)) {
      privateKeyPem = readFileSync(privFile, "utf8");
      const pubFile = join(outDir, "org.pub");
      publicKeyPem = existsSync(pubFile) ? readFileSync(pubFile, "utf8") : null;
    } else {
      const pair = generateEd25519KeyPair();
      privateKeyPem = pair.privateKeyPem;
      publicKeyPem = pair.publicKeyPem;
      writeFileSync(privFile, privateKeyPem, { mode: 0o600 });
      console.log(`generated new org key: ${privFile} (keep this OFFLINE)`);
    }
  }
  if (publicKeyPem) writeFileSync(join(outDir, "org.pub"), publicKeyPem);

  const bytes = canonicalPolicyBytes(policy);
  const signature = signBytes(bytes, privateKeyPem);
  const signed = JSON.stringify({ policy, signature }, null, 2) + "\n";
  writeFileSync(join(outDir, "policy.json"), signed);

  console.log(`signed policy written: ${join(outDir, "policy.json")}`);
  console.log(`org public key:        ${join(outDir, "org.pub")}`);
  console.log("install both at /etc/gear/ (root-owned) on managed machines.");
}

main();
