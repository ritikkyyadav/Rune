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
});
