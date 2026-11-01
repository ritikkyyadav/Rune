# UI decision — trust fixes, 2026-10-26

**Decided by the founder on 2026-10-26** ("well proceed with the fixes then"), in
reply to the TUI audit of v1.4.15 (https://claude.ai/artifact/6koL6RgzTb2EUBj5aB4CUg),
which listed these as "Recommended yes". This is the dated entry `docs/ui-freeze.md`
asks for before a key binding changes.

## What changes

1. **Esc steps back one level, and stopping a run takes two.** From a sub-agent's
   transcript, Esc returns to the agent row, then to the composer. With work in
   flight and an empty composer, the first Esc (or Ctrl+C) shows
   `esc again to stop`; a second press within two seconds stops the run.
   Replaces: one Esc from the composer aborts immediately, and Esc from a
   transcript jumps straight to the composer.
2. **The approval card stops taking letters.** `y`, `a`, `s` and `n` no longer
   answer it, and Shift+Tab moves the selection instead of granting the session.
   Digits and Enter answer only after the card has been open 500 ms and no other
   key was typed in the last 500 ms (1.5 s when a message is half written in the
   composer). Enter never answers while a message is half written: it is the key
   that would have sent it. Esc and Ctrl+C decline. Anything typed goes to the
   composer, is kept for after the card, and is shown on it ("kept for after: …").
   Replaces: single letters and digits resolving the card at once.
3. **Ctrl+L repaints.** `/clear` stays the explicit clear.
   Replaces: Ctrl+L erasing the on-screen transcript, folds and finished agents.

## What does not change

The fixed frame, scrolling model, ctrl+p/ctrl+n, the speaker band, the marks,
the palette and the grammar law. The other fix-first items in the audit
(Alt/Option keys, the resting row's outcome word, answer duplication and the raw
headline, false ✓ marks) are defects under the freeze's own rule and need no
decision.

## Second batch, 2026-10-27

**Decided by the founder on 2026-10-27** ("proceed with these works too first"), in reply to the
list of audit items still open after the first batch. Two of these were already on the page's
"Recommended yes" list of 2026-10-26.

1. **Code fences lose their side borders** (2026-10-26 list). The top and bottom rules stay; the
   side borders and right padding go, so a terminal selection copies the code. `/copy` is added.
2. **The working row stops inventing progress** (2026-10-26 list). With nothing arriving it says
   `waiting on the model`; a retry names the provider's error. Rune's voice lines stay for real
   work.
3. **A first launch opens the connect picker**, in `/login`'s own order (subscription, API key,
   offline), with web search left for later. `/setup` keeps the six-step wizard. Nothing runs until
   a model is connected, and a message sent before then is kept.
4. **`/config` splits into Settings and Advanced**, values in words.
5. **The minimum window is 60×12** (was 60×16).
6. **Box footers drop the word `observed`.** The evidence rungs stay in the session's ledger; the
   founder's rule of 2026-09-16 keeps them out of the TUI.

## Still open, needing the founder

- The white added band on dark terminals (audit T7) -- the art direction is the founder's.
- `›` carries five meanings, and the plan's pending mark is the letter `o` -- both frozen marks.
- The header spans the window while block rules are inset by a cell, by documented design
  (`flow.ts` `chromeWidth`, `surfaceWidth`); aligning them changes that design.
- In-app find and older pages rebuilt from the session log (T12) -- a feature, not a fix.
- The left arrow on an empty composer opens the session manager, and `?` opens the command list
  while the status line calls it `keys` (T13) -- key bindings, which need a dated decision.
- A rate limit names no time to retry at (T11).
