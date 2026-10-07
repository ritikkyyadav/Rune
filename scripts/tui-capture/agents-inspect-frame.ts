/**
 * Inspecting a sub-agent, painted by the REAL frame and driven by REAL keys.
 *
 * `fleet-frame.ts` beside this assembles a frame by hand out of the geometry
 * functions, which proves the panel's rows and nothing about the path a key
 * takes to reach them. That gap is exactly where this feature was broken: the
 * panel rendered correctly in every capture while `ctrl+f` was unbound for the
 * whole of a running turn and `enter` opened a transcript behind the list it
 * was pressed on.
 *
 * So nothing here is assembled. The controller is `Tui.prototype` itself over a
 * stub engine, each key goes through `routeKey`, and each frame is whatever
 * `renderBand` handed the viewport. The fan-out is real `AgentTurnEvent`s
 * through a real `TurnRenderer`.
 *
 * ZERO model calls, by construction: the engine is an object literal in this
 * file, and nothing touches a gateway, a provider or `~/.rune`.
 *
 *     bun scripts/tui-capture/agents-inspect-frame.ts OUTDIR [--cols 100] [--rows 30] [--ansi]
 *
 * `--ansi` keeps the colour (run under a pty, or with FORCE_COLOR-style env the
 * theme honours) and writes `.ansi` beside each `.txt`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argOf = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? Number(process.argv[at + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const COLS = argOf("--cols", 100);
const ROWS = argOf("--rows", 30);
const KEEP_ANSI = process.argv.includes("--ansi");
const OUT = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".";

// The window, before any UI module reads it.
Object.defineProperty(process.stdout, "columns", { value: COLS, configurable: true });
Object.defineProperty(process.stdout, "rows", { value: ROWS, configurable: true });
// Colour is decided ONCE, when ./theme loads, from whether stdout is a
// terminal. A capture written to a file is not one, so say it is -- before the
// import below -- or every frame comes out with no SGR in it at all.
if (KEEP_ANSI) {
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.env.COLORTERM ??= "truecolor";
  delete process.env.NO_COLOR;
}

const UI = "../../packages/orchestrator/src/bin/ui";
const { Tui } = await import(`${UI}/tui`);
const { fleetLedger } = await import(`${UI}/agents-panel`);
const { TurnRenderer } = await import(`${UI}/turn`);
const { stripAnsi } = await import(`${UI}/theme`);
const { setTermWidthOverride } = await import(`${UI}/render`);

// ─── A controller with a real prototype and a stub engine ───

let painted: string[] = [];

function controller(): any {
  const t: any = Object.create(Tui.prototype);
  const engine = {
    getModel: () => "gpt-6-sol",
    getProvider: () => "codex",
    getReasoningEffort: () => "high",
    getReasoningEffortLabel: () => "high",
    getPermissionMode: () => "gear-2",
    getContextUsage: () => ({ used: 48_100, limit: 140_000, percent: 34 }),
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
  };
  Object.assign(t, {
    inline: false,
    ctx: {
      engine,
      sessionId: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
      workspaceRoot: "/Users/founder/Project/Alan",
      version: "1.3.1-dev",
      customCommands: [],
    },
    transcript: [],
    focus: "composer",
    panelOverlay: false,
    childPane: null,
    childScroll: 0,
    lastChildRows: null,
    scroll: 0,
    input: "",
    caret: 0,
    mode: "turn",
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
    turnStart: Date.now() - 18_000,
    turnPreview: null,
    liveTurn: null,
    drawScheduled: false,
    lastPaint: 0,
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
    // Paint synchronously: a capture wants the frame the key produced, not the
    // one a 16ms timer will produce later.
    scheduleDraw: () => t.renderViewport(),
  });
  setTermWidthOverride(t.contentCols());
  return t;
}

// ─── The fan-out, as events ───

function fanOut(t: any): any {
  fleetLedger.reset();
  const turn = new TurnRenderer(
    { commit: () => {}, preview: () => {} },
    { getCost: () => 0, model: "gpt-6-sol" },
  );
  const dispatch = (callId: string, toolName: string, args: Record<string, unknown>) => {
    turn.onEvent({ type: "tool_call_start", callId, toolName } as never);
    turn.onEvent({
      type: "tool_call_args_delta",
      callId,
      partialJson: JSON.stringify(args),
    } as never);
    turn.onEvent({ type: "tool_progress", callId, note: "", state: "started" } as never);
  };
  dispatch("c1", "task", {
    name: "planner",
    label: "map the settings surface",
    prompt:
      "Map where settings are defined, validated and persisted. Report the files and the one function each lives in. Read-only.",
  });
  dispatch("c2", "worker", {
    name: "builder",
    label: "build the setup wizard",
    prompt: "Add a `timeout` setting to the config surface, with a test. Own src/config only.",
    files: ["src/config"],
  });
  dispatch("c3", "task", {
    name: "verifier",
    label: "re-run the frame captures",
    prompt: "Re-run the frame captures at 80 columns and report any row that overhangs.",
  });

  const child = (id: string, event: Record<string, unknown>, note = "") =>
    turn.onEvent({
      type: "tool_progress",
      callId: id,
      note,
      child: { agentId: id, event },
    } as never);
  const call = (
    id: string,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    ok = true,
  ) => {
    child(id, { type: "tool_call_start", callId, toolName });
    child(id, { type: "tool_call_args_delta", callId, partialJson: JSON.stringify(args) });
    child(id, {
      type: "tool_call_end",
      callId,
      args,
      output: {
        callId,
        toolName,
        success: ok,
        result: typeof result === "string" ? result : JSON.stringify(result),
        ...(ok ? {} : { error: String(result) }),
        durationMs: 240,
      },
    });
  };

  // planner: prose, a grep, a read, more prose -- and then a call in flight.
  child("c1", { type: "usage", inputTokens: 10_900, outputTokens: 1_500 });
  child("c1", {
    type: "thinking_delta",
    text: "Settings are probably one table plus a loader. Find the table first.",
  });
  child("c1", { type: "text_delta", text: "Starting from the config table, then its " });
  child("c1", { type: "text_delta", text: "loader. `config-settings.ts` looks like the table." });
  call(
    "c1",
    "t1",
    "grep",
    { pattern: "CONFIG_SETTINGS", path: "packages" },
    {
      total_matches: 6,
      matches: [
        { file: "packages/orchestrator/src/config-settings.ts", line_number: 41 },
        { file: "packages/orchestrator/src/settings-command.ts", line_number: 12 },
      ],
    },
  );
  call(
    "c1",
    "t2",
    "read_file",
    { path: "packages/orchestrator/src/config-settings.ts" },
    {
      path: "packages/orchestrator/src/config-settings.ts",
      total_lines: 212,
      lines_shown: 40,
      offset: 0,
      content:
        "   1\texport const CONFIG_SETTINGS: ConfigSetting[] = [\n" +
        '   2\t  { key: "max_turns", kind: "number", min: 1, max: 400 },\n' +
        '   3\t  { key: "effort", kind: "enum", values: EFFORTS },\n' +
        "   4\t];",
    },
  );
  child("c1", {
    type: "text_delta",
    text: "The table is one array; validation is `validateSetting` in the same file.",
  });
  // In flight: opened, its target known, no result yet.
  child("c1", { type: "tool_call_start", callId: "t3", toolName: "bash" });
  child("c1", {
    type: "tool_call_args_delta",
    callId: "t3",
    partialJson: '{"command":"bun test tests/unit/orchestrator/config-settings.test.ts"',
  });

  // builder: an edit with a diff.
  child("c2", { type: "usage", inputTokens: 7_100, outputTokens: 1_000 });
  child("c2", { type: "text_delta", text: "Adding the setting beside `max_turns`." });
  call(
    "c2",
    "t1",
    "edit_file",
    { path: "src/config/settings.ts" },
    {
      path: "src/config/settings.ts",
      diff:
        "--- a/src/config/settings.ts\n+++ b/src/config/settings.ts\n@@ -2,3 +2,4 @@\n" +
        '   { key: "max_turns", kind: "number", min: 1, max: 400 },\n' +
        '+  { key: "timeout", kind: "number", min: 1, max: 3600 },\n' +
        '   { key: "effort", kind: "enum", values: EFFORTS },',
    },
  );

  // verifier: a command that failed, then it came back.
  child("c3", { type: "usage", inputTokens: 2_900, outputTokens: 300 });
  call(
    "c3",
    "t1",
    "bash",
    { command: "bun test tests/unit/orchestrator/ui-frame.test.ts" },
    {
      stdout:
        "(pass) the launch frame > every painted line ends in the same column\n" +
        "(fail) full-screen behaviour > the frame still closes on both edges\n" +
        "  expected 79, received 80\n16 pass\n1 fail",
      stderr: "",
      exit_code: 1,
      timed_out: false,
    },
  );
  child("c3", {
    type: "text_delta",
    text: "One row overhangs at 80 columns: the narrow fallback pads to cols, not cols-1.",
  });
  child("c3", { type: "turn_complete", stopReason: "end_turn", totalTurns: 3 });
  turn.onEvent({
    type: "tool_progress",
    callId: "c3",
    note: "",
    state: "settled",
    ok: true,
  } as never);
  turn.onEvent({
    type: "tool_call_end",
    callId: "c3",
    args: {},
    output: {
      callId: "c3",
      toolName: "task",
      success: true,
      result: "One row overhangs at 80 columns.",
      durationMs: 31_000,
      structured: { task_id: "task_11111111-2222-3333-4444-555555555555" },
    },
  } as never);

  t.liveTurn = turn;
  t.turnPreview = turn.liveLines();
  return turn;
}

// ─── The lead's own transcript, so the workspace is not empty ───

const LEAD = [
  "",
  "  \x1b[7m Add a timeout setting, and check the narrow frame while you are in there. \x1b[0m",
  "",
  "  ◇ Three lanes: planner maps the settings surface, builder adds the",
  "    setting, verifier re-runs the frame captures at 80 columns.",
  "",
  "    │ › scout  map the settings surface",
  "    │ › work   build the setup wizard",
  "    │   scout  re-run the frame captures                    done · 1 step · 31s",
];

// ─── Drive it ───

mkdirSync(OUT, { recursive: true });
const frames: Array<{ name: string; note: string; rows: string[] }> = [];
const snap = (t: any, name: string, note: string) => {
  t.renderViewport();
  frames.push({ name, note, rows: [...painted] });
};
const key = (t: any, k: Record<string, unknown>) => t.routeKey(k);

{
  const t = controller();
  t.transcript = [...LEAD];
  fanOut(t);

  snap(t, "01-working", "a fan-out in flight; the keys are on the composer");

  key(t, { type: "right" });
  snap(t, "02-row-focused", "right arrow on an empty composer: the row is the selector");

  key(t, { type: "right" });
  snap(t, "03-row-moved", "right again: the selection moves to the next agent");

  key(t, { type: "left" });
  key(t, { type: "enter" });
  snap(t, "04-transcript-planner", "enter: planner's live transcript takes the workspace");

  key(t, { type: "right" });
  snap(t, "05-transcript-builder", "right inside a transcript: builder's");

  key(t, { type: "right" });
  snap(t, "06-transcript-verifier", "right again: verifier's, which has come back");

  key(t, { type: "esc" });
  snap(t, "07-back", `esc: back to the lead; engine.abort() calls so far = ${t.aborts}`);

  key(t, { type: "ctrl", name: "f" });
  snap(t, "08-cards", "ctrl+f during the turn: the cards");

  key(t, { type: "down" });
  key(t, { type: "enter" });
  snap(t, "09-cards-enter", "enter on a card: the cards give way to the transcript");

  key(t, { type: "esc" });

  // The turn ends; every member is back.
  for (const id of ["c1", "c2"]) {
    t.liveTurn.onEvent({
      type: "tool_call_end",
      callId: id,
      args: {},
      output: {
        callId: id,
        toolName: id === "c2" ? "worker" : "task",
        success: true,
        result: "ok",
      },
    } as never);
  }
  t.mode = "input";
  t.liveTurn = null;
  t.turnPreview = null;
  t.lastTurnMs = 118_000;
  snap(t, "10-rest", "at rest: the agents are back, and one key away");

  key(t, { type: "right" });
  snap(t, "11-rest-row", "right arrow at rest: the finished agents are selectable");

  key(t, { type: "enter" });
  snap(t, "12-rest-transcript", "enter at rest: a finished agent's transcript");

  key(t, { type: "esc" });
  // Typing with the row focused must reach the composer and take the keys back.
  key(t, { type: "right" });
  for (const ch of "hi") key(t, { type: "char", value: ch });
  snap(t, "13-typing", `typing on the row: input="${t.input}", focus=${t.focus}`);
}

for (const frame of frames) {
  const head = [
    `# ${frame.name} — ${frame.note}`,
    `# terminal: ${ROWS} rows x ${COLS} cols — painted by Tui.renderBand, keys through Tui.routeKey`,
    `#${Array.from({ length: COLS }, (_, i) => (i % 10 === 0 ? String((i / 10) % 10) : ".")).join("")}`,
  ];
  const plain = frame.rows.map((l) => stripAnsi(l).trimEnd());
  writeFileSync(
    join(OUT, `${frame.name}.txt`),
    [...head, ...plain.map((l, i) => `${String(i + 1).padStart(2)}|${l}`)].join("\n") + "\n",
  );
  if (KEEP_ANSI) writeFileSync(join(OUT, `${frame.name}.ansi`), frame.rows.join("\n") + "\n");
  console.log(`  frame -> ${join(OUT, `${frame.name}.txt`)}`);
}
