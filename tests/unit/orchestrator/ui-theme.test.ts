import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  THEMES,
  findTheme,
  DEFAULT_THEME,
  nearestAnsi256,
  type SlotName,
} from "../../../packages/orchestrator/src/bin/ui/themes";
import {
  setTheme,
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

const EXPECTED = [
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
afterEach(() => setTheme(DEFAULT_THEME));

describe("ui/themes registry", () => {
  it("bundles the full famous set with unique kebab names", () => {
    const names = THEMES.map((t) => t.name);
    expect(names).toEqual(EXPECTED);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("every theme defines all 8 slots with valid rgb + ansi", () => {
    for (const t of THEMES) {
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
    expect(DEFAULT_THEME).toBe("mono");
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

describe("ui/theme whole-terminal recolor (OSC 10/11)", () => {
  it("terminalThemeSeq emits the active theme's fg + bg", () => {
    setTheme("dracula");
    const seq = terminalThemeSeq();
    if (colorEnabled) {
      expect(seq).toContain("]11;#282a36"); // OSC 11 background
      expect(seq).toContain("]10;#f8f8f2"); // OSC 10 foreground = text slot
    } else {
      expect(seq).toBe("");
    }
  });

  it("light themes paint a light background (so dark text is readable)", () => {
    setTheme("github-light");
    if (colorEnabled) expect(terminalThemeSeq()).toContain("]11;#ffffff");
  });

  it("TERMINAL_THEME_RESET restores fg + bg via OSC 110/111", () => {
    expect(TERMINAL_THEME_RESET).toContain("]110");
    expect(TERMINAL_THEME_RESET).toContain("]111");
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

  it("listThemes exposes only the two production themes (mono, mono-light)", () => {
    expect(listThemes().map((t) => t.name)).toEqual(["mono", "mono-light"]);
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
    expect(resolveInitialTheme({ env: "mono-light", saved: "mono", configured: "mono" })).toBe(
      "mono-light",
    );
    expect(resolveInitialTheme({ env: undefined, saved: "mono-light", configured: "mono" })).toBe(
      "mono-light",
    );
    expect(resolveInitialTheme({ saved: null, configured: "mono-light" })).toBe("mono-light");
    expect(resolveInitialTheme({})).toBe(DEFAULT_THEME);
    // unknown *and* non-production themes are skipped at each tier (matrix/dracula are hidden now)
    expect(resolveInitialTheme({ env: "bogus", saved: "mono-light" })).toBe("mono-light");
    expect(resolveInitialTheme({ env: "matrix", saved: "dracula" })).toBe(DEFAULT_THEME);
    expect(resolveInitialTheme({ configured: "bogus" })).toBe(DEFAULT_THEME);
  });
});
