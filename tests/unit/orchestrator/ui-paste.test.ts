import { describe, it, expect } from "vitest";
import {
  shouldCollapse,
  pasteChip,
  expandPastes,
  livePasteIds,
  PasteScanner,
  PASTE_INLINE_MAX,
  PASTE_START,
  PASTE_END,
} from "../../../packages/orchestrator/src/bin/ui/paste";

describe("ui/paste — bracketed-paste collapsing", () => {
  it("keeps small single-line pastes inline", () => {
    expect(shouldCollapse("a short snippet")).toBe(false);
    expect(shouldCollapse("x".repeat(PASTE_INLINE_MAX))).toBe(false);
  });

  it("collapses anything multi-line or long", () => {
    expect(shouldCollapse("line1\nline2")).toBe(true); // newline → collapse regardless of length
    expect(shouldCollapse("x".repeat(PASTE_INLINE_MAX + 1))).toBe(true);
  });

  it("chips a multi-line paste with a line count and a long one with a char count", () => {
    expect(pasteChip(1, "a\nb\nc")).toBe("[Pasted text #1 +3 lines]");
    expect(pasteChip(7, "y".repeat(500))).toBe("[Pasted text #7 +500 chars]");
  });

  it("round-trips: a chip expands back to the exact body it stood for", () => {
    const body = "policy\nrules\nhere";
    const bodies = new Map([[1, body]]);
    const chip = pasteChip(1, body);
    const composed = `please apply ${chip} to the repo`;
    expect(expandPastes(composed, bodies)).toBe(`please apply ${body} to the repo`);
  });

  it("expands several chips independently and leaves unknown ids untouched", () => {
    const bodies = new Map([
      [1, "AAA"],
      [2, "BBB"],
    ]);
    const s = `${pasteChip(1, "x".repeat(300))} and ${pasteChip(2, "y".repeat(300))} and [Pasted text #9 +5 lines]`;
    const out = expandPastes(s, bodies);
    expect(out).toContain("AAA");
    expect(out).toContain("BBB");
    expect(out).toContain("[Pasted text #9 +5 lines]"); // no body #9 → left as written
  });

  it("livePasteIds finds exactly the chips still in the composer", () => {
    const s = `keep ${pasteChip(3, "a\nb")} drop nothing ${pasteChip(4, "z".repeat(400))}`;
    expect([...livePasteIds(s)].sort()).toEqual([3, 4]);
    expect([...livePasteIds("no chips here")]).toEqual([]);
  });
});

describe("ui/paste — PasteScanner (stream splitting)", () => {
  it("passes ordinary keystrokes straight through as a key segment", () => {
    const s = new PasteScanner();
    expect(s.push("abc")).toEqual([{ type: "keys", data: "abc" }]);
    expect(s.active).toBe(false);
  });

  it("carves a single-chunk bracketed paste into one paste segment", () => {
    const s = new PasteScanner();
    const segs = s.push(`hi ${PASTE_START}pasted body${PASTE_END} bye`);
    expect(segs).toEqual([
      { type: "keys", data: "hi " },
      { type: "paste", content: "pasted body" },
      { type: "keys", data: " bye" },
    ]);
    expect(s.active).toBe(false);
  });

  it("reassembles a paste split across many chunks without decoding it per character", () => {
    const s = new PasteScanner();
    const big = "line\n".repeat(1000); // ~5k lines worth of body, arriving in pieces
    expect(s.push(PASTE_START + big.slice(0, 2000))).toEqual([]); // still open, nothing emitted
    expect(s.active).toBe(true);
    expect(s.push(big.slice(2000))).toEqual([]); // more body, still open
    const done = s.push(PASTE_END + "\r"); // end marker + a stray Enter after the paste
    expect(done[0]).toEqual({ type: "paste", content: big });
    expect(done[1]).toEqual({ type: "keys", data: "\r" });
    expect(s.active).toBe(false);
  });

  it("handles back-to-back pastes in one chunk", () => {
    const s = new PasteScanner();
    const segs = s.push(`${PASTE_START}A${PASTE_END}${PASTE_START}B${PASTE_END}`);
    expect(segs).toEqual([
      { type: "paste", content: "A" },
      { type: "paste", content: "B" },
    ]);
  });
});
