// ─── Detached Ed25519 signatures for a release ───
//
// macOS has Developer ID and notarization. Windows has Authenticode. Linux has
// nothing built in, and the honest answer there is a detached signature anyone
// can check against a public key published in the README.
//
// What gets signed is `SHA256SUMS`, not each binary. That file already names
// every artifact and its digest, and it is generated in the same CI job that
// produced the binaries — so one signature over it covers the whole release,
// and verifying is two commands instead of ten.
//
// The primitive is the one Gear already uses for signed session exports
// (`packages/orchestrator/src/signing.ts`), so there is one Ed25519
// implementation in the repo rather than a second one for releases.
//
// Usage:
//   bun scripts/sign-release.ts sign   <dir>            # needs GEAR_SIGNING_PRIVATE_KEY
//   bun scripts/sign-release.ts verify <dir> <pubkey>   # pubkey: PEM file or base64
//
// GEAR_SIGNING_PRIVATE_KEY is a PEM private key, either raw or base64-encoded
// (CI secrets travel more safely base64'd, so both are accepted).

import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signBytes, verifySignature } from "../packages/orchestrator/src/signing";

const [mode, dir, keyArg] = process.argv.slice(2);

function die(msg: string): never {
  console.error(`  ${msg}`);
  process.exit(1);
}

/** Accept a PEM directly, a base64-encoded PEM, or a path to either. */
function readKey(raw: string): string {
  let value = raw.trim();
  if (existsSync(value)) value = readFileSync(value, "utf8").trim();
  if (value.includes("-----BEGIN")) return value;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded.trim();
  } catch {
    // fall through
  }
  die("the key is neither PEM, base64-encoded PEM, nor a path to one");
}

if (!mode || !dir) {
  console.error("usage: bun scripts/sign-release.ts sign|verify <dir> [publicKey]");
  process.exit(2);
}

const sumsPath = join(dir, "SHA256SUMS");
const sigPath = join(dir, "SHA256SUMS.sig");
if (!existsSync(sumsPath)) die(`no SHA256SUMS in ${dir} — nothing to sign.`);
const sums = readFileSync(sumsPath);

if (mode === "sign") {
  const secret = process.env.GEAR_SIGNING_PRIVATE_KEY;
  if (!secret || !secret.trim()) {
    // Not an error: a release without the secret is unsigned on Linux, and
    // saying so beats failing the build for a key the founder may not have yet.
    console.log("  · GEAR_SIGNING_PRIVATE_KEY is not set — skipping Linux signatures.");
    console.log("    docs/release.md says how to create one.");
    process.exit(0);
  }
  const privateKeyPem = readKey(secret);
  const signature = signBytes(sums, privateKeyPem);

  // Verify what was just produced, against the public key derived from the
  // same private key. A signature nobody checked is a signature nobody can
  // trust, and the cheapest moment to find a broken one is before it ships.
  const derivedPublicPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  if (!verifySignature(sums, signature, derivedPublicPem)) {
    die("the signature just produced does not verify — refusing to write it.");
  }

  writeFileSync(sigPath, `${signature}\n`, "utf8");
  console.log(`  signed ${sumsPath}`);
  console.log(`  wrote  ${sigPath}`);
  console.log("");
  console.log("  signed with this public key (it must match the README's):");
  console.log(
    derivedPublicPem
      .trim()
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  console.log("");
  console.log("  Anyone can check it:");
  console.log("    bun scripts/sign-release.ts verify <dir> <public-key.pem>");
  process.exit(0);
}

if (mode === "verify") {
  if (!keyArg) die("verify needs a public key: a PEM file, or base64 PEM.");
  if (!existsSync(sigPath)) die(`no SHA256SUMS.sig in ${dir} — this release is unsigned.`);
  const publicKeyPem = readKey(keyArg);
  const signature = readFileSync(sigPath, "utf8").trim();
  if (!verifySignature(sums, signature, publicKeyPem)) {
    die("SIGNATURE DOES NOT VERIFY — do not run these binaries.");
  }
  console.log("  signature verifies: SHA256SUMS is the file that was signed.");
  console.log("  now check the binaries against it:");
  console.log(`    cd ${dir} && sha256sum -c SHA256SUMS`);
  process.exit(0);
}

die(`unknown mode "${mode}" — expected sign or verify.`);
