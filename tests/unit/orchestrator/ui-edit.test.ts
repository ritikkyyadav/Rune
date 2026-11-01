import { describe, expect, it } from "bun:test";
import {
  deleteBack,
  deleteForward,
  deleteSpaceWordBack,
  deleteWordBack,
  deleteWordForward,
  nextBoundary,
  prevBoundary,
  wordLeft,
  wordRight,
} from "../../../packages/orchestrator/src/bin/ui/edit";

const ROCKET = "\u{1F680}"; // two UTF-16 code units
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}"; // one grapheme, eight units
const HINDI = "क्य"; // "kya": a conjunct of three code points

describe("composer editing by character, not by code unit", () => {
  it("Backspace after an emoji removes the whole emoji, never half of it", () => {
    const text = `ship it ${ROCKET}`;
    const edit = deleteBack(text, text.length);
    expect(edit).toEqual({ text: "ship it ", caret: 8 });
    expect(edit.text).not.toContain("�");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(edit.text)).toBe(false);
  });

  it("treats a joined emoji and an Indic conjunct as one character each", () => {
    expect(deleteBack(`a${FAMILY}`, 1 + FAMILY.length)).toEqual({ text: "a", caret: 1 });
    expect(deleteBack(HINDI, HINDI.length)).toEqual({ text: "", caret: 0 });
    expect(prevBoundary(`a${ROCKET}b`, 3)).toBe(1);
    expect(nextBoundary(`a${ROCKET}b`, 1)).toBe(3);
  });

  it("Delete removes one whole character forward and is a no-op at the end", () => {
    expect(deleteForward(`${ROCKET}x`, 0)).toEqual({ text: "x", caret: 0 });
    expect(deleteForward("abc", 3)).toEqual({ text: "abc", caret: 3 });
    expect(deleteBack("abc", 0)).toEqual({ text: "abc", caret: 0 });
  });
});

describe("word moves and word deletes (Option keys, readline)", () => {
  const line = "fix the flaky login test";

  it("Option+left goes to the start of this word, then the previous one", () => {
    expect(wordLeft(line, line.length)).toBe(line.indexOf("test"));
    expect(wordLeft(line, line.indexOf("test"))).toBe(line.indexOf("login"));
    expect(wordLeft(line, 2)).toBe(0);
    expect(wordLeft(line, 0)).toBe(0);
  });

  it("Option+right goes to the end of this word, then the next one", () => {
    expect(wordRight(line, 0)).toBe(3);
    expect(wordRight(line, 3)).toBe(7);
    expect(wordRight(line, line.length)).toBe(line.length);
  });

  it("skips punctuation the way readline does", () => {
    const path = "open src/cli.js now";
    expect(wordLeft(path, path.indexOf(" now"))).toBe(path.indexOf("js"));
    expect(wordRight(path, path.indexOf("src") + 3)).toBe(path.indexOf("cli") + 3);
  });

  it("Option+Backspace deletes back to the start of the word, keeping the rest", () => {
    expect(deleteWordBack(line, line.length)).toEqual({
      text: "fix the flaky login ",
      caret: 20,
    });
    expect(deleteWordForward(line, 0)).toEqual({ text: " the flaky login test", caret: 0 });
  });

  it("ctrl+w deletes back to the previous whitespace, punctuation included", () => {
    const text = "run bun test tests/unit/ui-keys.test.ts";
    expect(deleteSpaceWordBack(text, text.length)).toEqual({ text: "run bun test ", caret: 13 });
    expect(deleteSpaceWordBack("one two   ", 10)).toEqual({ text: "one ", caret: 4 });
  });

  it("moves over emoji as single characters", () => {
    const text = `ok ${ROCKET} go`;
    expect(wordLeft(text, text.length)).toBe(text.length - 2);
    // Readline treats an emoji like punctuation: deleting a word back from just
    // after it takes the gap and the word before it -- and never half of it.
    expect(deleteWordBack(text, text.length - 3)).toEqual({ text: " go", caret: 0 });
    expect(deleteBack(text, text.length - 3)).toEqual({ text: "ok  go", caret: 3 });
  });
});
