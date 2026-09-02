/**
 * The engine graph law.
 *
 * The engine is a library. Every surface — the terminal, the desktop, the
 * protocol host — is a client of it. The moment the engine imports a terminal
 * module it drags the ANSI/theme/width stack into every consumer's graph and
 * the "every client is replaceable" invariant quietly stops being true.
 *
 * It has happened once: `engine.ts` imported `isVerificationCommand` from
 * `./bin/ui/activity` when the function's home is `brief.ts`. One character of
 * convenience, one whole UI stack in the engine's dependency graph.
 *
 * So the law is tested, not documented: nothing under
 * `packages/orchestrator/src` that is not itself under `bin/` may import from
 * `bin/ui`. Comments and prose about the rule are exempt — only import and
 * re-export statements count.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dir, "../../../packages/orchestrator/src");
const BIN = join(SRC, "bin");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Import specifiers, not prose. Matches `import … from "x"`, `export … from
 * "x"`, bare `import "x"` and dynamic `import("x")`.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) found.push(m[1]!);
  }
  return found;
}

/** Does this specifier, resolved from `file`, land inside `bin/ui`? */
function reachesBinUi(file: string, spec: string): boolean {
  if (spec.startsWith(".")) {
    const target = resolve(file, "..", spec);
    return target === join(BIN, "ui") || target.startsWith(join(BIN, "ui") + sep);
  }
  // Non-relative forms that still name the terminal layer.
  return /(^|\/)bin\/ui(\/|$)/.test(spec);
}

describe("engine graph purity", () => {
  const engineSide = walk(SRC).filter((f) => !f.startsWith(BIN + sep));

  it("has files to check", () => {
    // A refactor that moved the source tree should fail loudly, not silently pass.
    expect(engineSide.length).toBeGreaterThan(20);
    expect(engineSide.some((f) => f.endsWith(`${sep}engine.ts`))).toBe(true);
  });

  it("never imports from bin/ui outside bin/", () => {
    const offenders: string[] = [];
    for (const file of engineSide) {
      const source = readFileSync(file, "utf8");
      for (const spec of importSpecifiers(source)) {
        if (reachesBinUi(file, spec)) {
          offenders.push(`${relative(SRC, file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("detects an offending import when one is introduced", () => {
    // Guards the guard: the matcher must actually fire on the shape it forbids.
    const fake = join(SRC, "engine.ts");
    expect(importSpecifiers(`import { x } from "./bin/ui/activity";`)).toEqual([
      "./bin/ui/activity",
    ]);
    expect(reachesBinUi(fake, "./bin/ui/activity")).toBe(true);
    expect(reachesBinUi(fake, "./brief")).toBe(false);
  });
});
