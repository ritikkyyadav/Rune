"""Capture the real slash/picker UI without submitting a provider prompt.

Uses capture.py's isolated profile, scratch cwd and credential scrub. Writes
text and HTML terminal frames. Usage: python3 .../capture-workspace-panels.py OUT
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import capture as rig
from vtcolor import ColorScreen, ColorStream, html


def snapshot(session, out, name):
    session.snapshot(str(out), name)
    screen = ColorScreen(session.rows, session.cols)
    ColorStream(screen).feed(session.raw)
    (out / (name + ".html")).write_text(
        html(screen, ground=(14, 16, 22), foreground=(214, 218, 227), title="Rune"),
        encoding="utf-8",
    )


def main(out):
    out.mkdir(parents=True, exist_ok=True)
    rig.fresh_profile()
    for cols, rows in ((80, 24), (120, 40)):
        session = rig.start(rows, cols)
        try:
            tag = "%dx%d" % (cols, rows)
            snapshot(session, out, tag + "-idle")
            session.send("/")
            snapshot(session, out, tag + "-commands")
            for _ in range(12):
                session.send(b"\x1b[B", settle=0.04)
            session.pump(0.3)
            snapshot(session, out, tag + "-commands-scrolled")
            session.send(b"\x15")  # clear the draft
            session.send("/no-such-command")
            snapshot(session, out, tag + "-no-match")
            session.send(b"\x15")
            session.send("/config")
            session.send(rig.CR, settle=1.0)
            snapshot(session, out, tag + "-settings")
            session.send(rig.ESC)
            session.send("/model")
            session.send(rig.CR, settle=1.0)
            snapshot(session, out, tag + "-models")
            session.send(rig.ESC)
        finally:
            session.close()
    print("captured -> %s" % out)


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
