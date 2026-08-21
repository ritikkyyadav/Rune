import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  THEMES,
  findTheme,
  DEFAULT_THEME,
  nearestAnsi256,
  adaptiveTheme,
  contrastRatio,
  GEAR_ACCENTS,
  type SlotName,
} from "../../../packages/orchestrator/src/bin/ui/themes";
import {
  setTheme,
  configureAutoTheme,
  getTheme,
  listThemes,
  paintWith,
  swatch,
  text,
  stripAnsi,
  colorEnabled,
  truecolor,
  terminalThemeSeq,
  TERMINAL_THEME_RESET,
  withThemeBg,
} from "../../../packages/orchestrator/src/bin/ui/theme";
import {
  saveTheme,
  loadSavedTheme,
  resolveInitialTheme,
} from "../../../packages/orchestrator/src/bin/ui/theme-store";
import {
  ansi256ToRgb,
  parseTerminalColorResponses,
  stripTerminalColorResponses,
} from "../../../packages/orchestrator/src/bin/ui/terminal-colors";

const EXPECTED = [
  "gear",
  "gear-orange",
  "gear-violet",
  "gear-emerald",
  "gear-mono",
  "gear-dark",
  "gear-orange-dark",
  "gear-violet-dark",
  "gear-emerald-dark",
  "gear-mono-dark",
  "studio",
  "atlas",
  "atlas-light",
  "mono",
  "mono-light",
  "matrix",
  "dracula",
  "nord",
  "solarized-dark",
  "solarized-light",
  "gruvbox",
  "tokyo-night",
  "catppuccin",
  "one-dark",
  "synthwave",
  "neon",
  "neon-lime",
  "high-contrast",
  "github-light",
];
const SLOTS: SlotName[] = ["text", "muted", "faint", "accent", "info", "warn", "ok", "line"];

// The active theme is module-global; keep tests order-independent.
afterEach(() => {
  configureAutoTheme({});
  setTheme(DEFAULT_THEME);
});

describe("ui/themes registry", () => {
  it("bundles the full famous set with unique kebab names", () => {
    const names = THEMES.map((t) => t.name);
    expect(names).toEqual(EXPECTED);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("every theme defines its brand pigment and all 8 slots with valid rgb + ansi", () => {
    for (const t of THEMES) {
      expect(t.brand.rgb, `${t.name}.brand`).toHaveLength(3);
      expect(t.brand.ansi).toBeGreaterThanOrEqual(0);
      expect(t.brand.ansi).toBeLessThanOrEqual(255);
      for (const s of SLOTS) {
        const p = t.slots[s];
        expect(p, `${t.name}.${s}`).toBeTruthy();
        expect(p.rgb).toHaveLength(3);
        for (const c of p.rgb) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255);
        }
        expect(p.ansi).toBeGreaterThanOrEqual(0);
        expect(p.ansi).toBeLessThanOrEqual(255);
      }
    }
  });

  it("default theme exists, unknown lookups return undefined", () => {
    expect(DEFAULT_THEME).toBe("gear-orange");
    expect(findTheme(DEFAULT_THEME)).toBeTruthy();
    expect(findTheme("does-not-exist")).toBeUndefined();
  });

  it("nearestAnsi256 stays in range for extremes", () => {
    expect(nearestAnsi256([0, 0, 0])).toBeGreaterThanOrEqual(0);
    expect(nearestAnsi256([255, 255, 255])).toBeLessThanOrEqual(255);
    expect(nearestAnsi256([128, 128, 128])).toBeGreaterThanOrEqual(0);
  });

  it("every theme defines a valid background pigment", () => {
    for (const t of THEMES) {
      expect(t.bg.rgb, `${t.name}.bg`).toHaveLength(3);
      for (const c of t.bg.rgb) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
      expect(t.bg.ansi).toBeGreaterThanOrEqual(0);
      expect(t.bg.ansi).toBeLessThanOrEqual(255);
    }
  });
});

describe("ui/theme whole-terminal recolor (OSC 10/11/12)", () => {
  it("terminalThemeSeq emits the active theme's foreground, background, and cursor", () => {
    setTheme("dracula");
    const seq = terminalThemeSeq();
    if (colorEnabled) {
      expect(seq).toContain("]11;#282a36"); // OSC 11 background
      expect(seq).toContain("]10;#f8f8f2"); // OSC 10 foreground = text slot
      expect(seq).toContain("]12;#8be9fd"); // OSC 12 cursor = interactive signal
    } else {
      expect(seq).toBe("");
    }
  });

  it("light themes paint a light background (so dark text is readable)", () => {
    setTheme("github-light");
    if (colorEnabled) expect(terminalThemeSeq()).toContain("]11;#ffffff");
  });

  it("uses the supplied card base in production, not the browser customizer canvas", () => {
    setTheme("gear-orange");
    if (colorEnabled) {
      expect(terminalThemeSeq()).toContain("]11;#faf9f6");
      expect(terminalThemeSeq()).not.toContain("]11;#ccd8d1");
    }
  });

  it("TERMINAL_THEME_RESET restores fg, bg, and cursor", () => {
    expect(TERMINAL_THEME_RESET).toContain("]110");
    expect(TERMINAL_THEME_RESET).toContain("]111");
    expect(TERMINAL_THEME_RESET).toContain("]112");
  });

  it("Follow terminal preserves the host surface instead of repainting it", () => {
    configureAutoTheme({ background: [180, 25, 25], foreground: [255, 255, 255] });
    setTheme("auto");
    expect(terminalThemeSeq()).toBe("");
    expect(withThemeBg(text("hello"))).toContain("hello");
    expect(withThemeBg(text("hello"))).not.toContain("\x1b[K");
  });

  it("withThemeBg paints the bg + fills the row (works where OSC is ignored, e.g. Warp)", () => {
    setTheme("github-light"); // white bg, dark text → the case that was unreadable
    const out = withThemeBg(text("hello"));
    expect(out).toContain("hello"); // text preserved
    if (colorEnabled) {
      // SGR background, respecting colour depth: truecolor `48;2` or 256-colour `48;5`.
      const bg = truecolor ? "48;2;255;255;255" : `48;5;${findTheme("github-light")!.bg.ansi}`;
      expect(out).toContain(bg);
      expect(out.startsWith("\x1b[48;")).toBe(true); // bg opens the row (before the text)
      expect(out).toContain("\x1b[K"); // erase-to-EOL fills the right margin with bg
    }
  });

  it("withThemeBg uses a 256-colour bg fallback when truecolor is unavailable (Terminal.app)", () => {
    // The bug behind the unreadable Terminal.app render: bg was hardcoded truecolor.
    setTheme("matrix");
    const out = withThemeBg(text("x"));
    expect(out).toContain("x");
    if (colorEnabled) expect(out).toMatch(/\x1b\[48;[25];/); // 48;2 (truecolor) OR 48;5 (256)
  });
});

describe("ui/theme active-theme control", () => {
  it("setTheme switches; unknown is rejected and leaves active unchanged", () => {
    expect(setTheme("dracula")).toBe(true);
    expect(getTheme().name).toBe("dracula");
    expect(setTheme("nope")).toBe(false);
    expect(getTheme().name).toBe("dracula");
  });

  it("preserves the cosmetic accent across light/dark and the surface across accent aliases", () => {
    expect(setTheme("orange")).toBe(true);
    expect(getTheme().name).toBe("gear-orange");
    expect(setTheme("dark")).toBe(true);
    expect(getTheme().name).toBe("gear-orange-dark");
    expect(setTheme("violet")).toBe(true);
    expect(getTheme().name).toBe("gear-violet-dark");
    expect(setTheme("light")).toBe(true);
    expect(getTheme().name).toBe("gear-violet");
    expect(setTheme("system")).toBe(true);
    expect(getTheme().name).toBe("auto");
  });

  it("listThemes exposes all ten customizer combinations plus Follow terminal", () => {
    expect(listThemes().map((t) => t.name)).toEqual([
      "gear",
      "gear-orange",
      "gear-violet",
      "gear-emerald",
      "gear-mono",
      "gear-dark",
      "gear-orange-dark",
      "gear-violet-dark",
      "gear-emerald-dark",
      "gear-mono-dark",
      "auto",
    ]);
    expect(listThemes()[0]!.label).toBe("Electric Cobalt · Light");
    expect(listThemes()[10]!.label).toMatch(/^Auto · follows terminal/);
  });

  it("matches the customizer's exact light/dark bases and five cosmetic accents", () => {
    const expectedBrand = {
      gear: [0, 56, 255],
      "gear-orange": [255, 85, 0],
      "gear-violet": [124, 58, 237],
      "gear-emerald": [5, 150, 105],
      "gear-mono": [26, 25, 23],
      "gear-dark": [56, 117, 255],
      "gear-orange-dark": [255, 110, 38],
      "gear-violet-dark": [167, 139, 250],
      "gear-emerald-dark": [16, 185, 129],
      "gear-mono-dark": [255, 255, 255],
    } as const;
    for (const [name, brand] of Object.entries(expectedBrand)) {
      const theme = findTheme(name)!;
      const dark = name.endsWith("dark");
      expect(theme.bg.rgb).toEqual(dark ? [10, 10, 12] : [250, 249, 246]); // dark card = #0A0A0C per the v2 contract tokens
      expect(theme.slots.text.rgb).toEqual(dark ? [255, 255, 255] : [26, 25, 23]);
      expect(theme.brand.rgb).toEqual([...brand]);
      expect(contrastRatio(theme.slots.text.rgb, theme.bg.rgb)).toBeGreaterThanOrEqual(7);
      expect(theme.canvas?.rgb).toEqual(dark ? [0, 0, 0] : [204, 216, 209]);
      expect(theme.surfaces?.card.rgb).toEqual(dark ? [10, 10, 12] : [250, 249, 246]);
      expect(theme.surfaces?.bar.rgb).toEqual(dark ? [18, 18, 21] : [241, 239, 234]);
      expect(theme.surfaces?.code.rgb).toEqual(dark ? [15, 15, 18] : [240, 238, 232]);
      // Accent dots are cosmetic in the supplied customizer; some are not
      // intended as small body text and therefore are not contrast-normalized.
      expect(contrastRatio(theme.slots.muted.rgb, theme.bg.rgb)).toBeGreaterThanOrEqual(6);
    }
    expect(GEAR_ACCENTS).toEqual(["cobalt", "orange", "violet", "emerald", "mono"]);
  });

  it("tokens preserve payload and (when colour is on) differ across themes", () => {
    setTheme("matrix");
    const a = text("X");
    setTheme("dracula");
    const b = text("X");
    expect(stripAnsi(a)).toBe("X");
    expect(stripAnsi(b)).toBe("X");
    if (colorEnabled) expect(a).not.toBe(b);
  });

  it("paintWith / swatch render a theme without mutating the active one", () => {
    setTheme("atlas");
    expect(stripAnsi(paintWith("matrix", "ok", "Z"))).toBe("Z");
    expect(stripAnsi(swatch("dracula"))).toBe("●●●●");
    expect(getTheme().name).toBe("atlas"); // unchanged by either call
  });
});

describe("ui/theme-store persistence", () => {
  it("round-trips the saved theme via the JSON sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-theme-"));
    try {
      expect(loadSavedTheme(dir)).toBeNull();
      saveTheme("nord", dir);
      expect(loadSavedTheme(dir)).toBe("nord");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a corrupt sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "alan-theme-"));
    try {
      writeFileSync(join(dir, "theme.json"), "{ not valid json");
      expect(loadSavedTheme(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveInitialTheme honours env > saved > configured, restricted to production themes", () => {
    expect(resolveInitialTheme({ env: "orange-dark", saved: "mono", configured: "violet" })).toBe(
      "gear-orange-dark",
    );
    expect(resolveInitialTheme({ env: undefined, saved: "mono-light", configured: "mono" })).toBe(
      "gear-mono",
    );
    expect(resolveInitialTheme({ saved: null, configured: "dark" })).toBe("gear-dark");
    expect(resolveInitialTheme({})).toBe(DEFAULT_THEME);
    // unknown *and* non-production themes are skipped at each tier (matrix/dracula are hidden now)
    expect(resolveInitialTheme({ env: "bogus", saved: "emerald" })).toBe("gear-emerald");
    expect(resolveInitialTheme({ env: "matrix", saved: "dracula" })).toBe(DEFAULT_THEME);
    expect(resolveInitialTheme({ configured: "bogus" })).toBe(DEFAULT_THEME);
  });

  it("migrates saved Elio theme ids to the matching Gear themes", () => {
    expect(resolveInitialTheme({ saved: "elio" })).toBe("gear");
    expect(resolveInitialTheme({ saved: "elio-dark" })).toBe("gear-dark");
  });
});

describe("ui/theme Follow terminal mode", () => {
  it("uses native terminal colors when the background is unknown", () => {
    const theme = adaptiveTheme({ foreground: [255, 255, 255] });
    expect(theme.label).toBe("Auto · follows terminal");
    expect(theme.preserveTerminal).toBe(true);
    expect(theme.useNativeColors).toBe(true);

    configureAutoTheme({ foreground: [255, 255, 255] });
    setTheme("auto");
    expect(text("native text")).toBe("native text");
    expect(paintWith("auto", "accent", "native accent")).toBe("native accent");
    expect(terminalThemeSeq()).toBe("");
    expect(withThemeBg("native row")).toBe("native row");
  });

  it("derives high-contrast colors from a saturated red terminal background", () => {
    const background: [number, number, number] = [170, 24, 24];
    const theme = adaptiveTheme({ background });
    expect(theme.name).toBe("auto");
    expect(theme.label).toBe("Auto · follows terminal (dark)");
    expect(theme.bg.rgb).toEqual(background);
    expect(theme.preserveTerminal).toBe(true);
    expect(theme.useNativeColors).toBe(false);
    expect(contrastRatio(theme.slots.text.rgb, background)).toBeGreaterThanOrEqual(7);
    for (const slot of ["muted", "faint", "accent", "info", "warn", "ok"] as const) {
      expect(contrastRatio(theme.slots[slot].rgb, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(theme.slots.line.rgb, background)).toBeGreaterThanOrEqual(3);
  });

  it("adapts safely to very light terminal backgrounds", () => {
    const background: [number, number, number] = [250, 248, 242];
    const theme = adaptiveTheme({ background, foreground: [120, 120, 120] });
    expect(theme.label).toBe("Auto · follows terminal (light)");
    expect(contrastRatio(theme.slots.text.rgb, background)).toBeGreaterThanOrEqual(7);
    for (const slot of ["muted", "faint", "accent", "info", "warn", "ok"] as const) {
      expect(contrastRatio(theme.slots[slot].rgb, background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every text-bearing slot readable across representative terminal colors", () => {
    const levels = [0, 64, 128, 192, 255];
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          const background: [number, number, number] = [r, g, b];
          const theme = adaptiveTheme({ background });
          for (const slot of ["text", "muted", "faint", "accent", "info", "warn", "ok"] as const) {
            expect(contrastRatio(theme.slots[slot].rgb, background)).toBeGreaterThanOrEqual(4.5);
          }
          expect(contrastRatio(theme.slots.line.rgb, background)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("parses OSC rgb responses from terminals such as VS Code and iTerm", () => {
    expect(
      parseTerminalColorResponses("\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:1212/3434/5656\x1b\\"),
    ).toEqual({ foreground: [255, 255, 255], background: [18, 52, 86] });
  });

  it("preserves keys typed while terminal color replies are being detected", () => {
    const response = "\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;#121212\x07";
    expect(stripTerminalColorResponses(`h${response}i`)).toBe("hi");
  });

  it("maps ANSI colors used by COLORFGBG", () => {
    expect(ansi256ToRgb(0)).toEqual([0, 0, 0]);
    expect(ansi256ToRgb(15)).toEqual([255, 255, 255]);
    expect(ansi256ToRgb(196)).toEqual([255, 0, 0]);
  });
});
