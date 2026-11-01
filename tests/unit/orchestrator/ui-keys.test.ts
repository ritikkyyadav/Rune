import { describe, it, expect } from "bun:test";
import { arrowRun, parseKeys, type Key } from "../../../packages/orchestrator/src/bin/ui/keys";

const types = (data: string) => parseKeys(data).map((k) => k.type);

describe("ui/keys parseKeys", () => {
  it("parses printable characters", () => {
    expect(parseKeys("abc")).toEqual([
      { type: "char", value: "a" },
      { type: "char", value: "b" },
      { type: "char", value: "c" },
    ]);
  });

  it("parses enter, backspace, tab", () => {
    expect(types("\r")).toEqual(["enter"]);
    expect(types("\n")).toEqual(["enter"]);
    expect(types("\x7f")).toEqual(["backspace"]);
    expect(types("\t")).toEqual(["tab"]);
  });

  it("parses arrow keys and navigation CSI sequences", () => {
    expect(types("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(types("\x1b[H\x1b[F")).toEqual(["home", "end"]);
    expect(types("\x1b[3~")).toEqual(["delete"]);
  });

  it("parses Shift+Tab (back-tab) as a distinct key, separate from tab", () => {
    expect(types("\x1b[Z")).toEqual(["shift-tab"]);
    expect(types("\t")).toEqual(["tab"]);
    // Mixed in a chunk: a char, a shift-tab, then enter all survive.
    expect(types("a\x1b[Z\r")).toEqual(["char", "shift-tab", "enter"]);
  });

  it("parses control keys", () => {
    expect(parseKeys("\x03")).toEqual([{ type: "ctrl", name: "c" }]);
    expect(parseKeys("\x04")).toEqual([{ type: "ctrl", name: "d" }]);
    expect(parseKeys("\x0c")).toEqual([{ type: "ctrl", name: "l" }]);
    expect(parseKeys("\x14")).toEqual([{ type: "ctrl", name: "t" }]);
  });

  it("treats a lone ESC as escape", () => {
    expect(types("\x1b")).toEqual(["esc"]);
  });

  it("surfaces bracketed-paste markers", () => {
    const ks = parseKeys("\x1b[200~hi\x1b[201~");
    expect(ks[0]).toEqual({ type: "paste-start" });
    expect(ks.at(-1)).toEqual({ type: "paste-end" });
    expect(ks.slice(1, -1)).toEqual([
      { type: "char", value: "h" },
      { type: "char", value: "i" },
    ]);
  });

  it("handles a multi-key chunk (type then submit)", () => {
    expect(types("hi\r")).toEqual(["char", "char", "enter"]);
  });

  it("handles multi-byte code points as a single char", () => {
    const ks = parseKeys("é🚀") as Extract<Key, { type: "char" }>[];
    expect(ks.map((k) => k.value)).toEqual(["é", "🚀"]);
  });

  it("maps SGR mouse wheel to scroll, consuming clicks", () => {
    expect(types("\x1b[<64;10;5M")).toEqual(["wheel-up"]);
    expect(types("\x1b[<65;10;5M")).toEqual(["wheel-down"]);
    // modifier-shifted wheel (e.g. ctrl+wheel = 64+16) still scrolls
    expect(types("\x1b[<80;1;1M")).toEqual(["wheel-up"]);
    expect(types("\x1b[<81;1;1M")).toEqual(["wheel-down"]);
    // a plain left-click press surfaces with its cell; the release is consumed
    expect(parseKeys("\x1b[<0;10;5M\x1b[<0;10;5m")).toEqual([{ type: "click", x: 10, y: 5 }]);
    // modifier-clicks (the host's own selection gestures) and drags stay consumed
    expect(types("\x1b[<4;10;5M")).toEqual([]);
    expect(types("\x1b[<32;10;5M")).toEqual([]);
    expect(types("\x1b[<2;10;5M")).toEqual([]);
    // wheeling then typing: the char after the sequence still registers
    expect(types("\x1b[<64;1;1Mx")).toEqual(["wheel-up", "char"]);
  });

  it("maps legacy X10 mouse wheel and swallows its coordinate bytes", () => {
    // ESC [ M Cb Cx Cy, each byte offset by 32 → wheel-up Cb=96, wheel-down Cb=97
    expect(types("\x1b[M\x60\x21\x21")).toEqual(["wheel-up"]);
    expect(types("\x1b[M\x61\x21\x21")).toEqual(["wheel-down"]);
    // resyncs after the 3 coordinate bytes so a trailing char isn't lost
    expect(types("\x1b[M\x60\x21\x21x")).toEqual(["wheel-up", "char"]);
    // a non-wheel legacy click emits nothing but is still consumed
    expect(types("\x1b[M\x20\x21\x21")).toEqual([]);
  });
});

describe("OSC replies in the key stream", () => {
  it("consumes a late color-probe reply silently instead of Esc + typed junk", () => {
    // BEL-terminated (xterm default) and ST-terminated forms, wrapped in real keys.
    expect(types("a\x1b]11;rgb:1e1e/2020/2626\x07b")).toEqual(["char", "char"]);
    expect(types("\x1b]10;#c8ccd4\x1b\\x")).toEqual(["char"]);
  });

  it("swallows an unterminated OSC tail rather than typing its bytes", () => {
    // A reply split across reads: the fragment must not become keystrokes.
    expect(types("\x1b]11;rgb:1e1e/20")).toEqual([]);
    // …while a lone ESC at the end of a chunk still means Escape.
    expect(types("\x1b")).toEqual(["esc"]);
  });
});

// The wheel under alternate-scroll mode: a burst of one-way arrows in a single
// read is the wheel, and its length is the distance. One arrow is a keypress.
describe("ui/keys arrowRun", () => {
  it("reads a one-way burst as the wheel, signed by direction", () => {
    expect(arrowRun(parseKeys("\x1b[A\x1b[A\x1b[A"))).toBe(3);
    expect(arrowRun(parseKeys("\x1b[B\x1b[B"))).toBe(-2);
  });
  it("leaves a lone arrow to the keyboard", () => {
    expect(arrowRun(parseKeys("\x1b[A"))).toBe(0);
    expect(arrowRun([])).toBe(0);
  });
  it("is not fooled by mixed or non-arrow chunks", () => {
    expect(arrowRun(parseKeys("\x1b[A\x1b[B"))).toBe(0);
    expect(arrowRun(parseKeys("\x1b[A\x1b[A" + "x"))).toBe(0);
    expect(arrowRun(parseKeys("\x1b[C\x1b[C"))).toBe(0);
  });
});

// The application-cursor (SS3) arrows. Warp delivers the wheel as ESC O A
// under alternate-scroll mode; before this branch that read as Esc + "OA".
describe("ui/keys SS3 arrows", () => {
  it("parses ESC O A-D/H/F as the same keys as their CSI twins", () => {
    expect(types("\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF")).toEqual([
      "up",
      "down",
      "right",
      "left",
      "home",
      "end",
    ]);
  });
  it("reads a Warp wheel notch as an arrow burst, never as typed text", () => {
    const keys = parseKeys("\x1bOA\x1bOA\x1bOA");
    expect(keys.map((k) => k.type)).toEqual(["up", "up", "up"]);
    expect(arrowRun(keys)).toBe(3);
  });
  it("swallows F1-F4 and any other SS3 final instead of reading Escape + text", () => {
    expect(types("\x1bOP")).toEqual([]);
    // An application-keypad key (`ESC O x` is keypad 8 under DECKPAM) is not
    // Escape followed by two typed letters.
    expect(types("\x1bOx")).toEqual([]);
    expect(types("\x1bOxa")).toEqual(["char"]);
  });
});

// Option/Alt chords. Terminals send them as ESC + key (macOS Terminal's
// default Option+left is `ESC b`) or as xterm-modified CSI. Read as Escape,
// every one of them cleared the draft at rest and interrupted a running turn.
describe("ui/keys Option and Alt chords", () => {
  it("reads ESC b / ESC f / ESC d as readline's word moves and word delete", () => {
    expect(types("\x1bb")).toEqual(["word-left"]);
    expect(types("\x1bf")).toEqual(["word-right"]);
    expect(types("\x1bd")).toEqual(["word-delete"]);
    expect(types("\x1bB\x1bF")).toEqual(["word-left", "word-right"]);
  });

  it("reads ESC DEL and ESC BS as delete-word-back, ESC Enter as a newline", () => {
    expect(types("\x1b\x7f")).toEqual(["word-backspace"]);
    expect(types("\x1b\b")).toEqual(["word-backspace"]);
    expect(types("\x1b\r")).toEqual(["newline"]);
    expect(types("\x1b\n")).toEqual(["newline"]);
  });

  it("never reads an unbound Option chord as Escape, and never types its letter", () => {
    for (const chord of ["\x1bx", "\x1bq", "\x1b.", "\x1b1", "\x1bZ"]) {
      expect(types(chord)).toEqual([]);
    }
    // ...and what follows it in the same read still arrives.
    expect(parseKeys("\x1bxhi")).toEqual([
      { type: "char", value: "h" },
      { type: "char", value: "i" },
    ]);
    // A chord on an astral character consumes the whole code point.
    expect(types("\x1b\u{1F680}a")).toEqual(["char"]);
  });

  it("keeps a lone ESC, and a double ESC, as Escape", () => {
    expect(types("\x1b")).toEqual(["esc"]);
    expect(types("\x1b\x1b")).toEqual(["esc", "esc"]);
    expect(types("a\x1b")).toEqual(["char", "esc"]);
  });

  it("reads xterm-modified arrows: alt, ctrl or meta move by word; shift is plain", () => {
    expect(types("\x1b[1;3D\x1b[1;3C")).toEqual(["word-left", "word-right"]);
    expect(types("\x1b[1;5D\x1b[1;5C")).toEqual(["word-left", "word-right"]);
    expect(types("\x1b[1;9D")).toEqual(["word-left"]);
    expect(types("\x1b[1;2D\x1b[1;2C")).toEqual(["left", "right"]);
    expect(types("\x1b[1;3H\x1b[1;3F")).toEqual(["home", "end"]);
    expect(types("\x1b[3;3~\x1b[3;5~")).toEqual(["word-delete", "word-delete"]);
    expect(types("\x1b[3;2~")).toEqual(["delete"]);
    // Modified up/down are not gestures here; they stay consumed.
    expect(types("\x1b[1;3A\x1b[1;5B")).toEqual([]);
  });

  it("is not a wheel burst: word moves are not arrows", () => {
    expect(arrowRun(parseKeys("\x1bb\x1bb"))).toBe(0);
  });
});
