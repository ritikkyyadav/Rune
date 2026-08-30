/**
 * The frame, checked on BOTH edges.
 *
 * Every rule in this UI used to start at column 0 while every line of content
 * started at column 2, so each hairline overhung its own block by two
 * characters on the left. The right edges agreed, which is why four rounds of
 * measuring the right edge found nothing. It was invisible while rules were
 * repeated dashes — a dashed line's ragged start reads as texture — and became
 * obvious the moment they were drawn as continuous hairlines.
 *
 * These tests measure where lines BEGIN. Nothing else here does.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { renderBanner } from "../../../packages/orchestrator/src/bin/ui/banner";
import { renderComposer, statusLine } from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride } from "../../../packages/orchestrator/src/bin/ui/render";
import * as os from "os";

const WORKSPACE = `${os.homedir()}/Projects/sample-app`;

// setTermWidthOverride and process.stdout.columns are global module state.
// Leaving either set leaks a 400-column terminal into every file that runs
// after this one — which is exactly how this file broke ui-clamp while passing
// on its own.
const REAL_COLUMNS = process.stdout.columns;
afterEach(() => {
  setTermWidthOverride(null);
  Object.defineProperty(process.stdout, "columns", {
    value: REAL_COLUMNS,
    configurable: true,
  });
});

/** Every line the product paints on a fresh launch, in order. */
function launchFrame(columns: number): string[] {
  setTermWidthOverride(columns);
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  const banner = renderBanner({
    model: "claude-sonnet-4-6",
    version: "0.3.0",
    workspace: WORKSPACE,
    branch: "main",
    dirtyFiles: 0,
    scope: "3rd gear",
  } as any);
  const status = statusLine({ mode: "gear-3" } as any, columns);
  const composer = renderComposer({ input: "", caret: 0, width: columns, status } as any);
  return [...banner.split("\n"), ...composer.lines]
    .map(stripAnsi)
    .filter((l) => l.trim().length > 0);
}

const startsAt = (line: string): number => line.length - line.trimStart().length;

describe("the launch frame", () => {
  it("every painted line begins in the same column", () => {
    for (const columns of [60, 80, 100, 145, 165, 220]) {
      const lines = launchFrame(columns);
      const columnsUsed = new Set(lines.map(startsAt));
      expect([...columnsUsed], `at ${columns} cols`).toEqual([2]);
    }
  });

  it("every painted line ends in the same column", () => {
    for (const columns of [60, 80, 100, 145, 165, 220]) {
      const lines = launchFrame(columns);
      const widths = new Set(lines.map((l) => l.length));
      expect(widths.size, `at ${columns} cols: ${[...widths]}`).toBe(1);
    }
  });

  it("a rule is exactly as wide as the row it divides", () => {
    for (const columns of [80, 145]) {
      const lines = launchFrame(columns);
      // The masthead's rule is two weights — heavy under the chip, hairline
      // for the rest of the window — so a rule is any line made only of the
      // alphabet's horizontals.
      const isRule = (line: string) => /^\s*[━─]+$/.test(line);
      const rules = lines.filter(isRule);
      const content = lines.filter((line) => !isRule(line));
      expect(rules.length).toBeGreaterThanOrEqual(3); // header + field top + field bottom
      for (const r of rules) {
        expect(startsAt(r)).toBe(2);
        expect(r.length).toBe(content[0]!.length);
      }
    }
  });

  it("the field is closed, and the rules above and below it are identical", () => {
    const lines = launchFrame(100);
    const i = lines.findIndex((l) => l.includes("describe a change"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toMatch(/^\s*─+$/); // a rule above the input
    expect(lines[i + 1]).toMatch(/^\s*─+$/); // and one below
    expect(lines[i - 1]).toBe(lines[i + 1]!);
  });

  it("the header's rule never lands on the row above the field's", () => {
    // A fresh session has no transcript between them; the field owns a blank
    // line above itself so the two rules cannot become a doubled border.
    setTermWidthOverride(100);
    Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
    const status = statusLine({ mode: "gear-3" } as any, 100);
    const composer = renderComposer({ input: "", caret: 0, width: 100, status } as any);
    expect(stripAnsi(composer.lines[0]!).trim()).toBe("");
  });
});

describe("full-screen behaviour", () => {
  // At 80 columns the three widths land within five of each other, so a
  // mismatch between them is invisible. At 241 it is the whole screen: this is
  // the only place it can be caught.
  const F = require("../../../packages/orchestrator/src/bin/ui/flow");

  it("structural width follows the terminal — no fixed ceiling", () => {
    for (const columns of [80, 145, 241, 400]) {
      setTermWidthOverride(columns);
      // A row must be able to reach the window. A ceiling here truncates paths
      // and diffs while half the screen sits empty, which is worse than a
      // receipt sitting further right.
      expect(F.measure(), `at ${columns}`).toBeGreaterThanOrEqual(Math.min(columns - 2, 200));
      expect(F.measure()).toBeLessThanOrEqual(F.surfaceWidth());
    }
  });

  it("prose shares the frame's measure — it does not stop halfway", () => {
    for (const columns of [80, 145, 241, 400]) {
      setTermWidthOverride(columns);
      // Prose is the measure less the body indent, so a sentence ends flush
      // with the hairline above it and the rails below it.
      //
      // This used to assert the opposite: a hard ceiling of 88, defended as
      // "the one width that SHOULD stop early". The defence was sound
      // typography and the wrong rule for this surface, because prose was the
      // ONLY thing it bound. measure() had already given up its ceiling, so on
      // a 200-column window the header, the composer, the rails and every
      // receipt ran to the edge while the sentences inside them stopped at 84.
      // Half the window sat empty, all of it on one side — reported as "the
      // screen is divided into half". A reading measure nothing else obeys is
      // not a measure, it is a pane that failed to fill.
      expect(F.proseWidth(), `at ${columns}`).toBe(F.measure() - F.BODY.length);
    }
  });

  it("a turn's blocks all end inside the measure, and all reach it", () => {
    const { userBlock, responseBlock } = require("../../../packages/orchestrator/src/bin/ui/turn");
    const SENTENCE =
      "I set up the auto mode as the proper fourth gear autonomy, but there is one specific issue in it: even in fourth gear the agent still stops to ask about permissions, and what I wanted was for the classifier to sit on top as a watchdog instead. ";
    const PARAGRAPH = SENTENCE.repeat(6);
    const ANSWER = [
      PARAGRAPH,
      "",
      "- a bullet whose text is long enough to wrap at every width tested here, which is the case that used to run past the right edge",
      "",
      "1. an ordered item, likewise long enough to wrap, because its marker is wider than a bullet's and is charged to the same budget",
      "",
      "```ts",
      "const broker = new ContainmentBroker({ sandbox: true });",
      "```",
    ].join("\n");

    for (const columns of [60, 80, 145, 190, 241, 400]) {
      setTermWidthOverride(columns);
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
      for (const [name, block] of [
        ["asked", userBlock(PARAGRAPH)],
        ["answered", responseBlock(ANSWER)],
      ] as Array<[string, string]>) {
        const widths = stripAnsi(block)
          .split("\n")
          .map((l) => l.length)
          .filter((n) => n > 0);
        const widest = Math.max(...widths);
        // Never past the measure. A line that reaches the terminal's last cell
        // soft-wraps, and a soft wrap desyncs the pinned composer's cursor
        // math — which is how the list marker's unbudgeted width showed up
        // once the ceiling stopped hiding it.
        expect(widest, `${name} at ${columns}`).toBeLessThanOrEqual(F.measure());
        // And never far short of it. This is the half-drawn screen, as a
        // number: the gap here was 114 columns before prose joined the measure.
        expect(widest, `${name} at ${columns}`).toBeGreaterThan(F.measure() - 16);
      }
    }
  });

  it("the frame still closes on both edges at full screen", () => {
    for (const columns of [241, 400]) {
      const lines = launchFrame(columns);
      expect(new Set(lines.map(startsAt))).toEqual(new Set([2]));
      expect(new Set(lines.map((l) => l.length)).size).toBe(1);
    }
  });
});

describe("holding the field at the bottom", () => {
  const { holdOpenRows } = require("../../../packages/orchestrator/src/bin/ui/tui");

  it("holds the window open on a fresh session", () => {
    // 30-row window, banner has printed 3 rows, the field block is 5 rows.
    expect(holdOpenRows(30, 3, 5)).toBe(21);
    expect(3 + 21 + 5).toBe(29); // …and one row spare, never the last cell
  });

  it("gives the space back exactly as fast as output takes it", () => {
    // The field must not move as the transcript grows: every row printed is
    // one row of padding surrendered.
    let last = holdOpenRows(30, 3, 5);
    for (let printed = 4; printed <= 24; printed++) {
      const now = holdOpenRows(30, printed, 5);
      expect(now).toBe(last - 1);
      last = now;
    }
  });

  it("stops holding once the session has filled the window", () => {
    expect(holdOpenRows(30, 24, 5)).toBe(0);
    expect(holdOpenRows(30, 500, 5)).toBe(0); // and never goes negative
  });

  it("REGRESSION: /clear must reset the count, or the bar collapses upward", () => {
    // The bug: printedRows only ever counts up, so after a long session it sat
    // well past the viewport. /clear wiped the screen but left the count, so
    // the padding computed zero against an empty window and the field jumped
    // up under the banner with the bottom of the screen left blank.
    const afterLongSession = holdOpenRows(30, 200, 5);
    expect(afterLongSession).toBe(0); // correct while the output is still there

    // resetTranscript sets printedRows = 0, then printBanner re-counts its
    // own rows. The field must return to the bottom.
    const afterClear = holdOpenRows(30, 3, 5);
    expect(afterClear).toBe(21);
    expect(afterClear).toBeGreaterThan(afterLongSession);
  });

  it("follows a resize in both directions", () => {
    expect(holdOpenRows(50, 3, 5)).toBe(41); // taller window, more held open
    expect(holdOpenRows(12, 3, 5)).toBe(3); // shorter window, less
    expect(holdOpenRows(6, 3, 5)).toBe(0); // no room at all: hold nothing
  });
});
