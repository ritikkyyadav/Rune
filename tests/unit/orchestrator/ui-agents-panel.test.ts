/**
 * The right column, as pure functions.
 *
 * `ui-fleet.test.ts` drives the panel through a `TurnRenderer` and asserts what
 * a fan-out looks like. This file is the other half: the column's own
 * arithmetic — the rung ladder, the measure, the idle readout, the key legend —
 * tested without a renderer and without a terminal, because those are the parts
 * with a decision in them and a test for a decision should not need a pty.
 *
 * The invariant every case here shares: NO ROW IS EVER WIDER THAN THE COLUMN.
 * The right column is 40 cells with a 1-cell gutter and a divider beside it, so
 * a row one cell too long does not clip — it wraps, and a wrapped row in a
 * fixed frame desyncs every row below it for the rest of the session.
 */

import { describe, expect, it } from "bun:test";
import {
  chooseRungs,
  contextBar,
  elapsedWord,
  initialsFor,
  newestReceipt,
  panelHint,
  receiptLine,
  renderAgentsPanel,
  renderAgentsStrip,
  renderCard,
  renderSessionPanel,
  resolveName,
  tokenWord,
  type AgentCard,
  type PanelView,
} from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { visLen } from "../../../packages/orchestrator/src/bin/ui/render";

/** The panel's own measure at 120 columns: 40 cells less the gutter and the
 *  two-cell inset the frame draws it inside (laneA `panelContentCols`). */
const PANEL_W = 38;

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: over.id ?? "c1",
    name: "planner",
    brief: "map the settings surface",
    kind: "task",
    state: "running",
    note: "read config-settings.ts",
    tokens: 12_400,
    costUsd: 0,
    tools: 9,
    checks: 0,
    checksPassed: 0,
    reroutes: 0,
    pulseStep: 5,
    quietMs: 0,
    retired: false,
    startedAt: 1_000,
    ...over,
  };
}

function view(over: Partial<PanelView> = {}): PanelView {
  return {
    running: [],
    finished: [],
    selectedId: null,
    openId: null,
    focused: false,
    ...over,
  };
}

const NOW = 125_000;

describe("the column's measure", () => {
  it("never draws a row wider than the column it is given", () => {
    // Long everything: a name at the column's ceiling, a brief that is a
    // sentence, a verdict that is a sentence, and five-figure counters.
    const fat = card({
      name: "verification",
      brief: "map every settings surface in the orchestrator and report back",
      note: "bun test tests/unit/orchestrator/ui-frame.test.ts --coverage",
      receipt: { rung: "failure", at: NOW, text: "failed: the frame holds at 80x24 and 120x40" },
      tokens: 1_284_000,
      tools: 412,
      checks: 19,
      checksPassed: 18,
      reroutes: 7,
    });
    for (const width of [24, 28, 38, 40, 52]) {
      const rows = renderAgentsPanel(
        view({
          running: [fat, card({ id: "c2", name: "b" })],
          finished: [card({ id: "c3", name: "c", retired: true, state: "done" })],
          // Focused, selected and open: every optional marker and the `OPEN`
          // tail are on the same row at the same time, which is the widest a
          // head row can ever be.
          selectedId: "c1",
          openId: "c1",
          focused: true,
        }),
        width,
        30,
        NOW,
      );
      for (const row of rows) expect(visLen(stripAnsi(row))).toBeLessThanOrEqual(width);
      const strip = renderAgentsStrip(view({ running: [fat] }), width);
      expect(visLen(stripAnsi(strip))).toBeLessThanOrEqual(width);
      const session = renderSessionPanel(
        {
          contextPercent: 34,
          contextUsed: 48_100,
          contextLimit: 140_000,
          model: "gpt-5.6-sol",
          effort: "max",
          route: "codex · cache warm",
          costUsd: 1.84,
          toolCalls: 41,
          toolBreakdown: "19 read · 9 edit · 8 run",
          filesChanged: 4,
          added: 81,
          removed: 12,
          sandbox: "on · workspace writes only",
          gear: "1st · edits ask",
          lastCheck: "ui-frame ✓ 1.9s · 2m ago",
        },
        width,
        { running: 0, finished: 4 },
      );
      for (const row of session) expect(visLen(stripAnsi(row))).toBeLessThanOrEqual(width);
    }
  });

  it("never draws more rows than the budget, and says how many it dropped", () => {
    const many = Array.from({ length: 12 }, (_, i) => card({ id: `c${i}`, name: `agent${i}` }));
    for (const rows of [6, 10, 18, 30]) {
      const out = renderAgentsPanel(view({ running: many }), PANEL_W, rows, NOW);
      expect(out.length).toBeLessThanOrEqual(rows);
    }
    // A card cut off mid-way leaves the reader wondering whether that was all
    // of them, so the overflow is counted in words instead.
    const tight = stripAnsi(renderAgentsPanel(view({ running: many }), PANEL_W, 8, NOW).join("\n"));
    expect(tight).toMatch(/\+\d+ more rows|\+\d+$/m);
  });
});

describe("the rung ladder", () => {
  it("spends rows on the densest card that fits, and never claims one it lacks", () => {
    // Four rows a card, plus a heading and its rule.
    expect(chooseRungs(3, 0, 30)).toEqual({ rung: "full", pairs: false, initials: false });
    // Two sections' chrome (2 + 3) leaves 25 of 30: six members need 24.
    expect(chooseRungs(4, 2, 30)).toEqual({ rung: "full", pairs: false, initials: false });
    // Six members into a 16-row column: two rows each, not four.
    expect(chooseRungs(6, 0, 16).rung).toBe("short");
    // Eight will not even fit at two rows apiece, so it drops another rung
    // rather than drawing six of them and leaving two members unmentioned.
    expect(chooseRungs(8, 0, 16).rung).toBe("line");
    // Twelve into 14: one row each.
    expect(chooseRungs(12, 0, 14).rung).toBe("line");
    // Below that there is no rung except everybody-one-cell, and inventing one
    // would mean dropping members silently.
    expect(chooseRungs(20, 0, 10)).toEqual({ rung: "line", pairs: true, initials: true });
    expect(chooseRungs(0, 0, 10)).toEqual({ rung: "full", pairs: false, initials: false });
  });

  it("draws four rows at full, two at short and one at line", () => {
    const c = card({ receipt: { rung: "verified", text: "checks pass", at: NOW } });
    expect(renderCard(c, 1, view(), "full", PANEL_W, NOW)).toHaveLength(4);
    expect(renderCard(c, 1, view(), "short", PANEL_W, NOW)).toHaveLength(2);
    expect(renderCard(c, 1, view(), "line", PANEL_W, NOW)).toHaveLength(1);
    // The short rung keeps the VERDICT, not the brief: two rows are head and
    // the one claim the member has made.
    expect(stripAnsi(renderCard(c, 1, view(), "short", PANEL_W, NOW)[1]!)).toContain("checks pass");
    // …and falls back to the brief for a member that has proved nothing.
    const fresh = card();
    expect(stripAnsi(renderCard(fresh, 1, view(), "short", PANEL_W, NOW)[1]!)).toContain(
      "map the settings surface",
    );
  });
});

describe("the selection is a claim about where the keys go", () => {
  it("paints a marker only while the panel has focus", () => {
    const c = card();
    const unfocused = stripAnsi(
      renderCard(c, 1, view({ selectedId: "c1" }), "line", PANEL_W, NOW)[0]!,
    );
    const focused = stripAnsi(
      renderCard(c, 1, view({ selectedId: "c1", focused: true }), "line", PANEL_W, NOW)[0]!,
    );
    expect(focused.trimStart().startsWith(">") || focused.trimStart().startsWith("›")).toBe(true);
    expect(unfocused.startsWith(" ")).toBe(true);
    // The same text width: the marker is a cell that was already there. (The
    // focused row is also the full-width selection bar, so its padding runs to
    // the panel edge; the words inside it do not move.)
    expect(stripAnsi(unfocused).trimEnd().length).toBe(stripAnsi(focused).trimEnd().length);
  });

  it("names the keys that are actually live", () => {
    expect(panelHint(view())).toContain("esc composer");
    const running = panelHint(view({ running: [card()] }));
    expect(running).toContain("enter open");
    expect(running).not.toContain("c clear");
    const withFinished = panelHint(
      view({ running: [card()], finished: [card({ id: "c2", retired: true })], openId: "c1" }),
    );
    // Open on one: the key that undoes it is the one advertised.
    expect(withFinished).toContain("ctrl+w close");
    expect(withFinished).toContain("c clear");
  });
});

describe("the verdict", () => {
  it("is the mark AND the word, never the mark alone", () => {
    const line = stripAnsi(receiptLine({ rung: "failure", text: "checks fail", at: NOW }, 30));
    expect(line).toContain("checks fail");
    // One cell of mark, one space, then the word — legible with no colour.
    expect(line.length).toBeGreaterThan("checks fail".length);
  });

  it("reports the newest one in a roster, not the first in the list", () => {
    const older = card({ id: "a", receipt: { rung: "verified", text: "checks pass", at: 10 } });
    const newer = card({
      id: "b",
      name: "verifier",
      receipt: { rung: "failure", text: "checks fail", at: 99 },
    });
    expect(newestReceipt([older, newer])?.card.name).toBe("verifier");
    // Order of the list must not decide it: a finished member can hold it.
    expect(newestReceipt([newer, older])?.card.name).toBe("verifier");
    expect(newestReceipt([card()])).toBeNull();
  });
});

describe("the idle readout", () => {
  it("leads with the check, because that is the field about evidence", () => {
    const rows = renderSessionPanel(
      {
        contextPercent: 34,
        model: "gpt-5.6-sol",
        costUsd: 1.84,
        lastCheck: "ui-frame ✓ 1.9s · 2m ago",
      },
      PANEL_W,
      undefined,
    ).map((r) => stripAnsi(r));
    const check = rows.findIndex((r) => r.includes("ui-frame"));
    const context = rows.findIndex((r) => r.includes("34%"));
    const cost = rows.findIndex((r) => r.includes("1.84"));
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(context);
    expect(check).toBeLessThan(cost);
  });

  it("says nothing about a measurement nobody has made", () => {
    const rows = renderSessionPanel({ model: "gpt-5.6-sol" }, PANEL_W).map((r) => stripAnsi(r));
    const body = rows.join("\n");
    expect(body).toContain("gpt-5.6-sol");
    expect(body).not.toContain("cost");
    expect(body).not.toContain("$0.00");
    expect(body).not.toContain("context");
    expect(body).not.toContain("check");
  });

  it("draws a bar whose fill is the percentage and whose cells fit the column", () => {
    expect(contextBar(0, 10)).toBe("[          ]");
    expect(stripAnsi(contextBar(100, 10)).slice(1, -1).trim().length).toBe(10);
    // Non-zero never reads as empty: 1% is one cell, not none.
    expect(stripAnsi(contextBar(1, 20)).slice(1, -1).trimEnd().length).toBe(1);
    for (const cells of [6, 12, 20])
      expect(visLen(stripAnsi(contextBar(42, cells)))).toBe(cells + 2);
  });
});

describe("names and numbers, in the panel's own words", () => {
  it("resolves a name by the documented order and suffixes a collision", () => {
    const taken = new Set<string>();
    expect(resolveName("Planner", undefined, 1, taken)).toBe("planner");
    taken.add("planner");
    expect(resolveName("planner", undefined, 2, taken)).toBe("planner-2");
    expect(resolveName(undefined, "scout-auth", 3, taken)).toBe("scout-auth");
    expect(resolveName(undefined, undefined, 4, taken)).toBe("agent-4");
    // A name is one column, so it is clipped to it rather than overrunning.
    expect(resolveName("a-very-long-role-name", undefined, 5, taken).length).toBeLessThanOrEqual(
      11,
    );
  });

  it("keeps initials stable while members come and go", () => {
    expect(initialsFor(["planner", "parser", "builder"])).toEqual(["Pl", "Pa", "B"]);
  });

  it("reports tokens and elapsed at the resolution a person compares them at", () => {
    expect(tokenWord(0)).toBe("0");
    expect(tokenWord(900)).toBe("900");
    expect(tokenWord(12_400)).toBe("12.4k");
    expect(tokenWord(1_284_000)).toBe("1284k");
    expect(elapsedWord(48_000)).toBe("48s");
    expect(elapsedWord(124_000)).toBe("2m 04s");
  });
});
