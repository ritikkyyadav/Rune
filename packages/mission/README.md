# Gear — the mission layer

A terminal design system for an autonomous coding agent, and the runtime that makes it
truthful.

Most coding-agent interfaces are a chat log with tool calls in it. This one is built
around a different object: **a mission** — a contract signed at minute zero and handed
back, checked off, with its evidence attached.

```
bun run --cwd packages/mission demo              # the reference session, 18 minutes of work
bun run --cwd packages/mission demo -- --narrow  # 58 columns
bun run --cwd packages/mission demo -- --ascii   # 7-bit, no colour
bun run --cwd packages/mission demo | cat        # the rung that has to still read
```

## The one architectural rule

```
runtime → typed append-only event log → reducer → state → surface
```

**No component parses model prose.** A model that hangs, lies, or returns malformed
output cannot make this UI claim the work succeeded, because the UI never reads what
the model said. If you find a model-generated string being used to decide what to
draw, that is the bug.

## What that buys

| | |
|---|---|
| `criterion` | flips only on `CRITERION_MET` carrying evidence — and if that evidence is a test, it must have **failed on the baseline commit**. Enforced in `reduce.ts`, not in review. |
| `CHECK_RESULT` | cannot claim rung `verified` without a baseline that failed. There is no rung for "probably", so the agent can never write "likely unrelated". |
| success | is not a state. It is a count of criteria. A mission **concludes** whether it succeeded or not and the terminus renders the same shape either way. |
| crash recovery | is free: the log *is* the mission. Replay to the last checkpoint and answer the only two questions anyone has — what was lost, what was not. |

## The two surfaces

**The stream** is ordinary scrollback: written once, never redrawn, selectable,
greppable, tee-able. Only the bottom rows redraw. **A hold** takes the whole screen and
is always momentary — a decision, an inspection, or the terminus. They are never on
screen together, and `esc` always returns to the exact row you left.

What replaces the always-on panel is **the ledger**: one row of mission state that is
always current and always true, and that names the key which expands it.

Nothing larger than twelve rows enters the stream without a keystroke.

## The budgets, both closed

- **Glyphs** — two shapes. Round is work, diamond is judgement. Every glyph has an
  ASCII twin and occupies exactly one cell in both modes (unit-tested). Status beyond
  the shape is carried by the *word* beside it, never by a new symbol.
- **Chrome colour** — six semantic roles, mapped onto the terminal's **own sixteen
  colours**, so the UI inherits whatever theme the user already chose. Truecolour is
  detected and deliberately unused here. No state is carried by colour alone.
- **Code colour** — six token classes, inside a code region and nowhere else. It
  carries nothing, which is exactly why it is safe to spend there: switch it off and
  nothing is lost. Five of the six need no grammar; a language the keyword list has
  never heard of gets an empty one.

## The degradation ladder

Decided once at startup, each rung independent because they fail independently:
piped (`NO_TTY`), `NO_COLOR`, non-UTF-8 locale, CJK ambiguous width (the block ramp
falls back on its own), and width. Every rung can be at its floor and the screen still
says the same things. That is the acceptance test.

## No spinner

A braille spinner turns at the same rate whether a tool is streaming or has been wedged
for four minutes. The **pulse** is one cell, eight levels, driven by `TOOL_PROGRESS`
and by nothing else. When the bytes stop the pulse stops, and the row swaps its counter
for `quiet 6s`.

## Layout

```
src/events.ts        the vocabulary. adding an event is adding a fact the product can state.
src/reduce.ts        the reducer and the five state machines. pure, replayable.
src/log.ts           append-only JSONL, fsync'd at checkpoints. the mission IS this file.
src/render/caps.ts   the degradation ladder
src/render/row.ts    spans, roles, the fold, the measure, and the drop-to-its-own-row rule
src/render/ansi.ts   the two colour budgets, and the OSC 11 row tint
src/render/code.ts   diffs, snippets, foreign output, stack traces, the six token classes
src/render/pulse.ts  the pulse
src/surface/terminal.ts  COMMITTED vs LIVE. five escapes, relative moves only.
src/surface/stream.ts    state → the rows that enter scrollback
src/surface/ledger.ts    the one row that replaces the panel
src/surface/holds.ts     decision · changes · team · terminus · gate · recovery · away
src/adapt/engine.ts      Berne's existing agent-loop events → the mission vocabulary
```

## Adapting the engine that exists

`EngineAdapter` translates the events Berne's plan runner already emits. It is
deliberately capped: **every rung it produces is `observed` or below, and it never
emits `CRITERION_MET`** — because nothing in the current engine stream carries a
baseline commit or a repeat count, and promoting a green test run to `✓` would invent
the one fact the claim column exists to protect.

To lift the ceiling the engine needs three things, in order:

1. a baseline commit recorded when the mission opens
2. a test runner reporting `passed / total` against that baseline as well as against
   the working tree
3. criteria as objects, agreed at minute zero, that those results can flip

Until then the product tells the truth at `·` and says nothing it cannot support.
A test asserts this ceiling, so it cannot be lost by accident.

## Wiring it to an engine

Emit events; draw nothing.

```ts
const log = new MissionLog(".alan/missions/m-4f2a.jsonl");
const caps = detectCaps();
const surface = new Surface(stdoutSink(), caps, screenFor(await queryGround()));

const before = log.current;
const ev = log.append({ type: "TOOL_ENDED", id, exit, detail, bytes, elapsedMs, rung: "observed" });
surface.commit(project(ev, log.current, before, caps));
surface.live([...running.map((t) => toolRunning(t, pulse.level(now), pulse.quietMs(now))),
              ...ledger(log.current, { caps })]);
```

## The tests that matter

`tests/unit/mission/` — 68 of them. Four are load-bearing, in the sense that they are the
difference between an interface that reports work and one that can be believed about
it:

1. a criterion cannot flip on prose that says the work is done
2. a check with no baseline cannot render `✓`
3. `concluded` with unmet criteria renders; a success claim with one unmet is
   unconstructible
4. a tool that starts and never reports renders flat and says `quiet Ns`

Plus: the interactive escape stream, replayed through a terminal emulator, equals the
piped transcript byte for byte — and no row overflows its measure at any of the four
rungs of the ladder.
