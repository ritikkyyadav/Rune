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
