import { describe, expect, it } from "bun:test";
import { INPUT_METHODS } from "../../../packages/orchestrator/src/bin/ui/tui-input";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { ledgerRows, type StepState } from "../../../packages/orchestrator/src/first-run";
import * as F from "../../../packages/orchestrator/src/bin/ui/flow";

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
