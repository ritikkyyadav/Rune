// ─── Make the release signing keypair ───
//
// Prints an Ed25519 keypair: the private half to paste into the
// RUNE_SIGNING_PRIVATE_KEY repository secret (base64, because CI secrets travel
// more safely that way), and the public half to commit to the README so anyone
// can verify a download.
//
// It prints rather than writes. A private key that lands in a file inside a git
// repository is a private key one `git add -A` away from being public, and this
// repo has had `add -A` sweep in-flight work before.
//
//   bun scripts/keygen.ts

import { generateEd25519KeyPair } from "../packages/orchestrator/src/signing";

const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();

console.log("─── PUBLIC key — commit this to the README ───\n");
console.log(publicKeyPem.trim());
console.log("\n─── PRIVATE key — RUNE_SIGNING_PRIVATE_KEY, base64 ───");
console.log("Settings → Secrets and variables → Actions → New repository secret\n");
console.log(Buffer.from(privateKeyPem, "utf8").toString("base64"));
console.log("\nStore the private key in a password manager as well. Losing it means");
console.log("publishing a new public key, which every existing verifier will reject.");
