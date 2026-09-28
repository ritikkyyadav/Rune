/**
 * Tripwire: Rune's shipped source never presents itself as Claude Code.
 *
 * Until 2026-09-28 Rune signed people in with their Claude Pro/Max plan using
 * Claude Code's own OAuth client id, then sent each request with the
 * `oauth-2025-04-20` beta and Claude Code's identity line as the first system
 * block. Anthropic's terms do not permit that ("Anthropic does not permit
 * third-party developers to offer Claude.ai login into their own applications,
 * or to route requests through Free, Pro, or Max plan credentials on behalf of
 * their users"), so it was removed. The record is
 * docs/program/compliance-subscription-routes.md.
 *
 * This test is what keeps it removed. It reads every file under every
 * `packages/<pkg>/src` directory, of any type, with no exclusions, and fails
 * on any of the three markers of that handshake. A comment quoting one fails
 * too, on purpose: there is no reason for Rune's source to spell them.
 */

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const REPO = join(import.meta.dir, "..", "..", "..");

/** The three things the retired handshake needed, byte for byte. */
const FORBIDDEN = [
  // Claude Code's system-prompt identity line.
  "You are Claude Code, Anthropic's official CLI",
  // The beta header that let a subscription token call the Messages API.
  "oauth-2025-04-20",
  // Claude Code's OAuth client id, as it stood in the deleted oauth/anthropic.ts.
  "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
];

/** Every `src` directory under packages/, however deep (never inside node_modules). */
function srcDirs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.name === "src") out.push(full);
    else out.push(...srcDirs(full));
  }
  return out;
}

/** Every file under a directory, no exclusions. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** The forbidden markers a file's bytes contain. */
function markersIn(bytes: Buffer): string[] {
  return FORBIDDEN.filter((marker) => bytes.includes(Buffer.from(marker, "utf8")));
}

describe("no subscription impersonation in packages/**/src", () => {
  const files = srcDirs(join(REPO, "packages")).flatMap(filesUnder);

  test("the scan actually covers the source tree", () => {
    // A walker that silently found nothing would pass everything.
    expect(files.length).toBeGreaterThan(200);
    const rel = files.map((f) => relative(REPO, f));
    expect(rel).toContain(join("packages", "llm-gateway", "src", "providers", "anthropic.ts"));
    expect(rel).toContain(join("packages", "orchestrator", "src", "provider-registry.ts"));
  });

  test("the matcher catches each marker (positive control)", () => {
    for (const marker of FORBIDDEN) {
      expect(markersIn(Buffer.from(`const x = "${marker}";`))).toEqual([marker]);
    }
    expect(markersIn(Buffer.from("nothing to see"))).toEqual([]);
  });

  test("no file carries the Claude Code identity, the oauth beta, or its client id", () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const marker of markersIn(readFileSync(file))) {
        hits.push(`${relative(REPO, file)}: ${marker}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
