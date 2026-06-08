import { describe, it, expect } from "vitest";
import { parseKeys, type Key } from "../../../packages/orchestrator/src/bin/ui/keys";

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
    // a left-click press + release yields no keys and leaks no coordinate chars
    expect(types("\x1b[<0;10;5M\x1b[<0;10;5m")).toEqual([]);
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
