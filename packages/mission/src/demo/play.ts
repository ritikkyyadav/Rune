#!/usr/bin/env bun
// ─── Gear · the demo ───
// Plays the reference mission through the real pipeline: events → log → reducer →
// projection → surface. Nothing here draws a frame directly, so a screen that could
// not happen in the product cannot be staged here either.
//
//   bun packages/mission/src/demo/play.ts              the whole session
//   bun packages/mission/src/demo/play.ts --speed 4    faster
//   bun packages/mission/src/demo/play.ts --ascii      the 7-bit rung
//   bun packages/mission/src/demo/play.ts --mono       NO_COLOR
//   bun packages/mission/src/demo/play.ts --narrow     58 columns
//   bun packages/mission/src/demo/play.ts --columns 140  where a decision goes side by side
//   bun packages/mission/src/demo/play.ts | cat        the rung that has to still read

import { MissionLog } from "../log";
import { type MissionState, initialState } from "../reduce";
import { detectCaps, holdWidth, MEASURE, NARROW, type Caps } from "../render/caps";
import { queryGround, screenFor } from "../render/ansi";
import { type Row } from "../render/row";
import { Pulse } from "../render/pulse";
import { Surface, stdoutSink } from "../surface/terminal";
import { ledger } from "../surface/ledger";
import { header, project, toolRunning } from "../surface/stream";
import { decisionHold, terminus } from "../surface/holds";
import { EVIDENCE, MISSION, NOT_DONE } from "./session";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

const speed = value("speed", 3);
const overrides: Partial<Caps> = {};
if (flag("ascii")) {
  overrides.glyphs = "ascii";
  overrides.pulse = "ascii";
}
if (flag("mono")) {
  overrides.colour = "none";
  overrides.tint = false;
}
if (flag("narrow")) {
  overrides.columns = NARROW;
  overrides.measure = NARROW;
} else {
  // A pipe reports no width, so the ladder's width rung has to be askable for.
  overrides.columns = value("columns", process.stdout.columns ?? 92);
  overrides.measure = MEASURE;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const caps = detectCaps(overrides);
  const screen = screenFor(caps.tint ? await queryGround() : undefined);
  const surface = new Surface(stdoutSink(), caps, screen);

  const clock = { now: () => Date.now() };
  const log = new MissionLog(undefined, clock);
  let previous: MissionState = initialState();

  // One pulse per running tool, fed by TOOL_PROGRESS and by nothing else.
  const pulses = new Map<string, Pulse>();

  surface.commit(
    header(
      {
        version: "0.4",
        repo: "ledger/core",
        branch: "main",
        treeClean: true,
        note: "3 open issues on auth",
        model: "claude-opus-4-1",
        effort: "max",
        sandboxed: true,
        posture: "edits and tests run free, shell asks",
      },
      caps,
    ),
  );

  const liveRows = (): Array<Row | null> => {
    const state = log.current;
    const running = state.tools.filter((t) => t.running);
    const rows: Array<Row | null> = running.map((t) => {
      const p = pulses.get(t.id);
      const now = clock.now();
      return toolRunning(t, p?.level(now) ?? 0, p?.quietMs(now) ?? 0);
    });
    if (state.id && state.phase !== "concluded")
      rows.push(...ledger(state, { caps, now: clock.now() }));
    return rows;
  };

  let last = 0;
  for (const beat of MISSION) {
    await sleep(((beat.at - last) * 1000) / speed);
    last = beat.at;

    const ev = log.append(beat.event);
    const state = log.current;

    // A decision takes the whole screen. It is the one thing that blocks, and the
    // ledger goes with it, because nothing else is true while it is open.
    if (ev.type === "DECISION_OPENED") {
      const d = state.decisions[state.decisions.length - 1]!;
      surface.settle([]);
      surface.commit([null, ...decisionHold(d, holdWidth(caps)), null]);
      previous = state;
      continue;
    }

    if (ev.type === "TOOL_STARTED") pulses.set(ev.id, new Pulse(clock.now()));
    if (ev.type === "TOOL_PROGRESS") pulses.get(ev.id)?.sample(ev.bytes, clock.now());
    if (ev.type === "TOOL_ENDED") pulses.delete(ev.id);

    const rows = project(ev, state, previous, caps);
    if (rows.length) surface.commit(rows);
    previous = state;

    if (ev.type === "MISSION_CONCLUDED") {
      surface.settle([]);
      surface.commit([
        null,
        ...terminus(
          state,
          { notDone: NOT_DONE, evidence: EVIDENCE, branch: "gear/m-4f2a", commits: 3 },
          holdWidth(caps),
        ),
      ]);
      break;
    }

    surface.live(liveRows());

    // Keep the pulse honest between events: a tool that stops reporting goes flat and
    // the row starts saying `quiet Ns` on its own.
    const until = Date.now() + 200 / speed;
    while (Date.now() < until && log.current.tools.some((t) => t.running)) {
      await sleep(80 / speed);
      surface.live(liveRows());
    }
  }

  surface.close();
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + "\n");
  process.exit(1);
});
