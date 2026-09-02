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
    expect(stripAnsi(paintWith("gear-dark", "danger", "failed"))).toBe("failed");
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
    for (const name of ["gear", "gear-dark", "auto"]) {
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
    expect(names).toEqual(["gear-dark", "gear", "auto"]);
    expect(DEFAULT_THEME).toBe("gear-dark");
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

  it("the accent is the datum on paper and the signal on ink", () => {
    // One hue, two values of it. `info` is the slot the `accent` ROLE resolves
    // through — see ROLE_SLOT, where the names read from the other direction.
    expect(findTheme("gear")!.slots.info.rgb).toEqual([14, 94, 99]);
    expect(findTheme("gear-dark")!.slots.info.rgb).toEqual([23, 160, 168]);
  });

  it("every retired accent name still resolves, to the ground it was saved on", () => {
    // Someone with `gear-violet-dark` in ~/.gear/theme.json gets the dark mode,
    // not an "unknown theme" error and a surprise repaint. `flow` was the
    // previous dark default and migrates the same way.
    for (const [saved, resolved] of [
      ["gear-dark", "gear-dark"],
      ["flow", "gear-dark"],
      ["orange", "gear"],
      ["gear-violet-dark", "gear-dark"],
      ["mono-light", "gear"],
      ["light", "gear"],
      ["dark", "gear-dark"],
      ["system", "auto"],
    ] as const) {
      expect(findTheme(saved)?.name, saved).toBe(resolved);
      expect(setTheme(saved), saved).toBe(true);
      expect(getTheme().name, saved).toBe(resolved);
    }
    setTheme("gear-dark");
    expect(setTheme("not-a-theme")).toBe(false);
    expect(getTheme().name).toBe("gear-dark");
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
    expect(stripAnsi(swatch("gear-dark"))).toBe(glyph("live").repeat(4));
    expect(getTheme().name).toBe("auto");
  });

  it("the two grounds are inversions, not two shades of one", () => {
    // Asserted on the pigments rather than on rendered output: a test process
    // has no tty, so nothing emits colour and every swatch strips to the same
    // four marks. The palette is the thing that has to differ.
    const light = findTheme("gear")!;
    const dark = findTheme("gear-dark")!;
    expect(light.appearance).toBe("light");
    expect(dark.appearance).toBe("dark");
    expect(light.slots.text.rgb).not.toEqual(dark.slots.text.rgb);
    expect(light.bg.rgb).not.toEqual(dark.bg.rgb);
  });
});

describe("theme-store migration", () => {
  it("round-trips the sidecar and resolves precedence onto the reduced modes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-theme-"));
    try {
      expect(loadSavedTheme(dir)).toBeNull();
      saveTheme("auto", dir);
      expect(loadSavedTheme(dir)).toBe("auto");
      // A retired accent id in the environment is honoured as a CHOICE and
      // resolved onto the ground it was saved on — not rejected, and not
      // silently kept as a name nothing can paint.
      expect(resolveInitialTheme({ env: "gear-orange-dark", saved: "auto" })).toBe("gear-dark");
      expect(resolveInitialTheme({ env: "gear", saved: "auto" })).toBe("gear");
      expect(resolveInitialTheme({ env: "bogus", saved: "auto" })).toBe("auto");
      expect(resolveInitialTheme({ configured: "dracula" })).toBe("gear-dark");
      expect(resolveInitialTheme({})).toBe("gear-dark");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for corrupt state", () => {
    const dir = mkdtempSync(join(tmpdir(), "gear-theme-"));
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
    for (const name of ["gear", "gear-dark", "auto"]) {
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
    setTheme("gear-dark");
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
