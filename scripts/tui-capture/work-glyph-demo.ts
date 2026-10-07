/**
 * The working row with Say's glyph on it, played through a scripted turn.
 *
 * The founder judged this row by watching it before it was wired in
 * (2026-10-02, three rounds), and this is what they watched: the row drawn in
 * a real terminal through the same pure functions the rung uses -- `WorkGlyph`
 * and `paintGlyph` (ui/waveform.ts), `stagedRow` (ui/working.ts), `Pulse`
 * (ui/pulse.ts), `voiceLine`, `flowRow`. Kept because motion cannot be
 * reviewed in a diff: change a constant in waveform.ts and this is how to see
 * what it did, held in one state for as long as it takes to judge it.
 *
 * ZERO MODEL CALLS. There is no engine, no provider and no network here. The
 * "output" the glyph reacts to is a seeded generator of chunk arrivals, shaped
 * like a real stream on purpose -- ragged, with pauses -- because a perfectly
 * even feed would flatter the animation.
 *
 *     bun scripts/tui-capture/work-glyph-demo.ts              one 80s turn
 *     bun scripts/tui-capture/work-glyph-demo.ts --loop       until ctrl+c
 *     bun scripts/tui-capture/work-glyph-demo.ts --hold NAME  one state, held
 *                                   NAME: stream | hard | sweep | agents | rest
 *     bun scripts/tui-capture/work-glyph-demo.ts --theme ember
 *     bun scripts/tui-capture/work-glyph-demo.ts --frames 5   print every 5th
 *                                   frame as a line; no cursor control
 */

import { agentBlocks, type AgentCard } from "../../packages/orchestrator/src/bin/ui/agents-panel";
import * as F from "../../packages/orchestrator/src/bin/ui/flow";
import { Pulse, PULSE_WEIGHT, quietLabel } from "../../packages/orchestrator/src/bin/ui/pulse";
import { visLen } from "../../packages/orchestrator/src/bin/ui/render";
import { detectTerminalColors } from "../../packages/orchestrator/src/bin/ui/terminal-colors";
import {
  configureAutoTheme,
  faint,
  setFinish,
  setTheme,
} from "../../packages/orchestrator/src/bin/ui/theme";
import {
  loadSavedFinish,
  loadSavedTheme,
} from "../../packages/orchestrator/src/bin/ui/theme-store";
import { voiceLine } from "../../packages/orchestrator/src/bin/ui/voice";
import {
  GLYPH_COLORS,
  GLYPH_FRAME_MS,
  GLYPH_PATTERN,
  GLYPH_THEMES,
  STROKE_WEIGHT,
  WorkGlyph,
  paintGlyph,
  restGlyph,
} from "../../packages/orchestrator/src/bin/ui/waveform";
import {
  stagedRow,
  type WorkStage,
  type WorkingKind,
} from "../../packages/orchestrator/src/bin/ui/working";

// ─── The pretend stream ───

/** Seeded, so two runs of the preview are the same film. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let count = 0;
  let product = rng();
  while (product > limit) {
    count++;
    product *= rng();
  }
  return count;
}

/** What arrived in one frame: streamed bytes, tool calls opening or closing,
 *  and sub-agents reporting in. */
interface Arrived {
  bytes: number;
  calls: number;
  beats: number;
}
type Feed = (rng: () => number) => Arrived;

const NOTHING: Arrived = { bytes: 0, calls: 0, beats: 0 };
const silent: Feed = () => NOTHING;

/** Text arriving at about `bytesPerSecond`: chunks of uneven size at uneven
 *  times, and now and then a pause of a third of a second to a second. */
function stream(bytesPerSecond: number, pauseChance = 0.03): Feed {
  let pausedFrames = 0;
  return (rng) => {
    if (pausedFrames > 0) {
      pausedFrames--;
      return NOTHING;
    }
    if (rng() < pauseChance) {
      pausedFrames = 3 + Math.floor(rng() * 7);
      return NOTHING;
    }
    const chunk = 12;
    const chunks = poisson(rng, (bytesPerSecond * GLYPH_FRAME_MS) / 1000 / chunk);
    let bytes = 0;
    for (let i = 0; i < chunks; i++) bytes += 4 + Math.floor(rng() * (chunk * 2 - 8));
    return { ...NOTHING, bytes };
  };
}

/** Tool calls opening and closing. */
function calls(perSecond: number): Feed {
  return (rng) => ({ ...NOTHING, calls: poisson(rng, (perSecond * GLYPH_FRAME_MS) / 1000) });
}

/** Sub-agents reporting in. */
function beats(perSecond: number): Feed {
  return (rng) => ({ ...NOTHING, beats: poisson(rng, (perSecond * GLYPH_FRAME_MS) / 1000) });
}

const both =
  (...feeds: Feed[]): Feed =>
  (rng) =>
    feeds
      .map((feed) => feed(rng))
      .reduce((sum, next) => ({
        bytes: sum.bytes + next.bytes,
        calls: sum.calls + next.calls,
        beats: sum.beats + next.beats,
      }));

// ─── The turn ───

interface Segment {
  seconds: number;
  stage: WorkStage;
  kind: WorkingKind;
  phrase?: string;
  feed: Feed;
  agents?: number;
  /** Sub-agents in flight, each drawn as a block after the row's words. */
  members?: string[];
  receipt?: string[];
  caption: string;
}

/** A sub-agent as the rung sees one: running, and saying something. */
const member = (name: string, index: number): AgentCard => ({
  id: `m${index}`,
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
});

const TURN: Segment[] = [
  {
    seconds: 4,
    stage: "start",
    kind: "working",
    feed: silent,
    caption: "waiting on the model, nothing has arrived: the sweep",
  },
  {
    seconds: 5,
    stage: "start",
    kind: "working",
    feed: stream(220),
    caption: "the model starts thinking aloud: a slow, steady beat",
  },
  {
    seconds: 9,
    stage: "understand",
    kind: "reading",
    phrase: "Reading turn.ts",
    feed: both(calls(2.2), stream(60, 0.1)),
    caption: "a burst of reads: each call opening and closing is a stroke",
  },
  {
    seconds: 8,
    stage: "understand",
    kind: "delegating",
    phrase: "Delegating 3 sub-agents",
    // Three members writing at once: three streams into the one mark.
    feed: both(stream(520, 0.04), beats(0.5)),
    agents: 3,
    members: ["planner", "builder", "verifier"],
    caption: "three sub-agents out: one mark for all of them, a block for each",
  },
  {
    seconds: 5,
    stage: "plan",
    kind: "working",
    feed: stream(240),
    receipt: ["step 1 of 4"],
    caption: "planning: an ordinary stream, an unhurried beat",
  },
  {
    seconds: 12,
    stage: "act",
    kind: "editing",
    phrase: "Editing working.ts",
    feed: stream(1400, 0.02),
    receipt: ["step 2 of 4"],
    caption: "working hard: a long edit streaming fast, so it beats quicker and hits full height",
  },
  {
    seconds: 11,
    stage: "verify",
    kind: "running",
    phrase: "Checking with bun test",
    feed: silent,
    receipt: ["step 3 of 4"],
    caption: "the tests run and say nothing: the sweep, and the stall in words",
  },
  {
    seconds: 10,
    stage: "act",
    kind: "editing",
    phrase: "Editing working.ts",
    feed: both(stream(420, 0.08), calls(0.4)),
    receipt: ["step 3 of 4", "second pass"],
    caption: "the check failed, so it is back to building: said in words, second pass",
  },
  {
    seconds: 6,
    stage: "verify",
    kind: "running",
    phrase: "Checking with bun test",
    feed: silent,
    receipt: ["step 4 of 4", "second pass"],
    caption: "checking again",
  },
  {
    seconds: 7,
    stage: "verify",
    kind: "answering",
    feed: stream(260, 0.05),
    caption: "it passed: writing the answer",
  },
  {
    seconds: 5,
    stage: "verify",
    kind: "done",
    feed: silent,
    caption: "done: the mark drains, goes dim and holds still",
  },
];

const HOLD: Record<string, Segment> = {
  stream: { ...TURN[4]!, seconds: 3600, receipt: [], caption: "held: an ordinary stream" },
  hard: { ...TURN[5]!, seconds: 3600, receipt: [], caption: "held: working hard" },
  sweep: { ...TURN[6]!, seconds: 3600, receipt: [], caption: "held: silent, in flight" },
  agents: { ...TURN[3]!, seconds: 3600, caption: "held: three sub-agents out" },
  rest: { ...TURN[10]!, seconds: 3600, caption: "held: at rest" },
};

// ─── Arguments ───

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? "") : null;
};
const loop = args.includes("--loop");
const every = flag("--frames") != null ? Math.max(1, Number(flag("--frames")) || 1) : 0;
const holdName = flag("--hold");
const themeId = flag("--theme");

if (holdName != null && !HOLD[holdName]) {
  console.error(`--hold takes one of: ${Object.keys(HOLD).join(", ")}`);
  process.exit(2);
}
const theme = themeId != null ? GLYPH_THEMES.find((entry) => entry.id === themeId) : undefined;
if (themeId != null && !theme) {
  console.error(`--theme takes one of: ${GLYPH_THEMES.map((entry) => entry.id).join(", ")}`);
  process.exit(2);
}
// Say's `ink` carries no colours: it follows the system, which here is the
// terminal's own ink.
const colors = theme ? theme.colors : GLYPH_COLORS;
const script = holdName != null ? [HOLD[holdName]!] : TURN;

// ─── The film ───

const interactive = every === 0 && Boolean(process.stdout.isTTY);

if (interactive) {
  // The same three things the real CLI settles before it paints: what the
  // terminal's own colours are, which theme is saved, and which finish.
  try {
    configureAutoTheme(await detectTerminalColors());
  } catch {
    // A terminal that will not say is drawn in the default theme.
  }
  const saved = loadSavedTheme();
  if (saved) setTheme(saved);
  const finish = loadSavedFinish();
  if (finish === "matte" || finish === "crisp") setFinish(finish);
}

const width = (): number => process.stdout.columns || 100;
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function restore(): void {
  if (interactive) process.stdout.write("\x1b[?25h\n");
}
process.on("SIGINT", () => {
  restore();
  process.exit(0);
});

async function play(): Promise<void> {
  const rng = mulberry32(20261002);
  // A simulated clock, one frame a step: the pulse, the glyph and the voice
  // are all handed the same `now`, so a slow terminal changes only how long
  // the film takes to watch.
  const startedAt = 1_000_000;
  const live = new Pulse(startedAt);
  const glyph = new WorkGlyph();
  let frame = 0;
  let kind: WorkingKind | null = null;
  let kindSince = startedAt;
  let doneAt: number | null = null;

  for (const segment of script) {
    const frames = Math.round((segment.seconds * 1000) / GLYPH_FRAME_MS);
    for (let f = 0; f < frames; f++, frame++) {
      const now = startedAt + frame * GLYPH_FRAME_MS;
      if (segment.kind !== kind) {
        kind = segment.kind;
        kindSince = now;
        if (kind === "done") doneAt = now;
      }
      const inFlight = segment.kind !== "done" && segment.kind !== "waiting";
      // The liveness pulse and the mark are fed the same events and weigh
      // them differently: one answers "is it alive", the other draws the work.
      const got = segment.feed(rng);
      live.feed(
        got.bytes + got.calls * PULSE_WEIGHT.callback + got.beats * PULSE_WEIGHT.heartbeat,
        now,
      );
      glyph.feed(
        got.bytes + got.calls * STROKE_WEIGHT.callback + got.beats * STROKE_WEIGHT.heartbeat,
      );
      const liveness = live.sample(now);
      const drawn = glyph.step(
        {
          quietMs: liveness.quietMs,
          agents: segment.agents ?? 0,
          live: inFlight,
        },
        now,
      );
      const settled = drawn.levels.every((level) => level === 0);
      const mark =
        !inFlight && settled
          ? restGlyph()
          : paintGlyph(drawn, { colors, pattern: GLYPH_PATTERN, t: now / 1000 });
      const elapsedMs = (doneAt ?? now) - startedAt;
      const blocks = agentBlocks((segment.members ?? []).map(member), Math.max(24, width() - 36));
      const news = F.receiptOf([
        ...(segment.receipt ?? []),
        inFlight ? quietLabel(liveness) : null,
      ]);
      const receipt = [blocks, news && faint(news)].filter(Boolean).join(faint(" \u00b7 "));
      const row = stagedRow(
        mark,
        {
          stage: segment.stage,
          kind: segment.kind,
          phrase: segment.phrase,
          // The rung does not time the first two seconds of a turn.
          elapsedMs: elapsedMs < 2000 ? undefined : elapsedMs,
          voice: voiceLine({
            kind: segment.kind,
            elapsedMs,
            phaseMs: now - kindSince,
            seed: startedAt,
          }),
        },
        {
          width: width() - 1,
          reserve: receipt ? visLen(receipt) + 2 : 0,
          // The blocks are the count, as on the real rung.
          fact: !blocks,
        },
      );
      const line = F.flowRow(`${F.MARK}${row}`, receipt, width() - 1);

      if (interactive) {
        process.stdout.write(
          `\x1b[2A\r\x1b[2K${line}\n\x1b[2K${F.MARK}${faint(segment.caption)}\n`,
        );
        await sleep(GLYPH_FRAME_MS);
      } else if (frame % (every || 1) === 0) {
        const stamp = `${((frame * GLYPH_FRAME_MS) / 1000).toFixed(1).padStart(5)}s`;
        process.stdout.write(`${stamp} ${line}\n`);
      }
    }
  }
}

if (interactive) {
  process.stdout.write(
    `\n${F.MARK}${faint("Rune's working row, with Say's glyph. A preview: nothing here calls a model.")}\n\n\n\n\x1b[?25l`,
  );
}
do {
  await play();
} while (loop && interactive);
restore();
process.exit(0);
