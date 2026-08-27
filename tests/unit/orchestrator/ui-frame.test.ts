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
      const rules = lines.filter((l) => /^\s*─+$/.test(l));
      const content = lines.filter((l) => !/^\s*─+$/.test(l));
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

  it("prose keeps a reading limit however wide the window gets", () => {
    for (const columns of [145, 241, 400]) {
      setTermWidthOverride(columns);
      // The one width that SHOULD stop early. A 240-character sentence is not
      // a use of the space, it is a failure to have a measure.
      expect(F.proseWidth(), `at ${columns}`).toBeLessThanOrEqual(88);
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
