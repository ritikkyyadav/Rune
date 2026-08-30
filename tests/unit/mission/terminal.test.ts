import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemorySink, Surface, Prose } from "../../../packages/mission/src/surface/terminal";
import { detectCaps, plainCaps, MEASURE } from "../../../packages/mission/src/render/caps";
import { screenFor } from "../../../packages/mission/src/render/ansi";
import { L, type Row } from "../../../packages/mission/src/render/row";

const screen = screenFor();
const tty = detectCaps({ colour: "truecolor", glyphs: "utf8", pulse: "blocks", columns: MEASURE });
// Same glyph rung, same measure — only the TTY-ness differs, because what is under
// test is whether the erases and cursor-ups cancel, not whether the fold is a no-op.
const piped = { ...tty, colour: "none" as const, tint: false };

/**
 * A miniature terminal. It understands exactly the five things the writer is allowed
 * to emit — if the erases and the cursor-ups do not cancel out precisely, the screen
 * it produces will not match the piped transcript, and the test fails.
 */
function emulate(streamText: string): string {
  const lines: string[] = [""];
  let row = 0;
  let col = 0;
  let i = 0;

  const put = (ch: string) => {
    while (lines.length <= row) lines.push("");
    const line = lines[row]!;
    lines[row] =
      (line.length < col ? line.padEnd(col) : line).slice(0, col) + ch + line.slice(col + 1);
    col++;
  };

  while (i < streamText.length) {
    const ch = streamText[i]!;
    if (ch === "\x1b") {
      const m = /^\x1b\[(\??)([0-9;]*)([A-Za-z])/.exec(streamText.slice(i));
      if (!m) {
        i++;
        continue;
      }
      const [, priv, args, cmd] = m;
      if (!priv && cmd === "K" && args === "2") lines[row] = "";
      else if (!priv && cmd === "A") row = Math.max(0, row - (parseInt(args || "1", 10) || 1));
      // SGR (m) and the private modes (?25 cursor, ?2026 sync) do not move the cursor.
      i += m[0].length;
      continue;
    }
    if (ch === "\n") {
      row++;
      col = 0;
      while (lines.length <= row) lines.push("");
    } else if (ch === "\r") col = 0;
    else put(ch);
    i++;
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** The same session, driven identically into an interactive surface and a pipe. */
function drive(surface: Surface) {
  surface.commit([
    L("§d{─── }§a{gear 0.4}§d{ ─────────}"),
    L("  ledger/core §d{·} §a{main} §d{· clean}"),
  ]);
  surface.live([L(" §d{  │}  §d{⎿} ◌ run   pytest tests/auth¶§d{3 / 12}")]);
  surface.live([L(" §d{  │}  §d{⎿} ◌ run   pytest tests/auth¶§d{7 / 12}")]);
  surface.live([L(" §d{  │}  §d{⎿} ◌ run   pytest tests/auth¶§d{11 / 12}")]);
  surface.settle([L(" §d{  │}  §d{⎿} §o{✓} run   pytest tests/auth¶§d{2 failed   6.2s}   §d{·}")]);
  surface.commit([L(" §d{  └}  two reproduce, deterministically¶§d{1m52s}   §d{=}")]);
  surface.live([L("  §k{03}§d{ / 08 · 1 agent}¶§d{⇥ inspect  }")]);
  surface.settle([]);
}

describe("the writer owns the last N rows, never the screen", () => {
  // Test 12, the proof of the cursor arithmetic.
  it("replays to exactly the piped transcript", () => {
    const interactive = new MemorySink(true);
    drive(new Surface(interactive, tty, screen));

    const pipe = new MemorySink(false);
    drive(new Surface(pipe, piped, screen));

    const replayed = emulate(interactive.text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(replayed).toBe(pipe.text.replace(/\s+$/, ""));
  });

  it("uses only relative moves — no alternate screen, no absolute addressing", () => {
    const sink = new MemorySink(true);
    drive(new Surface(sink, tty, screen));
    expect(sink.text).not.toMatch(/\x1b\[\?1049/); // alternate screen
    expect(sink.text).not.toMatch(/\x1b\[2J/); // full-screen clear
    expect(sink.text).not.toMatch(/\x1b\[\d*;\d*H/); // absolute addressing
    expect(sink.text).not.toMatch(/\x1b\[H/);
    // and the five it is allowed to use
    expect(sink.text).toMatch(/\x1b\[2K/);
    expect(sink.text).toMatch(/\x1b\[1A/);
    expect(sink.text).toMatch(/\x1b\[\?2026h/);
  });

  it("writes nothing when the frame has not changed", () => {
    const sink = new MemorySink(true);
    const s = new Surface(sink, tty, screen);
    const row: Row = L("  §k{05}§d{ / 08}¶§d{⇥ inspect  }");
    s.live([row]);
    const afterFirst = sink.text.length;
    s.live([row]);
    expect(sink.text.length).toBe(afterFirst);
  });

  it("emits no ANSI at all on a pipe", () => {
    const pipe = new MemorySink(false);
    drive(new Surface(pipe, piped, screen));
    expect(pipe.text).not.toMatch(/\x1b/);
    // The NO_TTY rung commits final states only — no intermediate progress counts.
    expect(pipe.text).not.toContain("3 / 12");
    expect(pipe.text).toContain("2 failed");
  });
});

describe("prose streams, code does not", () => {
  it("renders only on word boundaries", () => {
    const p = new Prose({}, 0);
    // A complete word is safe to show; the fragment after it is held back, because
    // committing half a word freezes it into scrollback at the current width forever.
    expect(p.push("The call", 1)).toBe("The ");
    expect(p.push("back completes ", 2)).toBe("callback completes ");
    expect(p.text).toBe("The callback completes ");
  });

  it("flushes a stalled fragment rather than holding it forever", () => {
    const p = new Prose({ flushAfterMs: 40 }, 0);
    expect(p.push("supercalifragilistic", 10)).toBe("");
    expect(p.push("", 100)).toBe("supercalifragilistic");
  });
});

describe("the package cannot regress into owning the screen", () => {
  it("contains no forbidden escape anywhere in its source", () => {
    const root = join(import.meta.dir, "../../../packages/mission/src");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const offenders: string[] = [];
    for (const file of walk(root)) {
      // Strip comments first: the rule is about what the package *emits*, and the
      // writer's header names each forbidden escape in order to explain the ban.
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const bad of ["?1049", "[2J", "[" + "H"]) {
        if (src.includes(bad)) offenders.push(`${file}: ${bad}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
