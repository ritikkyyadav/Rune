import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { FRAME_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-frame";
import { setupStatusLine } from "../../../packages/orchestrator/src/bin/ui/composer";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { ledgerRows, type StepState } from "../../../packages/orchestrator/src/first-run";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";
import * as V from "../../../packages/orchestrator/src/bin/ui/viewport";
import { DEFAULT_UI_LAYOUT, setUiLayout } from "../../../packages/orchestrator/src/bin/ui/layout";

// The split is a setting now, and it is process-wide. Put it back so a file
// that runs after this one sees the product default.
afterAll(() => setUiLayout(DEFAULT_UI_LAYOUT));

const steps: StepState[] = [
  { id: "provider", label: "provider", status: "done", value: "anthropic" },
  { id: "model", label: "model", status: "done", value: "claude-sonnet" },
  { id: "key", label: "key", status: "current", value: "not configured" },
  { id: "search", label: "search", status: "pending", value: "not configured" },
  { id: "spend_cap", label: "spend cap", status: "pending", value: "not set" },
  { id: "sandbox", label: "sandbox", status: "pending", value: "not set" },
];

describe("setup in the production composer", () => {
  it("keeps the six-step ledger within 80-column and wide frames", () => {
    // One implementation of a ledger row, in first-run.ts, where the
    // integration test reads it too. The composer used to carry a second one
    // and the two could disagree about what a skipped step says.
    for (const width of [79, 119, 159]) {
      const rows = ledgerRows(steps, width - F.MARK.length);
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(visLen(row) + F.MARK.length).toBeLessThanOrEqual(width);
    }
  });

  it("puts every row of the wizard in the transcript gutter", () => {
    // The 2026-09-10 frames caught `/config`'s confirmation starting at column
    // 0. The wizard had the same defect for the same reason: `flowRow` budgets
    // a row and the CALLER owns the indent.
    const firstRun = {
      current: () => ({
        id: "provider",
        label: "provider",
        question: "Which provider?",
        hint: "the host Rune sends work to",
      }),
      steps: () => steps,
      heading: () => "1 of 6",
      precedenceLine: () => "flag > env > session > ~/.rune/config.toml",
      restartNote: () => undefined,
      maskCell: () => "\u2022",
      savedVsActive: () => [],
    };
    const fake = {
      mode: "setup",
      ctx: { firstRun },
      input: "",
      caret: 0,
      setupReceipt: null,
      setupBusy: false,
      contentCols: () => 79,
    };
    const block = INPUT_METHODS.composerBlock.call(fake as never, 23);
    for (const line of block.lines) {
      const p = stripAnsi(line);
      if (!p.trim()) continue;
      const indent = p.length - p.trimStart().length;
      // Three rungs and no others, which is the ladder ui-grammar enforces.
      expect([F.MARK.length, F.BODY.length, F.RAIL_IN.length], p).toContain(indent);
    }
    // Every step is still named, and the question and its hint are there.
    const all = stripAnsi(block.lines.join("\n"));
    for (const step of steps) expect(all).toContain(step.label);
    expect(all).toContain("Which provider?");
    expect(all).toContain("flag > env > session");
  });

  it("masks the actual key field and does not render its raw value anywhere", () => {
    const secret = "sk-live-do-not-render-1234";
    const firstRun = {
      current: () => ({
        id: "key",
        label: "key",
        question: "API key",
        hint: "stored by the OS",
        secret: true,
      }),
      steps: () => steps,
      heading: () => "3 of 6",
      precedenceLine: () => "flag > env > session > config.toml",
      restartNote: () => undefined,
      // The rung is the surface's, passed down: `first-run.ts` is engine-side
      // and never learns what a terminal can draw. A UTF-8 terminal gets the
      // bullet, which is what this test is asserting below.
      maskCell: () => "•",
      savedVsActive: () => [],
    };
    const fake = {
      mode: "setup",
      ctx: { firstRun },
      input: secret,
      caret: secret.length,
      setupReceipt: null,
      setupBusy: false,
      contentCols: () => 79,
    };
    const block = INPUT_METHODS.composerBlock.call(fake as never, 23);
    const plain = stripAnsi(block.lines.join("\n"));
    expect(plain).not.toContain(secret);
    expect(plain).not.toContain("1234");
    expect(plain).toContain("•".repeat(secret.length));
    for (const row of block.lines) expect(visLen(row)).toBeLessThanOrEqual(79);
  });

  // Promoted from tests/verification/v4-laneE-saved-vs-active-unrendered.test.ts
  // (V-4 Lane E, E3), and strengthened: that spec only grepped bin/ui for a
  // call site, so it would have passed on a call whose rows were computed and
  // then thrown away. What §2.8 promises is a comparison ON SCREEN -- two
  // columns, identical unless a session override is in force, and when one is,
  // the name of the source that won. `savedVsActive()` and `savedActiveRows()`
  // were fully implemented and fully tested in isolation; nothing under bin/ui
  // called either, so no user action could make the comparison appear.
  it("paints saved vs active, and names the source that won", () => {
    const firstRun = {
      current: () => ({
        id: "model",
        label: "model",
        question: "Which model?",
        hint: "the lineup Rune picks from",
      }),
      steps: () => steps,
      heading: () => "2 of 6",
      precedenceLine: () => "flag > env > session > ~/.rune/config.toml",
      restartNote: () => undefined,
      maskCell: () => "\u2022",
      savedVsActive: () => [
        { label: "provider", saved: "anthropic", active: "anthropic", differs: false },
        {
          label: "model",
          saved: "claude-sonnet",
          active: "gpt-oss:20b",
          differs: true,
          source: "env",
        },
      ],
    };
    const fake = {
      mode: "setup",
      ctx: { firstRun },
      input: "",
      caret: 0,
      setupReceipt: null,
      setupBusy: false,
      contentCols: () => 79,
    };
    const plain = stripAnsi(INPUT_METHODS.composerBlock.call(fake as never, 23).lines.join("\n"));
    // Both columns, both values, and which source is in force.
    expect(plain).toContain("saved");
    expect(plain).toContain("active");
    expect(plain).toContain("claude-sonnet");
    expect(plain).toContain("gpt-oss:20b");
    expect(plain).toContain("model: env outranks the file");
    // The ladder is stated once. It used to be printed twice -- once by the
    // table, once by the wizard's own row directly beneath it.
    const ladder = plain.split("\n").filter((l) => l.includes("flag > env > session"));
    expect(ladder).toHaveLength(1);
  });

  it("says so, once, when nothing is overridden", () => {
    const firstRun = {
      current: () => ({ id: "model", label: "model", question: "Which model?", hint: "h" }),
      steps: () => steps,
      heading: () => "2 of 6",
      precedenceLine: () => "flag > env > session > ~/.rune/config.toml",
      restartNote: () => undefined,
      maskCell: () => "\u2022",
      savedVsActive: () => [
        { label: "provider", saved: "anthropic", active: "anthropic", differs: false },
      ],
    };
    const fake = {
      mode: "setup",
      ctx: { firstRun },
      input: "",
      caret: 0,
      setupReceipt: null,
      setupBusy: false,
      contentCols: () => 79,
    };
    const plain = stripAnsi(INPUT_METHODS.composerBlock.call(fake as never, 23).lines.join("\n"));
    expect(plain).toContain("nothing differs");
    expect(plain).not.toContain("outranks the file");
    const ladder = plain.split("\n").filter((l) => l.includes("flag > env > session"));
    expect(ladder).toHaveLength(1);
  });

  it("submits a secret directly to FirstRun without history or transcript echo", async () => {
    const secret = "sk-direct-only-5678";
    const answered: string[] = [];
    const fake = {
      ctx: {
        firstRun: {
          done: () => false,
          answer: async (value: string) => {
            answered.push(value);
            return { receipt: { ok: true, title: "check", body: [], close: "stored" } };
          },
        },
      },
      setupBusy: false,
      setupReceipt: null,
      input: secret,
      caret: secret.length,
      history: [],
      transcript: [],
      scheduleDraw: () => {},
      editComposer: () => false,
      // The footer layout: the receipt is held in the field the block redraws,
      // and nothing reaches the transcript. (The split layout commits it as a
      // box instead -- pinned below.)
      setupInBand: () => false,
      landSetupReceipt: INPUT_METHODS.landSetupReceipt,
    };
    INPUT_METHODS.setupKey.call(fake as never, { type: "enter" });
    await Promise.resolve();
    await Promise.resolve();
    expect(answered).toEqual([secret]);
    expect(fake.history).toEqual([]);
    expect(fake.transcript).toEqual([]);
    expect(fake.input).toBe("");
  });
});

// ─── §2.8: the wizard across the four regions ───
//
// Lane E built every part §2.8 asks for and drew all three of them in the
// footer, because `bandLayout()` was true only for `input` and `turn`. At
// 120x40 that meant `/setup` dropped the panel and the divider entirely
// (`.codex/audit-20260910/handoff/m0/f4-frames/120x40-setup-wizard-no-split.txt`).
// These pin the split: the ledger is the PANEL, the question is the COMPOSER,
// and a receipt is an ordinary box in the WORKSPACE.
describe("setup across the four regions", () => {
  const SECRET = "sk-live-never-painted-9911";

  const REAL_COLUMNS = process.stdout.columns;
  const REAL_ROWS = process.stdout.rows;
  afterEach(() => {
    setTermWidthOverride(null);
    Object.defineProperty(process.stdout, "columns", {
      value: REAL_COLUMNS,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "rows", { value: REAL_ROWS, configurable: true });
  });

  function wizard(over: Record<string, unknown> = {}) {
    return {
      current: () => ({
        id: "key",
        label: "key",
        question: "API key for openai-codex",
        hint: "stored by the OS, never in config.toml",
        secret: true,
      }),
      steps: () => steps,
      heading: () => "3 of 6",
      precedenceLine: (w = Number.POSITIVE_INFINITY) =>
        w < 42
          ? "flag > env > session > config.toml"
          : "flag > env > session > ~/.rune/config.toml",
      restartNote: () => undefined,
      maskCell: () => "•",
      savedVsActive: () => [],
      ...over,
    };
  }

  /** Enough of the controller for the frame methods, which is all they touch. */
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
      mode: "setup",
      focus: "composer",
      input: "",
      caret: 0,
      setupBusy: false,
      setupReceipt: null,
      transcript: [],
      scroll: 0,
      ctx: { firstRun: wizard() },
      scheduleDraw() {},
      print(block: string) {
        this.transcript.push(...block.split("\n"));
      },
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
      atWidth: FRAME_METHODS.atWidth,
      bandLayout: FRAME_METHODS.bandLayout,
      bandModal: FRAME_METHODS.bandModal,
      setupInBand: FRAME_METHODS.setupInBand,
      panelBlock: FRAME_METHODS.panelBlock,
      setupPanelRows: FRAME_METHODS.setupPanelRows,
      bandComposer: FRAME_METHODS.bandComposer,
      bandSetupComposer: FRAME_METHODS.bandSetupComposer,
      landSetupReceipt: INPUT_METHODS.landSetupReceipt,
      ...over,
    };
    return tui;
  }

  it("takes the band at 120x40 and keeps Lane E's footer at 80x24", () => {
    expect(frame(120, 40).bandLayout()).toBe(true);
    // Below PANEL_MIN_COLS there is no second column to preserve, and the
    // footer block already puts the ledger directly above the question.
    expect(frame(80, 24).bandLayout()).toBe(false);
    expect(frame(99, 40).bandLayout()).toBe(false);
    expect(frame(100, 40).bandLayout()).toBe(true);
    // --inline has no frame at all.
    expect(frame(120, 40, { inline: true }).bandLayout()).toBe(false);
    // And a wizard that is not open does not claim the column.
    expect(frame(120, 40, { mode: "input", ctx: { firstRun: undefined } }).setupInBand()).toBe(
      false,
    );
  });

  it("puts the six-step ledger and saved-vs-active in the panel", () => {
    const t = frame(120, 40, { input: SECRET, caret: SECRET.length });
    const r = t.regionsNow(5);
    const painted = t.panelBlock(r);
    expect(painted).toHaveLength(r.panelRows);
    const plain = painted.map(stripAnsi);
    const all = plain.join("\n");

    // The heading names the step count; the ledger names every step, with the
    // mark that says where the wizard is.
    expect(all).toContain("SETUP");
    expect(all).toContain("3 of 6");
    for (const step of steps) expect(all).toContain(step.label);
    expect(all).toMatch(/✓ provider/);
    expect(all).toMatch(/› key/);

    // The comparison, under its own heading, and the ladder stated once.
    expect(all).toContain("SAVED vs ACTIVE");
    expect(all).toContain("saved");
    expect(all).toContain("active");
    expect(all).toContain("nothing differs");
    const ladder = plain.filter((l) => l.includes("flag > env > session"));
    expect(ladder).toHaveLength(1);

    // Nothing may cross the column's edge, and no key is ever in it.
    for (const row of painted) expect(visLen(row)).toBeLessThanOrEqual(r.panelCols);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("9911");
  });

  it("titles the composer with the question and masks the answer", () => {
    const t = frame(120, 40, { input: SECRET, caret: SECRET.length });
    const block = t.bandComposer(t.regionsNow());
    const plain = block.lines.map(stripAnsi);
    const all = plain.join("\n");

    expect(all).toContain("API key for openai-codex");
    expect(all).toContain("•".repeat(SECRET.length));
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("9911");
    expect(all).toContain("enter save");
    // The ledger is the panel's now: the composer carries the question and the
    // field, and nothing else.
    expect(all).not.toContain("SAVED vs ACTIVE");
    expect(all).not.toContain("spend cap");

    // The block fits the region it will be painted into, so the band never has
    // to trim the question off the front of it.
    const cap = t.regionsNow(t.regionsNow().bandRows).composerRows;
    expect(block.lines.length).toBeLessThanOrEqual(cap);
    expect(block.caretRow).toBeGreaterThanOrEqual(0);
    expect(block.caretRow).toBeLessThan(block.lines.length);
  });

  it("gives up the hint row, not the question, in a short wide window", () => {
    // 100x16 is the smallest window that still has a right column: the band is
    // 12 rows and the composer's clamp is 4, so a five-row block would be
    // painted tail-first and lose exactly the row that says what to type.
    const t = frame(100, 16);
    expect(t.bandLayout()).toBe(true);
    const block = t.bandComposer(t.regionsNow());
    const all = block.lines.map(stripAnsi).join("\n");
    expect(block.lines.length).toBeLessThanOrEqual(t.regionsNow(12).composerRows);
    expect(all).toContain("API key for openai-codex");
    expect(all).not.toContain("enter save");
  });

  it("commits a step's receipt to the workspace as a box, once", () => {
    const t = frame(120, 40, { input: SECRET, caret: SECRET.length });
    t.landSetupReceipt({
      ok: true,
      title: "check GET http://127.0.0.1:51789/v1/models",
      body: ["200 OK · 3 ms", "model mock-small reachable"],
      close: "key accepted · stored in the macOS Keychain, not in config.toml",
    });
    const all = t.transcript.map(stripAnsi).join("\n");
    expect(all).toContain("check");
    expect(all).toContain("127.0.0.1:51789/v1/models");
    expect(all).toContain("200 OK");
    expect(all).toContain("key accepted");
    expect(all).not.toContain(SECRET);
    // Committed and held are exclusive: a shrink below PANEL_MIN_COLS falls
    // back to the footer block, which draws `setupReceipt`, and a receipt in
    // both places is the same receipt printed twice.
    expect(t.setupReceipt).toBeNull();
  });

  it("holds the receipt in the footer block when there is no band", () => {
    const t = frame(80, 24);
    const receipt = {
      ok: false,
      title: "check GET http://x/v1/models",
      body: ["401"],
      close: "no",
    };
    t.landSetupReceipt(receipt);
    expect(t.setupReceipt).toBe(receipt);
    expect(t.transcript).toEqual([]);
  });

  it("keeps the ledger's restart row and drops the per-step repeat of it", () => {
    // `ledgerRow` gives the note its room FIRST and elides the value, so in a
    // 36-cell column `restart required` shortened a saved `custom` to `cust…`
    // -- the one field the row exists to carry. The dedicated row says it once.
    const saved: StepState[] = steps.map((s) =>
      s.id === "provider"
        ? { ...s, value: "custom", note: "restart required", restartRequired: true }
        : s,
    );
    const t = frame(120, 40, {
      ctx: {
        firstRun: wizard({
          steps: () => saved,
          restartNote: () => "provider — restart required",
        }),
      },
    });
    const all = t.panelBlock(t.regionsNow(5)).map(stripAnsi).join("\n");
    expect(all).toMatch(/✓ provider {2,}custom/);
    expect(all).not.toContain("cust…");
    // Said once, on its own row.
    const restart = all.split("\n").filter((l) => l.includes("restart required"));
    expect(restart).toHaveLength(1);
    expect(restart[0]).toContain("provider — restart required");
  });

  it("the footer block carries the same promise where there is no strip", () => {
    // At 80x24 the block IS the footer: `composeFrame` has no row left for a
    // status strip, so the sentence rides on the hint row instead.
    const fake = {
      mode: "setup",
      ctx: {
        firstRun: wizard({
          current: () => ({
            id: "provider",
            label: "provider",
            question: "Which provider?",
            hint: "h",
          }),
        }),
      },
      input: "",
      caret: 0,
      setupReceipt: null,
      setupBusy: false,
      contentCols: () => 79,
    };
    const plain = stripAnsi(INPUT_METHODS.composerBlock.call(fake as never, 23).lines.join("\n"));
    expect(plain).toContain("no model called yet");
    expect(plain).toContain("esc cancel");
  });

  it("the status strip promises no model call, at every width", () => {
    for (const width of [119, 79, 61]) {
      const strip = stripAnsi(setupStatusLine(width));
      expect(strip, `at ${width}`).toContain("setup");
      expect(strip, `at ${width}`).toContain("no model called yet");
      expect(visLen(strip), `at ${width}`).toBeLessThanOrEqual(width);
    }
    // The file being edited is named while there is room for it.
    expect(stripAnsi(setupStatusLine(119))).toContain("~/.rune/config.toml");
  });
});
