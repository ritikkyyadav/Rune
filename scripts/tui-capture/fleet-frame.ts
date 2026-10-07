/**
 * The AGENTS column, drawn by the product's own code, inside the real frame.
 *
 * Lane A's `frame-demo.ts` invents the right column as literal strings — it had
 * to, because the panel did not exist yet. This is the same rig with that half
 * replaced: the cards here are registered by the real `TurnRenderer` from real
 * `AgentTurnEvent`s, the rows are `renderAgentsPanel` / `renderSessionPanel`
 * and the renderer's own rung, the child pane's header is built from the ledger's own
 * `refreshPane`, and the geometry is `regions` / `splitPanes` / `composeFrame`.
 * Only the WORKSPACE is invented, and only because Lane D's boxes are not built
 * yet — it is obviously invented, and no verdict here is taken from it.
 *
 * ZERO model calls, by construction: nothing in this file touches a gateway, a
 * provider or `~/.rune`. The events are written out below, one object at a time.
 *
 *     bun scripts/tui-capture/fleet-frame.ts OUTDIR
 *
 * With a second argument it also diffs the right column against the mocks in
 * docs/program/phase-4-mocks/ and prints a per-frame verdict:
 *
 *     bun scripts/tui-capture/fleet-frame.ts OUTDIR --compare
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeFrame,
  regions,
  splitPanes,
  PANEL_COLS,
  type Regions,
} from "../../packages/orchestrator/src/bin/ui/viewport";
import { setTermWidthOverride } from "../../packages/orchestrator/src/bin/ui/render";
import { stripAnsi } from "../../packages/orchestrator/src/bin/ui/theme";
import { TurnRenderer, type TurnSink } from "../../packages/orchestrator/src/bin/ui/turn";
import {
  fleetLedger,
  renderAgentsPanel,
  renderSessionPanel,
} from "../../packages/orchestrator/src/bin/ui/agents-panel";

const HEADER_ROWS = 3;
const RULE = "─";
const w = (s: string): number => [...s].length;
const pad = (s: string, n: number): string =>
  w(s) >= n ? [...s].slice(0, n).join("") : s + " ".repeat(n - w(s));
/** flow's 2-cell indent; the right column's gutter is 1. */
const tight = (s: string): string => (s.startsWith(" ") ? s.slice(1) : s);

function header(cols: number): string[] {
  const usable = cols - 1;
  const left = "  R U N E  ~/Project/Alan";
  const right = "v0.4.1-dev+62f02d0";
  const gap = Math.max(1, usable - w(left) - w(right));
  return ["", `${left}${" ".repeat(gap)}${right}`, `  ${"━".repeat(7)}${RULE.repeat(usable - 9)}`];
}

function composer(r: Regions, lines: string[], hint: string): string[] {
  const width = r.collapsed ? r.workspaceCols - 4 : PANEL_COLS - 2;
  const edge = tight(`  ${RULE.repeat(width)}`);
  return [
    edge,
    ...lines.map((l) => tight(`  ${pad(l, width)}`.trimEnd())),
    edge,
    tight(`  ${hint}`),
  ];
}

// ─── The fan-out, as events ───

const sink: TurnSink = { commit: () => {}, preview: () => {} };

/** One delegation, exactly as the stream delivers it: the call opens, then its
 *  arguments stream in as JSON fragments. */
function dispatch(
  turn: TurnRenderer,
  callId: string,
  args: Record<string, unknown>,
  toolName: "task" | "worker" = "task",
): void {
  turn.onEvent({ type: "tool_call_start", callId, toolName } as never);
  turn.onEvent({
    type: "tool_call_args_delta",
    callId,
    partialJson: JSON.stringify(args),
  } as never);
}

const started = (id: string) => ({ type: "tool_progress", callId: id, note: "", state: "started" });
const beat = (id: string, note: string) => ({ type: "tool_progress", callId: id, note });
const fromChild = (id: string, event: Record<string, unknown>) => ({
  type: "tool_progress",
  callId: id,
  note: "",
  child: { agentId: id, event },
});

/**
 * Four members, at the ages the mock draws them: planner 2m04, builder 1m12,
 * verifier 48s and quiet 9s, scribe back at 31s.
 *
 * The clocks are set by handing the renderer a `now` in the past, which is the
 * only way a capture can show a two-minute-old agent without waiting two
 * minutes — the elapsed reading is still computed by the product from the
 * card's own `startedAt`.
 */
function fanOut(now: number): TurnRenderer {
  fleetLedger.reset();
  const turn = new TurnRenderer(sink, { getCost: () => 0 });
  dispatch(turn, "c1", { name: "planner", label: "map the settings surface" });
  dispatch(turn, "c2", { name: "builder", label: "build the setup wizard" }, "worker");
  dispatch(turn, "c3", { name: "verifier", label: "re-run the frame captures" });
  dispatch(turn, "c4", { name: "scribe", label: "write the help copy" });
  for (const id of ["c1", "c2", "c3", "c4"]) turn.onEvent(started(id) as never);
  // Backdate each card's clock. `startedAt` is the product's own field; only
  // the value is supplied here, and only because a capture cannot wait.
  const ages: Record<string, number> = { c1: 124_000, c2: 72_000, c3: 48_000, c4: 31_000 };
  for (const [id, age] of Object.entries(ages)) {
    const cardOf = fleetLedger.get(id);
    if (cardOf) cardOf.startedAt = now + QUIET_GAP_MS - age;
  }
  // Tokens and tools, from the children's own forwarded events. Each member's
  // LAST `tool_call_end` carries the note the parent projected from it, which
  // is exactly the shape the real stream delivers -- the heartbeat on the card
  // and the tool that produced it are one event, not two.
  const usage: Record<string, [number, number, number, string]> = {
    c1: [10_900, 1_500, 9, "read  config-settings.ts"],
    c2: [7_100, 1_000, 6, "edit  first-run.ts"],
    c3: [2_900, 300, 4, "bun test ui-frame.test.ts"],
    c4: [2_600, 300, 3, ""],
  };
  for (const [id, [input, output, tools, note]] of Object.entries(usage)) {
    turn.onEvent(
      fromChild(id, { type: "usage", inputTokens: input, outputTokens: output }) as never,
    );
    for (let i = 0; i < tools; i++) {
      turn.onEvent({
        type: "tool_progress",
        callId: id,
        note: i === tools - 1 ? note : "",
        child: {
          agentId: id,
          event: {
            type: "tool_call_end",
            callId: `${id}-t${i}`,
            output: { toolName: "read_file", success: true },
          },
        },
      } as never);
    }
  }
  // The scribe is back: its call landed in the transcript, so it gives up its
  // rung slot and keeps its card in the finished section.
  turn.onEvent({
    type: "tool_call_end",
    callId: "c4",
    toolName: "task",
    output: { toolName: "task", success: true },
  } as never);
  const scribe = fleetLedger.get("c4");
  if (scribe) scribe.endedAt = now + QUIET_GAP_MS;
  // The pulses, at the rates the mock draws: the planner streaming hard, the
  // builder steadily, the verifier silent for nine seconds. The events above
  // fed every accumulator at the wall clock, so the capture instant is nine
  // seconds LATER -- by then those feeds have decayed through ten half-lives
  // and the levels below are the only thing left in them. The glyph is still
  // computed by `Pulse.sample` from these units: a cell here is a cell the
  // product would draw at that rate, not one picked by hand.
  for (const [id, units] of [
    ["c1", 1_700],
    ["c2", 550],
  ] as const) {
    fleetLedger.feed(id, units, now + QUIET_GAP_MS);
  }
  fleetLedger.sample(now + QUIET_GAP_MS);
  return turn;
}

/** How long after the fan-out's events the capture is taken. Nine seconds,
 *  because that is the stall the mock's verifier row is reporting. */
const QUIET_GAP_MS = 9_200;

/** The same fan-out, with agent 3's transcript open and a failing check on it. */
function fanOutWithOpenPane(now: number): TurnRenderer {
  const turn = fanOut(now);
  turn.onEvent(
    fromChild("c3", {
      type: "verification_completed",
      attempt: 1,
      ran: true,
      passed: false,
      report: "1 fail",
    }) as never,
  );
  fleetLedger.selectIndex(3);
  const card = fleetLedger.get("c3");
  if (card) {
    fleetLedger.attachPane({ id: card.id, name: card.name, lines: fleetLedger.buffer(card.id) });
    fleetLedger.refreshPane(now + QUIET_GAP_MS);
  }
  return turn;
}

// ─── The frame ───

interface FrameInput {
  cols: number;
  rows: number;
  main: string[];
  panelRows: string[];
  strip?: string;
  composerRows: string[];
  hint: string;
  child?: { name: string; note: string; lines: string[] };
  status: string;
}

function frame(input: FrameInput): string[] {
  const usable = input.cols - 1;
  const head = header(input.cols);
  const probe = regions({
    columns: input.cols,
    rows: input.rows,
    headerRows: HEADER_ROWS,
    strip: true,
  });
  const comp = composer(probe, input.composerRows, input.hint);
  const r = regions({
    columns: input.cols,
    rows: input.rows,
    headerRows: HEADER_ROWS,
    composerRows: comp.length,
    strip: true,
  });
  const panes = splitPanes(r.workspaceRows, input.child != null);

  const left: string[] = [];
  const main = input.main.slice(0, panes.mainRows);
  while (main.length < panes.mainRows) main.push("");
  left.push(...main.map((l) => (l ? `  ${l}` : "")));
  if (input.child && panes.open) {
    // The product's own header shape (tui-frame.childHeader): `── name ── note
    // ── ctrl+w close ──`, filled to the workspace measure so it reads as a
    // seam and not as content.
    const parts = [input.child.name, input.child.note, "ctrl+w close"].filter((p) => p !== "");
    const body = ` ${parts.join(` ${RULE}${RULE} `)} `;
    const fill = Math.max(2, r.workspaceCols - 2 - w(body) - 2);
    left.push(`  ${RULE}${RULE}${body}${RULE.repeat(fill)}`);
    const kid = input.child.lines.slice(0, panes.childRows);
    while (kid.length < panes.childRows) kid.push("");
    left.push(...kid.map((l) => (l ? `  ${l}` : "")));
  }

  const right: string[] = [];
  if (r.collapsed) {
    if (input.strip) left.push(`  ${input.strip}`);
    left.push(...comp.slice(-r.composerRows));
  } else {
    const column = input.panelRows.map((l) => tight(`  ${l}`));
    while (column.length < r.panelRows) column.push("");
    right.push(...column.slice(0, r.panelRows));
    right.push(...comp.slice(-r.composerRows));
  }

  return composeFrame({
    rows: input.rows,
    header: head,
    transcript: [],
    footer: [`  ${input.status}`],
    scroll: 0,
    caretRow: 0,
    caretCol: 0,
    band: { regions: r, left, right, divider: "│", width: w },
  }).rows.map((l) => l.trimEnd());
}

// ─── Invented workspace content (Lane D owns the real boxes) ───

const BOX = (width: number, title: string, body: string[], receipt: string): string[] => [
  `┌ ${title} ${RULE.repeat(Math.max(1, width - w(title) - 5))}┐`,
  ...body.map((l) => `│ ${pad(l, width - 4)} │`),
  `└ ${receipt} ${RULE.repeat(Math.max(1, width - w(receipt) - 5))}┘`,
];

const WORK_MAIN = [
  "◇ Four lanes, named: planner has the settings surface, builder the",
  "  wizard, verifier the frame captures, scribe the help copy.",
  "",
  ...BOX(
    74,
    "read  packages/orchestrator/src/config-settings.ts",
    [
      "export const CONFIG_SETTINGS: ConfigSetting[] = [",
      '  { key: "max_turns", kind: "number", min: 1, max: 400 },',
      "… 204 unchanged lines",
    ],
    "· observed · 212 lines · 0.2s",
  ),
  "",
  "◇ Geometry holds at 120. Verifier is re-running the same captures",
  "  at 80 columns; I will not call it settled until that comes back.",
];

const CHILD_MAIN = [
  "◇ Capturing at 80x24 first, since that is where the right column",
  "  is supposed to collapse.",
  "",
  ...BOX(
    74,
    "run   bun test tests/unit/orchestrator/ui-frame.test.ts",
    [
      "✓ the launch frame > every painted line ends in the same column",
      "✗ full-screen behaviour > the frame still closes on both edges",
      "  expected 79, received 80",
      "16 pass  1 fail",
    ],
    "✗ exit 1 · 1 fail · 2.4s",
  ),
  "",
  "~ Suspected: the narrow fallback is padding to cols, not cols-1.",
];

// ─── Drive it ───

const out = process.argv[2] ?? ".";
const compare = process.argv.includes("--compare");
mkdirSync(out, { recursive: true });
// The capture's clock. It has to be the WALL clock, because `Pulse` stamps
// itself with `Date.now()` when a child first reports and a `now` in the future
// would make every row read `quiet 3695s` -- which is the mechanism working, on
// a lie the rig told it.
const NOW = Date.now();
/** The instant every frame below is drawn at — see QUIET_GAP_MS. */
const AT = NOW + QUIET_GAP_MS;

const built: Record<string, string[]> = {};

// 1. Four agents at 120x40 — the panel, live.
setTermWidthOverride(119);
{
  const turn = fanOut(NOW);
  void turn;
  const panelRows = renderAgentsPanel(fleetLedger.view(true, AT), 38, 32, AT).map(stripAnsi);
  built["120x40-working-4-agents"] = frame({
    cols: 120,
    rows: 40,
    main: WORK_MAIN,
    panelRows,
    composerRows: ["› and re-run the 80-column capture"],
    hint: "enter send · ctrl+f agents · ? keys",
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 34% context · 4 files edited · sandbox on",
  });
}

// 2. Agent 3's transcript open in the workspace split.
{
  const turn = fanOutWithOpenPane(NOW);
  void turn;
  const view = fleetLedger.view(true, AT);
  const panelRows = renderAgentsPanel(view, 38, 32, AT).map(stripAnsi);
  const card = fleetLedger.get("c3")!;
  const ordinal = fleetLedger.order().findIndex((c) => c.id === card.id) + 1;
  built["120x40-split-agent-3"] = frame({
    cols: 120,
    rows: 40,
    main: WORK_MAIN.slice(0, 8),
    panelRows,
    composerRows: ["›"],
    hint: "up/down select · enter open · ctrl+w close",
    child: {
      name: `${ordinal}  ${card.name}`,
      note: `running 48s ${RULE}${RULE} 3.2k tok · 4 tools`,
      lines: CHILD_MAIN,
    },
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 36% context · agent 3 open · sandbox on",
  });
}

// 3. Idle: the session readout, with the finished roster reachable.
{
  fleetLedger.reset();
  const sessionRows = renderSessionPanel(
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
    38,
    { running: 0, finished: 4 },
  ).map(stripAnsi);
  built["120x40-idle"] = frame({
    cols: 120,
    rows: 40,
    main: [
      ...BOX(
        74,
        "run   bun test tests/unit/orchestrator/ui-frame.test.ts",
        ["17 pass  0 fail  41 expect() calls"],
        "✓ exit 0 · 1.9s",
      ),
      "",
      "◆ done                                                        3 of 4",
    ],
    panelRows: sessionRows,
    composerRows: ["› describe a change, or / for commands"],
    hint: "enter send · ctrl+f agents · ? keys",
    status: "◆ 1st gear · edits ask · gpt-5.6-sol max · 34% context · 4 files edited · sandbox on",
  });
}

// 4. 80x24 — the column collapses to one strip row above the composer.
setTermWidthOverride(79);
{
  const turn = fanOut(NOW);
  // The row above the composer is the rung itself, with a block per member
  // (tui-frame.stripRow) -- it used to be replaced by a separate agents strip.
  const strip = stripAnsi(turn.liveLines()[0] ?? "").trimStart();
  built["80x24-working"] = frame({
    cols: 80,
    rows: 24,
    main: WORK_MAIN.map((l) => l.slice(0, 75)),
    panelRows: [],
    strip,
    composerRows: ["› and re-run the 80-column capture"],
    hint: "enter send · ctrl+b line · ctrl+f agents · ? keys",
    status: "◆ 1st gear · gpt-5.6-sol · 34% context · sandbox on",
  });
}

for (const [name, rows] of Object.entries(built)) {
  const cols = name.startsWith("120") ? 120 : 80;
  const head = [
    `# frame: ${name} — right column drawn by agents-panel.ts, workspace invented`,
    `# terminal: ${rows.length} rows x ${cols} cols`,
    `#${Array.from({ length: cols }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : ".")).join("")}`,
  ];
  writeFileSync(
    join(out, `${name}.txt`),
    [...head, ...rows.map((l, i) => `${String(i + 1).padStart(2)}|${l}`)].join("\n") + "\n",
  );
  console.log(`  frame -> ${join(out, `${name}.txt`)}`);
}

// ─── The comparison ───
//
// Only the RIGHT COLUMN is compared. The workspace here is invented and the
// mock's workspace is Lane D's unbuilt box grammar, so a whole-frame diff would
// report a difference this lane cannot close and hide the one it can.

if (compare) {
  const mockDir = "docs/program/phase-4-mocks";
  const column = (line: string, cols: number): string =>
    cols === 120 ? [...line, ..." ".repeat(200)].slice(79, 119).join("").trimEnd() : line.trimEnd();
  for (const [name, rows] of Object.entries(built)) {
    const cols = name.startsWith("120") ? 120 : 80;
    let mock: string[];
    try {
      mock = readFileSync(join(mockDir, `${name}.txt`), "utf8").split("\n");
    } catch {
      console.log(`\n${name}: no mock`);
      continue;
    }
    if (cols === 80) {
      // At 80 columns there IS no right column -- it is one strip row, and the
      // rest of the frame is the workspace, which is Lane D's unbuilt box
      // grammar and this rig's invented prose. So the strip is what is
      // compared, and it is compared as a whole row.
      const ourStrip = (rows.find((l) => l.includes("ctrl+f open")) ?? "").trimEnd();
      const mockStrip = (mock.find((l) => l.includes("ctrl+f open")) ?? "").trimEnd();
      console.log(`\n${name}: strip row ${ourStrip === mockStrip ? "identical" : "differs"}`);
      if (ourStrip !== mockStrip) {
        console.log(`    ours  |${ourStrip}|\n    mock  |${mockStrip}|`);
      }
      continue;
    }
    // The mock files carry a leading blank line for some frames; align on the
    // masthead row so row N here is row N there.
    const mockTop = mock.findIndex((l) => l.includes("R U N E"));
    const ourTop = rows.findIndex((l) => l.includes("R U N E"));
    let same = 0;
    const diffs: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const ours = column(rows[i] ?? "", cols);
      const theirs = column(mock[mockTop - ourTop + i] ?? "", cols);
      if (ours === theirs) same++;
      else if (ours !== "" || theirs !== "")
        diffs.push(`  row ${i + 1}\n    ours  |${ours}|\n    mock  |${theirs}|`);
    }
    console.log(`\n${name}: ${same}/${rows.length} column rows identical`);
    for (const d of diffs.slice(0, 12)) console.log(d);
    if (diffs.length > 12) console.log(`  … ${diffs.length - 12} more differing rows`);
  }
}
