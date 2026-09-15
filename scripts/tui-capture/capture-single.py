"""The single column, at two sizes, through a real pty.

Founder, 2026-09-15: "I want the older simple TUI panel, not that split one —
make it back." `[ui] layout` now defaults to `single`, and the claim that has
to be SEEN rather than unit-tested is that a 120-column window is an
80-column window stretched: one column, the transcript at the full width, the
agents strip, the composer at the bottom, the status line — and no divider
anywhere on the screen.

Everything about the rig — the scratch RUNE_HOME, the credential scrub by
shape, the local-only ollama profile, `--new --no-browser --pristine` — is
capture.py's and is imported rather than copied. This file adds only the
frames: idle, a typed draft, `/setup`, `/help`, at 120x40 and 80x24, plus a
`split`-layout control frame at 120x40 so the two shapes sit side by side in
the record.

Zero model calls: nothing is ever submitted to the composer.

    python3 scripts/tui-capture/capture-single.py OUTDIR
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture as rig  # noqa: E402

ESC = rig.ESC
CR = rig.CR

DRAFT = "rework the first-run wizard so the provider step"


def frames(outdir, tag, rows, cols, **env):
    s = rig.start(rows, cols, **env)
    try:
        s.snapshot(outdir, "%s-idle" % tag)

        # Typed, never submitted. The rule above the field must not move.
        s.send(DRAFT, settle=0.8)
        s.snapshot(outdir, "%s-typed" % tag)
        for _ in range(len(DRAFT)):
            s.send(b"\x7f", settle=0.0)
        s.pump(0.6)

        s.send("/setup", settle=0.4)
        s.send(CR, settle=1.8)
        s.snapshot(outdir, "%s-setup" % tag)
        s.send(ESC, settle=0.8)
        s.send(ESC, settle=0.8)

        s.send("/help", settle=0.4)
        s.send(CR, settle=1.6)
        s.snapshot(outdir, "%s-help" % tag)
    finally:
        s.close()


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    rig.fresh_profile()
    for cols, rows in ((120, 40), (80, 24)):
        frames(outdir, "%dx%d" % (cols, rows), rows, cols)
    # The control: the same window, told to draw the split. Kept in the record
    # so "the divider is gone" is a comparison rather than an assertion.
    frames(outdir, "120x40-split", 40, 120, RUNE_LAYOUT="split")
    print("captured -> %s" % outdir)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(HERE / "out-single"))
