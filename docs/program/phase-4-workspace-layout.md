# Phase 4A — the workspace layout

Design only. Nothing under `packages/` or `crates/` is touched by this document;
every claim about current behaviour carries a `file:line`, and everything in
§2–§4 is a proposal awaiting the four founder decisions in §4.3.

Companion: `docs/program/phase-4-mocks/` — seven plain-text frames at exact
column widths, generated and width-checked, listed in §3.

The terminal invariants applied throughout are the ones in the
`keel-terminal-ui` skill: a rung decided once at startup, a closed glyph budget
with one-cell ASCII twins, six colour roles with body text uncoloured, no
spinner, ledgers rather than progress bars, code truncated never wrapped, and
nothing larger than ~12 rows entering the stream without a keystroke.

---

## 1. The current TUI, mapped

### 1.1 The frame

Two layouts. The default is the **fixed-chrome viewport**; `--inline` /
`RUNE_INLINE` keeps the old committed-scrollback surface
(`packages/orchestrator/src/bin/ui/tui.ts:1-32`).

The fixed frame is composed by one pure function.
`composeFrame` (`packages/orchestrator/src/bin/ui/viewport.ts:178-223`) takes
`{rows, header, transcript, footer, scroll, caretRow, caretCol}` and returns a
`Frame` of exactly `rows` strings plus the absolute caret cell. It is the only
code that decides what occupies a given row, and it is pure so that the
off-by-ones are testable (`viewport.ts:24-26`).

`zones(rows, header, footer)` (`viewport.ts:91-107`) splits the height.
Priority under pressure is **footer > body > header** (`viewport.ts:81-90`), and
`MIN_BODY_ROWS = 1` (`viewport.ts:69`) guarantees the body never vanishes. The
header keeps its **top** rows when trimmed (`viewport.ts:184`); the footer keeps
its **tail**, and the caret moves up by exactly what was cut
(`viewport.ts:188-190`).

Sizes today:

| zone   | source                                               | height                                                                                                                                          |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| header | `Tui.bannerLines()` → `renderBanner` → `flow.header` | **3 rows**: a blank, the masthead, the seam rule (`packages/orchestrator/src/bin/ui/flow.ts:409-413`)                                           |
| body   | whatever is left                                     | `rows - header - footer`, min 1                                                                                                                 |
| footer | `Tui.footerBlock(headerRows)` (`tui.ts:1356-1374`)   | up to `max(3, rows - headerRows - 1)`; over that, rows are dropped from the **top** behind a `... N more lines above (ctrl+r to expand)` marker |

Width: `Tui.contentCols()` (`tui.ts:635-641`) is `columns - 1` in the fixed
layout — the last cell is deliberately left empty, because a line touching it
would wrap and desync the diff (`viewport.ts:252-254` turns autowrap off for the
same reason). That number is pushed into a **process-global** override,
`setTermWidthOverride` (`packages/orchestrator/src/bin/ui/render.ts:14`), set at
`tui.ts:627` and `tui.ts:412`, and read by `flow.measure()`
(`flow.ts:86-105`), `flow.surfaceWidth()` (`flow.ts:113-120`) and
`flow.verbatimWidth()` (`flow.ts:165-167`). **This global is the single biggest
obstacle to a two-column layout** — see §4.1, lane A.

Resize: `Tui.onResize` (`tui.ts:392-417`) re-sets the width override,
`viewport.invalidate()`s and repaints on every SIGWINCH rather than after a
settle timer, because a continuous drag never has 50 ms of quiet. The whole
handler is wrapped in `try/catch`, because a handler that throws once is never
called again (`tui.ts:394-396`).

Alt screen: `Viewport.enter()` (`viewport.ts:250-258`) writes
`?1049h` + autowrap-off + hide + clear + `?1007h`. `VIEWPORT_RESTORE`
(`viewport.ts:65`) is exported so the crash hook can restore without a Viewport;
it is installed on `process.once("exit")` (`tui.ts:695-703`) and on
SIGTERM/SIGHUP (`tui.ts:750-764`), with SIGTSTP/SIGCONT handled at
`tui.ts:772-788`. Paint is diffed row-by-row and wrapped in DEC 2026
synchronised output (`viewport.ts:300-327`); repaints are coalesced to ~16 ms by
`scheduleDraw` (`tui.ts:1748-1754`).

Scrolling: only the body scrolls. `?1007h` alternate-scroll turns a wheel notch
into a burst of arrows (`viewport.ts:37-48`), which `arrowRun`
(`packages/orchestrator/src/bin/ui/keys.ts:38-44`) recognises as the wheel, and
`Tui.arrowScrolls` (`tui.ts:1795-1801`) is the documented policy seam deciding
arrow-scrolls-vs-history.

### 1.2 The fleet panel

**It is not in `activity.ts`.** `activity.ts` renders _settled_ transcript rows
(`packages/orchestrator/src/bin/ui/activity.ts:774-800`). The live fleet panel
is entirely inside `TurnRenderer`
(`packages/orchestrator/src/bin/ui/turn.ts`), and it renders **inside the
footer**, as part of the live rung: `turn.liveLines()` (`turn.ts:684-703`)
→ `Tui.turnStateLines()` (`tui.ts:1826-1846`) → `composerBlock`'s `turn` branch
(`tui.ts:1117-1140`) → `footerBlock`.

State: one map, `private fleet = new Map<string, FleetAgent>()`
(`turn.ts:556`), keyed by `callId`, or `` `${callId}:${node.node}` `` for
workflow nodes (`turn.ts:988`). Rows never re-sort (`turn.ts:718-721`).

`FleetAgent` (`turn.ts:137-185`): `callId`, `kind: "task" | "worker"`,
`argsJson`, `brief`, `state: "queued"|"running"|"done"|"failed"|"skipped"`,
`startedAt?`, `endedAt?`, `note`/`noteAt`/`wantNote`, `steps`, `reroutes`,
`checks`, `checksPassed`, `node?`. **No token count and no cost.**

Lifecycle markers come from `tool_progress.state`: `"started"` promotes to
running and stamps the clock (`turn.ts:838-842`), `"settled"` writes
done/failed, stamps `endedAt` and clears the heartbeat (`turn.ts:843-851`).
Step/check/reroute tallies are taken from the child's own typed event where one
is carried (`turn.ts:857-880`), else from a prose heuristic
(`turn.ts:881-885`).

Budget: `FLEET_ROWS = 6` (`turn.ts:189-192`) plus a `+N more` row
(`turn.ts:738-744`) — at most 7 lines — and the whole live block is further
capped at `min(LIVE_BLOCK_ROWS, floor(rows/3))` by
`Tui.liveBlockBudget()` (`tui.ts:1848-1850`), held at its turn high-water mark
by `holdHeight` (`viewport.ts:118-129`, `tui.ts:1865-1869`) so the frame stops
re-splitting.

A row is retired the moment the call lands in the transcript
(`turn.ts:1855-1858`, pinned by
`tests/unit/orchestrator/ui-fleet.test.ts:214`). **There is no finished section
and no Clear action today.**

### 1.3 The composer

One flat string and one integer caret: `ComposerState { input, caret, width,
status, working?, placeholder? }`
(`packages/orchestrator/src/bin/ui/composer.ts:519-533`), owned by
`Tui.input` / `Tui.caret` (`tui.ts:420-421`) and edited by index arithmetic in
`editComposer` (`tui.ts:2031-2063`).

`renderComposer` (`composer.ts:579-644`) returns a **fixed 4-row block** plus
the status line: `["", edge, mid, edge, ...statusLines]`, `caretRow: 2`,
`caretCol = 4 + (caret - scroll)` (`composer.ts:643`). There is no wrapping —
the field is one row and scrolls **horizontally** to keep the caret in the last
visible cell (`composer.ts:596-597`). Control bytes in the rendered slice are
displayed as spaces (`composer.ts:601-603`). The placeholder
(`composer.ts:572`) renders _in_ the input row and costs no extra row. Height
is capped one level up, on the whole footer block (`tui.ts:1357-1372`).

**Paste does not flatten newlines at current HEAD.** `PasteScanner`
(`packages/orchestrator/src/bin/ui/paste.ts:54-91`) carves paste bodies out of
the stdin stream as substrings and normalises CR/CRLF **to** LF at the single
choke point (`paste.ts:76`) — the fix for the Warp wall-of-text defect
documented at `paste.ts:70-75`. `shouldCollapse` forces a chip for anything
containing a newline (`paste.ts:18-20`); `endPaste` stores the body verbatim and
inserts only the chip (`tui.ts:1985-1991`); `expandPastes` swaps it back on
submit (`paste.ts:30-36`, `tui.ts:2237`). Pinned by
`tests/unit/orchestrator/ui-paste.test.ts:96-122`. What is true is that the
newlines are **invisible** — the composer is a one-line field, so a multi-line
message is a chip, not text you can read back.

One residual: a paste arriving **without** bracketed-paste markers goes through
`parseKeys`, where every `\r`/`\n` becomes `{type:"enter"}` (`keys.ts:189-192`)
— i.e. it submits at each line break. Bracketed paste is enabled at
`tui.ts:682`.

### 1.4 Sub-agent transcripts, and whether a pane could subscribe

A live per-child stream exists, and it is **one line away from being usable**.

The path: the child's loop yields its own `AgentTurnEvent`s → `input.onEvent?.({
agentId, label, event })` at
`packages/orchestrator/src/subagent.ts:413-417` and
`packages/orchestrator/src/worker.ts:760` → the parent's `eventFor(callId)`
closure at `packages/orchestrator/src/agent-loop.ts:3243-3256` → a queue pumped
_while_ the call is awaited → yielded as `tool_progress`
(`agent-loop.ts:3529-3536`).

`ChildAgentEvent` (`packages/protocol/src/events.ts:355-371`) carries
`agentId`, `label?`, **the child's whole `event: AgentTurnEvent`**, and `node?`.
So the wire format is already rich enough for a child transcript pane.

The gate is `agent-loop.ts:3247-3255`:

```ts
const note =
  projectChildEvent(child.node?.node ?? child.agentId, child.event) ??
  projectWorkflowNode(child.node);
if (!note) return;
```

`projectChildEvent` returns `null` for `text_delta`, `thinking_delta`,
`tool_call_start`, `tool_call_args_delta`, `usage`, `turn_complete` and eight
others (`packages/orchestrator/src/subagent-events.ts:80-100`). **So no child
prose, no child thinking, no child tool-call starts and no child token counts
reach the parent at all.** A "watch this sub-agent think" pane is not buildable
until that `if (!note) return;` passes the event through.

Persistence: `tool_progress` is not in `RUN_TRACE_EVENTS`
(`packages/orchestrator/src/engine.ts:372-397`) and is never stored. Children
get no `sessions` row (`docs/program/phase-2-lifecycle.md:52`); their messages
land as a `delegation_checkpoint` event inside the **parent's** session
(`packages/orchestrator/src/delegated-sessions.ts:189-196`). A pane that must
survive a scrollback or a restart therefore needs its own buffer — see §4.1,
lane B.

Only one consumer of `event.child` exists anywhere: `turn.ts:1757`.
`tui.ts:5431` and `headless.ts:259` both name `tool_progress` as a no-op.

### 1.5 How the master labels a child

`label` exists on both delegation schemas and is the only human-authored
identifier: `TASK_TOOL_SCHEMA` (`packages/orchestrator/src/subagent.ts:143-210`,
`label` at `:160-165`, _"A 2-5 word name for this investigation"_) and
`WORKER_TOOL_SCHEMA` (`packages/orchestrator/src/worker.ts:165-240`, `label` at
`:192-197`). There is **no `name`, `role`, `persona` or `agentType` field.**

Two gaps:

1. Neither handler destructures `label` (`subagent.ts:273`, `worker.ts:539`), so
   `ChildAgentEvent.label` is set to the **prompt head**, not the label
   (`subagent.ts:415`, `worker.ts:760`). The TUI only sees the label because it
   re-parses the streamed args JSON in `fleetBrief` (`turn.ts:210-216`). Any
   non-TUI consumer of the event stream cannot see it.
2. `TaskLifecycleChild` (`packages/protocol/src/events.ts:62-88`) has `id`,
   `kind`, `status`, `integration?`, `conflicts?`, `startedAt?`,
   `integratedAt?` — **no name.** The TUI latches the `lifecycle` event
   (`turn.ts:2101-2103`) and renders it nowhere.

Workflow nodes are the exception: `workflow-tool.ts:244-257` sets
`label: node.label ?? node.id`, and `WorkflowNode.label`
(`packages/orchestrator/src/workflow.ts:52-53`) is documented as _"a human label
for the fleet view"_.

Per-child accounting that exists: `SubagentResult.toolCallCount`
(`packages/orchestrator/src/subagent-result.ts:49`), the child's own ISO
`startedAt`/`integratedAt` (`events.ts:84,87`, stamped at `subagent.ts:398`),
and a private `BudgetState.spentUsd`
(`packages/orchestrator/src/subagent-budget.ts:74-77`). Tokens are **converted
to dollars and discarded** (`subagent.ts:468-476`, `worker.ts:798-804`).

### 1.6 Keys bound today, and what is free

Global (`Tui.routeKey`, `tui.ts:1900-1974`): wheel up/down → scroll
(`:1906-1913`), left click → toggle fold (`:1917-1920`), **ctrl+o** → open the
newest fold or the work log (`:1921-1930`), **shift+tab** → gear cycle, or
allow-for-session inside a permission card (`:1934-1936`).

`input` mode (`tui.ts:2065-2149`): `left` on an empty composer opens `/sessions`
(`:2068`), `?` on an empty composer opens the palette (`:2072`), palette
up/down/tab/enter (`:2084-2103`), pgup/pgdn page the body (`:2114-2119`), enter
submits (`:2120`), up/down scroll-or-recall via `arrowScrolls` (`:2123-2129`),
esc clears the draft or cancels a loop (`:2131-2143`).

`ctrlKey` (`tui.ts:2151-2205`): **p** history back, **n** history forward,
**r** work log, **c** clear/arm/exit, **d** exit on empty, **l** reset
transcript, **u** kill to start, **a** caret home, **e** caret end, **t** prints
_"Transcript view (ctrl+t) is coming in a later build"_ — a reserved stub.

Panels: `pickerKey` `1`–`9` quick-select and type-to-jump (`tui.ts:3596-3634`);
`permKey` `1`–`3`, `y`/`n`/`s`/`a` (`tui.ts:268-309`); `questionKey` `1`–`9`
(`packages/orchestrator/src/bin/ui/question.ts:189-230`); `heldKey` `1`–`9`
(`packages/orchestrator/src/bin/ui/held.ts:179-208`); `sessionsKey` tab toggles
Active/Archived, `d`/`r`/`a`/`u` (`tui.ts:4078-4157`); `memoryKey`
`r`/`c`/`a`/`e`/`x`/`q` (`tui.ts:4377-4415`); `keysKey` and its two sub-modes
(`tui.ts:4584-4839`); `workReviewKey` (`tui.ts:5766-5779`).

**Free ctrl letters: `b`, `f`, `g`, `k`, `q`, `s`, `v`, `w`, `x`, `y`, `z`.**
`ctrl+t` is free in behaviour but claimed by the stub above.

Hard constraints from the parser (`keys.ts`), which decide what can _ever_ be
bound:

- `ctrl+j` and `ctrl+m` are **Enter**; `ctrl+i` is **Tab**; `ctrl+h` is
  **Backspace**; `ctrl+space` is dropped (`keys.ts:189-211`). They are not
  available, and this is why "shift+enter for a newline" cannot be implemented
  as stated.
- **Modified arrows and F-keys are unreachable.** `ESC[1;2A`-style sequences
  hit the `CSI_KEYS` lookup, miss, and are skipped whole (`keys.ts:152-160`);
  F1–F4 are swallowed at `keys.ts:167-174`. Alt+letter arrives as `esc` then the
  letter (`keys.ts:182-185`).
- **shift+digit is not a digit.** It is `!@#$%^&*()` — a different `char`
  entirely. The founder's "shift+N" cannot be built without kitty-keyboard-
  protocol support in the parser.

There is no keybinding config file anywhere under
`packages/orchestrator/src`; every binding is hard-coded.

### 1.7 Settings, the picker and help today

Everything modal renders **into the footer**, via `Tui.composerBlock`
(`tui.ts:972-1160`), and the footer is allowed almost the whole window
(`tui.ts:1357`). `/config` and `/settings` are a `renderPicker` list
(`Tui.showSettings`, `tui.ts:3418-3470`, picker at `composer.ts:865`);
`/model` is `Tui.modelTree` (`tui.ts:3215-3380`) over
`packages/orchestrator/src/bin/ui/model-picker.ts`; `/keys` is
`renderKeysPanel` / `renderKeyManagerPanel` / `renderKeyEditor`
(`composer.ts:1043`, `:1119`, `:1534`, masking pinned at
`tests/unit/orchestrator/ui-composer.test.ts:269-298`); `/sandbox` is a
three-tab picker (`tui.ts:3480-3548`). `/help` and `/status` **print into the
transcript** (`tui.ts:2351-2362`, `tui.ts:2431`, `status.ts:70-175`).

**There is no first-run wizard.** `packages/orchestrator/src/bin/welcome.ts` is
a five-line compat shim re-exporting the banner. The only launch-time picker is
`Tui.runLaunchPicker` (`tui.ts:4255-4293`), which offers to resume a prior
session and nothing else. Phase 4's whole setup flow is unbuilt.

### 1.8 What reads as Claude Code, concretely

Named in the source, so these are deliberate borrowings that the redesign should
decide about rather than inherit:

| element                                                                             | where                                                                                     | what to do                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| the masthead printed once at session start, "where Claude Code prints its creature" | `packages/orchestrator/src/bin/ui/banner.ts:186-191`                                      | keep the mark, drop the once-at-top placement — §2.9                                     |
| the composer **trailing** the output rather than being pinned                       | `tui.ts:1479-1485` ("In the Claude Code model the composer TRAILS the output")            | superseded: the composer becomes a fixed region of the right column                      |
| `[Pasted text #N +K lines]` chips, called a "Claude-Code idiom" in the comment      | `tui.ts:427-433`                                                                          | keep the mechanism (it is the right answer for megabyte pastes), restyle the chip — §2.5 |
| up-on-empty recalling the last prompt                                               | `tui.ts:1790-1793`                                                                        | already diverged; keep `ctrl+p`/`ctrl+n` as the named recall                             |
| `esc` twice to interrupt, then restart                                              | `tui.ts:5231`                                                                             | keep; it matches the keel interrupt contract                                             |
| the filled-circle agent voice `●`                                                   | already removed — `packages/orchestrator/src/bin/ui/glyphs.ts:28-31` chose `◇` explicitly | keep `◇`                                                                                 |
| a single flat live rung above a full-width composer                                 | `tui.ts:1826-1846`                                                                        | this is the layout being replaced                                                        |

Two further "same shape as everyone else" elements that are _not_ attributed in
comments but read that way: the whole-window modal panels that swallow the
screen (`/sessions`, `/keys`, `/memory` — `tui.ts:1076-1111`), and the fact that
sub-agents appear only as a transient six-row list that disappears when they
finish.

### 1.9 Terminal invariants: what already holds, and the one deviation

Already correct, and the redesign must not lose them:

- **Rung decided once at startup.** `detectGlyphMode`
  (`glyphs.ts:92-100`) resolves `utf8` / `ambig` / `ascii` from `RUNE_ASCII` and
  the locale at module load; `foldTerminalData` (`glyphs.ts:137-147`) folds
  _data_ — named punctuation, then NFKD, then `?` — not just glyphs.
- **Closed glyph budget**, 13 marks each with a one-cell ASCII twin
  (`glyphs.ts:18-48`) plus an 8-level pulse ramp (`glyphs.ts:73-85`).
- **Body text uncoloured; no background asserted.** `tui.ts:24-30` states it;
  rows no zone claims are erased to the terminal's own colour
  (`viewport.ts:306-309`).
- **The claim ladder exists**: `~ · = ✓` with `verified` defined as _a test that
  failed on the parent commit_ (`packages/orchestrator/src/brief.ts:56-69`),
  rendered by `renderClose` (`read-back.ts:82-103`) with an explicit
  "criteria without evidence are not met" footer.
- **Ledgers, not bars**: `flow.checklist` (`flow.ts:937-972`) reports
  `done/total` and states a skipped row's reason.
- **Code truncated, never wrapped**, with counted elision
  (`flow.diffRows`, `flow.ts:676-707`; `flow.clip`, `flow.ts:864`).
- **One grammar, enforced**: `tests/unit/orchestrator/ui-grammar.test.ts` fails
  any transcript row that right-aligns, any fourth indent rung, and any second
  receipt separator.

The deviation: **the product takes the alternate screen.** The skill forbids it.
The deviation is deliberate and documented (`viewport.ts:16-22`), the
compensating controls are real (a pure, tested compositor; `VIEWPORT_RESTORE` on
exit/SIGTERM/SIGHUP/crash; no background asserted; `--inline` as the escape
hatch), and the founder's two-column layout **requires** it. This design keeps
the deviation and adds one obligation: §2.1 makes the piped / `NO_TTY` rung the
committed-blocks path, so `rune -P` and `| cat` never see a frame.

---

## 2. The design

### 2.1 Frame geometry

Four regions. Three of them are chrome; one scrolls.

```
row 1..3     HEADER        full width. blank, masthead, seam rule. never scrolls.
row 4..R-1   BAND          split into two columns:
               WORKSPACE   left. the transcript. THE ONLY SCROLLING REGION.
               |           one divider column.
               PANEL       right-top. agents when any run, session when idle.
               COMPOSER    right-bottom. grows upward into the panel.
row R        STATUS        full width. the gear/model/context/sandbox strip.
```

The right column is **fixed at 40 cells**; the workspace takes the rest. A card
does not get better at 60 columns, and a proportional right column means the
workspace measure changes every time the window does — which re-wraps the
transcript. (Founder decision 2.)

| terminal | usable (`cols-1`) | workspace          | divider | right           | band rows |
| -------- | ----------------- | ------------------ | ------- | --------------- | --------- |
| 120×40   | 119               | **78** (cols 1–78) | 79      | **40** (80–119) | 36        |
| 160×50   | 159               | **118**            | 119     | **40**          | 46        |
| 100×30   | 99                | **58**             | 59      | **40**          | 26        |
| 80×24    | 79                | **79**, full width | —       | collapsed       | 20        |

The last cell of every row stays empty, as today (`tui.ts:635-641`).

Within the band, the composer owns the bottom of the right column and the panel
owns everything above it. Composer height is `max(4, wrapped rows + 3)`, capped
at `min(band - 8, floor(band * 0.6))` — at 120×40 that is 4 rows at rest and 21
at most, leaving the panel at least 8 rows. Above the cap the composer scrolls
internally (§2.5).

**Minimum size: 60 columns × 16 rows.** Below either, the frame does not
degrade further — it refuses. `composeFrame` returns a single centred block:

```
  R U N E
  needs 60x16. this window is 44x12.
  resize, or run with --inline for the scrollback layout.
```

That is the one case where refusing beats rendering: at 44 columns a diff row
is 38 cells wide after the rail, which is below `flow.measure()`'s own 40-column
floor (`flow.ts:103`), so every line of evidence would be a lie by truncation.

**Non-TTY.** A pipe already gets no TUI at all —
`resolveSurface` is `flags.isTTY && (tuiForced || !classicForced)`
(`packages/orchestrator/src/bin/ui/surface.ts:46-51`), so `| cat`, CI and
`rune -P` fall to the plain printer. That is the `NO_TTY` rung and it must stay:
no alt screen, no frame, no live region. Every block commits its
**final** state only, once, with `\n`. The right column becomes a set of
committed blocks (`AGENTS` printed when the fan-out settles, `SESSION` printed
at the end). This is what makes the log readable in ten years, and it is the
acceptance test for the whole design: run it through `| cat` and the transcript
must be complete.

### 2.2 The narrow-width rule

**Proposed default (recommended).** Below **100 columns** the right column
collapses to a **one-line agents strip** pinned directly above the composer, and
the composer spans the full width. The strip is always current and names the key
that expands it:

```
  ◆ 3 running · 1 done · planner ▆ · builder ▃ · verifier ▁       ctrl+f open
```

`ctrl+f` opens the panel as a **full-band overlay** over the workspace (the same
mechanic `/sessions` uses today, `tui.ts:1080-1094`), and `esc` closes it. This
follows the keel rule directly: a persistent side panel is stale most of the
time, so compress it to one always-current row that names the key which expands
it.

**Alternative (founder decision 1).** Keep the right column at every width and
shrink it to 28 cells between 90 and 100 columns, dropping the per-card briefs
and leaving `1 planner ▆ 2m`. Rejected as the default because at 90 columns the
workspace falls to 61 cells and a diff loses its right half — the founder's
first requirement is that code appears in proper boxes, and a box that clips
its own code is not one.

The threshold is one constant, `PANEL_MIN_COLS = 100`, so flipping it is a
one-line change and the pty capture at 99 and 100 columns is the test.

**Split orientation under the same pressure.** The founder asked for the
workspace to split _vertically_ for a child transcript. At 120 columns the
workspace is 78 cells, so a true side-by-side split gives each pane 38 — below
the 40-column measure floor. So: **stacked by default** (main pane above, child
pane below, divider row naming the child), upgrading automatically to
side-by-side when the workspace is ≥ 140 cells (i.e. a 180-column terminal).
This belongs with decision 1.

### 2.3 The workspace

#### Prose vs boxes

Two registers, and the difference is visible at a glance.

**Prose is never boxed.** It starts at the `MARK` column with `◇`, wraps at
`flow.proseWidth()`, and carries no rule. This is the agent talking.

**Everything a tool produced is boxed.** Three rows minimum:

```
  ┌ run   bun test tests/unit/orchestrator/ui-frame.test.ts ────────────────┐
  │ bun test v1.2.4                                                         │
  │ ✓ the launch frame > every painted line begins in the same column       │
  │ … 15 lines                                                              │
  │ 17 pass  0 fail  41 expect() calls                                      │
  └ ✓ exit 0 · 17 pass · 1.9s ──────────────────────────────────────────────┘
```

- **Title row**: the verb (`read` `grep` `edit` `run` `fetch`, padded to 5) then
  the argument — a path, a pattern, the command **verbatim**. Never a paraphrase.
- **Body**: the tool's own output, reformatted **never** (`flow.outputRail`'s
  rule, `flow.ts:790-816`), truncated never wrapped, clipped by `flow.clip`
  (`flow.ts:864`) which already keeps the tail and the verdict lines.
- **Receipt row**: the claim rung glyph (`~ · = ✓ ✗`, `brief.ts:56-61`), the
  outcome, and the metrics — `exit 0`, `+34 -0`, `212 lines`, `1.9s`.

Diffs keep today's banded rendering inside the box (`flow.diffRows`,
`flow.ts:676-707`) — line-number gutter, sign column, source indentation
preserved, elision counted.

Long output folds: bodies over 12 rows render `… N more lines · ctrl+o` and the
existing `FoldLedger` (`packages/orchestrator/src/bin/ui/folds.ts`) opens them
in place. Nothing larger than 12 rows enters the workspace without a keystroke.

**Glyph budget change.** Boxes need four corners. Add exactly four entries to
`GLYPH_DEFINITIONS` (`glyphs.ts:18-48`), each one cell in both modes:

| name    | utf8 | ascii | role |
| ------- | ---- | ----- | ---- |
| `boxTL` | `┌`  | `+`   | dim  |
| `boxTR` | `┐`  | `+`   | dim  |
| `boxBL` | `└`  | `+`   | dim  |
| `boxBR` | `┘`  | `+`   | dim  |

That takes the budget from 13 marks to 17 — inside the 16–20 ceiling — and it is
the only addition this design makes. In `ascii` mode a box reads
`+ run bun test … ----+ / | … / + exit 0 ----+`, which still frames.

#### The narration contract

What the agent says between tools, and what it is never allowed to say.

1. **It narrates before it acts, not after.** One or two sentences naming what
   it is about to do and why, then the box. The intent is captured _before_ the
   call so a call that hangs still has a reason on screen.
2. **Every claim carries a rung.** The four-rung ladder already exists
   (`brief.ts:48-69`). Prose rendering gains a rule the transcript enforces: a
   sentence that asserts an outcome is prefixed with its rung glyph — `~` for a
   hypothesis, `·` for something that appeared in quotable output, `=` for
   reproduced, `✓` for a test that failed on the parent commit. There is no rung
   for "probably", so "likely unrelated" cannot be written.
3. **The close is a ledger, not a summary.** `renderClose`
   (`read-back.ts:82-103`) already renders the criteria in read-back order with
   the evidence that moved each, and prints _"criteria without evidence are not
   met. nothing here was closed by assertion."_ when any is short. That block is
   the turn's last workspace entry, always.
4. **The UI never parses model prose for state.** Any rung, receipt or count on
   screen comes from the typed event, never from text. This is what keeps the
   screen truthful when the model lies or hangs.
5. **No invented activity.** No "Thinking deeply…" without an operation. The
   waiting indicator is the per-agent pulse (§2.4), driven by real event
   arrivals, and it says `quiet Ns` past the threshold rather than spinning.

#### Scrolling and focus

The workspace is the only scrolling region, unchanged: pgup/pgdn page it, the
wheel reaches it through `?1007h` arrow bursts, up/down on an empty composer
scroll it (`tui.ts:1795-1801`). Scroll offset is per pane, so opening a child
pane does not move the main one.

#### The vertical split

Opening agent _N_ (§2.7) splits the workspace into **main** and **child**.

```
  …main pane content, bottom-aligned against the divider…
  ── 3  verifier ── running 48s ── 3.2k tok · 4 tools ── ctrl+w close ──
  ◇ Capturing at 80x24 first, since that is where the right column
    is supposed to collapse.
  ┌ run   bun test … ┐
  …
```

- **Sizes**: main gets `ceil(band * 0.4)` rows, the divider row is the child's
  header, the child gets the rest. At 120×40 that is 14 / 1 / 21. Below a
  14-row band the split refuses and says so in one row rather than showing two
  unreadable slivers.
- **Header row** names the child: index, name, state, elapsed, tokens, tools,
  and the close key. It is drawn with `─` on both sides so it reads as a seam,
  not as content.
- **Which pane scrolls**: the focused one. Opening a child focuses the child
  pane (you opened it to read it). `ctrl+f` cycles focus (§2.7); the focused
  pane's divider/edge is drawn in the accent.
- **Thinking is visible**, exactly as for the main agent: the child's
  `thinking_delta` and `text_delta` stream into the child pane once
  `agent-loop.ts:3253` forwards them (§4.1 lane B). Until that lands the pane
  can only show the child's tool rows, and it must say so rather than look
  idle — the honest placeholder is `… this build shows tool activity only`.
- **Closing**: `ctrl+w`, or `esc` when the child pane has focus. The child's
  rows stay in its buffer, so reopening it does not lose scrollback.
- Only **one** child pane at a time. Opening another replaces it.

### 2.4 The agents panel (right-top)

The panel has two states and one rule: it shows agents whenever any exist this
session, and the session readout otherwise.

#### Working — full width (40 cells)

```
 AGENTS                       3 running
 ──────────────────────────────────────
 › 1  planner    ▆  2m 04s
      map the settings surface
      read  config-settings.ts
      12.4k tok · 9 tools
   2  builder    ▃  1m 12s
      build the setup wizard
      edit  first-run.ts
      8.1k tok · 6 tools
   3  verifier   ▁  48s · quiet 9s
      re-run the frame captures
      bun test ui-frame.test.ts
      3.2k tok · 4 tools

 FINISHED 1                    c clear
 ──────────────────────────────────────
   4  scribe     ✓  31s
      write the help copy
      2.9k tok · 3 tools · enter view
```

Per card, four rows:

| row | content                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | selection mark, index, **name**, **pulse**, elapsed (suppressed under 2 s, as today at `turn.ts:922-925`), or `✓`/`✗` when settled |
| 2   | the brief — what it was sent to do (today's `label`)                                                                               |
| 3   | what it is doing now: the heartbeat, verbatim from the child's own event                                                           |
| 4   | `N tok · N tools`, plus `N/N checks` and `N reroutes` when non-zero                                                                |

- **The pulse is the progress.** One cell from `PULSE_GLYPHS`
  (`glyphs.ts:73-85`), driven by that child's own event arrivals with a short
  EWMA — not a timer. It rises when the child reports and falls when it does
  not, and past the quiet threshold the row swaps its heartbeat for
  `quiet 9s`. This satisfies the Phase-3 visible-progress acceptance
  (`docs/program/phase-3-auto-efficiency.md:619`) with something that cannot
  lie, and it replaces the spinner the skill forbids.
- **Kind** (`task` / `worker`, today's `FleetAgent.kind`) is carried by the
  brief's verb, not by a chip: `scout` reads, `work` writes. The reference's
  Agent/Bash chip has no equivalent here — Rune's children are all agents.
- **Rows never re-sort**, as today (`turn.ts:718-721`).
- **Finished agents persist** in their own section with a count and a `c clear`
  action — the founder's explicit requirement and a change from today, where the
  row is retired at `tool_call_end` (`turn.ts:1855-1858`).
- Workflow members keep today's wave grouping (`turn.ts:761-790`) as a
  sub-heading inside the running section.

#### Working — collapsed (crowded)

When running + finished exceeds the panel's rows, cards collapse to one row
each, then to an initials row:

```
 AGENTS                      9 running
 ──────────────────────────────────────
 › 1 planner  ▆ 2m04   2 builder ▃ 1m12
   3 verifier ▁ 48s    4 scribe  ▂ 0m31
   5 mapper   ▅ 0m22   6 tracer  ▁ 0m19
 ──────────────────────────────────────
   P▆ B▃ V▁ S▂ M▅ T▁ D· R· C·      +3
```

Initials come from the name's first letter, upper-cased; collisions take the
first two letters (`Pl Pa`). The pulse rides beside each initial so the row
still says who is moving. The full list is always reachable — `ctrl+f` then
up/down walks all of them regardless of what the panel can draw.

#### Idle

The panel becomes the session readout — `/status`'s content
(`status.ts:70-175`) laid out as a column instead of printed into the
transcript:

```
 SESSION
 ──────────────────────────────────────
   context  [███████             ]  34%
            48.1k / 140k tokens
   model    gpt-5.6-sol  max
   route    codex · cache warm
   cost     $1.84 this session
   tools    41 calls
            19 read · 9 edit · 8 run
   changed  4 files  +81 -12
   sandbox  on · workspace writes only
   gear     1st · edits ask
   check    ui-frame ✓ 1.9s · 2m ago
```

The bar is `█` from the pulse ramp inside `[ ]`, so it folds to
`[#######     ]` on a seven-bit terminal. `last check` is the most recent
verification with its verdict and age — the one field that says whether the
current state of the tree has been tested at all.

`/status` itself stays, as the same content printed into the workspace for
copying.

### 2.5 The composer (right-bottom)

A closed field that grows upward.

```
 ──────────────────────────────────────
 › Rework the first-run wizard so the
   provider step remembers what the
   last session used, and make the
   spend cap accept a monthly figure
   as well as a per-session one.
   [Pasted text #1 +38 lines]
   The acceptance is the 80x24 capture
   matching the mock exactly.█
 ──────────────────────────────────────
 12 lines · 318 chars   ctrl+b line
```

- **Word-wrap at the pane width**, not horizontal scroll. This is the change
  that makes "every word stays visible" true, and it means replacing the flat
  `input`/`caret` pair (`composer.ts:519-533`) with a wrap that maps the caret
  index to (row, col). The buffer stays a single string with a single caret
  index — that is the right model and the edit operations
  (`tui.ts:2031-2063`) keep working unchanged; only the _renderer_ learns rows.
- **Grows upward into the panel** from 4 rows to the cap in §2.1, then
  **scrolls internally**, keeping the caret row visible and marking the elision
  with `… N lines above`. The panel gives up rows first; the workspace never
  moves.
- **Multi-line paste keeps its newlines** — already true (§1.3) — and the chip
  stays, because collapsing megabytes is correct. The chip now renders on its
  own row inside the box rather than inline, so the message's shape is visible.
- **Explicit newline: `ctrl+b`.** Not shift+enter and not ctrl+j, for the
  parser reasons in §1.6. (Founder decision 3.)
- **One quiet hint row**, below the lower rule, degrading by the same tier ladder
  `statusLine` already uses (`composer.ts:265-278`): at rest
  `enter send · ctrl+f agents · ? keys`; while typing
  `N lines · N chars   ctrl+b line`; while a turn streams
  `enter queues · esc interrupts`.
- **`/` commands** open the palette _above_ the field, inside the right column,
  windowed to the panel's rows — the same `renderSlashPalette` call
  (`composer.ts:934`) with a narrower width. **History** stays `ctrl+p` /
  `ctrl+n` (`tui.ts:2155-2160`). **The `/model` picker** does not fit in 40
  cells and opens in the workspace instead (§2.8).
- The caret stays a painted reversed cell, not an OSC-12 request
  (`composer.ts:604-611`).

### 2.6 Naming children

Three changes, smallest first.

1. **The delegation tool gets a `name`.** Add one optional property to
   `TASK_TOOL_SCHEMA` (`subagent.ts:143-210`) and `WORKER_TOOL_SCHEMA`
   (`worker.ts:165-240`):

   > `name` — one lowercase word naming this agent's role in the fan-out:
   > `planner`, `builder`, `verifier`, `scribe`, `mapper`. Shown on the agents
   > panel and used for the split-pane header. Distinct from `label`, which is
   > the 2–5 word brief.

   `label` keeps its current meaning and its current position on the panel's
   second row.

2. **The name reaches the wire.** Destructure it in both handlers
   (`subagent.ts:273`, `worker.ts:539`) and set `ChildAgentEvent.label` and a
   new `ChildAgentEvent.name` from it instead of the prompt head
   (`subagent.ts:415`, `worker.ts:760`) — which also fixes the existing defect
   that a non-TUI consumer cannot see the model-authored label at all.
   Add `name?: string` to `TaskLifecycleChild`
   (`packages/protocol/src/events.ts:62-88`) and carry it through
   `Engine.recordChild` (`engine.ts:6413-6462`).

3. **Fallback names, when the model wrote none.** Derived by the harness, never
   by a second model call, in this order:
   - the workflow node id, when the child is a node (`workflow.ts:52-53`);
   - the tool kind plus the first noun of the brief: `scout-auth`, `build-ui`;
   - the ordinal: `agent-2`.
     Uniqueness is enforced by the panel, not by the model: a duplicate name gets
     a numeric suffix (`builder`, `builder-2`) at the moment the second child is
     registered, and the suffix is stable for the life of the call.

Where names come from is **founder decision 4**. The recommendation is _both_:
the master's `name` argument when it supplies one, the harness fallback
otherwise, because a fan-out dispatched by a small free-route model will often
supply nothing and an unnamed row is the thing this phase exists to remove.

### 2.7 Keys

The complete map. Additions are **bold**; everything else is unchanged from
§1.6.

**Focus ring.** `ctrl+f` advances: composer → panel → workspace-main →
(workspace-child, only while a split is open) → composer. `esc` returns to the
composer from anywhere in the ring without cancelling anything. The focused
region is marked by its accent-painted edge; the composer's caret is the marker
when it has focus.

| key             | context                 | action                                                                                            |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| **ctrl+f**      | any                     | advance the focus ring                                                                            |
| **esc**         | panel / workspace focus | return focus to the composer                                                                      |
| ↑ / ↓           | **panel focus**         | **move the agent selection**                                                                      |
| **1–9**         | **panel focus**         | **select that agent directly**                                                                    |
| **enter**       | **panel focus**         | **open the selected agent's transcript in the workspace split**                                   |
| **c**           | **panel focus**         | **clear the finished section**                                                                    |
| **ctrl+w**      | any                     | **close the child pane**                                                                          |
| ↑ / ↓           | composer focus          | scroll the workspace or recall history, per `arrowScrolls` (`tui.ts:1795-1801`)                   |
| pgup / pgdn     | any                     | page the **focused** pane (main or child)                                                         |
| wheel           | any                     | scroll the focused pane                                                                           |
| **ctrl+b**      | composer                | **insert a newline**                                                                              |
| enter           | composer                | send, or queue while a turn streams                                                               |
| ctrl+p / ctrl+n | composer                | history back / forward                                                                            |
| ctrl+o          | workspace               | open the newest fold, else the work log                                                           |
| shift+tab       | any                     | gear cycle (unchanged)                                                                            |
| esc             | composer, empty         | interrupt the turn; twice to stop now                                                             |
| ctrl+c          | composer                | clear draft → arm → exit (unchanged)                                                              |
| `?` / `/`       | composer, empty         | command palette                                                                                   |
| ctrl+t          | —                       | **retire the stub** (`tui.ts:2201-2203`): the transcript view it promised is now `ctrl+f` + enter |

**Conflicts resolved.** `ctrl+f`, `ctrl+b` and `ctrl+w` are all free
(§1.6). Digits are free in `input`/`turn` and already mean _select_ in every
other Rune list (`pickerKey`, `permKey`, `questionKey`, `heldKey`), so `1–9`
under panel focus is the consistent choice, not a new idiom. `esc` gains a
meaning only where it had none (panel/workspace focus); in the composer it still
interrupts, which is the binding people rely on.

**The shift+digit problem, stated.** On every terminal Rune supports, shift+3
is `#`, not "shift+3" — `keys.ts:214-218` sees only the resulting character, and
modified keys generally are dropped before they reach a handler
(`keys.ts:152-160`). So **the founder's `shift+N` cannot be built as specified.**
The fallback is the two-key sequence above: `ctrl+f` then `N`, which is one
extra keystroke, works on a serial console, and needs no parser change. If a
single global chord is required, the parser must first learn the
kitty keyboard protocol (`CSI > 1 u`) with a CSI-`u` decoder and a runtime probe
— a lane of its own, and not one this phase needs.

### 2.8 First run and settings, inside the frame

The Phase 4 flow (`docs/CLAUDE_CODE_HANDOFF.md:205-211`) maps onto the three
regions without inventing a new subsystem.

**Where each part renders:**

| part                                                                        | region                                                                | why                                                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| the six setup steps, with ticks and current values                          | **panel (right-top)**                                                 | it is a ledger of what is done and what is left — the same object the acceptance checks       |
| `saved` vs `active` columns                                                 | **panel**, below the steps                                            | two columns, and they are identical unless a session override is in force, which then says so |
| each step's _receipt_ — the file written, the endpoint probed, the response | **workspace**                                                         | evidence belongs in the transcript, in the same boxes every other tool call uses              |
| the answer to the current step                                              | **composer**, titled                                                  | one field, one question; `enter` saves, `esc` skips                                           |
| `/config`, `/sandbox`                                                       | **workspace**, as a picker                                            | a settings list is 20+ rows; the panel has 8–32 and the composer must stay usable             |
| `/model`                                                                    | **workspace**, as the existing tree picker (`tui.ts:3215`)            | same reason                                                                                   |
| `/keys`                                                                     | **workspace** list + **composer** masked field                        | the list is evidence; the secret is input                                                     |
| `/help`                                                                     | **workspace**, committed                                              | it is a document; it should be scrollable and copyable                                        |
| `/status`                                                                   | **workspace**, committed — and permanently in the **panel** when idle | §2.4                                                                                          |

**Masked secrets.** The key field reuses `renderKeyEditor`'s masking
(`composer.ts:1534`, pinned at
`tests/unit/orchestrator/ui-composer.test.ts:269-298`): last four characters
only, everywhere, including the panel's step row and including the transcript
receipt. The receipt says _where_ the key went (the system keychain) and never
what it is. No API key may appear in `~/.rune/logs/tui-console.log` either —
that sink is `guardConsole` (`tui.ts:491-524`).

**Saved vs active.** Two columns in the panel. A row differs only when the
session holds an override (`/model` for this session, a `--provider` flag, an
env var), and a differing row is the only one painted in the accent, with the
precedence named in one line: `flag > env > session > ~/.rune/config.json`.

**Validation errors** land in the workspace as a failed box — the request
verbatim in the title row, the provider's own response in the body, and the
receipt row saying what state the world is in now and what the user can do:

```
  ┌ check POST https://api.example.com/v1/responses ─────────────────┐
  │ 401 Unauthorized                                                 │
  │ {"error":{"message":"Incorrect API key provided: sk-…7f2a"}}     │
  └ ✗ key rejected · nothing was saved · enter to retry ─────────────┘
```

**No model call to edit configuration.** The status strip during setup says so
explicitly — `◆ setup · no model called yet` — and the first call happens only
when the user sends a message. **Restart-required** settings say so on their own
row (`restart required`) rather than in a banner, and the setup ledger's last
row states whether anything set needs one.

**Cancellation and resize** are already handled by the frame: `esc` at any step
leaves the wizard with everything already saved still saved, and the ledger row
for the abandoned step reads `not set` rather than disappearing — work that did
not happen is still information (`flow.ts:933-935`).

### 2.9 What makes it Rune

- **The accent is Savoir blue, not violet.** `#0B37E0` on paper, lifted to
  `#3E63FF` on ink (`packages/shared/src/design-tokens.ts:105`, `:111`). The
  brief's `#A28CF3` is the 2026-09-03 violet that the 2026-09-05 rebrand
  replaced; this design uses what the code actually ships. One accent only
  (`themes.ts:76-81`); everything else is monochrome plus the three status
  colours.
- **Where the accent is spent**, and nowhere else: the seam rule under the
  wordmark, the focused region's edge, the selection mark `›`, the agent mark
  `◇`, the caret cell, and a `saved ≠ active` row. Not on prose, not on a
  background (`tui.ts:24-30`).
- **The masthead moves.** Today the eight-row quadrant gear
  (`glyphs.ts:62-71`) prints once at session start and scrolls away
  (`banner.ts:186-191`) — which is exactly where Claude Code prints its
  creature. In the new frame it is the **idle workspace**: on a session with
  nothing in it yet, the gear and the wordmark sit in the empty left pane and
  are pushed out by the first block. It costs nothing, it is the one place the
  mark can be large, and it is not where anyone else puts theirs.
- **The wordmark is type, not art**: letterspaced caps on a two-tone rule
  (`flow.ts:310-320`, `flow.ts:362-415`). Unchanged.
- **Boxes, not rails.** Today's `│ ` rail (`flow.ts:592-594`) marks work
  without framing it. The founder asked for framing, and a closed box is the
  visible difference between "the agent is talking" and "a program produced
  this". Rune boxes; the neighbours indent.
- **Spacing**: the three-rung indent ladder stays and stays enforced
  (`MARK` 2, `BODY` 4, `RAIL_IN` 6 — `flow.ts:68-72`,
  `tests/unit/orchestrator/ui-grammar.test.ts`). Boxes live at `MARK`.
- **The one-edge law stays**: nothing in the _workspace_ right-aligns
  (`flow.flowRow`, `flow.ts:207-230`). The **panel and the status strip are
  chrome**, so they may use `flow.row` (`flow.ts:174-181`) and align a count to
  the right edge, exactly as the header already does. The grammar test must be
  extended to say so rather than silently exempting a new file (§4.2).

---

## 3. The mock frames

In `docs/program/phase-4-mocks/`. Every file is exactly its named size; the last
column of every row is empty by design. Generated and width-checked.

| file                          | shows                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `120x40-working-4-agents.txt` | four named agents, three running with pulses and one finished; boxes for read / edit / run; the composer at rest                                                     |
| `120x40-split-agent-3.txt`    | agent 3's live transcript in the workspace split, its failing check, the panel marking it `OPEN`, the child-pane header and `ctrl+w`                                 |
| `120x40-idle.txt`             | no agents; the session readout with a context bar; the turn's close ledger with one criterion short and the "nothing was closed by assertion" footer                 |
| `80x24-working.txt`           | the narrow fallback: one-line agents strip, full-width composer                                                                                                      |
| `80x24-idle.txt`              | the same strip carrying the session summary                                                                                                                          |
| `120x40-first-run.txt`        | the setup wizard — step ledger and saved/active in the panel, receipts in the workspace, masked key field in the composer, `no model called yet` in the status strip |
| `120x40-composer-long.txt`    | the composer grown to eleven rows with a paste chip, the panel squeezed to `+2 more`                                                                                 |

Legend: `◇` the agent's voice · `◆` a phase or section mark · `›` selection ·
`✓ ✗ ~ · =` the claim ladder · `▁▂▃▄▅▆▇█` the pulse · `│ ─ ━` rules and the
region divider · `┌┐└┘` the proposed box corners · `…` counted elision ·
`█` in the composer is the painted caret cell (a reversed cell in the real
surface, not a glyph).

---

## 4. The build plan

### 4.1 Lanes, with disjoint file ownership

**Lane A — the frame and the panes.**
Owns `packages/orchestrator/src/bin/ui/viewport.ts` and the geometry half of
`tui.ts` (`contentCols`, `frameZones`, `bodyRowsNow`, `footerBlock`,
`renderViewport`, `onResize`, `scrollBy`/`scrollLines`,
`maxScroll`, `lastBodyMap`) plus `render.ts`.
Work: extend `composeFrame` from three zones to four regions with a column
split; add the per-region scroll offsets; add the workspace's main/child split;
**retire the `setTermWidthOverride` process global** in favour of a width passed
down (or an `AsyncLocalStorage`-free explicit `budgetWidth` argument, which
`flow.row`/`flow.flowRow` already accept — `flow.ts:174`, `:207`); add the
`60×16` refusal; add the `PANEL_MIN_COLS` collapse.
Acceptance: `tests/unit/orchestrator/ui-frame.test.ts` extended to assert the
divider column, the region widths and the row totals at 160×50, 120×40, 100×30,
99×30 and 80×24; a `59×16` and a `60×15` case asserting the refusal block; a
pty+pyte capture at 80×24 and 120×40 compared against the mocks.

**Lane B — the agents panel, naming, and the child stream.**
Owns `turn.ts`'s fleet section, a new `bin/ui/agents-panel.ts`,
`packages/orchestrator/src/subagent.ts`, `worker.ts`,
`subagent-events.ts`, `agent-loop.ts:3243-3256`, and
`packages/protocol/src/events.ts`.
Work: add `name` to both tool schemas and to `ChildAgentEvent` and
`TaskLifecycleChild`; destructure `label`/`name` in both handlers; **pass the
child event through when its projection is null** so a pane can subscribe to
`text_delta` / `thinking_delta` / `usage`; add per-child token and cost
accumulation from the forwarded `usage` events; keep finished cards with a
`c clear` action; add the per-child pulse; add the collapsed initials row.
Acceptance: `tests/unit/orchestrator/ui-fleet.test.ts` extended — a named child
reaches the card, a nameless one gets the harness fallback, two children with
the same name get distinct suffixes, a finished card survives `tool_call_end`
and disappears on `c`, the pulse reads flat and the row says `quiet Ns` when a
child reports nothing for the threshold, initials collapse at nine members;
plus a protocol test that a child `thinking_delta` reaches the parent stream.

**Lane C — the composer.**
Owns `packages/orchestrator/src/bin/ui/composer.ts` and the composer half of
`tui.ts` (`composerBlock`, `editComposer`, `insert`, `endPaste`, history).
Work: wrap instead of horizontal-scroll; caret index → (row, col); grow-then-
scroll with the cap; `ctrl+b` newline; the chip on its own row; the hint ladder
at 40 cells.
Acceptance: `tests/unit/orchestrator/ui-composer.test.ts` extended — a 500-char
input at width 40 produces the capped row count with the caret visible, the
caret row/col round-trips for every index in a wrapped buffer, `ctrl+b` produces
a real `\n` that survives submit, a 38-line paste is one chip row and expands
verbatim, no rendered row reaches the pane width.

**Lane D — the workspace boxes and narration.**
Owns `packages/orchestrator/src/bin/ui/flow.ts`, `activity.ts`, `glyphs.ts`,
`folds.ts`, `read-back.ts`.
Work: the box grammar (title / body / receipt); the four corner glyphs; boxes
for `run`, `read`, `edit`, `multi_edit`, `apply_patch`, `web_fetch`; diffs
banded inside boxes; the 12-row fold; the rung prefix on assertive prose.
Acceptance: `tests/unit/orchestrator/ui-grammar.test.ts` extended — every box
closes on both edges at 60, 80, 120 and 241 columns; no box row exceeds the
workspace measure; the glyph-budget test proves 17 marks, each one cell in both
modes; the ASCII rung renders a box with `+`/`-`/`|`; a body over 12 rows folds
with a count.

**Lane E — first run and settings in the frame.**
Owns a new `packages/orchestrator/src/first-run.ts`,
`config-settings.ts`, `settings-command.ts`, and the slash handlers in
`tui.ts` (`showSettings`, `runSandboxMenu`, `modelTree`, `openLogin`, `openKeys`).
Work: the six-step ledger; saved-vs-active; validation receipts; the masked
field; the restart-required row; precedence in one line.
Acceptance: `tests/integration/fresh-home-onboarding.test.ts` extended to walk a
clean `RUNE_HOME` through all six steps headlessly and assert the config file
contents, that no key appears in the config file or any log, that a session
override shows as `active ≠ saved`, and that an invalid key produces a receipt
and saves nothing; plus a pty capture of `120x40-first-run.txt`.

Lanes A–E touch disjoint files except `tui.ts`, which four of them share.
`tui.ts` is 5,979 lines and is already three programs in one; **the first commit
of lane A should split it** into `tui-frame.ts` (geometry/paint),
`tui-input.ts` (keys/composer/history), `tui-commands.ts` (slash handlers) and
`tui.ts` (the controller). Without that split the lanes serialise on one file.

### 4.2 Cross-cutting acceptance

- `NO_COLOR=1 RUNE_ASCII=1` renders every mock legibly — marks and layout carry
  the meaning, never colour.
- `| cat` and `rune -P` produce no escape sequences and a complete transcript.
- A `SIGTERM` mid-turn leaves the terminal restored (already covered by
  `tui.ts:750-764`; extend the test to the split-pane state).
- The grammar test gains an explicit chrome exemption list — panel, status strip,
  header — so a new right-aligning file cannot be added silently.

### 4.3 The four founder decisions

1. **The narrow-width rule.** Default: below 100 columns the right column
   collapses to a one-line strip and the composer spans the width, with `ctrl+f`
   opening the panel as an overlay. Alternative: keep a 28-cell column down to 90. _Same decision covers the split orientation_: stacked by default,
   side-by-side only when the workspace is ≥ 140 cells.
2. **Fixed vs proportional right column.** Default: fixed at 40 cells.
   Alternative: 30% of the width, clamped to 34–52 — better on ultrawides, at
   the cost of the workspace measure changing on every resize.
3. **The exact keys.** Proposed: `ctrl+f` focus ring, `1–9` under panel focus,
   `enter` to open, `ctrl+w` to close, `c` to clear finished, `ctrl+b` newline.
   The founder's `shift+N` is not implementable without a kitty-keyboard-protocol
   decoder (§2.7) — confirm the `ctrl+f`+`N` fallback, or fund the parser lane.
4. **Where names come from.** Proposed: **both** — the master's new `name`
   argument when it supplies one, a harness fallback derived from the workflow
   node id / the brief's first noun / the ordinal otherwise. Alternatives:
   model-only (cleaner, but a free-route model will often leave rows unnamed) or
   harness-only (always present, never meaningful).
