import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import {
  AUTO_THEME,
  COLOR_ROLES,
  DEFAULT_THEME,
  THEMES,
  adaptiveTheme,
  findTheme,
} from "../../../packages/orchestrator/src/bin/ui/themes";
import {
  TERMINAL_THEME_RESET,
  accent,
  body,
  cardSurface,
  codeSurface,
  configureAutoTheme,
  danger,
  diffHeaderSurface,
  diffSurface,
  dim,
  getTheme,
  listThemes,
  negativeSurface,
  ok,
  paintWith,
  panel,
  popoverSurface,
  positiveSurface,
  selection,
  setTheme,
  stripAnsi,
  swatch,
  terminalThemeSeq,
  text,
  themeBgSeq,
  tintSurface,
  warn,
  withThemeBg,
} from "../../../packages/orchestrator/src/bin/ui/theme";
import { glyph } from "../../../packages/orchestrator/src/bin/ui/glyphs";
import { hexToRgbTuple, runeAccentHex } from "../../../packages/shared/src/design-tokens";
import {
  loadSavedTheme,
  resolveInitialTheme,
  saveTheme,
} from "../../../packages/orchestrator/src/bin/ui/theme-store";
import {
  ansi256ToRgb,
  parseTerminalColorResponses,
  stripTerminalColorResponses,
} from "../../../packages/orchestrator/src/bin/ui/terminal-colors";

afterEach(() => {
  configureAutoTheme({});
  setTheme(DEFAULT_THEME);
});

describe("Flow six-role palette", () => {
  it("has exactly six closed foreground roles", () => {
    expect(COLOR_ROLES).toEqual(["body", "dim", "accent", "ok", "warn", "danger"]);
  });

  it("body inherits the terminal foreground even when ANSI is available", () => {
    const root = join(import.meta.dir, "../../..");
    const themeUrl = pathToFileURL(join(root, "packages/orchestrator/src/bin/ui/theme.ts")).href;
    const script = `
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      const theme = await import(${JSON.stringify(themeUrl)});
      process.stdout.write(JSON.stringify({
        body: theme.body("body text"),
        text: theme.text("body text"),
        dim: theme.dim("dim text"),
        panel: theme.panel("panel body"),
      }));
    `;
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "", TERM: "xterm-256color" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const rendered = JSON.parse(run.stdout.toString()) as Record<string, string>;
    expect(rendered.body).toBe("body text");
    expect(rendered.text).toBe("body text");
    expect(rendered.body).not.toContain("\x1b");
    expect(rendered.dim).toContain("\x1b[");
    expect(rendered.panel).toBe("panel body");
  });

  it("keeps semantic payloads intact", () => {
    for (const paint of [body, dim, accent, ok, warn, danger]) {
      expect(stripAnsi(paint("payload"))).toBe("payload");
    }
    expect(text("plain body")).toBe("plain body");
    expect(stripAnsi(paintWith("rune-dark", "danger", "failed"))).toBe("failed");
  });
});

describe("no background ownership", () => {
  it("never emits an OSC foreground or background mutation", () => {
    // Narrowed deliberately, and only by one glyph. The background (OSC 11) and
    // the foreground (OSC 10) belong to the user: they sit behind and beneath
    // everything, including their other programs, and claiming either is why a
    // TUI leaves a terminal looking wrong. The cursor is different — it is a
    // mark drawn on our row, inside our own input field, and inheriting it puts
    // a foreign accent in the middle of a themed frame. It is claimed, and
    // handed straight back on exit; see the cursor describe below.
    for (const name of ["rune", "rune-dark", "auto"]) {
      setTheme(name);
      expect(terminalThemeSeq(), name).not.toContain("]10;");
      expect(terminalThemeSeq(), name).not.toContain("]11;");
      expect(themeBgSeq(), name).toBe("");
    }
  });

  it("all former surface APIs are background-free pass-throughs", () => {
    const value = "surface payload";
    for (const surface of [
      withThemeBg,
      panel,
      positiveSurface,
      negativeSurface,
      cardSurface,
      codeSurface,
      diffSurface,
      diffHeaderSurface,
      popoverSurface,
    ]) {
      const rendered = surface(value);
      expect(stripAnsi(rendered)).toBe(value);
      expect(rendered).not.toMatch(/\x1b\[(?:4[0-9]|10[0-7])(?:;|m)/);
      expect(rendered).not.toContain("\x1b]");
    }
    expect(stripAnsi(selection(value))).toBe(value);
    expect(stripAnsi(tintSurface("warn", value))).toBe(value);
  });
});

// The six-role budget closes the set of MEANINGS a colour may carry. It never
// implied one palette: six roles times a dozen themes is the point, not a
// contradiction. These tests previously pinned the opposite — that every name
// collapses to a single mode — which is the shape of the deletion, not of the
// design.
describe("theme palettes", () => {
  it("offers two grounds and the host escape hatch, and nothing else", () => {
    // Phase 3 collapsed three visual identities into one. Five cosmetic
    // accents were the largest part of what made the product look like a theme
    // gallery rather than an instrument; the picker is light, dark, auto.
    const names = listThemes().map((theme) => theme.name);
    expect(names).toEqual(["rune-dark", "rune", "auto"]);
    expect(DEFAULT_THEME).toBe("rune-dark");
    expect(AUTO_THEME.preserveTerminal).toBe(true);
  });

  it("every theme supplies its own pigments for every coloured role", () => {
    // The failure this guards against is a palette that exists in the picker
    // and renders identically to its neighbours — a theme list as decoration.
    for (const theme of listThemes()) {
      if (theme.useNativeColors) continue; // host mode paints nothing by design
      for (const slot of ["faint", "info", "ok", "warn", "accent"] as const) {
        const pigment = theme.slots[slot];
        expect(pigment.rgb, `${theme.name}.${slot}`).toHaveLength(3);
        expect(pigment.ansi, `${theme.name}.${slot}`).toBeGreaterThanOrEqual(0);
        expect(pigment.ansi).toBeLessThanOrEqual(255);
      }
    }
  });

  it("the console paints the SAME accent the app does, on both grounds", () => {
    // One hue, two values of it, and they come from the shared token module —
    // if the console and the app ever disagree, the terminal is a different
    // product wearing the same name. `info` is the slot the `accent` ROLE
    // resolves through: see ROLE_SLOT, where the names read from the other
    // direction.
    expect(findTheme("rune")!.slots.info.rgb).toEqual(hexToRgbTuple(runeAccentHex("light")));
    expect(findTheme("rune-dark")!.slots.info.rgb).toEqual(hexToRgbTuple(runeAccentHex("dark")));
  });

  it("every retired accent name still resolves, to the ground it was saved on", () => {
    // Someone with `rune-violet-dark` in ~/.rune/theme.json gets the dark mode,
    // not an "unknown theme" error and a surprise repaint. `flow` was the
    // previous dark default and migrates the same way.
    for (const [saved, resolved] of [
      ["rune-dark", "rune-dark"],
      ["flow", "rune-dark"],
      ["orange", "rune"],
      ["rune-violet-dark", "rune-dark"],
      ["mono-light", "rune"],
      ["light", "rune"],
      ["dark", "rune-dark"],
      ["system", "auto"],
    ] as const) {
      expect(findTheme(saved)?.name, saved).toBe(resolved);
      expect(setTheme(saved), saved).toBe(true);
      expect(getTheme().name, saved).toBe(resolved);
    }
    setTheme("rune-dark");
    expect(setTheme("not-a-theme")).toBe(false);
    expect(getTheme().name).toBe("rune-dark");
  });

  it("keeps terminal-native mode inert and labels detected polarity", () => {
    configureAutoTheme({ background: [245, 245, 240], foreground: [20, 20, 20] });
    expect(setTheme("auto")).toBe(true);
    expect(getTheme().name).toBe("auto");
    expect(getTheme().appearance).toBe("light");
    expect(terminalThemeSeq()).toBe("");
    expect(withThemeBg("native")).toBe("native");
    expect(adaptiveTheme({ background: [5, 5, 8] }).appearance).toBe("dark");
  });

  it("renders a compact semantic swatch without changing the active mode", () => {
    setTheme("auto");
    expect(stripAnsi(swatch("rune-dark"))).toBe(glyph("live").repeat(4));
    expect(getTheme().name).toBe("auto");
  });

  it("the two grounds are inversions, not two shades of one", () => {
    // Asserted on the pigments rather than on rendered output: a test process
    // has no tty, so nothing emits colour and every swatch strips to the same
    // four marks. The palette is the thing that has to differ.
    const light = findTheme("rune")!;
    const dark = findTheme("rune-dark")!;
    expect(light.appearance).toBe("light");
    expect(dark.appearance).toBe("dark");
    expect(light.slots.text.rgb).not.toEqual(dark.slots.text.rgb);
    expect(light.bg.rgb).not.toEqual(dark.bg.rgb);
  });
});

describe("theme-store migration", () => {
  it("round-trips the sidecar and resolves precedence onto the reduced modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-theme-"));
    try {
      expect(loadSavedTheme(dir)).toBeNull();
      saveTheme("auto", dir);
      expect(loadSavedTheme(dir)).toBe("auto");
      // A retired accent id in the environment is honoured as a CHOICE and
      // resolved onto the ground it was saved on — not rejected, and not
      // silently kept as a name nothing can paint.
      expect(resolveInitialTheme({ env: "rune-orange-dark", saved: "auto" })).toBe("rune-dark");
      expect(resolveInitialTheme({ env: "rune", saved: "auto" })).toBe("rune");
      expect(resolveInitialTheme({ env: "bogus", saved: "auto" })).toBe("auto");
      expect(resolveInitialTheme({ configured: "dracula" })).toBe("rune-dark");
      expect(resolveInitialTheme({})).toBe("rune-dark");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for corrupt state", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-theme-"));
    try {
      writeFileSync(join(dir, "theme.json"), "{ invalid json");
      expect(loadSavedTheme(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("terminal color reply parser", () => {
  it("parses OSC rgb and hex responses", () => {
    expect(
      parseTerminalColorResponses("\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;#123456\x1b\\"),
    ).toEqual({ foreground: [255, 255, 255], background: [18, 52, 86] });
  });

  it("removes replies without swallowing typed input", () => {
    const response = "\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;#121212\x07";
    expect(stripTerminalColorResponses(`h${response}i`)).toBe("hi");
  });

  it("maps ANSI256 colors used by COLORFGBG", () => {
    expect(ansi256ToRgb(0)).toEqual([0, 0, 0]);
    expect(ansi256ToRgb(15)).toEqual([255, 255, 255]);
    expect(ansi256ToRgb(196)).toEqual([255, 0, 0]);
  });
});

describe("the caret is painted, not requested", () => {
  const { cursorCell } = require("../../../packages/orchestrator/src/bin/ui/theme");
  const { findTheme, contrastRatio } = require("../../../packages/orchestrator/src/bin/ui/themes");

  it("asks the terminal for nothing at all", () => {
    // OSC 12 asks a terminal to colour its own cursor, and a terminal may
    // simply refuse — Warp does, which is how a foreign accent ended up sitting
    // on the first character of the input on every frame while the sequence
    // went out correctly. A request that can be ignored is not ownership.
    for (const name of ["rune", "rune-dark", "auto"]) {
      setTheme(name);
      expect(terminalThemeSeq(), name).toBe("");
    }
    expect(TERMINAL_THEME_RESET).toBe(""); // nothing taken, nothing to give back
  });

  it("the character under the caret stays readable on every palette", () => {
    // Asserted on the RULE, not on cursorCell's output. A test process has no
    // tty, so cursorCell falls back to reverse video there — inspecting it
    // would say nothing about the choice being made, which is how the first
    // version of this test measured every theme against white and "found" a
    // contrast failure that did not exist.
    //
    // The real failure it replaces: a luminance threshold picked by eye put
    // white on Cyber Orange at ~2.9:1 — enough to pass a glance, not enough to
    // read the character you are typing over.
    const { caretForeground } = require("../../../packages/orchestrator/src/bin/ui/theme");
    for (const theme of listThemes()) {
      if (theme.useNativeColors) continue; // host mode uses the host's own pair
      const accent = theme.slots.info.rgb;
      const pick = caretForeground(accent);
      const chosen = contrastRatio(accent, pick === "black" ? [0, 0, 0] : [255, 255, 255]);
      const other = contrastRatio(accent, pick === "black" ? [255, 255, 255] : [0, 0, 0]);
      // It must pick the better of the two, always — that is the whole rule.
      expect(chosen, `${theme.name}: picked the worse foreground`).toBeGreaterThanOrEqual(other);
      // And the better of the two must actually be readable.
      expect(chosen, `${theme.name} caret contrast (${pick})`).toBeGreaterThanOrEqual(4);
    }
  });

  it("still carries the character, never blanks it", () => {
    setTheme("rune-dark");
    expect(stripAnsi(cursorCell("d"))).toBe("d");
    expect(stripAnsi(cursorCell(""))).toBe(" "); // end of line still gets a block
  });

  it("host mode paints with reverse video, claiming no colour of its own", () => {
    // Terminal-native exists so the host keeps every decision; reverse video is
    // legible by definition because it is the host's own pair.
    setTheme("auto");
    expect(cursorCell("d")).toContain("\x1b[7m");
  });
});

// ─── The finish (2026-09-26) ───
//
// A second axis beside light/dark: matte (the default) and crisp. The chrome is
// monochrome at both -- the accent IS the ink -- and matte is the one reason
// body text may be painted instead of inherited, under the conditions pinned
// below in a real colour process.
describe("the finish", () => {
  const themes = require("../../../packages/orchestrator/src/bin/ui/themes");
  const theme = require("../../../packages/orchestrator/src/bin/ui/theme");
  const store = require("../../../packages/orchestrator/src/bin/ui/theme-store");

  afterEach(() => {
    theme.setFinish("matte");
    theme.setAppearanceChosen(false);
  });

  const neutral = ([r, g, b]: number[]) => r === g && g === b;

  it("the accent is the ink: no hue on either ground, at either finish", () => {
    for (const finish of ["matte", "crisp"] as const) {
      for (const appearance of ["dark", "light"] as const) {
        const t = themes.runeTheme(appearance, finish);
        expect(t.finish).toBe(finish);
        expect(t.slots.info.rgb, `${appearance}.${finish}`).toEqual(t.slots.text.rgb);
        expect(t.brand.rgb).toEqual(t.slots.text.rgb);
        for (const slot of ["text", "muted", "faint", "info", "line"] as const) {
          expect(neutral(t.slots[slot].rgb), `${appearance}.${finish}.${slot}`).toBe(true);
        }
      }
    }
  });

  it("setFinish rebuilds the active theme; the id does not change", () => {
    setTheme("rune-dark");
    theme.setFinish("crisp");
    expect(getTheme().name).toBe("rune-dark");
    expect(getTheme().finish).toBe("crisp");
    expect(getTheme().slots.text.rgb).toEqual([255, 255, 255]);
    theme.setFinish("matte");
    expect(getTheme().name).toBe("rune-dark");
    expect(getTheme().finish).toBe("matte");
    expect(getTheme().slots.text.rgb).toEqual(hexToRgbTuple("#D3D3D3"));
    // A later theme switch keeps the finish.
    setTheme("rune");
    expect(getTheme().finish).toBe("matte");
  });

  it("Auto is monochrome too, and its errors are red again", () => {
    // The `accent` SLOT is the danger role. Auto used to fill it with a blue,
    // so an error in Auto printed in the brand colour.
    for (const finish of ["matte", "crisp"] as const) {
      const t = adaptiveTheme({ background: [0, 0, 0], foreground: [255, 255, 255] }, finish);
      expect(t.slots.info.rgb).toEqual(t.slots.text.rgb);
      const [r, g, b] = t.slots.accent.rgb;
      expect(r, `${finish} danger is red-dominant`).toBeGreaterThan(Math.max(g, b));
    }
    const matte = adaptiveTheme({ background: [0, 0, 0], foreground: [255, 255, 255] }, "matte");
    const crisp = adaptiveTheme({ background: [0, 0, 0], foreground: [255, 255, 255] }, "crisp");
    expect(crisp.slots.text.rgb).toEqual([255, 255, 255]);
    expect(matte.slots.text.rgb[0]).toBeLessThan(255); // the host's white, walked back
  });

  it("reads a typed /theme argument as either axis, or both", () => {
    expect(themes.parseThemeChoice("dark-matte")).toEqual({ theme: "dark", finish: "matte" });
    expect(themes.parseThemeChoice("light crisp")).toEqual({ theme: "light", finish: "crisp" });
    expect(themes.parseThemeChoice("rune-dark-crisp")).toEqual({
      theme: "rune-dark",
      finish: "crisp",
    });
    expect(themes.parseThemeChoice("matte")).toEqual({ finish: "matte" });
    expect(themes.parseThemeChoice("glossy")).toEqual({ finish: "crisp" });
    expect(themes.parseThemeChoice("light")).toEqual({ theme: "light" });
    // A real theme name always wins over a finish alias.
    expect(themes.parseThemeChoice("high-contrast")).toEqual({ theme: "high-contrast" });
    expect(themes.parseThemeChoice("")).toEqual({});
  });

  it("offers five rows, both surfaces, Terminal last", () => {
    const rows = themes.THEME_CHOICES.map(
      (c: { label: string; note: string }) => `${c.label} ${c.note}`,
    );
    expect(rows).toEqual([
      "Dark matte",
      "Dark crisp",
      "Light matte",
      "Light crisp",
      "Terminal follows",
    ]);
    expect(themes.themeChoiceIndex("rune-dark", "matte")).toBe(0);
    expect(themes.themeChoiceIndex("rune", "crisp")).toBe(3);
    expect(themes.themeChoiceIndex("auto", "crisp")).toBe(4);
    expect(themes.themeChoiceIndex("dracula", "matte")).toBe(-1);
  });

  it("saves the finish beside the theme, and a theme-only save keeps it", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-finish-"));
    try {
      expect(store.loadSavedFinish(dir)).toBeNull();
      store.saveTheme("rune", dir, "crisp");
      expect(store.loadSavedTheme(dir)).toBe("rune");
      expect(store.loadSavedFinish(dir)).toBe("crisp");
      store.saveTheme("rune-dark", dir);
      expect(store.loadSavedTheme(dir)).toBe("rune-dark");
      expect(store.loadSavedFinish(dir)).toBe("crisp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names which source chose the startup theme", () => {
    expect(store.initialThemeSource({ env: "rune", saved: "auto" })).toBe("env");
    expect(store.initialThemeSource({ env: "bogus", saved: "auto" })).toBe("saved");
    expect(store.initialThemeSource({ configured: "light" })).toBe("configured");
    expect(store.initialThemeSource({ configured: "dracula" })).toBe("default");
    expect(store.initialThemeSource({})).toBe("default");
  });

  it("matte paints body text only where it is safe to", () => {
    // In a real colour process: isTTY forced before the module loads, 24-bit
    // declared. Each case is one fresh process, because colour capability is
    // resolved once at module load.
    const root = join(import.meta.dir, "../../..");
    const themeUrl = pathToFileURL(join(root, "packages/orchestrator/src/bin/ui/theme.ts")).href;
    const render = (setup: string): string => {
      const script = `
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        const theme = await import(${JSON.stringify(themeUrl)});
        ${setup}
        process.stdout.write(JSON.stringify(theme.body("prose")));
      `;
      const run = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: root,
        env: { ...process.env, NO_COLOR: "", TERM: "xterm-256color", COLORTERM: "truecolor" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      return JSON.parse(run.stdout.toString()) as string;
    };
    const soft = "\x1b[38;2;211;211;211m";
    // The built-in default on a silent host: inherit, as it always has.
    expect(render(`theme.setTheme("rune-dark");`)).toBe("prose");
    // (a) the host reported a dark ground and the theme is dark: paint.
    expect(
      render(`theme.configureAutoTheme({ background: [0, 0, 0] }); theme.setTheme("rune-dark");`),
    ).toBe(`${soft}prose\x1b[0m`);
    // (a) a LIGHT ground under the dark theme: never grey prose on white.
    expect(
      render(
        `theme.configureAutoTheme({ background: [255, 255, 255] }); theme.setTheme("rune-dark");`,
      ),
    ).toBe("prose");
    // (b) a silent host, but the appearance was chosen: paint.
    expect(render(`theme.setTheme("rune-dark"); theme.setAppearanceChosen(true);`)).toBe(
      `${soft}prose\x1b[0m`,
    );
    // Crisp never paints body, whatever the host says.
    expect(
      render(
        `theme.configureAutoTheme({ background: [0, 0, 0] }); theme.setTheme("rune-dark"); theme.setFinish("crisp"); theme.setAppearanceChosen(true);`,
      ),
    ).toBe("prose");
  });
});
