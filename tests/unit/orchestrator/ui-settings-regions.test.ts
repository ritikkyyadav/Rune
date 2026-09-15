/**
 * §2.8's region table for the settings surfaces, pinned at both sizes.
 *
 * `docs/program/phase-4-workspace-layout.md` §2.8 says where each part of each
 * settings surface renders, and every row of that table is a claim about a
 * frame rather than about a renderer:
 *
 *   /config, /sandbox   the WORKSPACE, as a picker
 *   /model              the WORKSPACE, as the existing tree picker
 *   /keys               the WORKSPACE list + the COMPOSER's masked field
 *   /help               the WORKSPACE, committed
 *   /status             the WORKSPACE, committed -- and the PANEL when idle
 *
 * The frame methods are plain functions mixed onto `Tui.prototype`, so these
 * call the real ones on an object carrying only the state they touch -- the
 * same shape `ui-setup.test.ts` uses for the wizard. Nothing here fakes a
 * layout decision: `regions()` is the real one, and so is every renderer.
 *
 * §2.2 is the other half of the table: below `PANEL_MIN_COLS` (100) there is no
 * right column, so there is no split to make, and every one of these keeps the
 * footer layout it had. Each test says both sizes.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FRAME_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-frame";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import * as V from "../../../packages/orchestrator/src/bin/ui/viewport";
import { DEFAULT_UI_LAYOUT, setUiLayout } from "../../../packages/orchestrator/src/bin/ui/layout";
import {
  fleetLedger,
  renderSessionPanel,
  type SessionReadout,
} from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import type { KeyRow } from "../../../packages/orchestrator/src/bin/ui/composer";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";

const REAL_COLUMNS = process.stdout.columns;
const REAL_ROWS = process.stdout.rows;

beforeEach(() => {
  // The panel's three states are ordered: agents displace the session readout.
  // `fleetLedger` is a module singleton for the session's lifetime, so a file
  // that asserts the IDLE column has to start from an idle one.
  fleetLedger.reset();
});

afterEach(() => {
  setTermWidthOverride(null);
  Object.defineProperty(process.stdout, "columns", { value: REAL_COLUMNS, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: REAL_ROWS, configurable: true });
});

/** The real `/config` list: three shortcuts and nineteen settings, which is the
 *  "20+ rows" §2.8 gives as the reason it cannot be the panel's. */
const CONFIG_ITEMS = [
  { label: "Model and reasoning", hint: "choose intelligence" },
  { label: "API keys and internet search", hint: "manage keys | /login to connect" },
  { label: "Browser", hint: "off" },
  ...Array.from({ length: 19 }, (_, i) => ({
    label: `setting ${i + 1}`.padEnd(12, "x"),
    hint: "per effort",
  })),
];

/** `/sandbox`'s three tabs, verbatim from `runSandboxMenu`. */
const SANDBOX_ITEMS = [
  { label: "Mode", hint: "regular -- contained, still prompted" },
  { label: "Overrides", hint: "strict sandbox mode" },
  { label: "Config", hint: "2 excluded, filesystem read/write rules" },
];

/** Level 1 of `/model`'s tree: the provider roster, which is 37 rows now. */
const MODEL_ITEMS = [
  ...Array.from({ length: 37 }, (_, i) => ({ label: `provider-${i + 1}`, hint: `hint ${i + 1}` })),
  { label: "Type provider/model...", hint: "anything not listed" },
];

const KEY_ROWS: KeyRow[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    masked: "••••••••7f2a",
    source: "keychain",
    hasKey: true,
    keyCount: 2,
    savedKeys: [
      { id: "k1", masked: "••••••••7f2a", label: "work", addedAt: "2026-09-01", active: true },
      { id: "k2", masked: "••••••••1c04", label: "personal", addedAt: "2026-09-02", active: false },
    ],
    disabled: false,
    active: true,
  },
  { id: "openai", label: "OpenAI", masked: "", source: "none", disabled: false, active: false },
  {
    id: "ollama",
    label: "Ollama",
    masked: "",
    source: "none",
    local: true,
    endpoint: "http://127.0.0.1:11434",
    hasKey: true,
    disabled: false,
    active: false,
  },
] as KeyRow[];

/**
 * Enough of the controller for the frame methods, at a real window size.
 *
 * `regionsNow` is the real `regions()`; `contentCols`, `bandLayout`,
 * `bandModal`, `keysInBand`, `panelBlock`, `bandComposer`, `paneRows` and
 * `composerBlock` are the real methods off the prototype mixins.
 */
function frame(columns: number, rows: number, over: Record<string, unknown> = {}) {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  // The split is what this whole block is about, and it is no longer the
  // default (founder, 2026-09-15 -- ui/layout.ts). `contentCols` reads the
  // process layout, so saying it in `regionsNow` alone would leave the
  // measure at the window's width while the regions reported a right column.
  setUiLayout("split");
  const tui: any = {
    inline: false,
    mode: "input",
    focus: "composer",
    input: "",
    caret: 0,
    scroll: 0,
    transcript: [],
    childPane: null,
    childScroll: 0,
    picker: null,
    keysRows: KEY_ROWS,
    keysSel: 0,
    keysEdit: null,
    keysManage: null,
    filesEdited: new Set<string>(),
    turnStart: Date.now(),
    ctx: { firstRun: undefined },
    scheduleDraw() {},
    print(block: string) {
      this.transcript.push(...block.split("\n").map((l: string) => this.bound(l)));
    },
    slashMatches: () => [],
    turnStateLines: () => [],
    sessionReadout: () => ({}) as SessionReadout,
    regionsNow(composerRows?: number) {
      return V.regions({
        columns: process.stdout.columns!,
        rows: process.stdout.rows!,
        headerRows: 3,
        composerRows,
        strip: true,
        layout: "split",
      });
    },
    contentCols: FRAME_METHODS.contentCols,
    frameCols: FRAME_METHODS.frameCols,
    atWidth: FRAME_METHODS.atWidth,
    bound: FRAME_METHODS.bound,
    bandLayout: FRAME_METHODS.bandLayout,
    bandModal: FRAME_METHODS.bandModal,
    keysInBand: FRAME_METHODS.keysInBand,
    setupInBand: FRAME_METHODS.setupInBand,
    panesNow: FRAME_METHODS.panesNow,
    paneRows: FRAME_METHODS.paneRows,
    panelBlock: FRAME_METHODS.panelBlock,
    bandComposer: FRAME_METHODS.bandComposer,
    bandKeysComposer: FRAME_METHODS.bandKeysComposer,
    keysWorkspaceBlock: FRAME_METHODS.keysWorkspaceBlock,
    composerHint: FRAME_METHODS.composerHint,
    composerBlock: INPUT_METHODS.composerBlock,
    ...over,
  };
  return tui;
}

// The split is a setting now, and it is process-wide. Put it back so a file
// that runs after this one sees the product default.
afterAll(() => setUiLayout(DEFAULT_UI_LAYOUT));

/** A picker exactly as `Tui.pick` sets it up. */
const pickerState = (title: string, items: unknown[], footnote: string) => ({
  title,
  items,
  sel: 0,
  resolve: () => {},
  footnote,
});

/** The block the band actually paints into the workspace, at the workspace's
 *  own measure -- `renderBand`'s `modal` branch, without a Viewport. */
function workspaceBlock(t: any): { lines: string[]; caretRow: number; caretCol: number } {
  const r = t.regionsNow(t.bandComposer(t.regionsNow()).lines.length);
  const panes = t.panesNow(r.workspaceRows);
  const block = t.keysInBand()
    ? t.keysWorkspaceBlock(panes.mainRows)
    : t.composerBlock(panes.mainRows);
  return { ...block, lines: block.lines.map((l: string) => t.bound(l)) };
}

// ─── the region, surface by surface ───

describe("§2.8: /config and /sandbox open in the workspace, as a picker", () => {
  it("takes the band at 120x40 and keeps the footer at 80x24", () => {
    for (const items of [CONFIG_ITEMS, SANDBOX_ITEMS]) {
      const wide = frame(120, 40, { mode: "picker", picker: pickerState("x", items, "f") });
      expect(wide.bandModal()).toBe(true);
      expect(wide.bandLayout()).toBe(true);
      // The threshold is §2.2's one constant, and it is the founder's decision.
      expect(frame(100, 40, { mode: "picker", picker: wide.picker }).bandLayout()).toBe(true);
      expect(frame(99, 40, { mode: "picker", picker: wide.picker }).bandLayout()).toBe(false);
      expect(frame(80, 24, { mode: "picker", picker: wide.picker }).bandLayout()).toBe(false);
      expect(
        frame(120, 40, { mode: "picker", picker: wide.picker, inline: true }).bandLayout(),
      ).toBe(false);
    }
  });

  it("draws the settings list inside the workspace column, header and panel intact", () => {
    const t = frame(120, 40, {
      mode: "picker",
      picker: pickerState("Settings | 22 total", CONFIG_ITEMS, "enter change | esc close"),
    });
    const r = t.regionsNow(4);
    // The four regions are all still there: this is the whole point of the
    // band -- a list of nineteen settings must not cost the panel and the rule.
    expect(r.collapsed).toBe(false);
    expect(r.dividerCol).toBe(79);
    expect(r.workspaceCols).toBe(78);
    expect(r.panelCols).toBe(V.PANEL_COLS);
    expect(r.panelRows).toBeGreaterThanOrEqual(V.PANEL_MIN_ROWS);

    const block = workspaceBlock(t);
    const all = block.lines.map(stripAnsi).join("\n");
    // `renderPicker` lowercases its own title row; the content is the claim.
    expect(all).toContain("settings | 22 total");
    expect(all).toContain("Model and reasoning");
    expect(all).toContain("setting 19");
    // Every row lands inside the LEFT column -- a picker drawn at the window's
    // measure would be clipped by `bound()` with nothing saying so.
    for (const line of block.lines) expect(visLen(line)).toBeLessThanOrEqual(r.workspaceCols);
    // And it fits the rows the workspace has, so the panel keeps its own.
    const panes = t.panesNow(r.workspaceRows);
    expect(block.lines.length).toBeLessThanOrEqual(panes.mainRows);
  });

  it("the panel beside it is the idle session readout (§2.4), not blank", () => {
    const readout: SessionReadout = {
      model: "claude-opus-4",
      effort: "high",
      contextPercent: 12,
      contextUsed: 24000,
      contextLimit: 200000,
      sandbox: "on",
      gear: "confirm",
    };
    const t = frame(120, 40, {
      mode: "picker",
      picker: pickerState("Settings", CONFIG_ITEMS, "f"),
      sessionReadout: () => readout,
    });
    const r = t.regionsNow(4);
    const painted = t.panelBlock(r);
    expect(painted).toHaveLength(r.panelRows);
    const all = painted.map(stripAnsi).join("\n");
    expect(all).toContain("SESSION");
    expect(all).toContain("claude-opus-4");
    for (const row of painted) expect(visLen(row)).toBeLessThanOrEqual(r.panelCols);
  });

  it("the sandbox menu is the same picker path, not a second surface", () => {
    const t = frame(120, 40, {
      mode: "picker",
      picker: pickerState("sandbox", SANDBOX_ITEMS, "text forms: /sandbox mode|override|config"),
    });
    const all = workspaceBlock(t).lines.map(stripAnsi).join("\n");
    expect(all).toContain("sandbox");
    expect(all).toContain("Mode");
    expect(all).toContain("Overrides");
    expect(all).toContain("Config");
  });
});

describe("§2.8: /model is the existing tree picker, in the workspace", () => {
  it("opens in the band at 120x40 and in the footer at 80x24", () => {
    const picker = pickerState("Model | current ollama/gpt-oss:20b", MODEL_ITEMS, "keys: /keys");
    expect(frame(120, 40, { mode: "picker", picker }).bandLayout()).toBe(true);
    expect(frame(80, 24, { mode: "picker", picker }).bandLayout()).toBe(false);
  });

  it("windows 38 providers into the workspace's rows rather than the window's", () => {
    const t = frame(120, 40, {
      mode: "picker",
      picker: pickerState("Model | current ollama/gpt-oss:20b", MODEL_ITEMS, "keys: /keys"),
    });
    const r = t.regionsNow(4);
    const panes = t.panesNow(r.workspaceRows);
    const block = workspaceBlock(t);
    expect(block.lines.length).toBeLessThanOrEqual(panes.mainRows);
    const all = block.lines.map(stripAnsi).join("\n");
    expect(all).toContain("provider-1");
    for (const line of block.lines) expect(visLen(line)).toBeLessThanOrEqual(r.workspaceCols);
  });
});

describe("§2.8: /keys is the workspace list and the composer's masked field", () => {
  const SECRET = "sk-live-never-painted-4d91";

  it("takes the band at 120x40 and keeps the footer panel at 80x24", () => {
    expect(frame(120, 40, { mode: "keys" }).keysInBand()).toBe(true);
    expect(frame(120, 40, { mode: "keys" }).bandLayout()).toBe(true);
    expect(frame(100, 40, { mode: "keys" }).bandLayout()).toBe(true);
    expect(frame(99, 40, { mode: "keys" }).keysInBand()).toBe(false);
    expect(frame(80, 24, { mode: "keys" }).bandLayout()).toBe(false);
    expect(frame(120, 40, { mode: "keys", inline: true }).keysInBand()).toBe(false);
    // And no other mode was dragged in with it.
    for (const mode of ["permission", "ask", "question", "held", "sessions", "memory", "review"]) {
      expect(frame(120, 40, { mode }).bandModal()).toBe(false);
    }
  });

  it("puts the provider list in the workspace, with the last four and no secret", () => {
    const t = frame(120, 40, { mode: "keys" });
    const r = t.regionsNow(4);
    const block = workspaceBlock(t);
    const all = block.lines.map(stripAnsi).join("\n");
    expect(all).toContain("API keys");
    expect(all).toContain("Anthropic");
    expect(all).toContain("OpenAI");
    // The list is the EVIDENCE half: what is configured, masked to its tail.
    expect(all).toContain("7f2a");
    expect(all).not.toContain(SECRET);
    for (const line of block.lines) expect(visLen(line)).toBeLessThanOrEqual(r.workspaceCols);
  });

  it("masks the key being typed WHOLE, and never shows its tail", () => {
    const t = frame(120, 40, {
      mode: "keys",
      keysEdit: {
        id: "anthropic",
        label: "Anthropic",
        field: "key",
        value: SECRET,
        caret: SECRET.length,
        masked: true,
        mode: "add",
        pending: {},
        title: "Add API key -- Anthropic",
      },
    });
    const block = t.bandComposer(t.regionsNow());
    const all = block.lines.map(stripAnsi).join("\n");
    expect(all).toContain("Add API key");
    expect(all).not.toContain(SECRET);
    // Not even the four characters the SAVED row is allowed to carry: a live
    // field sits on screen for as long as the pane is open.
    expect(all).not.toContain("4d91");
    expect(all).toContain("•".repeat(SECRET.length));
    expect(all).toContain("enter save");
    // It fits the region it will be painted into, and parks its own caret.
    const cap = t.regionsNow(t.regionsNow().bandRows).composerRows;
    expect(block.lines.length).toBeLessThanOrEqual(cap);
    expect(block.caretRow).toBeGreaterThanOrEqual(0);
    expect(block.caretRow).toBeLessThan(block.lines.length);
  });

  it("keeps the list on screen while the field is open -- that is the split", () => {
    const t = frame(120, 40, {
      mode: "keys",
      keysManage: { id: "anthropic", label: "Anthropic", sel: 0 },
      keysEdit: {
        id: "anthropic",
        label: "Anthropic",
        field: "key",
        value: SECRET,
        caret: SECRET.length,
        masked: true,
        mode: "add",
        pending: {},
        title: "Add API key -- Anthropic",
      },
    });
    // The workspace shows the pool -- the thing the key is being added TO --
    // where the footer panel would have replaced it with the editor.
    const all = workspaceBlock(t).lines.map(stripAnsi).join("\n");
    expect(all).toContain("Anthropic | keys");
    expect(all).toContain("7f2a");
    expect(all).toContain("1c04");
    expect(all).not.toContain(SECRET);
    // And the editor's own box is NOT in the workspace: the field is elsewhere.
    expect(all).not.toContain("enter save | esc cancel | paste supported");
  });

  it("an unmasked step (the label) shows what is typed", () => {
    const t = frame(120, 40, {
      mode: "keys",
      keysEdit: {
        id: "anthropic",
        label: "Anthropic",
        field: "label",
        value: "work",
        caret: 4,
        masked: false,
        mode: "add",
        pending: { newKey: SECRET },
        title: "Label this key -- Anthropic",
      },
    });
    const all = t.bandComposer(t.regionsNow()).lines.map(stripAnsi).join("\n");
    expect(all).toContain("Label this key");
    expect(all).toContain("work");
    // The key already pasted is held in `pending`, and it is not on screen.
    expect(all).not.toContain(SECRET);
  });

  it("at 80x24 the footer panel is what it always was", () => {
    const t = frame(80, 24, { mode: "keys" });
    expect(t.bandLayout()).toBe(false);
    expect(t.keysInBand()).toBe(false);
    // `composerBlock` -- the footer path -- still renders the list, and still
    // swaps in the editor when one is open. Unchanged, by §2.2.
    const list = t.composerBlock(20).lines.map(stripAnsi).join("\n");
    expect(list).toContain("API keys");
    const editing = frame(80, 24, {
      mode: "keys",
      keysEdit: {
        id: "anthropic",
        label: "Anthropic",
        field: "key",
        value: SECRET,
        caret: SECRET.length,
        masked: true,
        mode: "add",
        pending: {},
        title: "Add API key -- Anthropic",
      },
    })
      .composerBlock(20)
      .lines.map(stripAnsi)
      .join("\n");
    expect(editing).toContain("Add API key");
    expect(editing).not.toContain(SECRET);
  });
});

describe("§2.8: /help and /status are committed to the workspace", () => {
  /** The rows `/help` prints, at the measure the command reads. */
  const helpRows = (width: number) =>
    [
      "  Commands",
      "  work",
      "    /diff     Inspect staged and uncommitted workspace changes",
      "    /status   Session status",
    ].map((l) => l.slice(0, width));

  it("a committed document lands in the workspace, and the frame stays whole", () => {
    const t = frame(120, 40);
    // Still the writing surface: /help does not take a mode, so the band is
    // the ordinary one and the panel and divider never blink.
    expect(t.bandLayout()).toBe(true);
    expect(t.bandModal()).toBe(false);
    t.print(helpRows(t.contentCols()).join("\n"));

    const r = t.regionsNow(4);
    const panes = t.panesNow(r.workspaceRows);
    // The workspace pane is the ONLY place these rows are: `paneRows` is the
    // left column's window onto the transcript.
    const pane = t.paneRows(t.transcript, panes.mainRows, 0, r.workspaceCols);
    const all = pane.rows.map(stripAnsi).join("\n");
    expect(all).toContain("Commands");
    expect(all).toContain("/status");
    for (const row of pane.rows) expect(visLen(row)).toBeLessThanOrEqual(r.workspaceCols);
  });

  it("/help is measured against the WORKSPACE, in both directions", () => {
    // Width: the two-column layout switches on at 110 cells. At 120 columns
    // the window is 120 and the workspace is 77, so reading `cols()` put the
    // right column at cells 62-116 of a 78-cell pane and `bound()` clipped it.
    // Height: `/help`'s full list is thirty-four rows, and the compact
    // names-only form is what it falls back to when they do not fit. The band
    // has already paid for the header and the composer, so the count is the
    // workspace's -- 36 rows at 120x40, which holds the whole document.
    const FULL_ROWS = 34;
    const wide = frame(120, 40);
    expect(wide.contentCols()).toBe(77);
    expect(wide.contentCols()).toBeLessThan(110);
    expect(wide.bandLayout()).toBe(true);
    expect(wide.regionsNow().workspaceRows - 2).toBeGreaterThanOrEqual(FULL_ROWS);
    // The old arithmetic, which is the footer layout's and said it did not fit.
    expect(40 - 8).toBeLessThan(FULL_ROWS);

    // Collapsed, the workspace IS the window in width and SMALLER than it in
    // height, so both branches land where they landed before: nothing at 80x24
    // moves.
    const narrow = frame(80, 24);
    expect(narrow.contentCols()).toBe(79);
    expect(narrow.regionsNow().workspaceRows - 2).toBeLessThan(FULL_ROWS);
    expect(24 - 8).toBeLessThan(FULL_ROWS);
  });

  it("/status is committed AND permanently in the panel when idle (§2.4)", () => {
    const readout: SessionReadout = {
      model: "gpt-oss:20b",
      effort: "medium",
      contextPercent: 4,
      contextUsed: 8000,
      contextLimit: 200000,
      costUsd: 0.42,
      sandbox: "on",
      gear: "confirm",
    };
    const t = frame(120, 40, { sessionReadout: () => readout });
    t.print(["  Rune", "  model     gpt-oss:20b", "  sandbox   on"].join("\n"));

    const r = t.regionsNow(4);
    const panes = t.panesNow(r.workspaceRows);
    const workspace = t
      .paneRows(t.transcript, panes.mainRows, 0, r.workspaceCols)
      .rows.map(stripAnsi)
      .join("\n");
    expect(workspace).toContain("gpt-oss:20b");

    // And the same readout is the column's resting state, with no agents and
    // no live turn -- which is what "permanently in the panel when idle" is.
    const panel = t.panelBlock(r).map(stripAnsi).join("\n");
    expect(panel).toContain("SESSION");
    expect(panel).toContain("gpt-oss:20b");
    // Pinned against the renderer itself, so the panel cannot quietly stop
    // being /status's content.
    const direct = renderSessionPanel(readout, r.panelContentCols).map(stripAnsi).join("\n");
    expect(direct).toContain("gpt-oss:20b");
  });

  it("at 80x24 a committed document is still the transcript, full width", () => {
    const t = frame(80, 24);
    expect(t.bandLayout()).toBe(true); // mode input: the band, collapsed
    const r = t.regionsNow(4);
    expect(r.collapsed).toBe(true);
    expect(r.workspaceCols).toBe(79);
    t.print(helpRows(t.contentCols()).join("\n"));
    const panes = t.panesNow(r.workspaceRows);
    const pane = t.paneRows(t.transcript, panes.mainRows, 0, r.workspaceCols);
    expect(pane.rows.map(stripAnsi).join("\n")).toContain("Commands");
  });
});
