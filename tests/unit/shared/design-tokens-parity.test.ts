// ─── Phase 0 guardrail: tokens ↔ gear-customizer-v2.html ───
// The HTML prototype is the product contract. This test regex-extracts every
// base + accent custom property from the HTML and asserts the shared token
// module carries the exact same values, so the three-way pigment drift that
// motivated Phase 0 cannot silently return. It also asserts the ten gear
// terminal themes in the CLI derive from the tokens (hex round-trip).

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  GEAR_ACCENT_NAMES,
  GEAR_ACCENT_CSS,
  GEAR_BASE_CSS,
  gearTerminalPalette,
  gearAccentHex,
  solidOver,
  type GearBaseName,
} from "../../../packages/shared/src/design-tokens";
import {
  THEMES,
  GEAR_ACCENTS,
  gearThemeName,
} from "../../../packages/orchestrator/src/bin/ui/themes";

const HTML_PATH = join(import.meta.dir, "../../../gear-customizer-v2.html");
const html = readFileSync(HTML_PATH, "utf8");

/** Pull `--name: value;` pairs out of the first CSS block matching `selector`. */
function cssVars(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(escaped + "\\s*\\{([^}]*)\\}"));
  if (!match) throw new Error(`selector not found in contract HTML: ${selector}`);
  const vars: Record<string, string> = {};
  for (const decl of match[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[decl[1]!] = decl[2]!.trim().replace(/\s+/g, " ");
  }
  return vars;
}

const norm = (value: string) => value.replace(/\s+/g, "").toUpperCase();

const BASE_VAR: Record<keyof (typeof GEAR_BASE_CSS)["light"], string> = {
  canvasBg: "--canvas-bg",
  cardBg: "--card-bg",
  textMain: "--text-main",
  textSub: "--text-sub",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  ochre: "--ochre",
  green: "--green",
  red: "--red",
  barBg: "--bar-bg",
  barHover: "--bar-hover",
  barActive: "--bar-active",
  hairline: "--hairline",
  codeBg: "--code-bg",
  codeTag: "--code-tag",
  diffBg: "--diff-bg",
  diffHdr: "--diff-hdr",
  popoverBg: "--popover-bg",
  kbdBg: "--kbd-bg",
};

describe("design tokens ↔ v2 contract HTML", () => {
  for (const base of ["light", "dark"] as GearBaseName[]) {
    it(`base "${base}" variables match the HTML verbatim`, () => {
      const vars = cssVars(`html[data-theme-base="${base}"]`);
      for (const [key, cssName] of Object.entries(BASE_VAR)) {
        const expected = vars[cssName];
        expect(expected, `${cssName} missing from HTML ${base} block`).toBeTruthy();
        expect(
          norm(GEAR_BASE_CSS[base][key as keyof typeof BASE_VAR]),
          `${cssName} (${base})`,
        ).toBe(norm(expected!));
      }
    });
  }

  it("light accents match html[data-accent=…]", () => {
    for (const accent of GEAR_ACCENT_NAMES) {
      const vars = cssVars(`html[data-accent="${accent}"]`);
      expect(norm(GEAR_ACCENT_CSS.light[accent]), accent).toBe(norm(vars["--accent"]!));
    }
  });

  it("dark accents match html[data-theme-base=dark][data-accent=…]", () => {
    for (const accent of GEAR_ACCENT_NAMES) {
      const vars = cssVars(`html[data-theme-base="dark"][data-accent="${accent}"]`);
      expect(norm(GEAR_ACCENT_CSS.dark[accent]), accent).toBe(norm(vars["--accent"]!));
    }
  });
});

describe("terminal themes derive from the tokens", () => {
  const toHex = (rgb: [number, number, number]) =>
    "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

  it("shared and CLI accent lists agree", () => {
    expect([...GEAR_ACCENTS]).toEqual([...GEAR_ACCENT_NAMES]);
  });

  for (const base of ["light", "dark"] as GearBaseName[]) {
    for (const accent of GEAR_ACCENT_NAMES) {
      it(`${gearThemeName(base, accent)} carries the token pigments`, () => {
        const theme = THEMES.find((t) => t.name === gearThemeName(base, accent));
        expect(theme).toBeTruthy();
        const palette = gearTerminalPalette(base);
        expect(toHex(theme!.slots.text.rgb)).toBe(palette.text);
        expect(toHex(theme!.slots.muted.rgb)).toBe(palette.muted);
        expect(toHex(theme!.slots.faint.rgb)).toBe(palette.faint);
        expect(toHex(theme!.slots.accent.rgb)).toBe(palette.red);
        expect(toHex(theme!.slots.warn.rgb)).toBe(palette.ochre);
        expect(toHex(theme!.slots.ok.rgb)).toBe(palette.green);
        expect(toHex(theme!.slots.line.rgb)).toBe(palette.line);
        expect(toHex(theme!.bg.rgb)).toBe(palette.bg);
        expect(toHex(theme!.brand.rgb)).toBe(gearAccentHex(base, accent));
        expect(toHex(theme!.slots.info.rgb)).toBe(gearAccentHex(base, accent));
        expect(theme!.surfaces).toBeTruthy();
        expect(toHex(theme!.surfaces!.hairline.rgb)).toBe(palette.surfaces.hairline);
        expect(toHex(theme!.surfaces!.popover.rgb)).toBe(palette.surfaces.popover);
      });
    }
  }

  it("solidOver composites translucent contract values deterministically", () => {
    expect(solidOver("#FAF9F6", "#000000")).toBe("#FAF9F6");
    expect(solidOver("rgba(255, 255, 255, 0.08)", "#0A0A0C")).toBe(
      solidOver("rgba(255,255,255,.08)", "#0A0A0C"),
    );
    // 8% white over the dark card is a near-black grey, never pure white.
    const hairline = solidOver("rgba(255, 255, 255, 0.08)", "#0A0A0C");
    expect(hairline.startsWith("#1")).toBe(true);
  });
});
