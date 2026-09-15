/**
 * `[ui] layout` — the single column is the default again.
 *
 * Founder, 2026-09-15: "I want the older simple TUI panel, not that split one
 * — make it back." The four-region workspace frame is not deleted; it is a
 * setting. This file pins the two halves of that claim:
 *
 *   1. what `single` reports — the collapsed shape at EVERY width, so a
 *      160-column window is an 80-column window stretched and nothing else;
 *   2. that `split` still reports what it always did, and that nothing but an
 *      explicit ask reaches it.
 *
 * The interesting risk is not the boolean. It is that `single` at 160 columns
 * could quietly grow a THIRD shape — a window wide enough for a panel, told
 * not to draw one, and left with arithmetic that was only ever exercised
 * under 100 columns. So the assertions below are stated as an equality
 * between two windows rather than as a list of expected numbers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as V from "../../../packages/orchestrator/src/bin/ui/viewport";
import {
  DEFAULT_UI_LAYOUT,
  parseUiLayout,
  resolveUiLayout,
  setUiLayout,
  uiLayout,
} from "../../../packages/orchestrator/src/bin/ui/layout";
import { FRAME_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-frame";
import {
  CONFIG_SETTINGS,
  resolveSetting,
} from "../../../packages/orchestrator/src/config-settings";

afterEach(() => setUiLayout(DEFAULT_UI_LAYOUT));

const at = (columns: number, rows: number, composerRows?: number, layout?: "single" | "split") =>
  V.regions({ columns, rows, headerRows: 3, composerRows, strip: true, layout });

describe("the layout setting", () => {
  it("defaults to the single column, in the module and in `regions()`", () => {
    expect(DEFAULT_UI_LAYOUT).toBe("single");
    expect(uiLayout()).toBe("single");
    // A caller that says nothing gets the product default, not the opt-in one.
    // This is the assertion that would have to be changed to put the split
    // back by stealth, which is exactly why it is written down.
    expect(at(160, 50).collapsed).toBe(true);
    expect(at(120, 40).collapsed).toBe(true);
  });

  it("reads env over config over the default, and ignores a typo", () => {
    expect(resolveUiLayout({})).toBe("single");
    expect(resolveUiLayout({ configured: "split" })).toBe("split");
    expect(resolveUiLayout({ configured: "split", env: "single" })).toBe("single");
    expect(resolveUiLayout({ env: "SPLIT" })).toBe("split");
    // A misspelling in config.toml must not decide the shape of the window.
    expect(resolveUiLayout({ configured: "splitt" })).toBe("single");
    expect(resolveUiLayout({ configured: "" })).toBe("single");
    // The words people actually reach for.
    expect(parseUiLayout("workspace")).toBe("split");
    expect(parseUiLayout("simple")).toBe("single");
    expect(parseUiLayout(undefined)).toBeUndefined();
  });

  it("is in the settable catalog, so /config and update_config can reach it", () => {
    const setting = CONFIG_SETTINGS.find((s) => s.key === "layout");
    expect(setting).toBeDefined();
    expect(setting!.tomlPath).toBe("ui.layout");
    expect(setting!.kind).toBe("enum");
    expect(setting!.values).toEqual(["single", "split"]);
    // It is NOT live: `contentCols()` is the measure every transcript row is
    // rendered at and rows are stored rendered, so flipping it mid-session
    // would re-wrap the whole history at a width it was never written for.
    expect(setting!.live).toBe(false);
    expect(resolveSetting("frame")?.key).toBe("layout");
  });
});

describe("single is the collapsed shape at every width", () => {
  // 80x24 is the shape the founder pointed at. These two are the same window,
  // wider and taller -- not a different frame that happens to agree at 80.
  const WIDE: Array<[number, number]> = [
    [120, 40],
    [160, 50],
    [100, 30],
    [99, 30],
  ];

  it("reports one column: no divider, no right column, the workspace spans the window", () => {
    for (const [columns, rows] of WIDE) {
      const r = at(columns, rows);
      expect(r.collapsed, `${columns}x${rows}`).toBe(true);
      expect(r.dividerCol, `${columns}x${rows}`).toBe(0);
      expect(r.panelCols, `${columns}x${rows}`).toBe(0);
      expect(r.panelContentCols, `${columns}x${rows}`).toBe(0);
      expect(r.panelRows, `${columns}x${rows}`).toBe(0);
      // The transcript takes the full width: usable is `columns - 1`, and the
      // workspace is all of it. At 120 the split left it 78.
      expect(r.workspaceCols, `${columns}x${rows}`).toBe(columns - 1);
      // One row on the agents strip, directly above the composer.
      expect(r.stripRows, `${columns}x${rows}`).toBe(1);
      expect(r.workspaceRows + r.stripRows + r.composerRows).toBe(r.bandRows);
    }
  });

  it("is 80x24's shape stretched -- every field a function of the window alone", () => {
    const narrow = at(80, 24);
    for (const [columns, rows] of WIDE) {
      const r = at(columns, rows);
      // The SHAPE: which fields are zero, which are one, and how the rows are
      // apportioned. Stated as a comparison so a third code path cannot hide
      // behind a number that happens to look reasonable.
      const shape = (x: V.Regions) => ({
        collapsed: x.collapsed,
        dividerCol: x.dividerCol,
        panelCols: x.panelCols,
        panelContentCols: x.panelContentCols,
        panelRows: x.panelRows,
        stripRows: x.stripRows,
        composerRows: x.composerRows,
        bandTop: x.bandTop,
        fullWidthWorkspace: x.workspaceCols === x.usable,
        bandIsTheWindow: x.headerRows + x.bandRows + 1 === rows,
      });
      expect(shape(r), `${columns}x${rows}`).toEqual({
        ...shape(narrow),
        bandIsTheWindow: true,
      });
    }
  });

  it("nothing above the composer moves while you type, at any width", () => {
    // The defect the fixed frame exists to remove, re-asserted for the new
    // default: at a wide width the split paid for a grown field out of the
    // PANEL. There is no panel now, so the region has to stand still and the
    // extra rows have to be painted OVER the workspace instead.
    for (const [columns, rows] of [...WIDE, [80, 24] as [number, number]]) {
      const rest = at(columns, rows, V.COMPOSER_MIN_ROWS);
      const seen = new Set<string>();
      for (let want = V.COMPOSER_MIN_ROWS; want <= 20; want++) {
        const r = at(columns, rows, want);
        seen.add(`${r.workspaceRows}/${r.stripRows}/${r.composerRows}/${r.bandTop}`);
      }
      expect(seen.size, `${columns}x${rows}`).toBe(1);
      expect(rest.workspaceRows).toBe(at(columns, rows, 999).workspaceRows);
      // …and the field can still PAINT a draft and a `/` palette, by covering
      // the workspace's bottom rows rather than by shrinking the region.
      expect(V.composerPaintRows(rest, 12), `${columns}x${rows}`).toBe(12);
      expect(V.composerPaintRows(rest, 999)).toBeLessThanOrEqual(
        rest.bandRows - rest.stripRows - V.WORKSPACE_MIN_ROWS,
      );
    }
  });

  it("the composer sits at the bottom of the band, with the strip above it", () => {
    for (const [columns, rows] of WIDE) {
      const r = at(columns, rows);
      expect(r.composerTop + r.composerRows, `${columns}x${rows}`).toBe(r.statusTop);
      expect(r.bandTop + r.workspaceRows + r.stripRows).toBe(r.composerTop);
    }
  });

  it("split still reports the four regions when it is asked for", () => {
    const r = at(120, 40, undefined, "split");
    expect(r.collapsed).toBe(false);
    expect(r.dividerCol).toBe(79);
    expect(r.workspaceCols).toBe(78);
    expect(r.panelCols).toBe(V.PANEL_COLS);
    expect(r.stripRows).toBe(0);
    // …and it still collapses under its own threshold, unchanged.
    expect(at(99, 30, undefined, "split").collapsed).toBe(true);
    expect(at(100, 30, undefined, "split").collapsed).toBe(false);
  });
});

describe("contentCols -- the measure the transcript is written at", () => {
  const measure = (columns: number): number => {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    return (FRAME_METHODS.contentCols as (this: unknown) => number).call({ inline: false });
  };

  it("is the whole window in single, and the left column in split", () => {
    setUiLayout("single");
    // 119, not 78: the forty cells the right column used to take are the
    // transcript's again. This is the fix the founder asked for, measured.
    expect(measure(120)).toBe(119);
    expect(measure(160)).toBe(159);
    expect(measure(80)).toBe(79);

    setUiLayout("split");
    expect(measure(120)).toBe(119 - V.PANEL_COLS - 2);
    expect(measure(160)).toBe(159 - V.PANEL_COLS - 2);
    // Below the threshold the split already measured the whole window.
    expect(measure(80)).toBe(79);
  });
});
