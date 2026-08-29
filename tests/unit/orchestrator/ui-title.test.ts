/**
 * The pane title.
 *
 * This is the only moving thing Warp will render for Gear — it badges agent
 * panes, and it decides what an agent pane is from a list `gear` is not on. So
 * the assertions here are about the two ways a title can quietly stop being
 * worth anything: it stops moving when work is happening, or it goes on moving
 * when work has stopped.
 */

import { describe, expect, test } from "bun:test";
import {
  titleText,
  titleSeq,
  type TitleState,
} from "../../../packages/orchestrator/src/bin/ui/title";

const working = (frame: number, quietMs = 0): TitleState => ({ kind: "working", frame, quietMs });

describe("what the tab says", () => {
  test("the mark leads, because a vertical tab truncates from the right", () => {
    // The one character that has to survive the ellipsis is the one that moves.
    for (let f = 0; f < 4; f++) {
      expect(titleText(working(f), "Alan").slice(1)).toStartWith(" Gear");
    }
  });

  test("consecutive frames differ, or there is no animation", () => {
    const seen = new Set<string>();
    for (let f = 0; f < 4; f++) seen.add(titleText(working(f), "Alan")[0]!);
    expect(seen.size).toBe(4);
  });

  test("the cycle wraps rather than running off the end", () => {
    expect(titleText(working(4), "Alan")).toBe(titleText(working(0), "Alan"));
    expect(titleText(working(-1), "Alan")).toBe(titleText(working(3), "Alan"));
  });

  test("a stalled turn stops the mark and says so in words", () => {
    // The whole argument of pulse.ts, carried onto the tab: a glyph that keeps
    // turning through a wedged tool call is worse than a tab that says nothing.
    const stalled = titleText(working(3, 31_000), "Alan");
    expect(stalled).toContain("quiet 31s");
    expect(stalled[0]).toBe(".");
    // and it is the same however many frames have gone by
    expect(titleText(working(99, 31_000), "Alan")).toBe(stalled);
  });

  test("ragged gaps below the threshold still animate", () => {
    expect(titleText(working(2, 3_999), "Alan")).not.toContain("quiet");
  });

  test("waiting on a person is stated, not implied by a stopped spinner", () => {
    expect(titleText({ kind: "waiting" }, "Alan")).toBe("? Gear - waiting for you");
  });

  test("idle carries the project, and nothing that suggests work", () => {
    expect(titleText({ kind: "idle" }, "Alan")).toBe("Gear - Alan");
    expect(titleText({ kind: "idle" }, "")).toBe("Gear");
  });

  test("every title is ASCII -- another program's font draws this, not our grid", () => {
    // Same argument as the clip in ./warp.ts. A tab strip is not the terminal
    // grid, so the one-cell glyph budget does not govern it -- but it must
    // render in any UI font, on any platform, which ASCII always does.
    const states: TitleState[] = [
      { kind: "idle" },
      { kind: "waiting" },
      working(0),
      working(2, 31_000),
    ];
    for (const st of states) {
      // eslint-disable-next-line no-control-regex
      expect(titleText(st, "Alan")).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("the wire format", () => {
  test("is OSC 0, BEL-terminated", () => {
    const seq = titleSeq("Gear - Alan");
    expect(seq.startsWith("\x1b]0;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
  });

  test("a title can never terminate its own sequence", () => {
    // Project names come off the filesystem, so a control character is reachable
    // here. Unlike warp.ts there is no JSON layer to neutralise one.
    const seq = titleSeq("Gear \x07 \x1b]0;evil");
    expect(seq.split("\x07")).toHaveLength(2); // exactly one, the terminator
    expect(seq).not.toContain("\x1b]0;evil");
  });

  test("clearing hands the tab back rather than naming it something else", () => {
    expect(titleSeq("")).toBe("\x1b]0;\x07");
  });
});
