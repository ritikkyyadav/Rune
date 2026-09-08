# The UI freeze

**Decided 2026-09-08, in P12.5 of the Phase 12 ship plan.**

The terminal layout has been rebuilt four times in eleven days. Each rebuild was
defensible on its own and the sequence was not: the product spent more of
September being re-decided than being used. This page states what is now fixed,
why each piece exists, and what it takes to change one.

**The rule.** Nothing on this page changes without a founder decision recorded in
`docs/program/`. Not "the founder said so in a message" — a dated entry, naming
the decision and what it replaces, in the program directory, the way
`docs/program/12-ship-zero-spend.md` names its own constraints. A lane that
believes a frozen decision is wrong writes the case down and stops; it does not
ship the alternative and wait to be told.

Defects are not changes. A row that runs off the right edge, a diff that never
arrives, a fold that does not close — those are bugs in the frozen design and
fixing them needs no decision, only a regression test. The line is simple: if
the fix would make a screenshot from before look _different in kind_, it is a
change; if it would make it look like what it was already trying to be, it is a
defect.

---

## What is frozen

### 1. The fixed frame

Three zones, and only one of them moves. The header band holds the top rows and
never scrolls. The composer and status hold the bottom rows and never scroll.
The transcript between them is the only scrolling region in the product.

The frame owns the alternate screen, which is a real trade and is stated as one
in `ui/tui.ts`: the terminal's native scrollback and momentum scrolling stop
applying to the transcript, and Rune scrolls its own buffer instead. In exchange
the frame cannot reflow old text on a resize — it repaints at the new width and
clips.

**Why.** The layout before it committed the transcript to the terminal's own
scrollback and pinned only the composer, so a wheel flick or a Page Up dragged
the header, the input field and the status bar off-screen together: the whole
window sliding as one sheet, with no fixed frame around anything. The founder's
call on the evening of 2026-09-05, after a day of living with the alternative,
was _"the header and footer both launch together; keep the footer at one fixed
place while I scroll."_

**The four flips this ends.** Footer pinned (the original) → the anti-alt-screen
doctrine and inline scrollback → fixed chrome on the alternate screen (0.3.0) →
inline as the default (2026-09-05 morning) → the fixed frame as the default
(2026-09-05 evening). Four reversals of the same decision in both directions.
This is the fifth position and it is the last one taken without a written
decision.

**The escape hatch stays.** `--inline` / `RUNE_INLINE` keeps the
native-scrollback layout for anyone who wants the terminal's own scrollback and
reflow back; `--fullscreen` / `RUNE_FULLSCREEN` names the default and wins over
it. `resolveSurface` in `ui/surface.ts` is the one place that decides, and
`ui-surface.test.ts` pins the default so it cannot drift back by accident.

### 2. Wheel scrolling by arrow bursts, never mouse capture

The wheel reaches the transcript through the terminal's alternate-scroll mode
(DEC private 1007), which turns a notch or a trackpad flick into arrow keys.
Rune reads a burst of two or more arrows all pointing one way as the wheel.

**Why.** The obvious implementation — turning on mouse reporting — captures the
mouse, and a captured mouse means click-drag selection stops being the
terminal's. Copying a path out of the transcript is something a person does
twenty times an hour. Scrolling without capturing costs one heuristic in
`ui/keys.ts`; capturing costs the user their clipboard.

PgUp/PgDn and the arrows over an empty composer scroll too, so the wheel is
never the only way.

### 3. `ctrl+p` / `ctrl+n` for history

Prompt history moves on `ctrl+p` and `ctrl+n`, and the arrows move it too when
the composer holds a draft that would otherwise have nowhere to go. The readline
bindings, because this is a terminal and those are what a terminal's hands
already know.

### 4. The speaker band

What you asked is set on an inverse band at the left margin: the band is sized
to the longest line of the message plus a one-cell inset, not to the window.

**Why.** The band is a _mark_, not a ground. Flow's rule is that the surface
behind everything belongs to the user and Rune never paints it; two things are
allowed to carry a background because they identify rather than decorate — the
caret, and the diff evidence bands. The speaker band is the third, and it is
sized to its content for the same reason: a band that ran to the window edge
would be painting the ground.

### 5. The marks

- `◇` — the agent speaking. One dot, prose beside it.
- ` ` — a tool call carries **no** mark. Reads, greps and edits almost always
  work; announcing that they did is noise, and their receipts carry the news.
- `✓` / `✗` — a check that passed, work that failed. Both still mean something
  by the time you reach them, precisely because the ordinary rows do not wear
  them.
- `›` — the selection mark: a call in flight, a chamber, an active step.
- `⬢` — the logo, in the header band only.

The whole vocabulary is closed and lives in `ui/glyphs.ts`, every glyph is one
terminal cell wide, and every one has an ASCII twin for terminals that cannot
show it. `ui-glyphs.test.ts` enforces all three properties **and** forbids a
non-ASCII literal anywhere else under `ui/` — which is what stops a renderer
quietly inventing a sixth mark.

### 6. Blue and mono, with the founder's violet

The accent is `#A28CF3`, derived to `#9682E1` on a light ground so it clears a
3:1 contrast floor. Colour carries meaning and never decoration: the accent is
identity and location, green is added and passed, red is removed and failed,
amber asks, and everything else is one of three greys. A value that is unknown
is absent — no row pads itself with a reassuring guess.

The teal Savoir DNA and the electric blue that replaced it are both gone, and
the violet is the founder's own choice rather than a derived token.

### 7. One grammar

Every content row goes through `flowRow`. Nothing in the transcript
right-aligns. The indent ladder has exactly three rungs — `MARK`, `BODY`,
`RAIL_IN`. Receipt parts are joined by one separator everywhere. A row is words,
never an object: no committed row may contain the opening of a JSON value.

**Why.** The UI had one design system and four dialects that did not use it —
the live rung, the read-back and the composer blocks each hand-built their own
layout — and the screen accurately reported that it was assembled by separate
parts. That is not a thing you fix once; it is a thing that drifts back the next
time a subsystem needs a row and writes one itself. So the law is tested rather
than documented, in `ui-grammar.test.ts`, and a new surface that hand-builds a
row fails the suite.

---

## Why a freeze, and not just a preference

Two records made this necessary.

**The transcript diagnosis of 2026-09-05.** Measured across three sessions in
`rune.db`: 62% of the model's prose was about the plan ledger, the steps and the
budget rather than about the work; 45% of active tool time produced no new
transcript row at all; and edits arrived with no diff behind them. The
conclusion was that the transcript was not communicating, and the response was
another round of layout work — the fourth. It fixed real mechanisms (rows land
when a call starts, bursts fold retroactively, prose streams in place) and it
also moved the furniture again, and only the first half was necessary.

**The founder's screenshots.** Every screenshot filed against the Rune UI in
early September turned out to be Claude Code. The product was being redesigned
against a picture of a different product, because nobody could see this one: the
TUI cannot look at itself, and there was no way to render a real session outside
a live terminal.

That is fixed, and it is what makes the freeze enforceable rather than
aspirational. `scripts/render-live.ts` replays any stored session through the
real `TurnRenderer` at any width and writes the result to a file. The five
largest September sessions, before and after this lane's fixes, are under
`docs/evidence/ui-render-20260908/`. The next argument about the UI can be had
over rendered output instead of over recollection:

```
bun --preload ./scripts/fake-tty.ts scripts/render-live.ts \
    --largest 5 --width 80 --width 120 \
    --out docs/evidence/<date>
```

---

## What this freeze does not cover

The transcript's _content_ — which facts a row carries, what a chamber
summarises, how a diff is banded — is still open to defect fixes and to
evidence-backed improvement, as long as every row still goes through `flowRow`
and the grammar test stays green. The freeze is on the frame, the scrolling
model, the key bindings, the marks and the palette: the things that were flipped
repeatedly, that a user builds muscle memory against, and that cost more to
re-decide than they could ever be worth to get marginally righter.
