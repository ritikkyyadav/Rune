/**
 * Ed25519 signing helpers for tamper-evident session exports.
 *
 * Uses Node's built-in `node:crypto` — no external deps.
 * Ed25519 sign/verify use crypto.sign / crypto.verify directly (not createSign),
 * because the BoringSSL build used by Bun does not support the hash-name
 * argument on createSign() for Ed25519 keys.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Generate a fresh Ed25519 key-pair and return PEM strings.
 */
export function generateEd25519KeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/**
 * Load a key-pair from `keyPath` (directory).
 * Expects `ed25519.key` (private, PEM) and `ed25519.pub` (public, PEM).
 * If neither file exists, generates a new pair and persists it.
 * The directory is created automatically if it does not exist.
 */
export function loadOrGenerateKeyPair(keyPath: string): KeyPair {
  const privFile = join(keyPath, "ed25519.key");
  const pubFile = join(keyPath, "ed25519.pub");

  if (existsSync(privFile) && existsSync(pubFile)) {
    return {
      privateKeyPem: readFileSync(privFile, "utf8"),
      publicKeyPem: readFileSync(pubFile, "utf8"),
    };
  }

  // Ensure the key directory exists
  mkdirSync(keyPath, { recursive: true });

  const pair = generateEd25519KeyPair();
  writeFileSync(privFile, pair.privateKeyPem, { mode: 0o600 });
  writeFileSync(pubFile, pair.publicKeyPem);
  return pair;
}

/**
 * Sign arbitrary bytes with an Ed25519 private key (PEM).
 * Returns a base64-encoded signature.
 *
 * Uses `crypto.sign(null, data, key)` — the `null` hash algorithm is required
 * for Ed25519 (the key type implies the hash; passing a name throws on BoringSSL).
 */
export function signBytes(data: Buffer | string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return cryptoSign(null, buf, key).toString("base64");
}

/**
 * Verify an Ed25519 signature.
 * `signature` is base64-encoded; `publicKeyPem` is the PEM-encoded public key.
 */
export function verifySignature(
  data: Buffer | string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    return cryptoVerify(null, buf, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
