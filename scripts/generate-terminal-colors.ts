// ─── Terminal colour table ───
//
// The TUI's half of the one token source. `tokens.css` is what the desktop and
// the web client read; this is the same pigments resolved for a terminal:
// exact 24-bit RGB, plus the ANSI-256 index a terminal without truecolor gets
// instead.
//
// It prints rather than writes a file, deliberately. `bin/ui/themes.ts` already
// derives the palette from `packages/shared/src/design-tokens.ts` at build
// time; generating a second checked-in copy would be a third place for the
// pigments to drift. What this gives you is a REVIEWABLE form: a table you can
// read in a pull request, instead of a diff of hex strings whose consequences
// nobody can see.
//
//   bun run scripts/generate-terminal-colors.ts          # both grounds
//   bun run scripts/generate-terminal-colors.ts --json   # machine-readable

import { savoirTerminalRoles, type GearBaseName } from "../packages/shared/src/design-tokens";
import { nearestAnsi256 } from "../packages/orchestrator/src/bin/ui/themes";

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface TerminalRole {
  role: string;
  hex: string;
  rgb: [number, number, number];
  /** What a 256-colour terminal is told instead. */
  ansi: number;
}

export function terminalTable(base: GearBaseName): TerminalRole[] {
  return Object.entries(savoirTerminalRoles(base)).map(([role, hex]) => {
    const rgb = hexToRgb(hex);
    return { role, hex, rgb, ansi: nearestAnsi256(rgb) };
  });
}

if (import.meta.main) {
  const json = process.argv.includes("--json");
  const bases: GearBaseName[] = ["light", "dark"];
  if (json) {
    console.log(
      JSON.stringify(Object.fromEntries(bases.map((b) => [b, terminalTable(b)])), null, 2),
    );
  } else {
    for (const base of bases) {
      console.log(`\n  ${base.toUpperCase()}`);
      console.log(`  ${"role".padEnd(10)}${"hex".padEnd(10)}${"rgb".padEnd(18)}ansi256`);
      for (const r of terminalTable(base)) {
        // The swatch is the point: a hex column nobody can see is why palette
        // changes used to ship unreviewed.
        const swatch = `\x1b[38;2;${r.rgb.join(";")}m███\x1b[0m`;
        console.log(
          `  ${r.role.padEnd(10)}${r.hex.padEnd(10)}${r.rgb.join(",").padEnd(18)}${String(r.ansi).padEnd(6)}${swatch}`,
        );
      }
    }
    console.log("");
  }
}
