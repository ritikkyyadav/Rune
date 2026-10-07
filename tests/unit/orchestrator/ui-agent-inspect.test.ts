/**
 * Inspecting a sub-agent: the keys that reach one, and the frame they produce.
 *
 * The panel, the cards and a child pane all existed before this file, and every
 * test of them handed a renderer some state and read the rows back. None of
 * them pressed a key. That is how four defects stood side by side in a feature
 * whose every capture looked right:
 *
 *   - `ctrl+f` was bound in `inputKey` and nowhere else, so for the whole of a
 *     running turn -- the only time a sub-agent is live -- it did nothing;
 *   - `enter` on a card opened the transcript BEHIND the cards overlay;
 *   - `esc` on the panel mid-turn fell through to the turn and interrupted it;
 *   - the transcript, once reached, held a call as the single word `read`.
 *
 * So everything below goes through `Tui.prototype.routeKey` and reads what
 * `renderBand` actually handed the viewport. The controller is the real
 * prototype over a stub engine: no model, no gateway, no `~/.rune`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Tui } from "../../../packages/orchestrator/src/bin/ui/tui";
import {
  AGENTS_KEY_HINT,
  agentBlocks,
  agentKeyAction,
  agentsHint,
  entersAgentRow,
  fleetLedger,
  type AgentCard,
  type AgentKeyState,
} from "../../../packages/orchestrator/src/bin/ui/agents-panel";
import type { Key } from "../../../packages/orchestrator/src/bin/ui/keys";
import { TurnRenderer } from "../../../packages/orchestrator/src/bin/ui/turn";
import { stripAnsi } from "../../../packages/orchestrator/src/bin/ui/theme";
import { setTermWidthOverride, visLen } from "../../../packages/orchestrator/src/bin/ui/render";
import { splitPanes, zoomPane } from "../../../packages/orchestrator/src/bin/ui/viewport";
import { setUiLayout } from "../../../packages/orchestrator/src/bin/ui/layout";

const REAL = { columns: process.stdout.columns, rows: process.stdout.rows };
function windowOf(columns: number, rows: number): void {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
}

beforeEach(() => {
  fleetLedger.reset();
});
afterEach(() => {
  fleetLedger.reset();
  setTermWidthOverride(null);
  windowOf(REAL.columns as number, REAL.rows as number);
});

// ─── A controller: the real prototype, a stub engine, a captured frame ───

interface Rig {
  t: any;
  /** The last frame `renderBand` painted, colour stripped. */
  frame(): string[];
  key(k: Key): void;
  type(text: string): void;
}

function rig(opts: { columns?: number; rows?: number; mode?: "turn" | "input" } = {}): Rig {
  windowOf(opts.columns ?? 100, opts.rows ?? 30);
  let painted: string[] = [];
  const t: any = Object.create(Tui.prototype);
  Object.assign(t, {
    inline: false,
    ctx: {
      engine: {
        getModel: () => "gpt-6-sol",
        getProvider: () => "codex",
        getReasoningEffort: () => "high",
        getReasoningEffortLabel: () => "high",
        getPermissionMode: () => "gear-2",
        getContextUsage: () => ({ used: 1, limit: 100, percent: 1 }),
        getLoopStatus: () => ({ count: 0, nextRunAt: null }),
        isSandboxEnabled: () => true,
        getCost: () => 0,
        abort: () => {
          t.aborts++;
        },
        cancelLoopTask: () => ({ ok: false }),
        interject: () => false,
        getDelegationTranscript: () => null,
        listDelegations: () => [],
      },
      sessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
      workspaceRoot: "/tmp/ws",
      version: "0.0.0",
      customCommands: [],
    },
    transcript: ["  lead row one", "  lead row two"],
    focus: "composer",
    panelOverlay: false,
    childPane: null,
    childScroll: 0,
    lastChildRows: null,
    scroll: 0,
    input: "",
    caret: 0,
    mode: opts.mode ?? "turn",
    queued: [],
    history: [],
    histIdx: -1,
    draft: "",
    aborting: false,
    aborts: 0,
    slashSel: 0,
    filesEdited: new Set<string>(),
    folds: { size: 0, newest: () => undefined, at: () => undefined },
    pastes: new Map(),
    lastBodyMap: null,
    lastTurnMs: null,
    liveBlockRows: 0,
    turnStart: Date.now() - 5_000,
    turnPreview: null,
    liveTurn: null,
    viewport: {
      mounted: true,
      render: (frame: { rows: string[] }) => {
        painted = frame.rows;
      },
      invalidate: () => {},
    },
    print: () => {},
    slashMatches: () => [],
    slashCatalog: () => [],
    modelLabel: () => "GPT-6 Sol",
    // Paint at once: a test wants the frame the key produced.
    scheduleDraw: () => t.renderViewport(),
  });
  setTermWidthOverride(t.contentCols());
  return {
    t,
    frame: () => painted.map((row) => stripAnsi(row).trimEnd()),
    key: (k) => t.routeKey(k),
    type: (text) => {
      for (const value of text) t.routeKey({ type: "char", value });
    },
  };
}

/** Three members through a real renderer: two in flight, one back. */
function fanOut(r: Rig): TurnRenderer {
  const turn = new TurnRenderer({ commit: () => {}, preview: () => {} }, { getCost: () => 0 });
  for (const [id, tool, name] of [
    ["c1", "task", "planner"],
    ["c2", "worker", "builder"],
    ["c3", "task", "verifier"],
  ] as const) {
    turn.onEvent({ type: "tool_call_start", callId: id, toolName: tool } as never);
    turn.onEvent({
      type: "tool_call_args_delta",
      callId: id,
      partialJson: JSON.stringify({ name, label: `${name} work`, prompt: `Brief for ${name}.` }),
    } as never);
    turn.onEvent({ type: "tool_progress", callId: id, note: "", state: "started" } as never);
  }
  const child = (id: string, event: Record<string, unknown>) =>
    turn.onEvent({
      type: "tool_progress",
      callId: id,
      note: "",
      child: { agentId: id, event },
    } as never);
  child("c1", { type: "text_delta", text: "Reading the settings table." });
  child("c1", { type: "tool_call_start", callId: "t1", toolName: "read_file" });
  child("c1", {
    type: "tool_call_end",
    callId: "t1",
    args: { path: "src/config-settings.ts" },
    output: {
      callId: "t1",
      toolName: "read_file",
      success: true,
      result: JSON.stringify({
        path: "src/config-settings.ts",
        total_lines: 3,
        content: "   1\texport const A = 1;",
      }),
      durationMs: 12,
    },
  });
  child("c2", { type: "text_delta", text: "Adding the setting." });
  // verifier has come back: its call landed in the lead's transcript.
  turn.onEvent({
    type: "tool_call_end",
    callId: "c3",
    args: {},
    output: {
      callId: "c3",
      toolName: "task",
      success: true,
      result: "done",
      durationMs: 9,
      structured: { task_id: "task_00000000-0000-0000-0000-000000000003" },
    },
  } as never);
  r.t.liveTurn = turn;
  r.t.turnPreview = turn.liveLines();
  r.t.renderViewport();
  return turn;
}

/** The row directly above the composer's top rule: the rung. */
function rung(frame: string[]): { row: string; index: number } {
  const index = frame.findIndex((row) => /^\s*[▁-█_.:\-=+*#]{6,}\s+\S/.test(row));
  return { row: frame[index] ?? "", index };
}

const RIGHT: Key = { type: "right" };
const LEFT: Key = { type: "left" };
const ENTER: Key = { type: "enter" };
const ESC: Key = { type: "esc" };
const CTRL_F: Key = { type: "ctrl", name: "f" };
const CTRL_W: Key = { type: "ctrl", name: "w" };

// ─── The table ───

describe("the agents keys, as a table", () => {
  const state = (over: Partial<AgentKeyState> = {}): AgentKeyState => ({
    focus: "composer",
    members: 3,
    empty: true,
    streaming: true,
    ...over,
  });

  test("the right arrow on an empty composer steps onto the row", () => {
    expect(agentKeyAction(RIGHT, state())).toEqual({ kind: "focus" });
    // At rest too: a finished agent is as reachable as a running one.
    expect(agentKeyAction(RIGHT, state({ streaming: false }))).toEqual({ kind: "focus" });
  });

  test("but never over a draft, and never with nobody to select", () => {
    // Over a draft the arrow is the caret's.
    expect(agentKeyAction(RIGHT, state({ empty: false })).kind).toBe("none");
    expect(agentKeyAction(RIGHT, state({ members: 0 })).kind).toBe("none");
  });

  test("the wheel cannot focus the row: up and down are not entry keys", () => {
    // Alternate-scroll mode delivers the wheel as arrows, one per read on a
    // slow trackpad. An overshoot at the bottom of the transcript must stay a
    // no-op, not a mode change.
    expect(entersAgentRow({ type: "up" }, state())).toBe(false);
    expect(entersAgentRow({ type: "down" }, state())).toBe(false);
    // And left already has a job at rest: it opens the sessions panel.
    expect(entersAgentRow(LEFT, state({ streaming: false }))).toBe(false);
  });

  test("on the row: arrows move, enter opens, esc goes back", () => {
    const row = state({ focus: "row" });
    expect(agentKeyAction(LEFT, row)).toEqual({ kind: "move", delta: -1 });
    expect(agentKeyAction(RIGHT, row)).toEqual({ kind: "move", delta: 1 });
    expect(agentKeyAction(ENTER, row)).toEqual({ kind: "open" });
    expect(agentKeyAction(ESC, row)).toEqual({ kind: "back" });
    // Up and down keep reading the lead's transcript.
    expect(agentKeyAction({ type: "up" }, row).kind).toBe("none");
  });

  test("on the row no printable key is an agents key -- not even a digit", () => {
    const row = state({ focus: "row" });
    for (const value of ["c", "1", "9", "a", " ", "?"]) {
      expect(agentKeyAction({ type: "char", value }, row).kind).toBe("none");
    }
    // And enter over a draft sends the draft: it does not open a transcript.
    expect(agentKeyAction(ENTER, state({ focus: "row", empty: false })).kind).toBe("none");
  });

  test("on the cards: up/down, digits, c and enter", () => {
    const cards = state({ focus: "cards" });
    expect(agentKeyAction({ type: "up" }, cards)).toEqual({ kind: "move", delta: -1 });
    expect(agentKeyAction({ type: "down" }, cards)).toEqual({ kind: "move", delta: 1 });
    expect(agentKeyAction({ type: "char", value: "3" }, cards)).toEqual({
      kind: "jump",
      ordinal: 3,
    });
    expect(agentKeyAction({ type: "char", value: "c" }, cards)).toEqual({ kind: "clear" });
    expect(agentKeyAction(ENTER, cards)).toEqual({ kind: "open" });
    expect(agentKeyAction(ESC, cards)).toEqual({ kind: "back" });
  });

  test("in a transcript: arrows switch, but only with nothing typed", () => {
    const view = state({ focus: "view" });
    expect(agentKeyAction(RIGHT, view)).toEqual({ kind: "move", delta: 1 });
    expect(agentKeyAction(LEFT, view)).toEqual({ kind: "move", delta: -1 });
    expect(agentKeyAction(RIGHT, state({ focus: "view", empty: false })).kind).toBe("none");
    // With one agent there is nothing to switch to -- and the key is still the
    // transcript's: let through, `left` would open the sessions panel over it.
    expect(agentKeyAction(RIGHT, state({ focus: "view", members: 1 })).kind).toBe("stay");
    expect(agentKeyAction(LEFT, state({ focus: "view", members: 1 })).kind).toBe("stay");
    expect(agentKeyAction(ESC, view)).toEqual({ kind: "back" });
    // Enter there belongs to the composer: it steers the lead.
    expect(agentKeyAction(ENTER, view).kind).toBe("none");
  });

  test("ctrl+f is the cards from anywhere; esc is never an agents key on the composer", () => {
    for (const focus of ["composer", "row", "cards", "view"] as const) {
      expect(agentKeyAction(CTRL_F, state({ focus }))).toEqual({ kind: "cards" });
    }
    // With the keys on the composer esc must reach the turn, where it stops it.
    expect(agentKeyAction(ESC, state()).kind).toBe("none");
  });
});

// ─── Through the real controller ───

describe("reaching a sub-agent while the turn is running", () => {
  test("right selects, right moves, enter opens the live transcript", () => {
    const r = rig();
    fanOut(r);
    // Before: the members in flight, and the key that reaches them.
    expect(rung(r.frame()).row).toContain("[planner] [builder]");
    expect(rung(r.frame()).row).toContain(AGENTS_KEY_HINT);

    r.key(RIGHT);
    expect(r.t.agentFocus()).toBe("row");
    // The selector is the whole roster, the finished member included, with the
    // mark on the first.
    expect(rung(r.frame()).row).toContain("›[planner] [builder] [verifier ✓]");

    r.key(RIGHT);
    expect(rung(r.frame()).row).toContain("[planner]›[builder] [verifier ✓]");

    r.key(LEFT);
    r.key(ENTER);
    expect(r.t.agentFocus()).toBe("view");
    expect(r.t.childPane?.id).toBe("c1");
    const frame = r.frame();
    const header = frame.find((row) => row.includes("planner") && row.includes("esc back"));
    expect(header).toBeDefined();
    const text = frame.join("\n");
    // What it was asked, what it said, and what it ran -- with the path.
    expect(text).toContain("Brief for planner.");
    expect(text).toContain("Reading the settings table.");
    expect(text).toContain("src/config-settings.ts");
    expect(text).toContain("export const A = 1;");
    // The lead's own transcript gave the workspace up.
    expect(text).not.toContain("lead row one");
  });

  test("ctrl+f opens the cards mid-turn, and enter there shows the transcript", () => {
    const r = rig();
    fanOut(r);
    r.key(CTRL_F);
    // It was unbound for the whole of a running turn.
    expect(r.t.panelOverlay).toBe(true);
    expect(r.t.agentFocus()).toBe("cards");
    expect(r.frame().join("\n")).toContain("AGENTS");

    r.key(ENTER);
    // The cards give way. They used to stay up, over the pane they had opened.
    expect(r.t.panelOverlay).toBe(false);
    expect(r.t.agentFocus()).toBe("view");
    const text = r.frame().join("\n");
    expect(text).not.toContain("AGENTS  ");
    expect(text).toContain("Brief for planner.");
  });

  test("esc steps back and does not interrupt the run", () => {
    const r = rig();
    fanOut(r);
    r.key(RIGHT);
    r.key(ENTER);
    r.key(ESC);
    expect(r.t.aborts).toBe(0);
    expect(r.t.childPane).toBeNull();
    expect(r.t.agentFocus()).toBe("composer");
    expect(r.frame().join("\n")).toContain("lead row one");

    // From the row, and from the cards, the same.
    r.key(RIGHT);
    r.key(ESC);
    r.key(CTRL_F);
    r.key(ESC);
    expect(r.t.aborts).toBe(0);
    expect(r.t.agentFocus()).toBe("composer");

    // And with the keys back on the composer, esc is the turn's again.
    r.key(ESC);
    expect(r.t.aborts).toBe(1);
  });

  test("ctrl+w closes the transcript mid-turn, and the card stops saying OPEN", () => {
    const r = rig();
    fanOut(r);
    r.key(RIGHT);
    r.key(ENTER);
    expect(fleetLedger.view(false).openId).toBe("c1");
    r.key(CTRL_W);
    expect(r.t.childPane).toBeNull();
    // The ledger's record of what is open went with the pane.
    expect(fleetLedger.view(false).openId).toBeNull();
  });

  test("inside a transcript the arrows turn to the neighbour's", () => {
    const r = rig();
    fanOut(r);
    r.key(RIGHT);
    r.key(ENTER);
    r.key(RIGHT);
    expect(r.t.childPane?.id).toBe("c2");
    expect(r.frame().join("\n")).toContain("Adding the setting.");
    expect(rung(r.frame()).row).toContain("[planner]›[builder]");
    r.key(RIGHT);
    expect(r.t.childPane?.id).toBe("c3");
    // Wrapping, like every other list.
    r.key(RIGHT);
    expect(r.t.childPane?.id).toBe("c1");
  });

  test("a transcript opened mid-run keeps filling", () => {
    const r = rig();
    const turn = fanOut(r);
    r.key(RIGHT);
    r.key(ENTER);
    const before = fleetLedger.paneRevision();
    expect(r.frame().join("\n")).not.toContain("validateSetting");
    turn.onEvent({
      type: "tool_progress",
      callId: "c1",
      note: "",
      child: {
        agentId: "c1",
        event: { type: "text_delta", text: " Validation is validateSetting." },
      },
    } as never);
    // The tick repaints on this number; without it the pane only moved when
    // the row above the composer happened to.
    expect(fleetLedger.paneRevision()).toBeGreaterThan(before);
    r.t.renderViewport();
    expect(r.frame().join("\n")).toContain("validateSetting");
  });
});

describe("the key that reaches the agents is always said", () => {
  test("at 80 columns the row's own words give way to it, not the other way round", () => {
    // Without the reservation the row is: mark, stage, the fact (`scouting the
    // relevant subsystem`), two blocks -- 75 cells of a 75-cell row, and the
    // hint is the part that does not fit. That was already true at a hundred
    // columns whenever a voice line was drawn, so the one hint that says the
    // agents can be opened was missing exactly when there were agents.
    const r = rig({ columns: 80, rows: 24 });
    fanOut(r);
    const row = rung(r.frame()).row;
    expect(row).toContain("[planner] [builder]");
    expect(row).toContain(AGENTS_KEY_HINT);
    expect(visLen(row)).toBeLessThanOrEqual(79);
  });

  test("and it is not said once the keys are already there", () => {
    const r = rig({ columns: 80, rows: 24 });
    fanOut(r);
    r.key(RIGHT);
    expect(rung(r.frame()).row).not.toContain(AGENTS_KEY_HINT);
    r.key(ESC);
    r.key(CTRL_F);
    // With the cards up the rung does not advertise the way to the agents.
    expect(rung(r.frame()).row).not.toContain(AGENTS_KEY_HINT);
  });
});

describe("in a colour terminal", () => {
  /**
   * Colour is decided once, when ./theme loads, from whether stdout is a
   * terminal -- so nothing in THIS process can see what a colour terminal
   * draws. A child process that says it is a terminal before it imports the
   * theme can.
   */
  function inColour(body: string): { colour: boolean; plain: string; raw: string } {
    const ui = new URL("../../../packages/orchestrator/src/bin/ui", import.meta.url).pathname;
    const script = `
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      process.env.COLORTERM = "truecolor";
      delete process.env.NO_COLOR;
      const { TurnRenderer } = await import("${ui}/turn.ts");
      const { fleetLedger } = await import("${ui}/agents-panel.ts");
      const { stripAnsi } = await import("${ui}/theme.ts");
      const { setTermWidthOverride } = await import("${ui}/render.ts");
      setTermWidthOverride(100);
      const turn = new TurnRenderer({ commit() {}, preview() {} }, { getCost: () => 0 });
      for (const [id, name] of [["c1", "planner"], ["c2", "builder"]]) {
        turn.onEvent({ type: "tool_call_start", callId: id, toolName: "task" });
        turn.onEvent({ type: "tool_call_args_delta", callId: id, partialJson: JSON.stringify({ name, label: name + " work" }) });
        turn.onEvent({ type: "tool_progress", callId: id, note: "", state: "started" });
      }
      ${body}
      const row = turn.liveLines()[0];
      process.stdout.write(JSON.stringify({ colour: row.includes("\x1b["), plain: stripAnsi(row), raw: row }));
    `;
    const proc = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString();
    if (!out.trim().startsWith("{")) throw new Error(`no frame: ${proc.stderr.toString()}`);
    return JSON.parse(out);
  }

  test("the rung does not end on a separator with nothing after it", () => {
    const row = inColour("");
    // The premise: this really was drawn in colour.
    expect(row.colour).toBe(true);
    expect(row.plain).toContain("[planner] [builder]");
    // `[planner] [builder] ·` -- a middot owed to a detail that was never there.
    expect(row.plain.trimEnd().endsWith("]")).toBe(true);
    expect(row.plain).not.toMatch(/\]\s+[·.]\s*$/);
  });

  test("the selected block carries the selection ink, and only that block", () => {
    const row = inColour(`fleetLedger.setFocus("row"); fleetLedger.selectIndex(2);`);
    expect(row.plain).toContain("[planner]›[builder]");
    // The fill opens immediately before the selected block's bracket and is
    // closed before anything else is drawn: a background sequence, the block,
    // a reset.
    expect(row.raw).toMatch(/\x1b\[48;[0-9;]+m(\x1b\[38;[0-9;]+m)?\[builder\]\x1b\[0m/);
    expect(row.raw).not.toMatch(/\x1b\[48;[0-9;]+m(\x1b\[38;[0-9;]+m)?\[planner\]/);
  });
});

describe("typing is never swallowed", () => {
  test("a character on the row lands in the composer and takes the keys back", () => {
    const r = rig();
    fanOut(r);
    r.key(RIGHT);
    expect(r.t.agentFocus()).toBe("row");
    r.type("can 1");
    // Every character, including the `c` and the digit the cards claim.
    expect(r.t.input).toBe("can 1");
    expect(r.t.agentFocus()).toBe("composer");
    // So enter is the composer's: it does not open a transcript.
    r.key(ENTER);
    expect(r.t.childPane).toBeNull();
  });

  test("a lone down arrow at the tail does not focus the row", () => {
    const r = rig();
    fanOut(r);
    r.key({ type: "down" });
    r.key({ type: "up" });
    expect(r.t.agentFocus()).toBe("composer");
  });

  test("the right arrow over a draft moves the caret, not the focus", () => {
    const r = rig();
    fanOut(r);
    r.type("hi");
    r.key(LEFT);
    r.key(RIGHT);
    expect(r.t.agentFocus()).toBe("composer");
    expect(r.t.caret).toBe(2);
  });
});

describe("nothing moves when the keys do", () => {
  test("the rung stays on its row through every focus", () => {
    const r = rig();
    fanOut(r);
    const at = rung(r.frame()).index;
    expect(at).toBeGreaterThan(0);
    r.key(RIGHT);
    expect(rung(r.frame()).index).toBe(at);
    r.key(ENTER);
    expect(rung(r.frame()).index).toBe(at);
    r.key(ESC);
    r.key(CTRL_F);
    expect(rung(r.frame()).index).toBe(at);
    r.key(ESC);
    expect(rung(r.frame()).index).toBe(at);
    // The frame is always exactly the window.
    expect(r.frame()).toHaveLength(30);
  });

  test("the status strip names the way back, and never `esc stop`, while away", () => {
    const r = rig();
    fanOut(r);
    const strip = () => r.frame().at(-1) ?? "";
    expect(strip()).toContain("esc stop");
    r.key(RIGHT);
    expect(strip()).toContain("esc back");
    expect(strip()).not.toContain("esc stop");
    expect(strip()).toContain("enter open");
    r.key(ENTER);
    expect(strip()).toContain("esc back");
    expect(strip()).not.toContain("esc stop");
    r.key(ESC);
    expect(strip()).toContain("esc stop");
  });

  test("every painted row fits the window at 80 columns too", () => {
    const r = rig({ columns: 80, rows: 24 });
    fanOut(r);
    for (const keys of [[RIGHT], [ENTER], [RIGHT], [ESC], [CTRL_F]]) {
      for (const k of keys) r.key(k);
      for (const row of r.frame()) expect(visLen(row)).toBeLessThanOrEqual(80);
      expect(r.frame()).toHaveLength(24);
    }
  });
});

describe("at rest, a finished agent is still one key away", () => {
  test("the row offers them, and enter opens what they did", () => {
    const r = rig({ mode: "turn" });
    const turn = fanOut(r);
    for (const id of ["c1", "c2"]) {
      turn.onEvent({
        type: "tool_call_end",
        callId: id,
        args: {},
        output: { callId: id, toolName: "task", success: true, result: "ok", durationMs: 1 },
      } as never);
    }
    r.t.mode = "input";
    r.t.liveTurn = null;
    r.t.turnPreview = null;
    r.t.lastTurnMs = 61_000;
    r.t.renderViewport();
    expect(rung(r.frame()).row).toContain("3 agents back");
    expect(rung(r.frame()).row).toContain(AGENTS_KEY_HINT);

    r.key(RIGHT);
    expect(rung(r.frame()).row).toContain("›[planner ✓] [builder ✓] [verifier ✓]");
    r.key(ENTER);
    expect(r.frame().join("\n")).toContain("src/config-settings.ts");
    r.key(ESC);
    expect(rung(r.frame()).row).toContain("3 agents back");
  });
});

// ─── The four-region frame, which is opt-in and must not have moved ───

describe('with a right column (`[ui] layout = "split"`)', () => {
  beforeEach(() => setUiLayout("split"));
  afterEach(() => setUiLayout("single"));

  test("the right arrow goes to the cards, which are already on screen", () => {
    const r = rig({ columns: 140, rows: 40 });
    fanOut(r);
    r.key(RIGHT);
    // No row to select on: the cards are beside the workspace.
    expect(r.t.agentFocus()).toBe("cards");
    expect(r.t.panelOverlay).toBe(false);
    r.key({ type: "down" });
    r.key(ENTER);
    expect(r.t.childPane?.id).toBe("c2");
    // The STACKED split, as it was: the lead's transcript keeps its rows.
    const text = r.frame().join("\n");
    expect(text).toContain("lead row one");
    expect(text).toContain("Adding the setting.");
    expect(text).toContain("ctrl+w close");
  });

  test("esc from the workspace's turn in the ring does not interrupt the run", () => {
    const r = rig({ columns: 140, rows: 40 });
    fanOut(r);
    // composer -> panel -> workspace
    r.key(CTRL_F);
    r.key(CTRL_F);
    expect(r.t.focus).toBe("workspace");
    r.key(ESC);
    expect(r.t.aborts).toBe(0);
    expect(r.t.focus).toBe("composer");
    // And from the composer it is the turn's, as always.
    r.key(ESC);
    expect(r.t.aborts).toBe(1);
  });

  test("the cards' legend keeps its row there, where the panel pays for it", () => {
    const r = rig({ columns: 140, rows: 40 });
    fanOut(r);
    r.key(RIGHT);
    const text = r.frame().join("\n");
    expect(text).toContain("up/down select");
    // The strip only has to say the way out.
    expect(r.frame().at(-1)).toContain("esc back");
  });
});

// ─── The selector ───

describe("the blocks as a selector", () => {
  const card = (id: string, name: string, over: Partial<AgentCard> = {}): AgentCard => ({
    id,
    name,
    brief: "",
    kind: "task",
    state: "running",
    note: "",
    tokens: 0,
    costUsd: 0,
    tools: 0,
    checks: 0,
    checksPassed: 0,
    reroutes: 0,
    pulseStep: 3,
    quietMs: 0,
    retired: false,
    ...over,
  });

  test("marks one block and leaves the others where they were", () => {
    const cards = [card("a", "planner"), card("b", "builder"), card("c", "verifier")];
    const second = stripAnsi(agentBlocks(cards, 60, { selectedId: "b" }));
    const third = stripAnsi(agentBlocks(cards, 60, { selectedId: "c" }));
    expect(second).toBe("[planner]›[builder] [verifier]");
    expect(third).toBe("[planner] [builder]›[verifier]");
    // Moving the selection changes two cells and shifts nothing.
    expect(second.length).toBe(third.length);
    expect(second.indexOf("[verifier]")).toBe(third.indexOf("[verifier]"));
  });

  test("with no selection it is the row it always was", () => {
    const cards = [card("a", "planner"), card("b", "builder")];
    expect(stripAnsi(agentBlocks(cards, 60))).toBe("[planner] [builder]");
    expect(stripAnsi(agentBlocks(cards, 60, { selectedId: null }))).toBe("[planner] [builder]");
    // An id that is not in the roster is no selection, not a crash.
    expect(stripAnsi(agentBlocks(cards, 60, { selectedId: "zz" }))).toBe("[planner] [builder]");
  });

  test("windows a wide fan-out around the selection and counts both sides", () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(`c${i}`, `agent${i}`));
    for (const selected of [0, 5, 11]) {
      const row = stripAnsi(agentBlocks(cards, 40, { selectedId: `c${selected}` }));
      // The selected one is always drawn, never counted away.
      expect(row).toContain(`›[agent${selected}]`);
      expect(visLen(row)).toBeLessThanOrEqual(40);
      // Every member is drawn or counted: nobody is dropped silently.
      const drawn = (row.match(/\[agent\d+\]/g) ?? []).length;
      const counted = (row.match(/\+(\d+)/g) ?? []).reduce((n, m) => n + Number(m.slice(1)), 0);
      expect(drawn + counted).toBe(12);
    }
    const middle = stripAnsi(agentBlocks(cards, 40, { selectedId: "c5" }));
    expect(middle.startsWith("+")).toBe(true);
    expect(/\+\d+$/.test(middle)).toBe(true);
  });

  test("the legend is a ladder that keeps the way out", () => {
    const view = { running: [], finished: [], selectedId: null, openId: null, focused: true };
    expect(stripAnsi(agentsHint("row", view))).toContain("left/right select");
    // Squeezed, the way out is the last thing to go.
    expect(stripAnsi(agentsHint("row", view, 24))).toBe("enter open · esc back");
    expect(stripAnsi(agentsHint("view", view, 10))).toBe("esc back");
    expect(agentsHint("composer", view)).toBe("");
  });
});

// ─── The pane's shape ───

describe("one column gives the transcript the workspace", () => {
  test("zoomPane has no refusal and one header row", () => {
    expect(zoomPane(16)).toEqual({
      open: true,
      refused: false,
      mainRows: 0,
      headerRows: 1,
      childRows: 15,
    });
    // The stacked split refuses below fourteen rows; this does not.
    expect(splitPanes(8, true).refused).toBe(true);
    expect(zoomPane(8).refused).toBe(false);
    expect(zoomPane(8).childRows).toBe(7);
  });

  test("the frame picks the shape by layout", () => {
    const r = rig();
    r.t.childPane = { id: "x", name: "x", lines: [] };
    // One column: the transcript has it all.
    expect(r.t.panesNow(20, true).mainRows).toBe(0);
    // A right column: the stacked split, untouched.
    expect(r.t.panesNow(20, false)).toEqual(splitPanes(20, true));
    r.t.childPane = null;
    expect(r.t.panesNow(20, true).open).toBe(false);
  });
});
