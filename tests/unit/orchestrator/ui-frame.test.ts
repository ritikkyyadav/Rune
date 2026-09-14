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
import {
  renderComposer,
  statusLine,
  composerTextWidth,
} from "../../../packages/orchestrator/src/bin/ui/composer";
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

/**
 * Every line the product paints on a fresh launch, split by which edge it
 * answers to.
 *
 * There are two, and the design says so: the header is the FRAME's chrome and
 * runs to the last cell of the measure it is handed, while everything inside
 * the frame — a box, the status strip, the composer's rules — is inset by MARK
 * on both sides. At 80 columns `80x24-idle.txt` ends the header rule at column
 * 79 and every row under it at column 77, and that two-cell step is the visible
 * difference between the window's divider and a block's own.
 */
function launchParts(columns: number): { chrome: string[]; block: string[] } {
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
  const keep = (lines: string[]) => lines.map(stripAnsi).filter((l) => l.trim().length > 0);
  return { chrome: keep(banner.split("\n")), block: keep(composer.lines) };
}

/** Every line the product paints on a fresh launch, in order. */
function launchFrame(columns: number): string[] {
  const { chrome, block } = launchParts(columns);
  return [...chrome, ...block];
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

  it("every painted line ends on the edge its region answers to", () => {
    // Two edges, and exactly two. The header spans the measure it is handed;
    // everything inside the frame stops MARK short of it on the right, the
    // same two cells it is inset by on the left. Anything that lands between
    // those two numbers is a third edge nobody chose.
    for (const columns of [60, 80, 100, 145, 165, 220]) {
      const { chrome, block } = launchParts(columns);
      const chromeWidths = new Set(chrome.map((l) => l.length));
      expect([...chromeWidths], `chrome at ${columns} cols`).toEqual([columns]);
      const blockWidths = new Set(block.filter((l) => /[━─]/.test(l)).map((l) => l.length));
      expect([...blockWidths], `block rules at ${columns} cols`).toEqual([columns - 2]);
      for (const line of [...chrome, ...block]) {
        expect(line.length, `at ${columns} cols: ${line}`).toBeLessThanOrEqual(columns);
      }
    }
  });

  it("a rule is exactly as wide as the row it divides", () => {
    for (const columns of [80, 145]) {
      // The masthead's rule is two weights — heavy under the chip, hairline
      // for the rest of the window — so a rule is any line made only of the
      // alphabet's horizontals.
      const isRule = (line: string) => /^\s*[━─]+$/.test(line);
      const { chrome, block } = launchParts(columns);
      for (const [name, lines] of [
        ["chrome", chrome],
        ["block", block],
      ] as const) {
        const rules = lines.filter(isRule);
        const content = lines.filter((line) => !isRule(line));
        expect(rules.length, name).toBeGreaterThanOrEqual(name === "chrome" ? 1 : 2);
        for (const r of rules) {
          expect(startsAt(r)).toBe(2);
          expect(r.length, `${name} rule at ${columns}`).toBe(content[0]!.length);
        }
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
      const { chrome, block } = launchParts(columns);
      expect(new Set([...chrome, ...block].map(startsAt))).toEqual(new Set([2]));
      // Still two edges at 400 columns, and still exactly two cells apart: the
      // inset is a constant, not a share of the window, so it does not grow
      // into a margin wide enough to read as an unfinished screen.
      expect(new Set(chrome.map((l) => l.length))).toEqual(new Set([columns]));
      const rules = block.filter((l) => /^\s*[━─]+$/.test(l));
      expect(new Set(rules.map((l) => l.length))).toEqual(new Set([columns - 2]));
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

// ─── The four-region frame ───
//
// Three zones became four regions: a full-width header, a band split into the
// workspace and a fixed 40-cell right column, and a full-width status strip.
// Everything below measures the split itself -- where the divider lands, what
// each region is allowed, and what the frame does when the window is too small
// to be told the truth in.

const V = require("../../../packages/orchestrator/src/bin/ui/viewport");

/** The sizes named in the design, plus the two either side of the collapse. */
const SIZES: Array<[number, number]> = [
  [160, 50],
  [120, 40],
  [100, 30],
  [99, 30],
  [80, 24],
];

const regionsAt = (columns: number, rows: number, composerRows?: number) =>
  V.regions({ columns, rows, headerRows: 3, composerRows, strip: true });

describe("the band", () => {
  it("puts the divider one column left of the fixed right column", () => {
    // 120 -> usable 119, workspace 78, divider 79, right 80..119. The last
    // cell of the window stays empty at every width: a row that reaches it
    // wraps, and one wrap desyncs every row below for the rest of the session.
    const expected: Record<number, [number, number, number]> = {
      // columns: [usable, workspace, divider]
      160: [159, 118, 119],
      120: [119, 78, 79],
      100: [99, 58, 59],
    };
    for (const [columns, [usable, workspace, divider]] of Object.entries(expected).map(
      ([c, v]) => [Number(c), v] as [number, [number, number, number]],
    )) {
      const r = regionsAt(columns, 40);
      expect(r.usable, `usable at ${columns}`).toBe(usable);
      expect(r.workspaceCols, `workspace at ${columns}`).toBe(workspace);
      expect(r.dividerCol, `divider at ${columns}`).toBe(divider);
      expect(r.panelCols, `panel at ${columns}`).toBe(40);
      // workspace + divider + panel is the whole usable width, exactly.
      expect(r.workspaceCols + 1 + r.panelCols).toBe(r.usable);
    }
  });

  it("the right column is FIXED, so the workspace measure only moves with the window", () => {
    for (const [columns] of SIZES) {
      const r = regionsAt(columns, 40);
      if (r.collapsed) continue;
      expect(r.panelCols, `at ${columns}`).toBe(V.PANEL_COLS);
    }
  });

  it("collapses below 100 columns and not at 100", () => {
    expect(regionsAt(100, 30).collapsed).toBe(false);
    expect(regionsAt(99, 30).collapsed).toBe(true);
    // Collapsed: no divider, no right column, the workspace spans the window.
    const narrow = regionsAt(80, 24);
    expect(narrow.dividerCol).toBe(0);
    expect(narrow.panelCols).toBe(0);
    expect(narrow.workspaceCols).toBe(79);
    // …and it spends exactly one row on the agents strip.
    expect(narrow.stripRows).toBe(1);
  });

  it("the rows add up to the window, at every size", () => {
    for (const [columns, rows] of SIZES) {
      const r = regionsAt(columns, rows);
      expect(r.headerRows + r.bandRows + 1, `${columns}x${rows}`).toBe(rows);
      expect(r.bandTop).toBe(3);
      expect(r.statusTop).toBe(rows - 1);
      if (r.collapsed) {
        // The strip and the composer come out of the left column.
        expect(r.workspaceRows + r.stripRows + r.composerRows).toBe(r.bandRows);
      } else {
        // The workspace is the whole band; the panel and composer share the
        // right column.
        expect(r.workspaceRows).toBe(r.bandRows);
        expect(r.panelRows + r.composerRows).toBe(r.bandRows);
      }
    }
  });
});

describe("the composer grows into the panel, never into the workspace", () => {
  it("takes its rows from the panel", () => {
    const band = regionsAt(120, 40).bandRows;
    let lastPanel = Infinity;
    for (let want = 4; want <= 21; want++) {
      const r = regionsAt(120, 40, want);
      expect(r.composerRows, `want ${want}`).toBe(want);
      // The workspace does not move. This is the whole reason the yielding
      // order is stated: a transcript that re-lays itself while you type is
      // what made the old footer feel like it was sliding.
      expect(r.workspaceRows, `want ${want}`).toBe(band);
      expect(r.panelRows).toBe(band - want);
      expect(r.panelRows).toBeLessThan(lastPanel);
      lastPanel = r.panelRows;
    }
  });

  it("stops at the cap, and the panel keeps its floor", () => {
    const r = regionsAt(120, 40, 200);
    expect(r.composerRows).toBe(21); // floor(36 * 0.6)
    expect(r.panelRows).toBe(15);
    expect(r.panelRows).toBeGreaterThanOrEqual(V.PANEL_MIN_ROWS);
    expect(regionsAt(120, 40, 0).composerRows).toBe(V.COMPOSER_MIN_ROWS);
  });

  it("never lets the workspace fall to nothing when collapsed", () => {
    for (let want = 4; want <= 40; want++) {
      const r = regionsAt(80, 24, want);
      expect(r.workspaceRows, `want ${want}`).toBeGreaterThanOrEqual(1);
      expect(r.workspaceRows + r.stripRows + r.composerRows).toBe(r.bandRows);
    }
  });

  // Promoted from tests/verification/v4-laneA-collapsed-composer-eats-workspace.test.ts
  // (V-4 Lane A). Below PANEL_MIN_COLS there is no panel for growth to come out
  // of -- the strip takes its place -- so a composer asking for more rows had
  // nowhere to take them from but the workspace, which is exactly the "the
  // whole window slides while you type" defect the fixed frame exists to
  // remove. Confirmed end to end with a real pty capture at 80x24: typing an
  // ordinary multi-sentence message visibly pushed the composer's top rule
  // from row 20 to row 12 as the field grew.
  it("collapsed, the composer never grows past its resting height -- the workspace stays put", () => {
    const seen = new Set<number>();
    for (let want = V.COMPOSER_MIN_ROWS; want <= 16; want++) {
      const r = regionsAt(80, 24, want);
      expect(r.collapsed, `want ${want}`).toBe(true);
      seen.add(r.workspaceRows);
    }
    expect(seen.size).toBe(1);
  });

  it("a typed draft growing from 4 to 12 rows at 80x24 does not take even one row from the workspace", () => {
    const atRest = regionsAt(80, 24, V.COMPOSER_MIN_ROWS);
    const grown = regionsAt(80, 24, 12);
    expect(grown.workspaceRows).toBe(atRest.workspaceRows);
    expect(grown.composerRows).toBe(atRest.composerRows);
  });

  it("the same collapse holds at every narrow width, not just 80 columns", () => {
    for (const columns of [99, 61, 60]) {
      const rows = columns === 60 ? 16 : 24;
      const atRest = regionsAt(columns, rows, V.COMPOSER_MIN_ROWS);
      const grown = regionsAt(columns, rows, 999);
      expect(atRest.collapsed, `${columns}`).toBe(true);
      expect(grown.workspaceRows, `${columns}`).toBe(atRest.workspaceRows);
    }
  });

  // The other half of the same trade. Holding the REGION at its resting height
  // is what keeps the workspace still; it must not also be what the composer is
  // allowed to DRAW, or a collapsed window gets a one-row field and no `/`
  // palette at all -- the first attempt at the fix above did exactly that, and
  // a real 80x24 pty capture showed a three-line draft rendered as its last
  // line only. The extra rows are taken by covering the workspace's bottom
  // rows, which moves nothing above them.
  it("collapsed, the composer may still PAINT a draft and a palette", () => {
    const r = regionsAt(80, 24, V.COMPOSER_MIN_ROWS);
    expect(r.collapsed).toBe(true);
    // At rest it paints exactly its region, so nothing is covered.
    expect(V.composerPaintRows(r, V.COMPOSER_MIN_ROWS)).toBe(r.composerRows);
    // A 12-row block (an 8-row palette over the field's four chrome rows) is
    // painted whole: the ceiling at this size is well above the resting height.
    expect(V.composerPaintRows(r, 12)).toBe(12);
    // And it is bounded: the workspace keeps rows, whatever is asked for.
    const most = V.composerPaintRows(r, 999);
    expect(most).toBeLessThanOrEqual(r.bandRows - r.stripRows - V.WORKSPACE_MIN_ROWS);
    expect(most).toBeGreaterThanOrEqual(V.COMPOSER_MIN_ROWS + 6);
  });

  it("with a panel there is nothing to cover: the paint is the region", () => {
    for (let want = 4; want <= 40; want++) {
      const r = regionsAt(120, 40, want);
      expect(V.composerPaintRows(r, want), `want ${want}`).toBe(r.composerRows);
    }
  });
});

// Promoted from tests/verification/v4-laneA-caret-off-composer-with-palette.test.ts
// (V-4 Lane A, A12). At 80x24 with the `/` palette open, the hardware caret sat
// on the blank rule BELOW the field while the typed `› /` was one row above it
// -- read from a real terminal emulator's own cursor state, and independently
// recorded by an earlier verification pass at commit b5aef39, so it had
// survived every Phase 4 lane unnoticed.
//
// The cause was not the palette's height, as that audit guessed. The composer
// block is bottom-aligned and keeps its TAIL when it does not fit, but the
// caret's row was divided by `regions().composerRows` -- the region -- instead
// of by the rows actually painted, and with a clip it was not moved up by the
// rows cut off the front either. The pty probe that found it is kept as a rig
// script (`scripts/tui-capture/caret-probe.py`); what it measures is this
// arithmetic, which is pinned here where it costs no process.
describe("the caret is on the row that holds the field", () => {
  it("a block painted whole puts the caret on its own row, not the region's", () => {
    const r = regionsAt(80, 24, V.COMPOSER_MIN_ROWS);
    const block = 12; // an 8-row palette above the field's four chrome rows
    const caretInBlock = block - 3; // the field row: palette, rule, FIELD, rule, hint
    const paint = V.composerPaintRows(r, block);
    expect(paint).toBe(block); // nothing clipped, so nothing to compensate

    // Bottom-aligned: the block's last row is the band's last row.
    const fieldRow = r.bandTop + r.bandRows - block + caretInBlock;
    expect(V.composerCaretRow(r, block, caretInBlock, paint)).toBe(fieldRow);
    // The bug, stated: dividing by the region put the caret three rows lower,
    // on a rule with nothing of the user's on it.
    expect(r.bandTop + r.bandRows - r.composerRows + caretInBlock).not.toBe(fieldRow);
  });

  it("a block too tall for the band keeps its tail, and the caret follows the clip", () => {
    const r = regionsAt(80, 24, V.COMPOSER_MIN_ROWS);
    const block = 40; // far past anything this window can paint
    const paint = V.composerPaintRows(r, block);
    expect(paint).toBeLessThan(block);
    const drop = block - paint;
    // A caret on the block's last row stays on the band's last row.
    expect(V.composerCaretRow(r, block, block - 1, paint)).toBe(r.bandTop + r.bandRows - 1);
    // A caret on a row that was cut off the front clamps to the top of what is
    // painted rather than pointing above the band.
    expect(V.composerCaretRow(r, block, drop - 1, paint)).toBe(r.bandTop + r.bandRows - paint);
  });
});

describe("bandComposer's collapsed text width keeps the wide branch's own margin", () => {
  // No pre-existing DEFECT test pinned this one (V-4 Lane C, item C1): the
  // verifier found it by direct execution, not by a written repro. bandComposer
  // (tui-frame.ts) sets two widths for the same composer -- an outer "surface"
  // measure (what F.surfaceWidth() reads, via atWidth) and an inner field
  // `width` (composerTextWidth's own argument) -- and the wide branch always
  // keeps the outer one cell WIDER than the inner (`PANEL_COLS + 2` vs
  // `PANEL_COLS + 1`), because `surfaceWidth()` itself subtracts `MARK.length`.
  // The collapsed branch fed `atWidth` the exact same number as the field
  // width, so `composerTextWidth` came out 73 at 80 columns instead of 74 --
  // undercounted by the one cell the margin expects, at every narrow size.
  afterEach(() => setTermWidthOverride(null));

  it("at 80 columns (contentCols 79), the field gets 74 text columns, not 73", () => {
    const contentCols = 79; // Tui.contentCols() at 80 real terminal columns
    setTermWidthOverride(contentCols + 1); // bandComposer's collapsed atWidth call
    expect(composerTextWidth(contentCols)).toBe(74);
  });

  it("documents the bug this fixed: outer === inner undercounts by exactly one column", () => {
    const contentCols = 79;
    setTermWidthOverride(contentCols); // the pre-fix collapsed atWidth call
    expect(composerTextWidth(contentCols)).toBe(73);
  });
});

describe("the workspace split", () => {
  it("gives the main pane 14 rows, the seam 1 and the child the rest at 120x40", () => {
    const r = regionsAt(120, 40);
    const panes = V.splitPanes(r.workspaceRows, true);
    expect([panes.mainRows, panes.headerRows, panes.childRows]).toEqual([14, 1, 21]);
    expect(panes.mainRows + panes.headerRows + panes.childRows).toBe(r.workspaceRows);
  });

  it("closed, the main pane is the whole workspace", () => {
    const r = regionsAt(120, 40);
    const panes = V.splitPanes(r.workspaceRows, false);
    expect(panes.open).toBe(false);
    expect(panes.mainRows).toBe(r.workspaceRows);
    expect(panes.childRows).toBe(0);
  });

  it("refuses rather than showing two slivers", () => {
    const panes = V.splitPanes(V.SPLIT_MIN_ROWS - 1, true);
    expect(panes.open).toBe(false);
    expect(panes.refused).toBe(true);
    expect(panes.childRows).toBe(0);
    expect(panes.headerRows).toBe(1); // one row saying why
    expect(V.splitPanes(V.SPLIT_MIN_ROWS, true).open).toBe(true);
  });
});

describe("too small to be told the truth in", () => {
  it("refuses at 59x16 and 60x15, and draws at 60x16", () => {
    expect(regionsAt(59, 16).refused).toBe(true);
    expect(regionsAt(60, 15).refused).toBe(true);
    expect(regionsAt(60, 16).refused).toBe(false);
  });

  it("says the size it needs, the size it has, and the way out", () => {
    const block = V.refusalRows(44, 12);
    expect(block).toHaveLength(3);
    expect(block[0]).toBe("R U N E");
    expect(block[1]).toContain("60x16");
    expect(block[1]).toContain("44x12");
    expect(block[2]).toContain("--inline");
    // Every row fits the window it is refusing to draw in -- a refusal that
    // overhangs is the bug it exists to avoid.
    for (const row of block) expect(row.length).toBeLessThanOrEqual(44 - 4);
  });
});

describe("composeBand", () => {
  const w = (s: string) => stripAnsi(s).length;

  it("pads the left column to the divider and never pads past it", () => {
    const r = regionsAt(120, 40, 4);
    const rows = V.composeBand({
      regions: r,
      left: ["  hello"],
      right: [" AGENTS"],
      divider: "│",
      width: w,
    });
    expect(rows).toHaveLength(r.bandRows);
    expect(rows[0]!.indexOf("│")).toBe(r.dividerCol - 1); // 0-based
    expect(w(rows[0]!)).toBe(r.dividerCol + w(" AGENTS"));
    // A row neither column claims is the divider and nothing else -- no
    // trailing spaces, because the painter erases to end of line and asserting
    // them would paint a background the terminal never asked for.
    expect(w(rows[1]!)).toBe(r.dividerCol);
    expect(rows[1]!.trimEnd()).toBe(rows[1]);
  });

  it("collapsed, there is no divider at all", () => {
    const r = regionsAt(80, 24, 4);
    const rows = V.composeBand({
      regions: r,
      left: ["  hello"],
      right: [],
      divider: "│",
      width: w,
    });
    expect(rows).toHaveLength(r.bandRows);
    expect(rows[0]).toBe("  hello");
    expect(rows.join("")).not.toContain("│");
  });

  it("no band row overhangs the usable width", () => {
    for (const [columns, rows] of SIZES) {
      const r = regionsAt(columns, rows, 4);
      const band = V.composeBand({
        regions: r,
        left: Array.from({ length: r.bandRows }, () => "x".repeat(r.workspaceCols)),
        right: Array.from({ length: r.bandRows }, () => "y".repeat(r.panelCols)),
        divider: "│",
        width: w,
      });
      for (const row of band) {
        expect(w(row), `${columns}x${rows}`).toBeLessThanOrEqual(r.usable);
      }
    }
  });
});

describe("composeFrame with a band", () => {
  const w = (s: string) => stripAnsi(s).length;

  it("keeps the header on top and the status strip on the last row", () => {
    const r = regionsAt(120, 40, 4);
    const frame = V.composeFrame({
      rows: 40,
      header: ["", "  R U N E", "  ───"],
      transcript: ["ignored"],
      footer: ["  ◆ 1st gear"],
      scroll: 0,
      caretRow: 36,
      caretCol: 82,
      band: {
        regions: r,
        left: ["  first"],
        right: [" AGENTS"],
        divider: "│",
        width: w,
      },
    });
    expect(frame.rows).toHaveLength(40);
    expect(frame.rows[1]).toBe("  R U N E");
    expect(frame.rows[3]).toContain("first");
    expect(frame.rows[39]).toBe("  ◆ 1st gear");
    // The caret is absolute in this mode: the composer is inside the band, not
    // in the footer, so there is no trimming for it to be measured against.
    expect(frame.caretRow).toBe(36);
    expect(frame.caretCol).toBe(82);
  });

  it("the three-zone path is untouched when there is no band", () => {
    const frame = V.composeFrame({
      rows: 10,
      header: ["h1", "h2"],
      transcript: ["a", "b", "c"],
      footer: ["f1"],
      scroll: 0,
      caretRow: 0,
      caretCol: 0,
    });
    expect(frame.rows).toHaveLength(10);
    expect(frame.rows[0]).toBe("h1");
    expect(frame.rows[9]).toBe("f1");
    expect(frame.rows.slice(2)).toContain("c");
  });
});

describe("the focus ring", () => {
  const FRAME = require("../../../packages/orchestrator/src/bin/ui/tui-frame");
  const INPUT = require("../../../packages/orchestrator/src/bin/ui/tui-input");

  /** Enough of a controller for the frame methods, which is all they touch.
   *  They are plain functions on an object -- the whole point of mixing them
   *  onto the prototype rather than closing over a class. */
  function controller(over: Record<string, unknown> = {}) {
    const tui: any = {
      inline: false,
      columns: 120,
      focus: "composer",
      panelOverlay: false,
      childPane: null,
      childScroll: 0,
      scroll: 0,
      input: "",
      mode: "input",
      draws: 0,
      scheduleDraw() {
        this.draws++;
      },
      regionsNow(composerRows?: number) {
        return V.regions({
          columns: this.columns,
          rows: 40,
          headerRows: 3,
          composerRows,
          strip: true,
        });
      },
      cycleFocus: FRAME.FRAME_METHODS.cycleFocus,
      releaseFocus: FRAME.FRAME_METHODS.releaseFocus,
      openChildPane: FRAME.FRAME_METHODS.openChildPane,
      closeChildPane: FRAME.FRAME_METHODS.closeChildPane,
      ctrlKey: INPUT.INPUT_METHODS.ctrlKey,
      ...over,
    };
    return tui;
  }

  it("advances composer -> panel -> workspace -> composer with no split", () => {
    expect(FRAME.focusRing(false)).toEqual(["composer", "panel", "workspace"]);
    const t = controller();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      t.cycleFocus();
      seen.push(t.focus);
    }
    expect(seen).toEqual(["panel", "workspace", "composer", "panel"]);
  });

  it("the child joins the ring only while a split is open", () => {
    expect(FRAME.focusRing(true)).toEqual(["composer", "panel", "workspace", "child"]);
    const t = controller();
    t.openChildPane({ id: "3", name: "verifier", lines: [] });
    expect(t.focus).toBe("child"); // you opened it to read it
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      t.cycleFocus();
      seen.push(t.focus);
    }
    expect(seen).toEqual(["composer", "panel", "workspace", "child"]);
  });

  it("ctrl+f toggles the overlay instead when the column is collapsed", () => {
    const t = controller({ columns: 80 });
    t.cycleFocus();
    expect(t.panelOverlay).toBe(true);
    expect(t.focus).toBe("panel");
    t.cycleFocus();
    expect(t.panelOverlay).toBe(false);
    expect(t.focus).toBe("composer");
  });

  it("esc returns to the composer, and reports whether it consumed the key", () => {
    const t = controller();
    // With the composer focused it consumes nothing: there esc still clears
    // the draft and interrupts, which is the binding people rely on.
    expect(t.releaseFocus()).toBe(false);
    t.cycleFocus();
    expect(t.focus).toBe("panel");
    expect(t.releaseFocus()).toBe(true);
    expect(t.focus).toBe("composer");
    // From the child pane, esc closes the split.
    t.openChildPane({ id: "3", name: "verifier", lines: ["x"] });
    expect(t.releaseFocus()).toBe(true);
    expect(t.childPane).toBeNull();
    // And it closes the overlay first, wherever focus was.
    const narrow = controller({ columns: 80 });
    narrow.cycleFocus();
    expect(narrow.releaseFocus()).toBe(true);
    expect(narrow.panelOverlay).toBe(false);
  });

  it("ctrl+w closes the split from anywhere, and ctrl+f is the ring", () => {
    const t = controller();
    t.openChildPane({ id: "3", name: "verifier", lines: ["x"] });
    t.focus = "composer";
    t.ctrlKey("w");
    expect(t.childPane).toBeNull();
    expect(t.childScroll).toBe(0);
    expect(t.focus).toBe("composer");
    // ctrl+w on a frame with no split is a no-op, not a repaint.
    const before = t.draws;
    t.ctrlKey("w");
    expect(t.draws).toBe(before);
    t.ctrlKey("f");
    expect(t.focus).toBe("panel");
  });
});

// Promoted from tests/verification/v4-laneA-stale-child-header-on-shrink.test.ts
// (V-4 Lane A). `splitPanes`' own doc comment promises "one row saying why
// beats two slivers that can hold nothing" whenever the workspace cannot fit a
// split -- but `childHeader` used to branch on `this.childPane` being
// non-null rather than on the CURRENT geometry (`panes.open`/`panes.refused`),
// so once a child pane had ever been opened, shrinking the window below
// SPLIT_MIN_ROWS left its stale header -- name, note, "ctrl+w close" -- on
// screen with zero body rows under it, and no refusal message at all.
describe("the split's refusal survives a stale child pane", () => {
  const FRAME = require("../../../packages/orchestrator/src/bin/ui/tui-frame");

  function controller(over: Record<string, unknown> = {}) {
    const tui: any = {
      inline: false,
      columns: 120,
      rows: 40,
      focus: "composer",
      panelOverlay: false,
      childPane: null,
      childScroll: 0,
      scroll: 0,
      input: "",
      mode: "input",
      draws: 0,
      scheduleDraw() {
        this.draws++;
      },
      regionsNow(composerRows?: number) {
        return V.regions({
          columns: this.columns,
          rows: this.rows,
          headerRows: 3,
          composerRows,
          strip: true,
        });
      },
      openChildPane: FRAME.FRAME_METHODS.openChildPane,
      closeChildPane: FRAME.FRAME_METHODS.closeChildPane,
      panesNow: FRAME.FRAME_METHODS.panesNow,
      childHeader: FRAME.FRAME_METHODS.childHeader,
      ...over,
    };
    return tui;
  }

  it("shrinking below SPLIT_MIN_ROWS shows the refusal row, not the old child's header", () => {
    const t = controller();
    t.openChildPane({ id: "3", name: "verifier", lines: ["x"], note: "running 48s" });

    // Shrink to a window whose workspace cannot hold a split.
    t.columns = 80;
    t.rows = 16;
    const r = t.regionsNow(4);
    const panes = t.panesNow(r.workspaceRows);

    expect(panes.open).toBe(false);
    expect(panes.refused).toBe(true);
    expect(panes.childRows).toBe(0);

    const header = t.childHeader(r, panes);
    expect(header).toContain(`needs ${V.SPLIT_MIN_ROWS} rows`);
    expect(header).not.toContain("verifier");
    expect(header).not.toContain("ctrl+w close");
  });

  it("a real split still shows the child's own header once the workspace can hold it", () => {
    const t = controller();
    t.openChildPane({ id: "3", name: "verifier", lines: ["x"], note: "running 48s" });
    const r = t.regionsNow(4);
    const panes = t.panesNow(r.workspaceRows);

    expect(panes.open).toBe(true);
    const header = t.childHeader(r, panes);
    expect(header).toContain("verifier");
    expect(header).toContain("ctrl+w close");
  });
});
