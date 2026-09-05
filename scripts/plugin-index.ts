#!/usr/bin/env bun
/**
 * Keep `plugins/index.json` honest about the trees it publishes.
 *
 * Each index entry carries the sha256 of the plugin tree, and `rune plugin add`
 * verifies it against the STAGED bundle before installing. A digest that drifts
 * from the files in this repository would turn that check from a guarantee into
 * a nuisance the first time someone edits an example — so the check is
 * mechanical and the fix is one command.
 *
 *   bun run scripts/plugin-index.ts            # report drift (exit 1 if any)
 *   bun run scripts/plugin-index.ts --write    # recompute and rewrite
 *
 * Only entries whose `source` is a local path are touched; a git-sourced entry
 * has no tree here to hash.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { computeIntegrity } from "../packages/orchestrator/src/plugins";
import {
  validatePluginIndex,
  type PluginIndexEntry,
} from "../packages/orchestrator/src/plugin-index";

const repoRoot = resolve(import.meta.dir, "..");
const indexPath = join(repoRoot, "plugins", "index.json");
const write = process.argv.includes("--write");

function localTree(entry: PluginIndexEntry): string | null {
  const source = entry.source.trim();
  if (/^(https?:\/\/|git@|git\+|ssh:\/\/)/.test(source) || source.endsWith(".git")) return null;
  const abs = isAbsolute(source) ? source : resolve(dirname(indexPath), source);
  return existsSync(abs) ? abs : null;
}

const raw = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
const validated = validatePluginIndex(raw);
if (!validated.ok) {
  console.error(`plugins/index.json is not a valid index:\n  ${validated.errors.join("\n  ")}`);
  process.exit(1);
}

const document = raw as { plugins: PluginIndexEntry[] };
const drift: string[] = [];
const missing: string[] = [];

for (const entry of document.plugins) {
  const tree = localTree(entry);
  if (!tree) {
    if (!entry.integrity) missing.push(`${entry.name}: remote source with no integrity digest`);
    continue;
  }
  const actual = computeIntegrity(tree);
  if (entry.integrity !== actual) {
    drift.push(
      `${entry.name}\n    published ${entry.integrity ?? "(none)"}\n    on disk   ${actual}`,
    );
    entry.integrity = actual;
  }
}

if (write) {
  // Through prettier, not `JSON.stringify` alone: `format:check` is a gate,
  // and a fix-it script that leaves the repo failing a gate is not a fix.
  const { format } = await import("prettier");
  writeFileSync(
    indexPath,
    await format(JSON.stringify(document, null, 2), { filepath: indexPath }),
  );
  console.log(
    drift.length === 0
      ? "plugins/index.json: already current"
      : `plugins/index.json: rewrote ${drift.length} digest(s)`,
  );
  process.exit(0);
}

if (drift.length === 0 && missing.length === 0) {
  console.log(`plugins/index.json: ${document.plugins.length} entries, digests current`);
  process.exit(0);
}
for (const line of drift) console.error(`  drift  ${line}`);
for (const line of missing) console.error(`  warn   ${line}`);
console.error("\nRun: bun run scripts/plugin-index.ts --write");
process.exit(drift.length > 0 ? 1 : 0);
