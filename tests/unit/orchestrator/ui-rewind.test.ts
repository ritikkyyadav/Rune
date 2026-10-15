/**
 * `/rewind`'s two decisions (R5.1): what the person asked for, and which
 * files a listed turn wrote.
 */

import { describe, expect, test } from "bun:test";
import { filesFromTurns, parseRewindArg } from "../../../packages/orchestrator/src/bin/ui/rewind";

describe("parseRewindArg", () => {
  test("a turn alone rewinds the conversation, as /rewind <n> always did", () => {
    expect(parseRewindArg("2", 3)).toEqual({ n: 2, mode: "chat" });
  });

  test("code, files, both, all, chat and conversation", () => {
    expect(parseRewindArg("2 code", 3)?.mode).toBe("code");
    expect(parseRewindArg("2 files", 3)?.mode).toBe("code");
    expect(parseRewindArg("2 both", 3)?.mode).toBe("both");
    expect(parseRewindArg("2 ALL", 3)?.mode).toBe("both");
    expect(parseRewindArg("2 chat", 3)?.mode).toBe("chat");
    expect(parseRewindArg("2 conversation", 3)?.mode).toBe("chat");
  });

  test("anything else lists the turns instead of guessing", () => {
    for (const bad of ["", "0", "4", "two", "2 everything", "-1", "1.5"]) {
      expect(parseRewindArg(bad, 3)).toBeNull();
    }
  });
});

describe("filesFromTurns", () => {
  const turns = [{ seq: 10 }, { seq: 30 }, { seq: 50 }];
  const written = new Map<number, string[]>([
    [10, ["a.ts"]],
    // A loop iteration after turn 1, before turn 2: turn 1's.
    [20, ["b.ts", "a.ts"]],
    [30, ["c.ts"]],
    [55, ["d.ts"]],
  ]);

  test("a turn owns the harness-led turns before the next listed one", () => {
    expect(filesFromTurns(turns, written, 0).sort()).toEqual(["a.ts", "b.ts"]);
    expect(filesFromTurns(turns, written, 1)).toEqual(["c.ts"]);
    expect(filesFromTurns(turns, written, 2)).toEqual(["d.ts"]);
  });

  test("a range covers every turn from the first on", () => {
    expect(filesFromTurns(turns, written, 1, 2).sort()).toEqual(["c.ts", "d.ts"]);
    expect(filesFromTurns(turns, written, 0, 2)).toHaveLength(4);
  });

  test("a turn with no tracked writes has none", () => {
    expect(filesFromTurns([{ seq: 60 }], written, 0)).toEqual([]);
  });
});
